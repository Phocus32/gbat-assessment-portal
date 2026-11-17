"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pool, query, withTransaction } = require("../server/db");
const { applySchema } = require("../server/schema");
const { hashPassword } = require("../server/security");
const { generateTemporaryPassword, logActivity } = require("../server/utils");
const { nameSchema, usernameSchema } = require("../server/validation");

const HTML_PATH = path.join(__dirname, "..", "index.html");

function parseArgs(argv) {
  const options = {
    demoStudents: true,
    quizTitle: "GBAT Diagnostic Assessment",
    minutes: 45
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-demo-students") {
      options.demoStudents = false;
    } else if (arg === "--quiz-title") {
      options.quizTitle = argv[index + 1] || options.quizTitle;
      index += 1;
    } else if (arg === "--minutes") {
      options.minutes = Number(argv[index + 1]) || options.minutes;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function extractClasses(html) {
  const match = /classes:\s*(\[[\s\S]*?\n\s*\])/.exec(html);
  if (!match) return ["SHS 1A", "SHS 1B", "SHS 1C"];

  try {
    const parsed = vm.runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 1000 });
    const names = parsed.map(item => String(item && item.name ? item.name : "").trim()).filter(Boolean);
    return names.length ? names : ["SHS 1A", "SHS 1B", "SHS 1C"];
  } catch {
    return ["SHS 1A", "SHS 1B", "SHS 1C"];
  }
}

async function ensureAdmin(created) {
  const existingAdmin = await query("SELECT id, name, username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (existingAdmin[0]) return existingAdmin[0];

  const name = (process.env.ADMIN_NAME || "Portal Administrator").trim();
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const nameResult = nameSchema.safeParse(name);
  const usernameResult = usernameSchema.safeParse(username);
  if (!nameResult.success) throw new Error(nameResult.error.issues[0].message);
  if (!usernameResult.success) throw new Error(usernameResult.error.issues[0].message);

  const taken = await query("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
  if (taken.length) throw new Error(`Username "${username}" is already in use by a non-admin account.`);

  const temporaryPassword = process.env.ADMIN_PASSWORD || generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await query(
    `INSERT INTO users (name, username, password_hash, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 1)`,
    [name, username, passwordHash]
  );
  await logActivity(null, `Created admin account "${name}" (${username})`);

  created.credentials.push({ role: "Admin", name, username, password: temporaryPassword });
  return { id: result.insertId, name, username };
}

async function ensureClasses(html, created) {
  const names = extractClasses(html);
  const classes = [];

  for (const name of names) {
    const rows = await query("SELECT id, name FROM classes WHERE name = ? LIMIT 1", [name]);
    if (rows[0]) {
      classes.push(rows[0]);
      continue;
    }
    const result = await query("INSERT INTO classes (name) VALUES (?)", [name]);
    await logActivity(null, `Created class ${name}`);
    created.classes += 1;
    classes.push({ id: result.insertId, name });
  }

  return classes;
}

async function ensureTeacher(created) {
  const rows = await query(
    "SELECT id, name, username FROM users WHERE role = 'teacher' AND active = 1 ORDER BY id LIMIT 1"
  );
  if (rows[0]) return rows[0];

  const name = (process.env.IMPORT_TEACHER_NAME || "GBAT Teacher").trim();
  const baseUsername = (process.env.IMPORT_TEACHER_USERNAME || "gbat.teacher").trim();
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
  await logActivity(null, `Created teacher account "${name}" (${username})`);
  created.credentials.push({ role: "Teacher", name, username, password: temporaryPassword });
  return { id: result.insertId, name, username };
}

async function ensureQuiz(teacher, cls, questions, options, created) {
  const existing = await query(
    `SELECT id FROM quizzes
      WHERE title = ? AND class_id = ? AND is_deleted = 0
      LIMIT 1`,
    [options.quizTitle, cls.id]
  );
  if (existing[0]) return existing[0];

  const quizId = await withTransaction(async connection => {
    const [result] = await connection.execute(
      `INSERT INTO quizzes (title, class_id, teacher_id, minutes, is_open)
       VALUES (?, ?, ?, ?, 1)`,
      [options.quizTitle, cls.id, teacher.id, options.minutes]
    );

    for (let position = 0; position < questions.length; position += 1) {
      const question = questions[position];
      await connection.execute(
        `INSERT INTO quiz_questions
           (quiz_id, position, question_text, options_json, correct_index, solution, subject, diagram_svg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.insertId,
          position,
          question.question_text,
          question.options_json,
          question.correct_index,
          question.solution,
          question.subject || "General",
          question.diagram_svg
        ]
      );
    }

    return result.insertId;
  });

  await logActivity(null, `Created quiz "${options.quizTitle}" for ${cls.name}`);
  created.quizzes += 1;
  return { id: quizId };
}

async function ensureDemoStudents(classes, created) {
  const results = [];

  for (const cls of classes) {
    const suffix = cls.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const username = `demo.${suffix}`;
    const name = `Demo Student - ${cls.name}`;
    const existing = await query("SELECT id, username FROM users WHERE username = ? LIMIT 1", [username]);
    if (existing[0]) {
      results.push({ className: cls.name, username, created: false });
      continue;
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await query(
      `INSERT INTO users (name, username, password_hash, role, class_id, must_change_password)
       VALUES (?, ?, ?, 'student', ?, 1)`,
      [name, username, passwordHash, cls.id]
    );
    await logActivity(null, `Created demo student account "${name}" (${username})`);
    created.credentials.push({ role: `Student (${cls.name})`, name, username, password: temporaryPassword });
    results.push({ className: cls.name, username, created: true });
  }

  return results;
}

async function ensureWelcomeAnnouncement(teacher, created) {
  const text = "Welcome to the GBAT portal. Your diagnostic assessment is now open. Sign in with your username and temporary password.";
  const existing = await query("SELECT id FROM announcements WHERE text = ? LIMIT 1", [text]);
  if (existing[0]) return false;

  await query("INSERT INTO announcements (author_id, text) VALUES (?, ?)", [teacher.id, text]);
  await logActivity(null, "Posted the welcome announcement");
  created.announcements += 1;
  return true;
}

async function main(cliOptions, { quiet = false } = {}) {
  const options = { ...parseArgs([]), ...(cliOptions || parseArgs(process.argv.slice(2))) };
  const log = quiet ? () => {} : (...args) => console.log(...args);
  await applySchema();
  if (!Number.isInteger(options.minutes) || options.minutes < 1 || options.minutes > 240) {
    throw new Error("Quiz duration must be between 1 and 240 minutes.");
  }

  const html = fs.readFileSync(HTML_PATH, "utf8");
  const created = { credentials: [], classes: 0, quizzes: 0, announcements: 0 };

  const admin = await ensureAdmin(created);
  const classes = await ensureClasses(html, created);
  const teacher = await ensureTeacher(created);

  const questionRows = await query(
    `SELECT id, question_text, options_json, correct_index, solution, subject, diagram_svg
       FROM questions
      WHERE created_by = ?
      ORDER BY id`,
    [teacher.id]
  );
  if (!questionRows.length) {
    throw new Error("The teacher has no questions. Run `npm run import-html` first.");
  }

  for (const cls of classes) {
    await ensureQuiz(teacher, cls, questionRows, options, created);
  }

  const demo = options.demoStudents ? await ensureDemoStudents(classes, created) : [];
  const announcement = options.demoStudents ? await ensureWelcomeAnnouncement(teacher, created) : false;

  log("");
  log("Portal is ready:");
  log(`  Admin:   ${admin.name} (${admin.username})`);
  log(`  Teacher: ${teacher.name} (${teacher.username})`);
  log(`  Classes: ${classes.map(cls => cls.name).join(", ")}`);
  log(`  Quiz:    "${options.quizTitle}" (${questionRows.length} questions) in each class`);
  if (demo.length) {
    log(`  Demo students: ${demo.map(item => item.username).join(", ")}`);
  }
  log("");
  log(
    `Created: ${created.classes} class(es), ${created.quizzes} quiz(zes), ` +
    `${created.announcements} announcement(s).`
  );

  if (created.credentials.length) {
    log("");
    log("NEW ACCOUNT CREDENTIALS (shown once):");
    for (const item of created.credentials) {
      log(`  ${item.role}: ${item.name}`);
      log(`    username: ${item.username}`);
      log(`    password: ${item.password}`);
    }
    log("");
    log("Every temporary password must be changed at first sign-in.");
  } else {
    log("No new accounts were needed.");
  }

  if (announcement) log("Welcome announcement posted.");

  return { admin, teacher, classes, created };
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}

module.exports = { main, parseArgs, ensureAdmin };
