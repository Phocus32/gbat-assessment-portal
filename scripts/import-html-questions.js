"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pool, query } = require("../server/db");
const { applySchema } = require("../server/schema");
const { hashPassword } = require("../server/security");
const { sanitizeSvg } = require("../server/svg");
const { generateTemporaryPassword, logActivity } = require("../server/utils");

const HTML_PATH = path.join(__dirname, "..", "index.html");

function parseArgs(argv) {
  const options = { owner: null, replace: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--owner") {
      options.owner = argv[index + 1] || null;
      index += 1;
    } else if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function extractQuestions(html) {
  const match = /const defaultQuestions = (\[[\s\S]*?\n\s*\]);/.exec(html);
  if (!match) throw new Error("Could not find the defaultQuestions array in index.html.");

  let parsed;
  try {
    parsed = vm.runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 1000 });
  } catch (error) {
    throw new Error(`Could not parse the questions in index.html: ${error.message}`);
  }

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("The defaultQuestions array is empty or invalid.");
  }

  return parsed.map((item, index) => {
    const label = `question ${index + 1}`;
    if (!item || typeof item.q !== "string" || !item.q.trim()) {
      throw new Error(`Invalid text for ${label}.`);
    }
    if (!Array.isArray(item.options) || item.options.length !== 4) {
      throw new Error(`Invalid options for ${label}.`);
    }
    if (!item.options.every(option => typeof option === "string" && option.trim())) {
      throw new Error(`Empty option for ${label}.`);
    }
    if (!Number.isInteger(item.ans) || item.ans < 0 || item.ans > 3) {
      throw new Error(`Invalid answer index for ${label}.`);
    }
    if (typeof item.sol !== "string" || !item.sol.trim()) {
      throw new Error(`Invalid solution for ${label}.`);
    }

    let diagramSvg = null;
    if (typeof item.svg === "string" && item.svg.trim()) {
      diagramSvg = sanitizeSvg(item.svg);
      if (!diagramSvg) throw new Error(`The diagram for ${label} contains unsafe SVG.`);
    }

    const subject = typeof item.subject === "string" && item.subject.trim()
      ? item.subject.trim().slice(0, 120)
      : "Mathematics";

    return {
      text: item.q.trim(),
      options: item.options.map(option => option.trim()),
      correctIndex: item.ans,
      solution: item.sol.trim(),
      subject,
      diagramSvg
    };
  });
}

async function findOrCreateTeacher(options) {
  if (options.owner) {
    const rows = await query(
      "SELECT id, name, username FROM users WHERE username = ? AND role = 'teacher' LIMIT 1",
      [options.owner]
    );
    if (!rows[0]) throw new Error(`No teacher account found with username "${options.owner}".`);
    return { teacher: rows[0], created: false, temporaryPassword: null };
  }

  const existing = await query(
    "SELECT id, name, username FROM users WHERE role = 'teacher' AND active = 1 ORDER BY id LIMIT 1"
  );
  if (existing[0]) return { teacher: existing[0], created: false, temporaryPassword: null };

  const baseUsername = (process.env.IMPORT_TEACHER_USERNAME || "gbat.teacher").trim();
  const name = (process.env.IMPORT_TEACHER_NAME || "GBAT Teacher").trim();
  let username = baseUsername;
  let suffix = 1;

  while ((await query("SELECT id FROM users WHERE username = ? LIMIT 1", [username])).length) {
    suffix += 1;
    username = `${baseUsername}${suffix}`;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await query(
    `INSERT INTO users (name, username, password_hash, role, must_change_password)
     VALUES (?, ?, ?, 'teacher', 1)`,
    [name, username, passwordHash]
  );

  await logActivity(null, `Created teacher account "${name}" (${username}) for the HTML question import`);
  return {
    teacher: { id: result.insertId, name, username },
    created: true,
    temporaryPassword
  };
}

async function importQuestions(teacherId, questions, options) {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  if (options.replace) {
    await query("DELETE FROM questions WHERE created_by = ?", [teacherId]);
    for (const question of questions) {
      await query(
        `INSERT INTO questions (question_text, options_json, correct_index, solution, subject, diagram_svg, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [question.text, JSON.stringify(question.options), question.correctIndex, question.solution, question.subject, question.diagramSvg, teacherId]
      );
      inserted += 1;
      continue;
    }
    return { inserted, updated, unchanged };
  }

  for (const question of questions) {
    const rows = await query(
      `SELECT id, options_json, correct_index, solution, subject, diagram_svg
         FROM questions
        WHERE created_by = ? AND question_text = ?
        LIMIT 1`,
      [teacherId, question.text]
    );
    const existing = rows[0];

    if (!existing) {
      await query(
        `INSERT INTO questions (question_text, options_json, correct_index, solution, subject, diagram_svg, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [question.text, JSON.stringify(question.options), question.correctIndex, question.solution, question.subject, question.diagramSvg, teacherId]
      );
      inserted += 1;
      continue;
    }

    const sameOptions = existing.options_json === JSON.stringify(question.options);
    const sameDiagram = (existing.diagram_svg || null) === question.diagramSvg;
    if (
      sameOptions &&
      Number(existing.correct_index) === question.correctIndex &&
      existing.solution === question.solution &&
      existing.subject === question.subject &&
      sameDiagram
    ) {
      unchanged += 1;
      continue;
    }

    await query(
      `UPDATE questions
          SET options_json = ?, correct_index = ?, solution = ?, subject = ?, diagram_svg = ?
        WHERE id = ?`,
      [JSON.stringify(question.options), question.correctIndex, question.solution, question.subject, question.diagramSvg, existing.id]
    );
    updated += 1;
  }

  return { inserted, updated, unchanged };
}

async function main(cliOptions, { quiet = false } = {}) {
  const options = cliOptions || parseArgs(process.argv.slice(2));
  const log = quiet ? () => {} : (...args) => console.log(...args);
  await applySchema();
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const questions = extractQuestions(html);

  log(`Found ${questions.length} questions in index.html (${questions.filter(q => q.diagramSvg).length} with diagrams).`);
  if (options.dryRun) {
    log("Dry run only. No database changes were made.");
    return { teacher: null, result: null, credentials: [] };
  }

  const user = await findOrCreateTeacher(options);
  const result = await importQuestions(user.teacher.id, questions, options);

  await logActivity(
    null,
    `Imported questions from index.html into ${user.teacher.name}'s bank (${result.inserted} added, ${result.updated} updated)`
  );

  const credentials = user.created
    ? [{
        role: "Teacher",
        name: user.teacher.name,
        username: user.teacher.username,
        password: user.temporaryPassword
      }]
    : [];

  if (user.created) {
    log("");
    log("A teacher account was created to own the question bank:");
    log(`  Name:     ${user.teacher.name}`);
    log(`  Username: ${user.teacher.username}`);
    log(`  Password: ${user.temporaryPassword}`);
    log("Sign in and change this password immediately.");
    log("");
  }

  log(`Import complete for ${user.teacher.name} (${user.teacher.username}).`);
  log(`  Added:   ${result.inserted}`);
  log(`  Updated: ${result.updated}`);
  log(`  Skipped: ${result.unchanged}`);

  return { teacher: user.teacher, result, credentials };
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(`Import failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}

module.exports = { main, extractQuestions, findOrCreateTeacher, importQuestions };
