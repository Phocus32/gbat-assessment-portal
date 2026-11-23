"use strict";

process.env.NODE_ENV = "test";
process.env.BCRYPT_ROUNDS = "4";
process.env.LOGIN_RATE_MAX = "1000";
process.env.COOKIE_SECURE = "false";
process.env.HOST = "127.0.0.1";
process.env.JWT_SECRET = "test-only-jwt-secret-that-is-long-enough";

// `npm test` starts this emulator through firebase.json. The default also lets
// you run node --test directly when an emulator is already listening.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "gbat-test";
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "gbat-test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../server/app");
const {
  getDb,
  listWhere,
  findUserByUsername,
  createUser: insertUser,
  getDocById,
  updateDocById,
  insertDoc,
  countQuizItems,
  close
} = require("../server/fdb");
const { ensureSettings } = require("../server/settings");
const { createSubject } = require("../server/subjects");
const { hashPassword } = require("../server/security");

const CSRF = { "X-Requested-With": "XMLHttpRequest" };

let generalSubjectId;
let mathsSubjectId;
let scienceSubjectId;
let secondClassId;

async function clearQuery(query) {
  const snapshot = await query.get();
  for (const doc of snapshot.docs) {
    for (const subcollection of await doc.ref.listCollections()) {
      await clearQuery(subcollection);
    }
    await doc.ref.delete();
  }
}

async function resetDatabase() {
  const db = getDb();
  const collections = [
    "activity_logs",
    "announcements",
    "attempts",
    "class_names",
    "classes",
    "complaints",
    "materials",
    "meta",
    "questions",
    "quizzes",
    "settings",
    "subject_names",
    "subjects",
    "submissions",
    "usernames",
    "users"
  ];
  for (const name of collections) {
    await clearQuery(db.collection(name));
  }
  await ensureSettings();
  generalSubjectId = await createSubject("General");
  mathsSubjectId = await createSubject("Mathematics");
  scienceSubjectId = await createSubject("Science");
}

async function createUser({ name, username, password, role, classId = null, mustChange = 0, subjectIds = [] }) {
  const passwordHash = await hashPassword(password);
  return insertUser({
    name,
    username,
    password_hash: passwordHash,
    role,
    class_id: classId,
    subject_ids: subjectIds,
    must_change_password: Boolean(mustChange)
  });
}

async function login(username, password) {
  const agent = request.agent(app);
  const response = await agent
    .post("/api/auth/login")
    .set(CSRF)
    .send({ username, password });
  return { agent, response };
}

before(async () => {
  await resetDatabase();
  await createUser({
    name: "Portal Admin",
    username: "admin.test",
    password: "AdminPass1234",
    role: "admin"
  });
});

after(async () => {
  await close();
});

test("secured portal end-to-end API flow", async t => {
  let adminAgent;
  let teacherAgent;
  let teacher2Agent;
  let studentAgent;
  let classId;
  let teacher1Id;
  let teacher2Id;
  let quizId;
  let practiceSubmissionId;
  let firstQuestionId;
  let secondQuestionId;
  let scienceQuestionId;
  let student2Id;
  let student2TempPassword;

  await t.test("health endpoint is public", async () => {
    const response = await request(app).get("/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  await t.test("HTML stays fresh while versioned assets are immutable", async () => {
    const page = await request(app).get("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["cache-control"], /no-store/);
    assert.match(page.text, /<title>Learners Connect<\/title>/);
    assert.doesNotMatch(page.text, /GBAT/);
    const match = page.text.match(/src="\/app\.js\?v=([\w-]{1,32})"/);
    assert.ok(match, "app.js should carry a cache-busting asset version");

    const asset = await request(app).get(`/app.js?v=${match[1]}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers["cache-control"], /immutable/);
  });

  await t.test("mutating requests require the CSRF header", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin.test", password: "AdminPass1234" });
    assert.equal(response.status, 403);
  });

  await t.test("admin can sign in with a hardened cookie", async () => {
    const { agent, response } = await login("admin.test", "AdminPass1234");
    assert.equal(response.status, 200);
    assert.equal(response.body.user.role, "admin");
    const cookie = String(response.headers["set-cookie"]);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const me = await agent.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, "admin.test");
    adminAgent = agent;
  });

  await t.test("unknown users receive a generic login failure", async () => {
    const { response } = await login("nobody.here", "WrongPass1234");
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "Invalid username or password.");
  });

  await t.test("admin can create and rename a class", async () => {
    const created = await adminAgent
      .post("/api/admin/classes")
      .set(CSRF)
      .send({ name: "Basic 8A" });
    assert.equal(created.status, 201);
    classId = created.body.class.id;

    const duplicate = await adminAgent
      .post("/api/admin/classes")
      .set(CSRF)
      .send({ name: "Basic 8A" });
    assert.equal(duplicate.status, 409);

    const renamed = await adminAgent
      .patch(`/api/admin/classes/${classId}`)
      .set(CSRF)
      .send({ name: "Basic 8A - Gold" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.class.name, "Basic 8A - Gold");

    const second = await adminAgent
      .post("/api/admin/classes")
      .set(CSRF)
      .send({ name: "Basic 8B" });
    assert.equal(second.status, 201);
    secondClassId = second.body.class.id;
  });

  await t.test("admin creates teacher and student accounts with temporary passwords", async () => {
    const teacher = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({
        name: "Teacher One",
        username: "teacher.one",
        role: "teacher",
        subjectIds: [mathsSubjectId, scienceSubjectId]
      });
    assert.equal(teacher.status, 201);
    assert.equal(teacher.body.user.mustChangePassword, true);
    teacher1Id = teacher.body.user.id;
    assert.deepEqual(teacher.body.user.subjectIds, [mathsSubjectId, scienceSubjectId]);
    assert.ok(teacher.body.temporaryPassword.length >= 10);

    const teacher2 = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({
        name: "Teacher Two",
        username: "teacher.two",
        role: "teacher",
        subjectIds: [mathsSubjectId]
      });
    assert.equal(teacher2.status, 201);
    teacher2Id = teacher2.body.user.id;

    const student = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Student One", username: "student.one", role: "student", classId });
    assert.equal(student.status, 201);
    assert.equal(student.body.user.className, "Basic 8A - Gold");

    const missingClass = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "No Class", username: "student.noclass", role: "student" });
    assert.equal(missingClass.status, 400);

    const teacherLogin = await login("teacher.one", teacher.body.temporaryPassword);
    assert.equal(teacherLogin.response.status, 200);
    teacherAgent = teacherLogin.agent;

    const blocked = await teacherAgent.get("/api/teacher/bootstrap");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");

    const changed = await teacherAgent
      .post("/api/auth/change-password")
      .set(CSRF)
      .send({ currentPassword: teacher.body.temporaryPassword, newPassword: "TeacherPass1234" });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);

    const bootstrap = await teacherAgent.get("/api/teacher/bootstrap");
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(bootstrap.body.subjects.map(item => item.id).sort(), [mathsSubjectId, scienceSubjectId].sort());

    const teacher2Login = await login("teacher.two", teacher2.body.temporaryPassword);
    assert.equal(teacher2Login.response.status, 200);
    teacher2Agent = teacher2Login.agent;
    const teacher2Changed = await teacher2Agent
      .post("/api/auth/change-password")
      .set(CSRF)
      .send({ currentPassword: teacher2.body.temporaryPassword, newPassword: "Teacher2Pass1234" });
    assert.equal(teacher2Changed.status, 200);

    const studentLogin = await login("student.one", student.body.temporaryPassword);
    assert.equal(studentLogin.response.status, 200);
    studentAgent = studentLogin.agent;

    const studentChanged = await studentAgent
      .post("/api/auth/change-password")
      .set(CSRF)
      .send({ currentPassword: student.body.temporaryPassword, newPassword: "StudentPass1234" });
    assert.equal(studentChanged.status, 200);
  });

  await t.test("role guards block cross-role API access", async () => {
    const adminOnTeacher = await adminAgent.get("/api/teacher/bootstrap");
    assert.equal(adminOnTeacher.status, 403);

    const studentOnAdmin = await studentAgent.get("/api/admin/bootstrap");
    assert.equal(studentOnAdmin.status, 403);

    const teacherOnAdmin = await teacherAgent.get("/api/admin/bootstrap");
    assert.equal(teacherOnAdmin.status, 403);
  });

  await t.test("admin manages subjects and teacher assignments", async () => {
    const created = await adminAgent
      .post("/api/admin/subjects")
      .set(CSRF)
      .send({ name: "English" });
    assert.equal(created.status, 201);

    const renamed = await adminAgent
      .patch(`/api/admin/subjects/${created.body.subject.id}`)
      .set(CSRF)
      .send({ name: "English Studies" });
    assert.equal(renamed.status, 200);

    const assigned = await adminAgent
      .patch(`/api/admin/users/${teacher2Id}`)
      .set(CSRF)
      .send({ subjectIds: [mathsSubjectId, created.body.subject.id] });
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.body.user.subjectIds.sort(), [mathsSubjectId, created.body.subject.id].sort());

    const bootstrap = await adminAgent.get("/api/admin/bootstrap");
    assert.ok(bootstrap.body.subjects.some(item => item.name === "English Studies"));
    assert.ok(bootstrap.body.users.some(user =>
      user.id === teacher2Id && user.subjectNames.includes("English Studies")
    ));

    const teacher2Bootstrap = await teacher2Agent.get("/api/teacher/bootstrap");
    assert.ok(teacher2Bootstrap.body.subjects.some(item => item.name === "English Studies"));

    const removed = await adminAgent
      .delete(`/api/admin/subjects/${created.body.subject.id}`)
      .set(CSRF);
    assert.equal(removed.status, 200);

    const restore = await adminAgent
      .patch(`/api/admin/users/${teacher2Id}`)
      .set(CSRF)
      .send({ subjectIds: [mathsSubjectId] });
    assert.equal(restore.status, 200);
  });

  await t.test("teacher builds a question bank and a class quiz", async () => {
    const first = await teacherAgent
      .post("/api/teacher/questions")
      .set(CSRF)
      .send({
        questionText: "What is 7 + 5?",
        subjectId: mathsSubjectId,
        options: ["10", "12", "14", "9"],
        correctIndex: 1,
        solution: "7 + 5 = 12."
      });
    assert.equal(first.status, 201);
    assert.equal(first.body.question.subject, "Mathematics");
    firstQuestionId = first.body.question.id;

    const second = await teacherAgent
      .post("/api/teacher/questions")
      .set(CSRF)
      .send({
        questionText: "Which number is even?",
        subjectId: mathsSubjectId,
        options: ["3", "5", "8", "9"],
        correctIndex: 2,
        solution: "8 is divisible by 2."
      });
    assert.equal(second.status, 201);
    assert.equal(second.body.question.subject, "Mathematics");
    secondQuestionId = second.body.question.id;

    const science = await teacherAgent
      .post("/api/teacher/questions")
      .set(CSRF)
      .send({
        questionText: "Which force keeps planets in orbit?",
        subjectId: scienceSubjectId,
        options: ["Gravity", "Magnetism", "Friction", "Tension"],
        correctIndex: 0,
        solution: "Gravity governs orbital motion."
      });
    assert.equal(science.status, 201);
    scienceQuestionId = science.body.question.id;

    const unassignedSubject = await teacher2Agent
      .post("/api/teacher/questions")
      .set(CSRF)
      .send({
        questionText: "What is photosynthesis?",
        subjectId: scienceSubjectId,
        options: ["Respiration", "Photosynthesis", "Digestion", "Condensation"],
        correctIndex: 1,
        solution: "Plants convert light into chemical energy."
      });
    assert.equal(unassignedSubject.status, 403);

    const quiz = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Numbers Check",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        questionIds: [firstQuestionId, secondQuestionId]
      });
    assert.equal(quiz.status, 201);
    quizId = quiz.body.quiz.id;

    const mixedSubjects = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Mixed Subjects",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        questionIds: [firstQuestionId, scienceQuestionId]
      });
    assert.equal(mixedSubjects.status, 400);

    const otherTeacherQuiz = await teacher2Agent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Should not work",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        questionIds: [firstQuestionId]
      });
    assert.equal(otherTeacherQuiz.status, 400);
  });

  await t.test("quiz begin and end times gate student access", async () => {
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();

    const invalidWindow = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Backwards Window",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        startAt: end,
        endAt: start,
        questionIds: [firstQuestionId]
      });
    assert.equal(invalidWindow.status, 400);

    const scheduled = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Scheduled Check",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        startAt: start,
        endAt: end,
        questionIds: [firstQuestionId]
      });
    assert.equal(scheduled.status, 201);
    const scheduledId = scheduled.body.quiz.id;
    assert.ok(scheduled.body.quiz.startAt);
    assert.ok(scheduled.body.quiz.endAt);

    const dashboard = await studentAgent.get("/api/student/dashboard");
    assert.equal(dashboard.status, 200);
    const scheduledCard = dashboard.body.quizzes.find(item => Number(item.id) === Number(scheduledId));
    assert.ok(scheduledCard, "scheduled quizzes should still be visible on the dashboard");
    assert.equal(scheduledCard.availability, "scheduled");
    assert.ok(scheduledCard.startAt);
    assert.ok(scheduledCard.endAt);

    const blocked = await studentAgent
      .post(`/api/student/quizzes/${scheduledId}/start`)
      .set(CSRF)
      .send({ mode: "Exam" });
    assert.equal(blocked.status, 403);

    const cleared = await teacherAgent
      .patch(`/api/teacher/quizzes/${scheduledId}`)
      .set(CSRF)
      .send({ startAt: null, endAt: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.startAt, null);
    assert.equal(cleared.body.endAt, null);

    const archived = await teacherAgent
      .delete(`/api/teacher/quizzes/${scheduledId}`)
      .set(CSRF);
    assert.equal(archived.status, 200);
  });

  await t.test("teacher downloads question import templates in every supported format", async () => {
    const csv = await teacherAgent.get("/api/teacher/questions/template.csv");
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.text, /question,optionA,optionB,optionC,optionD,answer,solution,subject,diagram/);

    const xlsx = await teacherAgent.get("/api/teacher/questions/template.xlsx");
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers["content-type"], /spreadsheetml/);
    assert.match(xlsx.headers["content-disposition"], /gbat-question-import-template\.xlsx/);

    const json = await teacherAgent.get("/api/teacher/questions/template.json");
    assert.equal(json.status, 200);
    assert.ok(JSON.parse(json.text).questions.length > 0);

    for (const extension of ["txt", "md"]) {
      const text = await teacherAgent.get(`/api/teacher/questions/template.${extension}`);
      assert.equal(text.status, 200);
      assert.match(text.text, /Question: What is 6 times 7\?/);
      assert.match(text.text, /Answer: B/);
    }
  });

  await t.test("teacher bulk imports CSV questions with strict answer and solution validation", async () => {
    const csvRows = rows => rows
      .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const headers = ["question", "optionA", "optionB", "optionC", "optionD", "answer", "solution", "subject", "diagram"];
    const csv = csvRows([
      headers,
      ["What is 9 + 4?", "11", "13", "14", "15", "B", "Add 9 and 4 to get 13, so option B is the correct answer here.", "", ""],
      ["Which shape has three sides?", "Square", "Circle", "Triangle", "Rectangle", "Triangle", "A triangle has exactly three sides, so the third option is the correct choice.", "", ""],
      ["What is 7 + 5?", "10", "12", "14", "9", "B", "Adding 7 and 5 gives 12, which matches the second option exactly.", "", ""],
      ["What is 9 + 4?", "11", "13", "14", "15", "B", "Add 9 and 4 to get 13, so option B is the correct answer here.", "", ""],
      ["What is 10 - 6?", "3", "4", "5", "6", "", "Subtract 6 from 10 to get 4, so option B is the correct answer here.", "", ""],
      ["What is 3 squared?", "6", "9", "12", "15", "B", "", "", ""]
    ]);

    const response = await teacherAgent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId))
      .attach("file", Buffer.from(csv, "utf8"), {
        filename: "questions.csv",
        contentType: "text/csv"
      });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.summary, { total: 6, created: 2, skipped: 2, failed: 2 });
    assert.match(response.body.failed[0].reason, /correct answer/i);
    assert.match(response.body.failed[1].reason, /worked solution/i);

    const mathsQuestions = await listWhere("questions", "subject_id", mathsSubjectId);
    assert.ok(mathsQuestions.some(item => item.question_text === "What is 9 + 4?" && item.correct_index === 1));
    assert.ok(mathsQuestions.some(item => item.question_text === "Which shape has three sides?" && item.correct_index === 2));

    const missing = await teacherAgent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId));
    assert.equal(missing.status, 400);
  });

  await t.test("bulk importer enforces subject scoping for teacher uploads", async () => {
    const csvRows = rows => rows
      .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const headers = ["question", "optionA", "optionB", "optionC", "optionD", "answer", "solution", "subject", "diagram"];
    const scienceCsv = csvRows([
      headers,
      [
        "What is photosynthesis?",
        "Respiration", "Photosynthesis", "Digestion", "Condensation", "B",
        "Plants use sunlight to turn carbon dioxide and water into glucose, so option B is correct.",
        "Science", ""
      ]
    ]);
    const plainCsv = csvRows([
      headers,
      [
        "What is 2 + 8?",
        "8", "10", "12", "14", "B",
        "Adding 2 and 8 gives 10, which is the second option in this question.",
        "", ""
      ]
    ]);

    const unassignedRow = await teacher2Agent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId))
      .attach("file", Buffer.from(scienceCsv, "utf8"), {
        filename: "science.csv",
        contentType: "text/csv"
      });
    assert.equal(unassignedRow.status, 200);
    assert.equal(unassignedRow.body.summary.created, 0);
    assert.equal(unassignedRow.body.summary.failed, 1);
    assert.match(unassignedRow.body.failed[0].reason, /not assigned/i);

    const unassignedDefault = await teacher2Agent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(scienceSubjectId))
      .attach("file", Buffer.from(plainCsv, "utf8"), {
        filename: "questions.csv",
        contentType: "text/csv"
      });
    assert.equal(unassignedDefault.status, 403);
  });

  await t.test("teacher bulk imports JSON and structured Markdown questions", async () => {
    const jsonPayload = {
      questions: [
        {
          question: "What is 5 + 9?",
          options: ["12", "13", "14", "15"],
          correctIndex: 1,
          solution: "Add 5 and 9 to get 14, so option B is the correct answer here."
        },
        {
          question: "Which planet is known as the Red Planet?",
          options: ["Venus", "Mars", "Jupiter", "Saturn"],
          answer: "Mars",
          solution: "Mars appears red because iron oxide covers its surface, so the second option is correct."
        },
        {
          question: "Which number is prime?",
          options: ["4", "6", "8", "9"],
          answer: "A",
          solution: ""
        }
      ]
    };

    const jsonResponse = await teacherAgent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId))
      .attach("file", Buffer.from(JSON.stringify(jsonPayload), "utf8"), {
        filename: "questions.json",
        contentType: "application/json"
      });
    assert.equal(jsonResponse.status, 200);
    assert.deepEqual(jsonResponse.body.summary, { total: 3, created: 2, skipped: 0, failed: 1 });
    assert.match(jsonResponse.body.failed[0].reason, /worked solution/i);

    const markdown = [
      "## Question 1",
      "Question: Which gas do plants absorb during photosynthesis?",
      "Subject: Mathematics",
      "A. Oxygen",
      "B. Nitrogen",
      "C. Carbon dioxide",
      "D. Hydrogen",
      "Answer: C",
      "Solution: Plants take in carbon dioxide from the air and use it with sunlight to make glucose during photosynthesis.",
      "",
      "## Question 2",
      "Question: What is 8 divided by 2?",
      "Subject: Mathematics",
      "A. 2",
      "B. 4",
      "C. 6",
      "D. 8",
      "Answer: B",
      "Solution:"
    ].join("\n");

    const mdResponse = await teacherAgent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId))
      .attach("file", Buffer.from(markdown, "utf8"), {
        filename: "questions.md",
        contentType: "text/markdown"
      });
    assert.equal(mdResponse.status, 200);
    assert.deepEqual(mdResponse.body.summary, { total: 2, created: 1, skipped: 0, failed: 1 });
    assert.equal(mdResponse.body.created[0].subject, "Mathematics");

    const txt = [
      "Question: Which instrument measures temperature?",
      "Subject: Science",
      "A. Barometer",
      "B. Thermometer",
      "C. Seismograph",
      "D. Microscope",
      "Answer: Thermometer",
      "Solution: A thermometer measures temperature, so the second option is the correct choice here."
    ].join("\n");

    const txtResponse = await teacherAgent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId))
      .attach("file", Buffer.from(txt, "utf8"), {
        filename: "questions.txt",
        contentType: "text/plain"
      });
    assert.equal(txtResponse.status, 200);
    assert.equal(txtResponse.body.summary.created, 1);
    assert.equal(txtResponse.body.created[0].subject, "Science");
  });

  await t.test("teacher bulk imports XLSX question workbooks", async () => {
    const ExcelJS = require("exceljs");
    const { TEMPLATE_HEADERS } = require("../server/question-import");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Questions");
    sheet.addRow(TEMPLATE_HEADERS);
    sheet.addRow([
      "What is 6 times 4?", "20", "24", "28", "30", "B",
      "Multiply 6 by 4 to get 24, so option B is the correct answer here.", "", ""
    ]);
    sheet.addRow([
      "What is 12 divided by 3?", "2", "3", "4", "6", "C",
      "", "", ""
    ]);

    const response = await teacherAgent
      .post("/api/teacher/questions/import")
      .set(CSRF)
      .field("subjectId", String(mathsSubjectId))
      .attach("file", Buffer.from(await workbook.xlsx.writeBuffer()), {
        filename: "questions.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.summary, { total: 2, created: 1, skipped: 0, failed: 1 });
    assert.equal(response.body.created[0].question, "What is 6 times 4?");
  });

  await t.test("student sees the quiz without answer keys", async () => {
    const dashboard = await studentAgent.get("/api/student/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.quizzes.length, 1);
    assert.equal(dashboard.body.quizzes[0].title, "Numbers Check");
    assert.equal(dashboard.body.quizzes[0].bestPct, null);
  });

  await t.test("practice attempt gives feedback and scores on submit", async () => {
    const started = await studentAgent
      .post(`/api/student/quizzes/${quizId}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(started.status, 200);
    assert.equal(started.body.questions.length, 2);
    assert.equal(started.body.questions[0].subject, "Mathematics");
    assert.equal(started.body.questions[0].correctIndex, undefined);
    assert.equal(started.body.questions[0].solution, undefined);
    assert.equal(started.body.answers.length, 0);

    const resumed = await studentAgent
      .post(`/api/student/quizzes/${quizId}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.attemptId, started.body.attemptId);

    const correct = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/answer`)
      .set(CSRF)
      .send({ position: 0, chosenIndex: 1 });
    assert.equal(correct.status, 200);
    assert.equal(correct.body.feedback.isCorrect, true);
    assert.equal(correct.body.feedback.correctIndex, 1);

    const locked = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/answer`)
      .set(CSRF)
      .send({ position: 0, chosenIndex: 0 });
    assert.equal(locked.status, 409);

    const wrong = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/answer`)
      .set(CSRF)
      .send({ position: 1, chosenIndex: 0 });
    assert.equal(wrong.status, 200);
    assert.equal(wrong.body.feedback.isCorrect, false);

    const submitted = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/submit`)
      .set(CSRF)
      .send({});
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.score, 1);
    assert.equal(submitted.body.total, 2);
    assert.equal(submitted.body.pct, 50);
    practiceSubmissionId = submitted.body.submissionId;

    const repeated = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/submit`)
      .set(CSRF)
      .send({});
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.submissionId, practiceSubmissionId);

    const submission = await studentAgent.get(`/api/submissions/${practiceSubmissionId}`);
    assert.equal(submission.status, 200);
    assert.equal(submission.body.submission.questions[0].solution.length > 0, true);
    assert.equal(submission.body.submission.questions[0].isCorrect, true);
  });

  await t.test("exam attempt never reveals answers before submission", async () => {
    const started = await studentAgent
      .post(`/api/student/quizzes/${quizId}/start`)
      .set(CSRF)
      .send({ mode: "Exam" });
    assert.equal(started.status, 200);
    assert.equal(started.body.mode, "Exam");
    assert.ok(started.body.secondsRemaining > 0);
    assert.equal(started.body.questions[0].correctIndex, undefined);
    assert.equal(started.body.questions[0].solution, undefined);

    const answered = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/answer`)
      .set(CSRF)
      .send({ position: 0, chosenIndex: 1 });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.saved, true);
    assert.equal(answered.body.feedback, undefined);
    assert.equal(answered.body.correctIndex, undefined);

    const submitted = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/submit`)
      .set(CSRF)
      .send({});
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.score, 1);
    assert.equal(submitted.body.total, 2);
  });

  await t.test("teacher can inspect results and download a safe CSV", async () => {
    const results = await teacherAgent.get(`/api/teacher/quizzes/${quizId}/results`);
    assert.equal(results.status, 200);
    assert.equal(results.body.students.length, 1);
    assert.equal(results.body.students[0].attempts, 2);
    assert.equal(results.body.students[0].bestPct, 50);
    assert.equal(results.body.accuracy.length, 2);
    assert.equal(results.body.kpis.completed, 1);

    const denied = await teacher2Agent.get(`/api/teacher/quizzes/${quizId}/results`);
    assert.equal(denied.status, 404);

    const csv = await teacherAgent.get(`/api/teacher/quizzes/${quizId}/results.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.text, /Student One/);
    assert.match(csv.text, /Basic 8A - Gold/);
  });

  await t.test("teacher bootstrap exposes class grouping and quiz windows", async () => {
    const bootstrap = await teacherAgent.get("/api/teacher/bootstrap");
    assert.equal(bootstrap.status, 200);
    assert.ok(bootstrap.body.submissions.length > 0);
    assert.ok(bootstrap.body.submissions.every(item => "classId" in item));
    assert.ok(bootstrap.body.submissions.some(item => Number(item.classId) === Number(classId)));
    assert.ok(bootstrap.body.quizzes.every(item => "startAt" in item && "endAt" in item));
  });

  await t.test("submission access is scoped to owner, teacher and admin", async () => {
    const teacherReads = await teacherAgent.get(`/api/submissions/${practiceSubmissionId}`);
    assert.equal(teacherReads.status, 200);
    const adminReads = await adminAgent.get(`/api/submissions/${practiceSubmissionId}`);
    assert.equal(adminReads.status, 200);
    const otherTeacherReads = await teacher2Agent.get(`/api/submissions/${practiceSubmissionId}`);
    assert.equal(otherTeacherReads.status, 403);
  });

  await t.test("a class with students or quizzes cannot be deleted", async () => {
    const response = await adminAgent
      .delete(`/api/admin/classes/${classId}`)
      .set(CSRF);
    assert.equal(response.status, 409);
    assert.match(response.body.error, /Cannot delete/);
  });

  await t.test("archiving a quiz preserves submissions but hides it", async () => {
    const archived = await teacherAgent
      .delete(`/api/teacher/quizzes/${quizId}`)
      .set(CSRF);
    assert.equal(archived.status, 200);

    const dashboard = await studentAgent.get("/api/student/dashboard");
    assert.equal(dashboard.body.quizzes.length, 0);

    const results = await teacherAgent.get(`/api/teacher/quizzes/${quizId}/results`);
    assert.equal(results.status, 404);

    const keptSubmissions = await listWhere("submissions", "quiz_id", quizId);
    assert.equal(keptSubmissions.length, 2);

    const start = await studentAgent
      .post(`/api/student/quizzes/${quizId}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(start.status, 404);
  });

  await t.test("lockout blocks guessing and admin reset clears it", async () => {
    const student2 = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Student Two", username: "student.two", role: "student", classId });
    assert.equal(student2.status, 201);
    student2Id = student2.body.user.id;
    student2TempPassword = student2.body.temporaryPassword;

    const roster = await teacherAgent.get("/api/teacher/students");
    assert.equal(roster.status, 200);
    assert.ok(roster.body.students.some(student => student.id === student2Id));

    // A teacher can only manage classes they own a quiz for: moving the
    // student into a class they do not teach must be rejected.
    const deniedMove = await teacherAgent
      .patch(`/api/teacher/students/${student2Id}`)
      .set(CSRF)
      .send({ classId: secondClassId });
    assert.equal(deniedMove.status, 403);

    const secondQuiz = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Second Class Check",
        classId: secondClassId,
        subjectId: mathsSubjectId,
        minutes: 20,
        questionIds: [firstQuestionId, secondQuestionId]
      });
    assert.equal(secondQuiz.status, 201);

    const moved = await teacherAgent
      .patch(`/api/teacher/students/${student2Id}`)
      .set(CSRF)
      .send({ classId: secondClassId });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.student.className, "Basic 8B");

    const movedBack = await teacherAgent
      .patch(`/api/teacher/students/${student2Id}`)
      .set(CSRF)
      .send({ classId });
    assert.equal(movedBack.status, 200);
    assert.equal(movedBack.body.student.className, "Basic 8A - Gold");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { response } = await login("student.two", `WrongPass${attempt}9`);
      assert.equal(response.status, 401);
    }

    const locked = await login("student.two", student2TempPassword);
    assert.equal(locked.response.status, 429);

    const reset = await adminAgent
      .post(`/api/admin/users/${student2Id}/reset-password`)
      .set(CSRF)
      .send({});
    assert.equal(reset.status, 200);
    assert.ok(reset.body.temporaryPassword.length >= 10);

    const unlocked = await login("student.two", reset.body.temporaryPassword);
    assert.equal(unlocked.response.status, 200);
    assert.equal(unlocked.response.body.user.mustChangePassword, true);

    const suspended = await adminAgent
      .patch(`/api/admin/users/${student2Id}`)
      .set(CSRF)
      .send({ active: false });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.user.active, false);

    const stillSignedIn = await unlocked.agent.get("/api/auth/me");
    assert.equal(stillSignedIn.status, 401);

    const blocked = await login("student.two", reset.body.temporaryPassword);
    assert.equal(blocked.response.status, 401);

    const reactivated = await adminAgent
      .patch(`/api/admin/users/${student2Id}`)
      .set(CSRF)
      .send({ active: true });
    assert.equal(reactivated.status, 200);
  });

  await t.test("teacher announcements reach students and are owner-deletable", async () => {
    const posted = await teacherAgent
      .post("/api/teacher/announcements")
      .set(CSRF)
      .send({ text: "Bring your calculators tomorrow." });
    assert.equal(posted.status, 201);

    const dashboard = await studentAgent.get("/api/student/dashboard");
    assert.ok(dashboard.body.announcements.some(item => item.text.includes("calculators")));

    const denied = await teacher2Agent
      .delete(`/api/teacher/announcements/${posted.body.announcement.id}`)
      .set(CSRF);
    assert.equal(denied.status, 403);

    const deleted = await teacherAgent
      .delete(`/api/teacher/announcements/${posted.body.announcement.id}`)
      .set(CSRF);
    assert.equal(deleted.status, 200);
  });

  await t.test("admin settings update is visible to teachers", async () => {
    const updated = await adminAgent
      .put("/api/admin/settings")
      .set(CSRF)
      .send({
        defaultQuizMinutes: 30,
        minQuizMinutes: 5,
        maxQuizMinutes: 120,
        minQuestions: 2,
        maxQuestions: 50,
        passMark: 60,
        maxAttempts: 3,
        requireApproval: false,
        showSolutions: true,
        allowRetakes: true
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.settings.passMark, 60);
    assert.equal(updated.body.settings.maxAttempts, 3);

    const bootstrap = await teacherAgent.get("/api/teacher/bootstrap");
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.settings.defaultQuizMinutes, 30);
    assert.equal(bootstrap.body.settings.minQuizMinutes, 5);

    await adminAgent
      .put("/api/admin/settings")
      .set(CSRF)
      .send({
        defaultQuizMinutes: 45,
        minQuizMinutes: 1,
        maxQuizMinutes: 240,
        minQuestions: 1,
        maxQuestions: 200,
        passMark: 50,
        maxAttempts: 0,
        requireApproval: false,
        showSolutions: true,
        allowRetakes: true
      });
  });

  await t.test("weak passwords are rejected", async () => {
    const response = await studentAgent
      .post("/api/auth/change-password")
      .set(CSRF)
      .send({ currentPassword: "StudentPass1234", newPassword: "short" });
    assert.equal(response.status, 400);
  });

  await t.test("admin deletes unused accounts but preserves accounts with history", async () => {
    const created = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Delete Me", username: "delete.me", role: "student", classId });
    assert.equal(created.status, 201);

    const removed = await adminAgent
      .delete(`/api/admin/users/${created.body.user.id}`)
      .set(CSRF);
    assert.equal(removed.status, 200);

    const deletedUser = await findUserByUsername("delete.me");
    assert.equal(deletedUser, null);

    const studentRow = await findUserByUsername("student.one");
    const blocked = await adminAgent
      .delete(`/api/admin/users/${studentRow.id}`)
      .set(CSRF);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Cannot delete/);
  });

  await t.test("admin can rename a student without changing the username", async () => {
    const created = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Rename Me", username: "rename.me", role: "student", classId });
    assert.equal(created.status, 201);

    const renamed = await adminAgent
      .patch(`/api/admin/users/${created.body.user.id}`)
      .set(CSRF)
      .send({ name: "Renamed Student" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.name, "Renamed Student");
    assert.equal(renamed.body.user.username, "rename.me");

    const removed = await adminAgent
      .delete(`/api/admin/users/${created.body.user.id}`)
      .set(CSRF);
    assert.equal(removed.status, 200);
  });

  await t.test("creating a quiz with shuffleQuestions=true stores the flag", async () => {
    const created = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Shuffle Quiz",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        shuffleQuestions: true,
        questionIds: [firstQuestionId]
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.shuffleQuestions, true);
    assert.equal(created.body.quiz.shuffleQuestions, true);
  });

  await t.test("patching a quiz toggles its shuffle setting and rewrites question order", async () => {
    const created = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Shuffle Quiz",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        shuffleQuestions: true,
        questionIds: [firstQuestionId, secondQuestionId]
      });
    assert.equal(created.status, 201);

    const started = await studentAgent
      .post(`/api/student/quizzes/${created.body.quiz.id}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(started.status, 200);

    const patched = await teacherAgent
      .patch(`/api/teacher/quizzes/${created.body.quiz.id}`)
      .set(CSRF)
      .send({ shuffleQuestions: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.shuffleQuestions, false);

    const attempt = await getDocById("attempts", started.body.attemptId);
    assert.deepEqual(attempt.question_order, [0, 1]);
  });

  await t.test("admin approval controls student quiz visibility", async () => {
    await adminAgent
      .put("/api/admin/settings")
      .set(CSRF)
      .send({ requireApproval: true });

    const created = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Approval Quiz",
        classId,
        subjectId: mathsSubjectId,
        minutes: 20,
        questionIds: [firstQuestionId]
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.quiz.approved, false);

    const before = await studentAgent.get("/api/student/dashboard");
    assert.equal(before.status, 200);
    assert.equal(before.body.quizzes.some(quiz => quiz.id === created.body.quiz.id), false);

    const approved = await adminAgent
      .patch(`/api/admin/quizzes/${created.body.quiz.id}`)
      .set(CSRF)
      .send({ approved: true, isOpen: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.quiz.approved, true);

    const after = await studentAgent.get("/api/student/dashboard");
    assert.ok(after.body.quizzes.some(quiz => quiz.id === created.body.quiz.id));

    const blocked = await studentAgent
      .post(`/api/student/quizzes/${created.body.quiz.id}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(blocked.status, 200);

    await adminAgent
      .put("/api/admin/settings")
      .set(CSRF)
      .send({ requireApproval: false });
  });

  await t.test("admin can hide worked solutions from students", async () => {
    await adminAgent
      .put("/api/admin/settings")
      .set(CSRF)
      .send({ showSolutions: false });

    const hidden = await studentAgent.get(`/api/submissions/${practiceSubmissionId}`);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.submission.questions[0].correctIndex, undefined);
    assert.equal(hidden.body.submission.questions[0].solution, undefined);
    assert.equal(hidden.body.submission.questions[0].isCorrect, undefined);

    const teacherView = await teacherAgent.get(`/api/submissions/${practiceSubmissionId}`);
    assert.equal(teacherView.body.submission.questions[0].correctIndex, 1);
    assert.equal(teacherView.body.submission.questions[0].isCorrect, true);

    await adminAgent
      .put("/api/admin/settings")
      .set(CSRF)
      .send({ showSolutions: true });
  });

  await t.test("importStudentsFromWorkbook parses rows from an Excel workbook buffer", async () => {
    const ExcelJS = require("exceljs");
    const { importStudentsFromWorkbook, ExcelInputError } = require("../server/student-import");
    const { readStudentRows, TEMPLATE_HEADERS } = require("../server/excel");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Students");
    sheet.addRow(TEMPLATE_HEADERS);
    sheet.addRow(["Ada", "Lovelace", "Basic 8A - Gold", "AdaLovelace"]);
    sheet.addRow(["Grace", "Hopper", "Basic 8A - Gold", "GraceHopper"]);
    sheet.addRow(["Alan", "Turing", "Nope", "Alanturing"]);

    const buffer = await workbook.xlsx.writeBuffer();
    const result = await importStudentsFromWorkbook(buffer, "tester");
    assert.strictEqual(result.summary.created, 2);
    assert.strictEqual(result.summary.skipped, 0);
    assert.strictEqual(result.summary.failed, 1);
    assert.ok(result.created.length >= 2);
    assert.equal(typeof ExcelInputError, "function");
    assert.equal(typeof readStudentRows, "function");
  });

  await t.test("empty or missing buffer throws ExcelInputError", async () => {
    const { readStudentRows, ExcelInputError } = require("../server/excel");
    await assert.rejects(() => readStudentRows(null), ExcelInputError);
    await assert.rejects(() => readStudentRows(undefined), ExcelInputError);
  });

  await t.test("admin search finds accounts and classes by name", async () => {
    const created = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Searchable Student", username: "search.student", role: "student", classId });
    assert.equal(created.status, 201);

    const byName = await adminAgent.get("/api/admin/search?q=searchable");
    assert.equal(byName.status, 200);
    assert.ok(byName.body.users.some(user => user.id === created.body.user.id));
    assert.equal(byName.body.users[0].className, "Basic 8A - Gold");

    const byClass = await adminAgent.get(`/api/admin/search?classId=${classId}`);
    assert.ok(byClass.body.users.every(user => Number(user.classId) === Number(classId)));

    const byClassName = await adminAgent.get("/api/admin/search?q=Basic%208B");
    assert.ok(byClassName.body.classes.some(cls => cls.id === secondClassId));
  });

  await t.test("admin manages a class as a batch of students", async () => {
    const created = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Batch Student", username: "batch.student", role: "student", classId });
    assert.equal(created.status, 201);
    const studentId = created.body.user.id;

    const added = await adminAgent
      .post(`/api/admin/classes/${secondClassId}/members`)
      .set(CSRF)
      .send({ userIds: [studentId] });
    assert.equal(added.status, 200);
    assert.equal(added.body.count, 1);

    const moved = await getDocById("users", studentId);
    assert.equal(Number(moved.class_id), Number(secondClassId));

    const rejected = await adminAgent
      .post(`/api/admin/classes/${secondClassId}/members`)
      .set(CSRF)
      .send({ userIds: [teacher1Id] });
    assert.equal(rejected.status, 400);

    const removed = await adminAgent
      .delete(`/api/admin/classes/${secondClassId}/members/${studentId}`)
      .set(CSRF);
    assert.equal(removed.status, 200);
    const unassigned = await getDocById("users", studentId);
    assert.equal(unassigned.class_id, null);
  });

  await t.test("teachers and students submit complaints that only they and admin can read", async () => {
    const fromTeacher = await teacherAgent
      .post("/api/complaints")
      .set(CSRF)
      .send({
        subject: "Broken projector",
        category: "facility",
        message: "The projector in the exam hall is not working."
      });
    assert.equal(fromTeacher.status, 201);
    assert.equal(fromTeacher.body.complaint.senderRole, "teacher");
    assert.equal(fromTeacher.body.complaint.status, "open");
    const teacherComplaintId = fromTeacher.body.complaint.id;

    const fromStudent = await studentAgent
      .post("/api/complaints")
      .set(CSRF)
      .send({
        subject: "Quiz did not load",
        category: "technical",
        message: "I clicked start but the quiz stayed blank on my phone."
      });
    assert.equal(fromStudent.status, 201);
    assert.equal(fromStudent.body.complaint.senderRole, "student");
    assert.equal(fromStudent.body.complaint.senderClassName, "Basic 8A - Gold");
    const studentComplaintId = fromStudent.body.complaint.id;

    const teacherList = await teacherAgent.get("/api/complaints");
    assert.equal(teacherList.status, 200);
    assert.ok(teacherList.body.complaints.every(item => item.id === teacherComplaintId));

    const studentList = await studentAgent.get("/api/complaints");
    assert.deepEqual(studentList.body.complaints.map(item => item.id), [studentComplaintId]);

    const otherStudent = await adminAgent.get(`/api/complaints/${teacherComplaintId}`);
    assert.equal(otherStudent.status, 200);

    const deniedRead = await studentAgent.get(`/api/complaints/${teacherComplaintId}`);
    assert.equal(deniedRead.status, 404);

    const deniedCreate = await adminAgent
      .post("/api/complaints")
      .set(CSRF)
      .send({ subject: "Admin note", message: "Admins reply instead of complaining." });
    assert.equal(deniedCreate.status, 403);

    const deniedReply = await teacherAgent
      .post(`/api/complaints/${studentComplaintId}/replies`)
      .set(CSRF)
      .send({ message: "I cannot reply as a teacher." });
    assert.equal(deniedReply.status, 403);

    const filtered = await adminAgent.get("/api/complaints?role=student&q=quiz");
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.complaints.map(item => item.id), [studentComplaintId]);

    const replied = await adminAgent
      .post(`/api/complaints/${studentComplaintId}/replies`)
      .set(CSRF)
      .send({ message: "We fixed the quiz. Please try again." });
    assert.equal(replied.status, 201);
    assert.equal(replied.body.complaint.status, "replied");
    assert.equal(replied.body.complaint.replies.length, 1);

    const studentAfterReply = await studentAgent.get(`/api/complaints/${studentComplaintId}`);
    assert.equal(studentAfterReply.body.complaint.replies[0].message, "We fixed the quiz. Please try again.");

    const closed = await adminAgent
      .patch(`/api/complaints/${studentComplaintId}/status`)
      .set(CSRF)
      .send({ status: "closed" });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.complaint.status, "closed");

    const onlyOpen = await adminAgent.get("/api/complaints?status=open");
    assert.ok(onlyOpen.body.complaints.every(item => item.status === "open"));
  });

  await t.test("idle sessions expose settings and expire after inactivity", async () => {
    const username = "idle.check";
    const password = "IdlePass1234";
    const idleUserId = await createUser({
      name: "Idle Checker",
      username,
      password,
      role: "teacher",
      subjectIds: [generalSubjectId]
    });
    const { agent, response } = await login(username, password);
    assert.equal(response.status, 200);

    const settings = await agent.get("/api/auth/session");
    assert.equal(settings.status, 200);
    assert.equal(settings.body.idleTimeoutSeconds, 60);
    assert.equal(settings.body.warningSeconds, 15);
    assert.equal(settings.body.heartbeatSeconds, 15);
    assert.ok(settings.body.expiresAt);

    await updateDocById("users", idleUserId, {
      last_activity_at: new Date(Date.now() - 30000)
    });

    const activity = await agent.post("/api/auth/activity").set(CSRF).send({});
    assert.equal(activity.status, 200);
    assert.equal(activity.body.ok, true);
    const touched = await getDocById("users", idleUserId);
    assert.ok(touched.last_activity_at instanceof Date);
    assert.ok(Date.now() - touched.last_activity_at.getTime() < 5000);

    const meBeforeExpiry = await agent.get("/api/auth/me");
    assert.equal(meBeforeExpiry.status, 200);

    await updateDocById("users", idleUserId, {
      last_activity_at: new Date(Date.now() - 2 * 60 * 1000)
    });

    const meAfterExpiry = await agent.get("/api/auth/me");
    assert.equal(meAfterExpiry.status, 401);
    assert.equal(meAfterExpiry.body.code, "SESSION_EXPIRED");
  });

  await t.test("student leaderboard defaults to this week's exam standings", async () => {
    const leaderboard = await studentAgent.get("/api/student/leaderboard");
    assert.equal(leaderboard.status, 200);
    assert.equal(leaderboard.body.period.key, "week");
    assert.ok(leaderboard.body.leaderboard.length > 0);

    const ranks = leaderboard.body.leaderboard.map(row => row.rank);
    const ranked = ranks.filter(rank => rank !== null);
    assert.deepEqual(ranked, [...ranked].sort((a, b) => a - b));
    const firstUnranked = ranks.indexOf(null);
    assert.ok(firstUnranked === -1 || ranks.slice(firstUnranked).every(rank => rank === null));
    assert.ok(leaderboard.body.leaderboard.every(row => typeof row.points === "number"));

    const allTime = await studentAgent.get("/api/student/leaderboard?period=all");
    assert.equal(allTime.status, 200);
    assert.equal(allTime.body.period.key, "all");
    assert.equal(allTime.body.period.start, null);

    const invalid = await studentAgent.get("/api/student/leaderboard?period=today");
    assert.equal(invalid.status, 400);

    const anonymous = await request(app).get("/api/student/leaderboard");
    assert.equal(anonymous.status, 401);
  });

  await t.test("admins and teachers can view class leaderboards within their scope", async () => {
    const outside = await adminAgent
      .post("/api/admin/classes")
      .set(CSRF)
      .send({ name: "Leaderboard Outside" });
    assert.equal(outside.status, 201);
    const outsideId = outside.body.class.id;

    const teacherView = await teacherAgent.get("/api/leaderboard");
    assert.equal(teacherView.status, 200);
    assert.equal(Number(teacherView.body.class.id), Number(classId));
    assert.ok(teacherView.body.classes.length >= 2);
    assert.equal(teacherView.body.you, null);

    const denied = await teacherAgent.get(`/api/leaderboard?classId=${outsideId}`);
    assert.equal(denied.status, 403);

    const adminView = await adminAgent.get(`/api/leaderboard?classId=${outsideId}`);
    assert.equal(adminView.status, 200);
    assert.equal(Number(adminView.body.class.id), Number(outsideId));
    assert.equal(adminView.body.leaderboard.length, 0);

    const unscopedTeacher = await teacher2Agent.get("/api/leaderboard");
    assert.equal(unscopedTeacher.status, 200);
    assert.equal(unscopedTeacher.body.class, null);
    assert.deepEqual(unscopedTeacher.body.classes, []);

    const studentBlocked = await studentAgent.get("/api/leaderboard");
    assert.equal(studentBlocked.status, 403);
    const anonymous = await request(app).get("/api/leaderboard");
    assert.equal(anonymous.status, 401);
  });

  await t.test("leaderboard scores only exams in the selected UTC period", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const createdClass = await adminAgent
      .post("/api/admin/classes")
      .set(CSRF)
      .send({ name: "Leaderboard Period Lab" });
    assert.equal(createdClass.status, 201);
    const periodClassId = createdClass.body.class.id;

    const examStudentId = await insertDoc("users", {
      name: "Period Exam",
      username: "period.exam",
      password_hash: "",
      role: "student",
      class_id: periodClassId,
      subject_ids: [],
      active: true,
      must_change_password: false,
      token_version: 0,
      created_at: new Date()
    });
    const practiceStudentId = await insertDoc("users", {
      name: "Period Practice",
      username: "period.practice",
      password_hash: "",
      role: "student",
      class_id: periodClassId,
      subject_ids: [],
      active: true,
      must_change_password: false,
      token_version: 0,
      created_at: new Date()
    });

    const quizIds = [];
    for (const title of ["Period This Week", "Period Last Week", "Period Older"]) {
      quizIds.push(await insertDoc("quizzes", {
        title,
        class_id: periodClassId,
        teacher_id: teacher1Id,
        subject_id: mathsSubjectId,
        minutes: 10,
        is_open: true,
        is_deleted: false,
        created_at: new Date()
      }));
    }

    const now = new Date();
    const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    thisMonday.setUTCDate(thisMonday.getUTCDate() - ((thisMonday.getUTCDay() + 6) % 7));
    const lastMonday = new Date(thisMonday.getTime() - 7 * dayMs);
    const olderMonday = new Date(lastMonday.getTime() - 7 * dayMs);
    const midweek = monday => new Date(monday.getTime() + dayMs + 60 * 60 * 1000);

    const addSubmission = (studentId, quizIndex, mode, pct, submittedAt) => insertDoc("submissions", {
      quiz_id: quizIds[quizIndex],
      class_id: periodClassId,
      student_id: studentId,
      mode,
      pct,
      submitted_at: submittedAt,
      created_at: submittedAt
    });

    await addSubmission(examStudentId, 0, "Exam", 80, new Date());
    await addSubmission(examStudentId, 1, "Exam", 70, midweek(lastMonday));
    await addSubmission(examStudentId, 2, "Exam", 60, midweek(olderMonday));
    await addSubmission(examStudentId, 0, "Practice", 100, new Date());
    await addSubmission(practiceStudentId, 0, "Practice", 100, new Date());
    await addSubmission(practiceStudentId, 1, "Practice", 100, midweek(lastMonday));
    await addSubmission(practiceStudentId, 2, "Practice", 100, midweek(olderMonday));

    const fetchPeriod = async period => {
      const suffix = period ? `&period=${period}` : "";
      const response = await adminAgent.get(`/api/leaderboard?classId=${periodClassId}${suffix}`);
      assert.equal(response.status, 200);
      return response.body;
    };
    const rowFor = (body, studentId) =>
      body.leaderboard.find(row => Number(row.studentId) === Number(studentId));

    const week = await fetchPeriod();
    assert.equal(week.period.key, "week");
    const weekStart = new Date(week.period.start);
    assert.equal(weekStart.getUTCDay(), 1);
    assert.equal(weekStart.getUTCHours(), 0);
    assert.equal(weekStart.getUTCMinutes(), 0);
    assert.equal(week.leaderboard.length, 2);

    const weekExam = rowFor(week, examStudentId);
    const weekPractice = rowFor(week, practiceStudentId);
    assert.equal(weekExam.rank, 1);
    assert.equal(weekExam.points, 80);
    assert.equal(weekExam.quizzesTaken, 1);
    assert.equal(weekExam.averagePct, 80);
    assert.equal(weekPractice.rank, null);
    assert.equal(weekPractice.points, 0);
    assert.equal(weekPractice.quizzesTaken, 0);
    assert.equal(week.leaderboard[0].studentId, examStudentId);

    const lastWeek = await fetchPeriod("last-week");
    assert.equal(lastWeek.period.key, "last-week");
    assert.equal(new Date(lastWeek.period.start).getTime(), weekStart.getTime() - 7 * dayMs);
    const lastWeekExam = rowFor(lastWeek, examStudentId);
    const lastWeekPractice = rowFor(lastWeek, practiceStudentId);
    assert.equal(lastWeekExam.rank, 1);
    assert.equal(lastWeekExam.points, 70);
    assert.equal(lastWeekPractice.rank, null);
    assert.equal(lastWeekPractice.points, 0);

    const allTime = await fetchPeriod("all");
    assert.equal(allTime.period.key, "all");
    assert.equal(allTime.period.start, null);
    assert.equal(allTime.period.end, null);
    assert.equal(allTime.quizCount, 3);
    const allTimeExam = rowFor(allTime, examStudentId);
    const allTimePractice = rowFor(allTime, practiceStudentId);
    assert.equal(allTimeExam.rank, 1);
    assert.equal(allTimeExam.points, 210);
    assert.equal(allTimeExam.quizzesTaken, 3);
    assert.equal(allTimeExam.averagePct, 70);
    assert.equal(allTimePractice.rank, null);
    assert.equal(allTimePractice.points, 0);

    const invalidStaffPeriod = await adminAgent
      .get(`/api/leaderboard?classId=${periodClassId}&period=today`);
    assert.equal(invalidStaffPeriod.status, 400);
  });

  await t.test("student rewards derive XP, level, streak and badges from submissions", async () => {
    const progress = await studentAgent.get("/api/student/progress");
    assert.equal(progress.status, 200);
    assert.ok(progress.body.level.xp > 0);
    assert.equal(typeof progress.body.level.number, "number");
    assert.ok(progress.body.level.xpToNext >= 0);
    assert.ok(Array.isArray(progress.body.badges));
    assert.ok(progress.body.badges.some(item => item.id === "first-steps" && item.earned));
    assert.ok(progress.body.badgesEarned >= 1);
    assert.equal(typeof progress.body.streak.current, "number");
    assert.ok(progress.body.classGoal, "class quest should be present for a classed student");
    assert.equal(typeof progress.body.classGoal.average, "number");
    assert.ok(progress.body.classGoal.target >= 70);
    assert.ok(Array.isArray(progress.body.classGoal.milestones));
    assert.equal(typeof progress.body.classGoal.myContribution.attempts, "number");

    const anonymous = await request(app).get("/api/student/progress");
    assert.equal(anonymous.status, 401);
  });

  await t.test("teacher and admin can switch practice mode for a quiz", async () => {
    const created = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Practice Toggle Check",
        classId,
        subjectId: mathsSubjectId,
        minutes: 10,
        questionIds: [firstQuestionId]
      });
    assert.equal(created.status, 201);
    const practiceQuizId = created.body.quiz.id;

    const teacherPatch = await teacherAgent
      .patch(`/api/teacher/quizzes/${practiceQuizId}`)
      .set(CSRF)
      .send({ allowPractice: false });
    assert.equal(teacherPatch.status, 200);
    assert.equal(teacherPatch.body.allowPractice, false);
    assert.equal(teacherPatch.body.quiz.allowPractice, false);

    const deniedForOtherTeacher = await teacher2Agent
      .patch(`/api/teacher/quizzes/${practiceQuizId}`)
      .set(CSRF)
      .send({ allowPractice: true });
    assert.equal(deniedForOtherTeacher.status, 404);

    const dashboard = await studentAgent.get("/api/student/dashboard");
    assert.equal(dashboard.status, 200);
    const shownQuiz = dashboard.body.quizzes.find(item => Number(item.id) === Number(practiceQuizId));
    assert.equal(shownQuiz.allowPractice, false);

    const blocked = await studentAgent
      .post(`/api/student/quizzes/${practiceQuizId}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /Practice is disabled/);

    const adminPatch = await adminAgent
      .patch(`/api/admin/quizzes/${practiceQuizId}`)
      .set(CSRF)
      .send({ allowPractice: true });
    assert.equal(adminPatch.status, 200);
    assert.equal(adminPatch.body.quiz.allowPractice, true);

    const started = await studentAgent
      .post(`/api/student/quizzes/${practiceQuizId}/start`)
      .set(CSRF)
      .send({ mode: "Practice" });
    assert.equal(started.status, 200);
    assert.equal(started.body.mode, "Practice");
  });

  await t.test("teachers can delete selected bank questions without changing published quizzes", async () => {
    const createQuestion = async (questionText, solution) => {
      const created = await teacherAgent
        .post("/api/teacher/questions")
        .set(CSRF)
        .send({
          questionText,
          subjectId: mathsSubjectId,
          options: ["24", "25", "26", "27"],
          correctIndex: 1,
          solution
        });
      assert.equal(created.status, 201);
      return created.body.question.id;
    };

    const first = await createQuestion("What is 18 plus 7?", "Add 18 and 7 to get 25.");
    const second = await createQuestion("What is 9 plus 16?", "Add 9 and 16 to get 25.");
    const kept = await createQuestion("What is 40 minus 12?", "Subtract 12 from 40 to get 28.");

    const quiz = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Bank Copy Check",
        classId,
        subjectId: mathsSubjectId,
        minutes: 10,
        questionIds: [kept]
      });
    assert.equal(quiz.status, 201);
    const copyQuizId = quiz.body.quiz.id;
    const itemsBefore = await countQuizItems(copyQuizId);
    assert.equal(itemsBefore, 1);

    const denied = await teacher2Agent
      .delete("/api/teacher/questions")
      .set(CSRF)
      .send({ ids: [first] });
    assert.equal(denied.status, 403);

    const empty = await teacherAgent
      .delete("/api/teacher/questions")
      .set(CSRF)
      .send({ ids: [] });
    assert.equal(empty.status, 400);

    const missing = await teacherAgent
      .delete("/api/teacher/questions")
      .set(CSRF)
      .send({ ids: [first, 999999] });
    assert.equal(missing.status, 404);
    assert.ok(await getDocById("questions", first));

    const deleted = await teacherAgent
      .delete("/api/teacher/questions")
      .set(CSRF)
      .send({ ids: [first, second] });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { ok: true, deleted: 2 });
    assert.equal(await getDocById("questions", first), null);
    assert.equal(await getDocById("questions", second), null);
    assert.ok(await getDocById("questions", kept));
    assert.equal(await countQuizItems(copyQuizId), itemsBefore);

    const bootstrap = await teacherAgent.get("/api/teacher/bootstrap");
    assert.equal(bootstrap.status, 200);
    const questionIds = bootstrap.body.questions.map(item => Number(item.id));
    assert.ok(!questionIds.includes(Number(first)));
    assert.ok(!questionIds.includes(Number(second)));
    assert.ok(questionIds.includes(Number(kept)));
  });

  await t.test("deleting a quiz keeps its copied questions and stored submissions", async () => {
    const created = await teacherAgent
      .post("/api/teacher/questions")
      .set(CSRF)
      .send({
        questionText: "What is 11 plus 4?",
        subjectId: mathsSubjectId,
        options: ["14", "15", "16", "17"],
        correctIndex: 1,
        solution: "Add 11 and 4 to get 15."
      });
    assert.equal(created.status, 201);
    const questionId = created.body.question.id;

    const quiz = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Deletion Check",
        classId,
        subjectId: mathsSubjectId,
        minutes: 10,
        questionIds: [questionId]
      });
    assert.equal(quiz.status, 201);
    const deleteQuizId = quiz.body.quiz.id;
    const itemsBefore = await countQuizItems(deleteQuizId);
    assert.equal(itemsBefore, 1);

    const started = await studentAgent
      .post(`/api/student/quizzes/${deleteQuizId}/start`)
      .set(CSRF)
      .send({ mode: "Exam" });
    assert.equal(started.status, 200);

    const answered = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/answer`)
      .set(CSRF)
      .send({ position: 0, chosenIndex: 1 });
    assert.equal(answered.status, 200);

    const submitted = await studentAgent
      .post(`/api/student/attempts/${started.body.attemptId}/submit`)
      .set(CSRF)
      .send({});
    assert.equal(submitted.status, 201);
    const submissionId = submitted.body.submissionId;

    const deleted = await teacherAgent
      .delete(`/api/teacher/quizzes/${deleteQuizId}`)
      .set(CSRF);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { ok: true, deleted: true });

    const stored = await getDocById("quizzes", deleteQuizId);
    assert.equal(stored.is_deleted, true);
    assert.equal(stored.is_open, false);
    assert.equal(await countQuizItems(deleteQuizId), itemsBefore);

    const submission = await studentAgent.get(`/api/submissions/${submissionId}`);
    assert.equal(submission.status, 200);

    const dashboard = await studentAgent.get("/api/student/dashboard");
    assert.equal(dashboard.status, 200);
    assert.ok(!dashboard.body.quizzes.some(item => Number(item.id) === Number(deleteQuizId)));

    const results = await teacherAgent.get(`/api/teacher/quizzes/${deleteQuizId}/results`);
    assert.equal(results.status, 404);
  });

  await t.test("learning materials are class-scoped and soft-deleted", async () => {
    const outsideClass = await adminAgent
      .post("/api/admin/classes")
      .set(CSRF)
      .send({ name: "Materials Outside Scope" });
    assert.equal(outsideClass.status, 201);
    const outsideClassId = outsideClass.body.class.id;

    const adminLink = await adminAgent
      .post("/api/materials")
      .set(CSRF)
      .send({
        title: "Exam revision video",
        description: "A short recap before the test.",
        kind: "link",
        fileType: "video",
        subjectId: mathsSubjectId,
        classIds: [classId],
        linkUrl: "https://example.com/lesson"
      });
    assert.equal(adminLink.status, 201);
    const adminMaterialId = adminLink.body.material.id;

    const teacherLink = await teacherAgent
      .post("/api/materials")
      .set(CSRF)
      .send({
        title: "Week 1 slides",
        description: "Introduction slides.",
        kind: "link",
        fileType: "slides",
        subjectId: scienceSubjectId,
        classIds: [classId],
        linkUrl: "https://example.com/slides"
      });
    assert.equal(teacherLink.status, 201);
    const teacherMaterialId = teacherLink.body.material.id;

    const outOfScope = await teacherAgent
      .post("/api/materials")
      .set(CSRF)
      .send({
        title: "Other class notes",
        kind: "link",
        fileType: "link",
        classIds: [outsideClassId],
        linkUrl: "https://example.com/private"
      });
    assert.equal(outOfScope.status, 403);

    const unsafeLink = await adminAgent
      .post("/api/materials")
      .set(CSRF)
      .send({
        title: "Unsafe link",
        kind: "link",
        fileType: "link",
        classIds: [classId],
        linkUrl: "javascript:alert(1)"
      });
    assert.equal(unsafeLink.status, 400);

    const anonymous = await request(app).get("/api/materials");
    assert.equal(anonymous.status, 401);

    const studentBlocked = await studentAgent
      .post("/api/materials")
      .set(CSRF)
      .send({
        title: "Student upload",
        kind: "link",
        fileType: "link",
        classIds: [classId],
        linkUrl: "https://example.com/student"
      });
    assert.equal(studentBlocked.status, 403);

    const studentList = await studentAgent.get("/api/materials");
    assert.equal(studentList.status, 200);
    assert.equal(studentList.body.canManage, false);
    assert.equal(studentList.body.materials.length, 2);
    assert.ok(studentList.body.materials.every(item => item.classIds.includes(classId)));
    assert.ok(studentList.body.materials.some(item => item.url === "https://example.com/lesson"));

    const videoOnly = await studentAgent.get("/api/materials?type=video");
    assert.equal(videoOnly.status, 200);
    assert.equal(videoOnly.body.materials.length, 1);
    assert.equal(videoOnly.body.materials[0].id, adminMaterialId);

    const otherClassMaterial = await adminAgent
      .post("/api/materials")
      .set(CSRF)
      .send({
        title: "Second class only",
        kind: "link",
        fileType: "link",
        classIds: [outsideClassId],
        linkUrl: "https://example.com/second"
      });
    assert.equal(otherClassMaterial.status, 201);
    const otherMaterialId = otherClassMaterial.body.material.id;

    const otherClassList = await studentAgent.get(`/api/materials?classId=${outsideClassId}`);
    assert.equal(otherClassList.status, 200);
    assert.equal(otherClassList.body.materials.length, 0);

    const beforeView = await getDocById("materials", teacherMaterialId);
    const viewed = await studentAgent
      .post(`/api/materials/${teacherMaterialId}/view`)
      .set(CSRF)
      .send({});
    assert.equal(viewed.status, 200);
    const afterView = await getDocById("materials", teacherMaterialId);
    assert.equal(Number(afterView.views), Number(beforeView.views || 0) + 1);

    const foreignView = await studentAgent
      .post(`/api/materials/${otherMaterialId}/view`)
      .set(CSRF)
      .send({});
    assert.equal(foreignView.status, 403);

    const removed = await teacherAgent
      .delete(`/api/materials/${teacherMaterialId}`)
      .set(CSRF);
    assert.equal(removed.status, 200);
    const stored = await getDocById("materials", teacherMaterialId);
    assert.ok(stored.deleted_at instanceof Date);

    const staffList = await teacherAgent.get("/api/materials");
    assert.equal(staffList.body.canManage, true);
    assert.ok(!staffList.body.materials.some(item => item.id === teacherMaterialId));

    const uploadUrl = await teacherAgent
      .post("/api/materials/upload-url")
      .set(CSRF)
      .send({
        fileName: "notes.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        classIds: [classId]
      });
    assert.equal(uploadUrl.status, 503);
  });
});
