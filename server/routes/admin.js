"use strict";

const express = require("express");
const multer = require("multer");
const { query } = require("../db");
const { hashPassword } = require("../security");
const { buildStudentTemplate } = require("../excel");
const { importStudentsFromWorkbook, ExcelInputError } = require("../student-import");
const {
  asyncHandler,
  publicUser,
  toBoolean,
  generateTemporaryPassword,
  logActivity
} = require("../utils");
const {
  idSchema,
  classCreateSchema,
  classUpdateSchema,
  userCreateSchema,
  userUpdateSchema,
  settingsSchema
} = require("../validation");

const router = express.Router();

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
});

router.get("/students/template.xlsx", asyncHandler(async (req, res) => {
  const classes = await query("SELECT name FROM classes ORDER BY name");
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
  const [users, classes, logs, settings, statsRows] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.username, u.role, u.class_id, c.name AS class_name,
              u.active, u.must_change_password, u.last_login_at, u.created_at
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
        ORDER BY FIELD(u.role, 'admin', 'teacher', 'student'), u.name`
    ),
    query(
      `SELECT c.id, c.name, c.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.class_id = c.id AND u.role = 'student') AS student_count,
              (SELECT COUNT(*) FROM quizzes q WHERE q.class_id = c.id AND q.is_deleted = 0) AS quiz_count
         FROM classes c
        ORDER BY c.name`
    ),
    query(
      `SELECT id, actor_name, action, created_at
         FROM activity_logs
        ORDER BY id DESC
        LIMIT 100`
    ),
    query("SELECT setting_value FROM settings WHERE setting_key = 'default_quiz_minutes' LIMIT 1"),
    query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
         (SELECT COUNT(*) FROM users WHERE role = 'teacher') AS teachers,
         (SELECT COUNT(*) FROM classes) AS classes,
         (SELECT ROUND(AVG(pct)) FROM submissions) AS average,
         (SELECT COUNT(*) FROM quizzes WHERE is_open = 1 AND is_deleted = 0) AS open_quizzes`
    )
  ]);

  const defaultQuizMinutes = Number(settings[0] ? settings[0].setting_value : 45);

  res.json({
    users: users.map(publicUser),
    classes: classes.map(cls => ({
      id: cls.id,
      name: cls.name,
      studentCount: Number(cls.student_count),
      quizCount: Number(cls.quiz_count),
      createdAt: cls.created_at
    })),
    logs: logs.map(log => ({
      id: log.id,
      actorName: log.actor_name,
      action: log.action,
      createdAt: log.created_at
    })),
    settings: { defaultQuizMinutes },
    stats: {
      students: Number(statsRows[0].students),
      teachers: Number(statsRows[0].teachers),
      classes: Number(statsRows[0].classes),
      average: Number(statsRows[0].average || 0),
      openQuizzes: Number(statsRows[0].open_quizzes)
    }
  });
}));

router.post("/classes", asyncHandler(async (req, res) => {
  const input = classCreateSchema.parse(req.body);
  const existing = await query("SELECT id FROM classes WHERE name = ? LIMIT 1", [input.name]);
  if (existing.length) {
    return res.status(409).json({ error: "A class with that name already exists." });
  }

  const result = await query("INSERT INTO classes (name) VALUES (?)", [input.name]);
  await logActivity(req.user, `Created class ${input.name}`);
  return res.status(201).json({ class: { id: result.insertId, name: input.name } });
}));

router.patch("/classes/:id", asyncHandler(async (req, res) => {
  const classId = idSchema.parse(req.params.id);
  const input = classUpdateSchema.parse(req.body);

  const rows = await query("SELECT id, name FROM classes WHERE id = ? LIMIT 1", [classId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "Class not found." });

  const duplicate = await query("SELECT id FROM classes WHERE name = ? AND id <> ? LIMIT 1", [input.name, classId]);
  if (duplicate.length) {
    return res.status(409).json({ error: "A class with that name already exists." });
  }

  await query("UPDATE classes SET name = ? WHERE id = ?", [input.name, classId]);
  await logActivity(req.user, `Renamed class "${target.name}" to "${input.name}"`);
  return res.json({ class: { id: classId, name: input.name } });
}));

router.delete("/classes/:id", asyncHandler(async (req, res) => {
  const classId = idSchema.parse(req.params.id);
  const rows = await query("SELECT id, name FROM classes WHERE id = ? LIMIT 1", [classId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "Class not found." });

  const counts = await query(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE class_id = ? AND role = 'student') AS student_count,
       (SELECT COUNT(*) FROM quizzes WHERE class_id = ?) AS quiz_count`,
    [classId, classId]
  );
  const studentCount = Number(counts[0].student_count);
  const quizCount = Number(counts[0].quiz_count);

  if (studentCount > 0 || quizCount > 0) {
    return res.status(409).json({
      error: `Cannot delete "${target.name}": it still has ${studentCount} student(s) and ${quizCount} quiz(zes). Move or remove them first.`
    });
  }

  await query("DELETE FROM classes WHERE id = ?", [classId]);
  await logActivity(req.user, `Deleted class ${target.name}`);
  return res.json({ ok: true });
}));

router.post("/users", asyncHandler(async (req, res) => {
  const input = userCreateSchema.parse(req.body);

  const duplicate = await query("SELECT id FROM users WHERE username = ? LIMIT 1", [input.username]);
  if (duplicate.length) {
    return res.status(409).json({ error: "That username is already in use." });
  }

  let classId = null;
  if (input.role === "student") {
    const classRows = await query("SELECT id, name FROM classes WHERE id = ? LIMIT 1", [input.classId]);
    if (!classRows[0]) return res.status(400).json({ error: "Select a valid class for the student." });
    classId = classRows[0].id;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const result = await query(
    `INSERT INTO users (name, username, password_hash, role, class_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [input.name, input.username, passwordHash, input.role, classId]
  );

  const createdRows = await query(
    `SELECT u.*, c.name AS class_name
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = ?`,
    [result.insertId]
  );

  await logActivity(req.user, `Created ${input.role} account "${input.name}" (${input.username})`);
  return res.status(201).json({
    user: publicUser(createdRows[0]),
    temporaryPassword
  });
}));

router.patch("/users/:id", asyncHandler(async (req, res) => {
  const userId = idSchema.parse(req.params.id);
  const input = userUpdateSchema.parse(req.body);

  const rows = await query(
    `SELECT u.*, c.name AS class_name
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = ?
      LIMIT 1`,
    [userId]
  );
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(403).json({ error: "Admin accounts are managed from the command line." });
  }

  if (typeof input.active === "boolean" && input.active === false && target.id === req.user.id) {
    return res.status(400).json({ error: "You cannot deactivate your own account." });
  }

  const updates = [];
  const params = [];
  const actions = [];

  if (typeof input.active === "boolean") {
    updates.push("active = ?", "token_version = token_version + 1");
    params.push(input.active ? 1 : 0);
    actions.push(`${input.active ? "Activated" : "Suspended"} user ${target.name}`);
  }

  if (input.classId !== undefined) {
    if (target.role !== "student") {
      return res.status(400).json({ error: "Only student accounts can be assigned to a class." });
    }
    if (!input.classId) {
      return res.status(400).json({ error: "Students must belong to a class." });
    }
    const classRows = await query("SELECT id, name FROM classes WHERE id = ? LIMIT 1", [input.classId]);
    if (!classRows[0]) return res.status(400).json({ error: "Class not found." });
    updates.push("class_id = ?");
    params.push(classRows[0].id);
    actions.push(`Moved ${target.name} to ${classRows[0].name}`);
  }

  if (!updates.length) {
    return res.status(400).json({ error: "No changes were supplied." });
  }

  params.push(userId);
  await query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);

  for (const action of actions) {
    await logActivity(req.user, action);
  }

  const updatedRows = await query(
    `SELECT u.*, c.name AS class_name
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = ?`,
    [userId]
  );
  return res.json({ user: publicUser(updatedRows[0]) });
}));

router.post("/users/:id/reset-password", asyncHandler(async (req, res) => {
  const userId = idSchema.parse(req.params.id);
  const rows = await query("SELECT id, name, role, username FROM users WHERE id = ? LIMIT 1", [userId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(403).json({ error: "Admin passwords can only be changed from the signed-in account or the command line." });
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await query(
    `UPDATE users
        SET password_hash = ?,
            must_change_password = 1,
            token_version = token_version + 1,
            failed_login_attempts = 0,
            locked_until = NULL
      WHERE id = ?`,
    [passwordHash, userId]
  );

  await logActivity(req.user, `Reset password for ${target.name} (${target.username})`);
  return res.json({ temporaryPassword });
}));

router.delete("/users/:id", asyncHandler(async (req, res) => {
  const userId = idSchema.parse(req.params.id);
  if (Number(userId) === Number(req.user.id)) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }

  const rows = await query("SELECT id, name, username, role FROM users WHERE id = ? LIMIT 1", [userId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(403).json({ error: "Admin accounts are managed from the command line." });
  }

  const counts = await query(
    `SELECT
       (SELECT COUNT(*) FROM quiz_attempts WHERE student_id = ?) AS attempts,
       (SELECT COUNT(*) FROM questions WHERE created_by = ?) AS questions,
       (SELECT COUNT(*) FROM quizzes WHERE teacher_id = ?) AS quizzes`,
    [userId, userId, userId]
  );
  const attemptCount = Number(counts[0].attempts);
  const questionCount = Number(counts[0].questions);
  const quizCount = Number(counts[0].quizzes);

  if (attemptCount > 0 || questionCount > 0 || quizCount > 0) {
    return res.status(409).json({
      error: `Cannot delete "${target.name}": the account still has ${attemptCount} attempt(s), ${questionCount} question(s) and ${quizCount} quiz(zes). Suspend the account instead.`
    });
  }

  await query("DELETE FROM users WHERE id = ?", [userId]);
  await logActivity(req.user, `Deleted ${target.role} account "${target.name}" (${target.username})`);
  return res.json({ ok: true });
}));

router.put("/settings", asyncHandler(async (req, res) => {
  const input = settingsSchema.parse(req.body);
  await query(
    `INSERT INTO settings (setting_key, setting_value)
     VALUES ('default_quiz_minutes', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [String(input.defaultQuizMinutes)]
  );
  await logActivity(req.user, `Updated default quiz duration to ${input.defaultQuizMinutes} minutes`);
  return res.json({ settings: input });
}));

module.exports = router;
