"use strict";

const express = require("express");
const multer = require("multer");
const {
  listAll,
  listWhere,
  listClasses,
  getDocById,
  updateDocById,
  findClassByName,
  createClass,
  renameClass,
  deleteClass,
  findUserByUsername,
  createUser,
  getManyByIds,
  deleteUser,
  countQuizItems,
  recentDocs
} = require("../fdb");
const {
  createSubject,
  renameSubject,
  deleteSubject,
  listSubjects,
  ensureSubject,
  subjectIdsOf,
  subjectMap
} = require("../subjects");
const { getSettings, saveSettings } = require("../settings");
const { hashPassword } = require("../security");
const { buildStudentTemplate } = require("../excel");
const { importStudentsFromWorkbook, ExcelInputError } = require("../student-import");
const {
  asyncHandler,
  publicUser,
  generateTemporaryPassword,
  logActivity
} = require("../utils");
const {
  idSchema,
  classCreateSchema,
  classUpdateSchema,
  userCreateSchema,
  userUpdateSchema,
  subjectCreateSchema,
  subjectUpdateSchema,
  settingsSchema,
  adminQuizUpdateSchema
} = require("../validation");

const router = express.Router();

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
});

const ROLE_ORDER = { admin: 1, teacher: 2, student: 3 };

function attachClassName(user, classMap, subjectNamesMap = new Map()) {
  const className = user.class_id === null || user.class_id === undefined
    ? null
    : (classMap.get(Number(user.class_id)) || null);
  const subjectIds = subjectIdsOf(user);
  return {
    ...publicUser({ ...user, class_name: className }),
    subjectIds,
    subjectNames: subjectIds.map(id => subjectNamesMap.get(id)).filter(Boolean)
  };
}

router.get("/students/template.xlsx", asyncHandler(async (req, res) => {
  const classes = await listClasses();
  const buffer = await buildStudentTemplate(classes.map(cls => cls.name));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=\"gbat-student-import-template.xlsx\"");
  return res.send(buffer);
}));

router.post("/students/import", uploadExcel.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new ExcelInputError("Choose an Excel file to upload.");
  if (!/\.xlsx$/i.test(req.file.originalname || "")) {
    throw new ExcelInputError("Upload a .xlsx Excel file.");
  }
  const result = await importStudentsFromWorkbook(req.file.buffer, req.user);
  return res.json(result);
}));

router.get("/bootstrap", asyncHandler(async (req, res) => {
  const [users, classes, logs, settings, submissions, quizzes, subjects] = await Promise.all([
    listAll("users"),
    listClasses(),
    recentDocs("activity_logs", 50),
    getSettings(),
    listAll("submissions"),
    listAll("quizzes"),
    listSubjects()
  ]);

  const classMap = new Map(classes.map(cls => [Number(cls.id), cls.name]));
  const subjectNames = new Map(subjects.map(subject => [Number(subject.id), subject.name]));
  const teacherNames = new Map(
    users.filter(user => user.role === "teacher").map(user => [Number(user.id), user.name])
  );

  const studentsByClass = new Map();
  for (const user of users) {
    if (user.role !== "student" || user.class_id === null || user.class_id === undefined) continue;
    const key = Number(user.class_id);
    studentsByClass.set(key, (studentsByClass.get(key) || 0) + 1);
  }
  const quizzesByClass = new Map();
  let openQuizzes = 0;
  let pendingApproval = 0;
  for (const quiz of quizzes) {
    if (quiz.is_deleted) continue;
    const key = Number(quiz.class_id);
    quizzesByClass.set(key, (quizzesByClass.get(key) || 0) + 1);
    if (quiz.is_open) openQuizzes += 1;
    if (quiz.approved === false) pendingApproval += 1;
  }

  const sortedUsers = [...users].sort((a, b) => {
    const roleDiff = (ROLE_ORDER[a.role] || 4) - (ROLE_ORDER[b.role] || 4);
    return roleDiff || a.name.localeCompare(b.name);
  });

  const liveQuizzes = quizzes
    .filter(quiz => !quiz.is_deleted)
    .sort((a, b) => Number(b.id) - Number(a.id));
  const questionCounts = await Promise.all(liveQuizzes.map(quiz => countQuizItems(quiz.id)));

  const average = submissions.length
    ? Math.round(submissions.reduce((sum, row) => sum + Number(row.pct || 0), 0) / submissions.length)
    : 0;

  res.json({
    users: sortedUsers.map(user => attachClassName(user, classMap, subjectNames)),
    classes: classes.map(cls => ({
      id: cls.id,
      name: cls.name,
      studentCount: studentsByClass.get(Number(cls.id)) || 0,
      quizCount: quizzesByClass.get(Number(cls.id)) || 0,
      createdAt: cls.created_at
    })),
    subjects,
    quizzes: liveQuizzes.map((quiz, index) => ({
      id: quiz.id,
      title: quiz.title,
      classId: quiz.class_id,
      className: classMap.get(Number(quiz.class_id)) || null,
      teacherName: teacherNames.get(Number(quiz.teacher_id)) || "Unknown",
      subjectId: quiz.subject_id || null,
      subjectName: subjectNames.get(Number(quiz.subject_id)) || quiz.subject || "General",
      minutes: Number(quiz.minutes),
      questionCount: questionCounts[index],
      isOpen: quiz.is_open === true || quiz.is_open === 1,
      approved: quiz.approved !== false,
      createdAt: quiz.created_at
    })),
    logs: logs.map(log => ({
      id: log.id,
      actorName: log.actor_name,
      action: log.action,
      createdAt: log.created_at
    })),
    settings,
    stats: {
      students: users.filter(user => user.role === "student").length,
      teachers: users.filter(user => user.role === "teacher").length,
      classes: classes.length,
      average,
      openQuizzes,
      pendingApproval
    }
  });
}));

router.post("/classes", asyncHandler(async (req, res) => {
  const input = classCreateSchema.parse(req.body);
  if (await findClassByName(input.name)) {
    return res.status(409).json({ error: "A class with that name already exists." });
  }

  const id = await createClass(input.name);
  await logActivity(req.user, `Created class ${input.name}`);
  return res.status(201).json({ class: { id, name: input.name } });
}));

router.patch("/classes/:id", asyncHandler(async (req, res) => {
  const classId = idSchema.parse(req.params.id);
  const input = classUpdateSchema.parse(req.body);

  const target = await getDocById("classes", classId);
  if (!target) return res.status(404).json({ error: "Class not found." });

  const duplicate = await findClassByName(input.name);
  if (duplicate && Number(duplicate.id) !== Number(classId)) {
    return res.status(409).json({ error: "A class with that name already exists." });
  }

  await renameClass(classId, input.name);
  await logActivity(req.user, `Renamed class "${target.name}" to "${input.name}"`);
  return res.json({ class: { id: classId, name: input.name } });
}));

router.delete("/classes/:id", asyncHandler(async (req, res) => {
  const classId = idSchema.parse(req.params.id);
  const target = await getDocById("classes", classId);
  if (!target) return res.status(404).json({ error: "Class not found." });

  const [students, quizzes] = await Promise.all([
    listWhere("users", "class_id", classId),
    listWhere("quizzes", "class_id", classId)
  ]);
  const studentCount = students.filter(user => user.role === "student").length;
  const quizCount = quizzes.filter(quiz => !quiz.is_deleted).length;

  if (studentCount > 0 || quizCount > 0) {
    return res.status(409).json({
      error: `Cannot delete "${target.name}": it still has ${studentCount} student(s) and ${quizCount} quiz(zes). Move or remove them first.`
    });
  }

  await deleteClass(classId);
  await logActivity(req.user, `Deleted class ${target.name}`);
  return res.json({ ok: true });
}));

router.get("/subjects", asyncHandler(async (req, res) => {
  res.json({ subjects: await listSubjects() });
}));

router.post("/subjects", asyncHandler(async (req, res) => {
  const input = subjectCreateSchema.parse(req.body);
  const id = await createSubject(input.name);
  await logActivity(req.user, `Created subject ${input.name}`);
  return res.status(201).json({ subject: { id, name: input.name } });
}));

router.patch("/subjects/:id", asyncHandler(async (req, res) => {
  const subjectId = idSchema.parse(req.params.id);
  const input = subjectUpdateSchema.parse(req.body);
  const target = await getDocById("subjects", subjectId);
  if (!target) return res.status(404).json({ error: "Subject not found." });
  await renameSubject(subjectId, input.name);
  await logActivity(req.user, `Renamed subject "${target.name}" to "${input.name}"`);
  return res.json({ subject: { id: subjectId, name: input.name } });
}));

router.delete("/subjects/:id", asyncHandler(async (req, res) => {
  const subjectId = idSchema.parse(req.params.id);
  const target = await getDocById("subjects", subjectId);
  if (!target) return res.status(404).json({ error: "Subject not found." });

  const [questions, quizzes] = await Promise.all([
    listWhere("questions", "subject_id", subjectId),
    listWhere("quizzes", "subject_id", subjectId)
  ]);
  if (questions.length || quizzes.length) {
    return res.status(409).json({
      error: `Cannot delete "${target.name}": it still has ${questions.length} question(s) and ${quizzes.length} quiz(zes). Rename it instead, or move that content first.`
    });
  }

  const teachers = await listWhere("users", "subject_ids", subjectId);
  for (const teacher of teachers) {
    const remaining = subjectIdsOf(teacher).filter(id => id !== Number(subjectId));
    await updateDocById("users", teacher.id, { subject_ids: remaining });
  }

  await deleteSubject(subjectId);
  await logActivity(req.user, `Deleted subject ${target.name}`);
  return res.json({ ok: true });
}));

router.patch("/quizzes/:id", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const input = adminQuizUpdateSchema.parse(req.body);
  const quiz = await getDocById("quizzes", quizId);
  if (!quiz || quiz.is_deleted) return res.status(404).json({ error: "Quiz not found." });

  const patch = {};
  const actions = [];
  if (input.approved !== undefined) {
    patch.approved = Boolean(input.approved);
    actions.push(`${input.approved ? "Approved" : "Returned"} quiz "${quiz.title}"`);
  }
  if (input.isOpen !== undefined) {
    patch.is_open = Boolean(input.isOpen);
    actions.push(`${input.isOpen ? "Opened" : "Closed"} quiz "${quiz.title}"`);
  }

  await updateDocById("quizzes", quizId, patch);
  for (const action of actions) await logActivity(req.user, action);
  return res.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      approved: patch.approved === undefined ? quiz.approved !== false : patch.approved,
      isOpen: patch.isOpen === undefined ? quiz.is_open === true || quiz.is_open === 1 : patch.isOpen
    }
  });
}));

router.post("/users", asyncHandler(async (req, res) => {
  const input = userCreateSchema.parse(req.body);

  if (await findUserByUsername(input.username)) {
    return res.status(409).json({ error: "That username is already in use." });
  }

  let classId = null;
  if (input.role === "student") {
    const cls = await getDocById("classes", input.classId);
    if (!cls) return res.status(400).json({ error: "Select a valid class for the student." });
    classId = cls.id;
  }

  let subjectIds = [];
  if (input.role === "teacher") {
    const generalId = await ensureSubject("General");
    const requested = input.subjectIds && input.subjectIds.length
      ? [...new Set(input.subjectIds.map(Number))]
      : [generalId];
    const valid = await getManyByIds("subjects", requested);
    if (valid.length !== requested.length) {
      return res.status(400).json({ error: "One or more selected subjects no longer exist." });
    }
    subjectIds = requested;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const userId = await createUser({
    name: input.name,
    username: input.username,
    password_hash: passwordHash,
    role: input.role,
    class_id: classId,
    subject_ids: subjectIds,
    active: true,
    must_change_password: true,
    failed_login_attempts: 0,
    locked_until: null,
    token_version: 0,
    last_login_at: null,
    created_at: new Date()
  });

  const created = await getDocById("users", userId);
  const className = classId === null ? null : (await getDocById("classes", classId)).name;
  const names = await subjectMap();

  await logActivity(req.user, `Created ${input.role} account "${input.name}" (${input.username})`);
  return res.status(201).json({
    user: {
      ...publicUser({ ...created, class_name: className }),
      subjectIds: subjectIds,
      subjectNames: subjectIds.map(id => names.get(id)).filter(Boolean)
    },
    temporaryPassword
  });
}));

router.patch("/users/:id", asyncHandler(async (req, res) => {
  const userId = idSchema.parse(req.params.id);
  const input = userUpdateSchema.parse(req.body);

  const target = await getDocById("users", userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(403).json({ error: "Admin accounts are managed from the command line." });
  }

  if (typeof input.active === "boolean" && input.active === false && Number(target.id) === Number(req.user.id)) {
    return res.status(400).json({ error: "You cannot deactivate your own account." });
  }

  const patch = {};
  const actions = [];
  let bumpToken = false;

  if (input.name !== undefined && input.name !== target.name) {
    patch.name = input.name;
    actions.push(`Renamed ${target.name} to ${input.name}`);
  }

  let subjectNames = null;
  if (input.subjectIds !== undefined) {
    if (target.role !== "teacher") {
      return res.status(400).json({ error: "Only teacher accounts can be assigned subjects." });
    }
    const requested = [...new Set(input.subjectIds.map(Number))];
    if (!requested.length) {
      return res.status(400).json({ error: "Assign at least one subject to the teacher." });
    }
    const valid = await getManyByIds("subjects", requested);
    if (valid.length !== requested.length) {
      return res.status(400).json({ error: "One or more selected subjects no longer exist." });
    }
    patch.subject_ids = requested;
    const names = await subjectMap();
    subjectNames = requested.map(id => names.get(id)).filter(Boolean);
    actions.push(`Set subjects for ${target.name} to ${subjectNames.join(", ")}`);
  }

  if (typeof input.active === "boolean") {
    patch.active = input.active;
    bumpToken = true;
    actions.push(`${input.active ? "Activated" : "Suspended"} user ${target.name}`);
  }

  let className = target.class_id === null || target.class_id === undefined ? null : undefined;
  if (input.classId !== undefined) {
    if (target.role !== "student") {
      return res.status(400).json({ error: "Only student accounts can be assigned to a class." });
    }
    if (!input.classId) {
      return res.status(400).json({ error: "Students must belong to a class." });
    }
    const cls = await getDocById("classes", input.classId);
    if (!cls) return res.status(400).json({ error: "Class not found." });
    patch.class_id = cls.id;
    className = cls.name;
    actions.push(`Moved ${target.name} to ${cls.name}`);
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "No changes were supplied." });
  }

  if (bumpToken) patch.token_version = Number(target.token_version || 0) + 1;
  await updateDocById("users", userId, patch);

  for (const action of actions) {
    await logActivity(req.user, action);
  }

  const updated = await getDocById("users", userId);
  if (className === undefined) {
    const cls = updated.class_id === null || updated.class_id === undefined
      ? null
      : await getDocById("classes", updated.class_id);
    className = cls ? cls.name : null;
  }
  if (subjectNames === null) {
    const names = await subjectMap();
    subjectNames = subjectIdsOf(updated).map(id => names.get(id)).filter(Boolean);
  }
  return res.json({
    user: {
      ...publicUser({ ...updated, class_name: className }),
      subjectIds: subjectIdsOf(updated),
      subjectNames
    }
  });
}));

router.post("/users/:id/reset-password", asyncHandler(async (req, res) => {
  const userId = idSchema.parse(req.params.id);
  const target = await getDocById("users", userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(403).json({ error: "Admin passwords can only be changed from the signed-in account or the command line." });
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await updateDocById("users", userId, {
    password_hash: passwordHash,
    must_change_password: true,
    token_version: Number(target.token_version || 0) + 1,
    failed_login_attempts: 0,
    locked_until: null
  });

  await logActivity(req.user, `Reset password for ${target.name} (${target.username})`);
  return res.json({ temporaryPassword });
}));

router.delete("/users/:id", asyncHandler(async (req, res) => {
  const userId = idSchema.parse(req.params.id);
  if (Number(userId) === Number(req.user.id)) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }

  const target = await getDocById("users", userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(403).json({ error: "Admin accounts are managed from the command line." });
  }

  const [attempts, questions, quizzes] = await Promise.all([
    listWhere("attempts", "student_id", userId),
    listWhere("questions", "created_by", userId),
    listWhere("quizzes", "teacher_id", userId)
  ]);

  if (attempts.length > 0 || questions.length > 0 || quizzes.length > 0) {
    return res.status(409).json({
      error: `Cannot delete "${target.name}": the account still has ${attempts.length} attempt(s), ${questions.length} question(s) and ${quizzes.length} quiz(zes). Suspend the account instead.`
    });
  }

  await deleteUser(userId);
  await logActivity(req.user, `Deleted ${target.role} account "${target.name}" (${target.username})`);
  return res.json({ ok: true });
}));

router.put("/settings", asyncHandler(async (req, res) => {
  const current = await getSettings();
  const input = settingsSchema.parse({ ...current, ...req.body });
  await saveSettings(input);
  await logActivity(req.user, "Updated quiz and assessment settings");
  return res.json({ settings: await getSettings() });
}));

module.exports = router;
