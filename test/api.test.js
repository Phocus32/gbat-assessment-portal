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
  setSetting,
  close
} = require("../server/fdb");
const { hashPassword } = require("../server/security");

const CSRF = { "X-Requested-With": "XMLHttpRequest" };

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
    "meta",
    "questions",
    "quizzes",
    "settings",
    "submissions",
    "usernames",
    "users"
  ];
  for (const name of collections) {
    await clearQuery(db.collection(name));
  }
  await setSetting("default_quiz_minutes", "45");
}

async function createUser({ name, username, password, role, classId = null, mustChange = 0 }) {
  const passwordHash = await hashPassword(password);
  return insertUser({
    name,
    username,
    password_hash: passwordHash,
    role,
    class_id: classId,
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
  let quizId;
  let practiceSubmissionId;
  let firstQuestionId;
  let secondQuestionId;
  let student2Id;
  let student2TempPassword;

  await t.test("health endpoint is public", async () => {
    const response = await request(app).get("/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
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
  });

  await t.test("admin creates teacher and student accounts with temporary passwords", async () => {
    const teacher = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Teacher One", username: "teacher.one", role: "teacher" });
    assert.equal(teacher.status, 201);
    assert.equal(teacher.body.user.mustChangePassword, true);
    assert.ok(teacher.body.temporaryPassword.length >= 10);

    const teacher2 = await adminAgent
      .post("/api/admin/users")
      .set(CSRF)
      .send({ name: "Teacher Two", username: "teacher.two", role: "teacher" });
    assert.equal(teacher2.status, 201);

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

  await t.test("teacher builds a question bank and a class quiz", async () => {
    const first = await teacherAgent
      .post("/api/teacher/questions")
      .set(CSRF)
      .send({
        questionText: "What is 7 + 5?",
        subject: "Mathematics",
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
        subject: "Science",
        options: ["3", "5", "8", "9"],
        correctIndex: 2,
        solution: "8 is divisible by 2."
      });
    assert.equal(second.status, 201);
    assert.equal(second.body.question.subject, "Science");
    secondQuestionId = second.body.question.id;

    const quiz = await teacherAgent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Numbers Check",
        classId,
        minutes: 20,
        questionIds: [firstQuestionId, secondQuestionId]
      });
    assert.equal(quiz.status, 201);
    quizId = quiz.body.quiz.id;

    const otherTeacherQuiz = await teacher2Agent
      .post("/api/teacher/quizzes")
      .set(CSRF)
      .send({
        title: "Should not work",
        classId,
        minutes: 20,
        questionIds: [firstQuestionId]
      });
    assert.equal(otherTeacherQuiz.status, 400);
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
      .send({ defaultQuizMinutes: 30 });
    assert.equal(updated.status, 200);

    const bootstrap = await teacherAgent.get("/api/teacher/bootstrap");
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.settings.defaultQuizMinutes, 30);
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
});
