"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {
  listWhere,
  insertDoc,
  updateDocById,
  deleteDocById,
  findUserByUsername,
  createUser,
  close
} = require("../server/fdb");
const { hashPassword } = require("../server/security");
const { sanitizeSvg } = require("../server/svg");
const { generateTemporaryPassword, logActivity } = require("../server/utils");

const SOURCE_PATH = path.join(__dirname, "..", "questions-source.html");

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
  if (!match) throw new Error("Could not find the defaultQuestions array in questions-source.html.");

  let parsed;
  try {
    parsed = vm.runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 1000 });
  } catch (error) {
    throw new Error(`Could not parse the questions in questions-source.html: ${error.message}`);
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
    const owner = await findUserByUsername(options.owner);
    if (!owner || owner.role !== "teacher") {
      throw new Error(`No teacher account found with username "${options.owner}".`);
    }
    return { teacher: owner, created: false, temporaryPassword: null };
  }

  const teachers = (await listWhere("users", "role", "teacher"))
    .filter(user => user.active)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (teachers[0]) return { teacher: teachers[0], created: false, temporaryPassword: null };

  const baseUsername = (process.env.IMPORT_TEACHER_USERNAME || "gbat.teacher").trim();
  const name = (process.env.IMPORT_TEACHER_NAME || "GBAT Teacher").trim();
  let username = baseUsername;
  let suffix = 1;

  while (await findUserByUsername(username)) {
    suffix += 1;
    username = `${baseUsername}${suffix}`;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const teacherId = await createUser({
    name,
    username,
    password_hash: passwordHash,
    role: "teacher",
    class_id: null,
    active: true,
    must_change_password: true,
    failed_login_attempts: 0,
    locked_until: null,
    token_version: 0,
    last_login_at: null,
    created_at: new Date()
  });

  await logActivity(null, `Created teacher account "${name}" (${username}) for the HTML question import`);
  return {
    teacher: { id: teacherId, name, username },
    created: true,
    temporaryPassword
  };
}

async function importQuestions(teacherId, questions, options) {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const existing = await listWhere("questions", "created_by", teacherId);
  const byText = new Map(existing.map(question => [question.question_text, question]));

  if (options.replace) {
    for (const question of existing) {
      await deleteDocById("questions", question.id);
    }
    for (const question of questions) {
      await insertDoc("questions", {
        question_text: question.text,
        options: question.options,
        correct_index: question.correctIndex,
        solution: question.solution,
        subject: question.subject,
        diagram_svg: question.diagramSvg,
        created_by: teacherId,
        created_at: new Date(),
        updated_at: new Date()
      });
      inserted += 1;
    }
    return { inserted, updated, unchanged };
  }

  for (const question of questions) {
    const current = byText.get(question.text);

    if (!current) {
      await insertDoc("questions", {
        question_text: question.text,
        options: question.options,
        correct_index: question.correctIndex,
        solution: question.solution,
        subject: question.subject,
        diagram_svg: question.diagramSvg,
        created_by: teacherId,
        created_at: new Date(),
        updated_at: new Date()
      });
      inserted += 1;
      continue;
    }

    const sameOptions = JSON.stringify(current.options) === JSON.stringify(question.options);
    const sameDiagram = (current.diagram_svg || null) === question.diagramSvg;
    if (
      sameOptions &&
      Number(current.correct_index) === question.correctIndex &&
      current.solution === question.solution &&
      current.subject === question.subject &&
      sameDiagram
    ) {
      unchanged += 1;
      continue;
    }

    await updateDocById("questions", current.id, {
      options: question.options,
      correct_index: question.correctIndex,
      solution: question.solution,
      subject: question.subject,
      diagram_svg: question.diagramSvg,
      updated_at: new Date()
    });
    updated += 1;
  }

  return { inserted, updated, unchanged };
}

async function main(cliOptions, { quiet = false } = {}) {
  const options = cliOptions || parseArgs(process.argv.slice(2));
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const html = fs.readFileSync(SOURCE_PATH, "utf8");
  const questions = extractQuestions(html);

  log(`Found ${questions.length} questions in questions-source.html (${questions.filter(q => q.diagramSvg).length} with diagrams).`);
  if (options.dryRun) {
    log("Dry run only. No database changes were made.");
    return { teacher: null, result: null, credentials: [] };
  }

  const user = await findOrCreateTeacher(options);
  const result = await importQuestions(user.teacher.id, questions, options);

  await logActivity(
    null,
    `Imported questions from questions-source.html into ${user.teacher.name}'s bank (${result.inserted} added, ${result.updated} updated)`
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
      await close();
    });
}

module.exports = { main, extractQuestions, findOrCreateTeacher, importQuestions };
