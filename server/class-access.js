"use strict";

/**
 * Class-level authorization for teachers.
 *
 * A teacher's class scope is an explicit admin-managed assignment on the user
 * document. It is deliberately not derived from quizzes the teacher created:
 * that allowed a teacher to grant themselves access to any class simply by
 * creating a quiz there.
 */

const {
  getDb,
  col,
  getDocById,
  getManyByIds,
  listAll,
  listClasses
} = require("./fdb");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function classIdsOf(row) {
  if (!row || !Array.isArray(row.class_ids)) return [];
  return [...new Set(row.class_ids
    .map(Number)
    .filter(id => Number.isInteger(id) && id > 0))];
}

async function allowedClassIds(user) {
  if (!user) return new Set();
  if (user.role === "admin") {
    return new Set((await listClasses()).map(cls => Number(cls.id)));
  }
  if (user.role === "teacher") return new Set(classIdsOf(user));
  if (user.role === "student" && user.class_id !== null && user.class_id !== undefined) {
    return new Set([Number(user.class_id)]);
  }
  return new Set();
}

async function assertClassAllowed(user, classId) {
  const id = Number(classId);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, "Choose a valid class.");
  }
  const allowed = await allowedClassIds(user);
  if (!allowed.has(id)) {
    throw httpError(403, "That class is not assigned to your account.");
  }
  const cls = await getDocById("classes", id);
  if (!cls) throw httpError(400, "Class not found.");
  return cls;
}

async function assertClassesAllowed(user, classIds) {
  const requested = [...new Set(classIds.map(Number))];
  if (!requested.length) throw httpError(400, "Select at least one class.");
  const allowed = await allowedClassIds(user);
  for (const id of requested) {
    if (!Number.isInteger(id) || id <= 0 || !allowed.has(id)) {
      throw httpError(403, "One or more selected classes are outside your scope.");
    }
  }
  const existing = await getManyByIds("classes", requested);
  if (existing.length !== requested.length) {
    throw httpError(400, "One or more selected classes no longer exist.");
  }
  return requested;
}

/**
 * One-time upgrade for installs where teacher scope was inferred from owned
 * quizzes. Existing assignments are migrated once, then the explicit field is
 * authoritative. Teachers with no quizzes receive an empty list until an admin
 * assigns classes.
 */
async function migrateTeacherClassAssignments() {
  const [users, quizzes] = await Promise.all([
    listAll("users"),
    listAll("quizzes")
  ]);

  const byTeacher = new Map();
  for (const quiz of quizzes) {
    const teacherId = Number(quiz.teacher_id);
    const classId = Number(quiz.class_id);
    if (!Number.isInteger(teacherId) || !Number.isInteger(classId) || classId <= 0) continue;
    const ids = byTeacher.get(teacherId) || new Set();
    ids.add(classId);
    byTeacher.set(teacherId, ids);
  }

  const validClassIds = new Set((await listClasses()).map(cls => Number(cls.id)));
  const updates = [];
  for (const user of users) {
    if (user.role !== "teacher" || Array.isArray(user.class_ids)) continue;
    const ids = [...(byTeacher.get(Number(user.id)) || [])]
      .filter(id => validClassIds.has(id))
      .sort((a, b) => a - b);
    updates.push({ id: user.id, class_ids: ids });
  }

  for (let index = 0; index < updates.length; index += 400) {
    const batch = getDb().batch();
    for (const update of updates.slice(index, index + 400)) {
      batch.update(col("users").doc(String(update.id)), { class_ids: update.class_ids });
    }
    await batch.commit();
  }
  return updates.length;
}

module.exports = {
  classIdsOf,
  allowedClassIds,
  assertClassAllowed,
  assertClassesAllowed,
  migrateTeacherClassAssignments
};
