"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {
  listAll,
  listWhere,
  findUserByUsername,
  findClassByName,
  createClass,
  createUser,
  createQuizWithItems,
  getDocById,
  insertDoc,
  updateDocById,
  close
} = require("../server/fdb");
const { hashPassword } = require("../server/security");
const { ensureSubject, subjectIdsOf } = require("../server/subjects");
const { generateTemporaryPassword, logActivity } = require("../server/utils");
const { nameSchema, usernameSchema } = require("../server/validation");

const SOURCE_PATH = path.join(__dirname, "..", "questions-source.html");

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
  const admins = (await listWhere("users", "role", "admin")).sort((a, b) => a.id - b.id);
  if (admins[0]) return admins[0];

  const name = (process.env.ADMIN_NAME || "Portal Administrator").trim();
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const nameResult = nameSchema.safeParse(name);
  const usernameResult = usernameSchema.safeParse(username);
  if (!nameResult.success) throw new Error(nameResult.error.issues[0].message);
  if (!usernameResult.success) throw new Error(usernameResult.error.issues[0].message);

  if (await findUserByUsername(username)) {
    throw new Error(`Username "${username}" is already in use by a non-admin account.`);
  }

  const temporaryPassword = process.env.ADMIN_PASSWORD || generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const id = await createUser({
    name,
    username,
    password_hash: passwordHash,
    role: "admin",
    must_change_password: true
  });

  await logActivity(null, `Created admin account "${name}" (${username})`);
  created.credentials.push({ role: "Admin", name, username, password: temporaryPassword });
  return { id, name, username };
}

async function ensureClasses(html, created) {
  const names = extractClasses(html);
  const classes = [];

  for (const name of names) {
    const existing = await findClassByName(name);
    if (existing) {
      classes.push(existing);
      continue;
    }
    const id = await createClass(name);
    await logActivity(null, `Created class ${name}`);
    created.classes += 1;
    classes.push({ id, name });
  }

  return classes;
}

async function ensureTeacher(created) {
  const teachers = (await listWhere("users", "role", "teacher"))
    .filter(user => user.active)
    .sort((a, b) => a.id - b.id);
  if (teachers[0]) return teachers[0];

  const name = (process.env.IMPORT_TEACHER_NAME || "GBAT Teacher").trim();
  const baseUsername = (process.env.IMPORT_TEACHER_USERNAME || "gbat.teacher").trim();
  let username = baseUsername;
  let suffix = 1;
  while (await findUserByUsername(username)) {
    suffix += 1;
    username = `${baseUsername}${suffix}`;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const id = await createUser({
    name,
    username,
    password_hash: passwordHash,
    role: "teacher",
    must_change_password: true
  });
  await logActivity(null, `Created teacher account "${name}" (${username})`);
  created.credentials.push({ role: "Teacher", name, username, password: temporaryPassword });
  return { id, name, username };
}

async function ensureQuiz(teacher, cls, questions, subject, options, created) {
  const existing = (await listWhere("quizzes", "class_id", cls.id))
    .filter(quiz =>
      quiz.title === options.quizTitle &&
      Number(quiz.subject_id) === Number(subject.id) &&
      !quiz.is_deleted
    )
    .sort((a, b) => a.id - b.id)[0];
  if (existing) return existing;

  const quizId = await createQuizWithItems(
    {
      title: options.quizTitle,
      class_id: cls.id,
      teacher_id: teacher.id,
      subject_id: Number(subject.id),
      subject: subject.name,
      minutes: options.minutes,
      shuffle_questions: false,
      is_open: true,
      is_deleted: false,
      approved: true,
      created_at: new Date()
    },
    questions.map(question => ({
      question_text: question.question_text,
      options: question.options,
      correct_index: question.correct_index,
      solution: question.solution,
      subject: subject.name,
      subject_id: Number(subject.id),
      diagram_svg: question.diagram_svg || null
    }))
  );

  await logActivity(null, `Created quiz "${options.quizTitle}" for ${cls.name}`);
  created.quizzes += 1;
  return { id: quizId };
}

async function ensureDemoStudents(classes, created) {
  const results = [];

  for (const cls of classes) {
    const suffix = String(cls.name).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const username = `demo.${suffix}`;
    const name = `Demo Student - ${cls.name}`;
    if (await findUserByUsername(username)) {
      results.push({ className: cls.name, username, created: false });
      continue;
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await createUser({
      name,
      username,
      password_hash: passwordHash,
      role: "student",
      class_id: cls.id,
      must_change_password: true
    });
    await logActivity(null, `Created demo student account "${name}" (${username})`);
    created.credentials.push({
      role: `Student (${cls.name})`,
      name,
      username,
      password: temporaryPassword
    });
    results.push({ className: cls.name, username, created: true });
  }

  return results;
}

async function ensureWelcomeAnnouncement(teacher, created) {
  const text = "Welcome to the GBAT portal. Your diagnostic assessment is now open. Sign in with your username and temporary password.";
  const announcements = await listAll("announcements");
  if (announcements.some(item => item.text === text)) return false;

  await insertDoc("announcements", {
    author_id: teacher.id,
    text,
    created_at: new Date()
  });
  await logActivity(null, "Posted the welcome announcement");
  created.announcements += 1;
  return true;
}

async function main(cliOptions, { quiet = false } = {}) {
  const options = { ...parseArgs([]), ...(cliOptions || parseArgs(process.argv.slice(2))) };
  const log = quiet ? () => {} : (...args) => console.log(...args);
  if (!Number.isInteger(options.minutes) || options.minutes < 1 || options.minutes > 240) {
    throw new Error("Quiz duration must be between 1 and 240 minutes.");
  }

  const html = fs.readFileSync(SOURCE_PATH, "utf8");
  const created = { credentials: [], classes: 0, quizzes: 0, announcements: 0 };

  const admin = await ensureAdmin(created);
  const classes = await ensureClasses(html, created);
  const teacher = await ensureTeacher(created);

  const questionRows = (await listWhere("questions", "created_by", teacher.id))
    .sort((a, b) => a.id - b.id);
  if (!questionRows.length) {
    throw new Error("The teacher has no questions. Run `npm run import-html` first.");
  }

  const subjectIds = [];
  for (const question of questionRows) {
    const id = question.subject_id || await ensureSubject(question.subject || "General");
    if (!subjectIds.includes(Number(id))) subjectIds.push(Number(id));
    if (!question.subject_id) {
      await updateDocById("questions", question.id, { subject_id: Number(id) });
    }
  }
  await updateDocById("users", teacher.id, {
    subject_ids: [...new Set([...subjectIdsOf(teacher), ...subjectIds])]
  });
  teacher.subject_ids = [...new Set([...subjectIdsOf(teacher), ...subjectIds])];

  const primaryId = subjectIds[0];
  const primaryDoc = await getDocById("subjects", primaryId);
  const primary = {
    id: primaryId,
    name: primaryDoc ? primaryDoc.name : "General"
  };
  const questionsForQuiz = questionRows.filter(question =>
    Number(question.subject_id || primaryId) === Number(primaryId)
  );

  for (const cls of classes) {
    await ensureQuiz(teacher, cls, questionsForQuiz, primary, options, created);
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
      await close();
    });
}

module.exports = { main, parseArgs, ensureAdmin };
