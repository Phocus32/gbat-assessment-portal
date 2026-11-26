"use strict";

/**
 * Subjects are first-class records. Questions, quizzes and teacher accounts
 * reference a numeric subject id, so renaming a subject never breaks a quiz
 * snapshot or hides a teacher's question bank.
 */

const {
  getDb,
  col,
  docData,
  duplicateError,
  getDocById,
  updateDocById,
  deleteDocById,
  listAll,
  listWhere,
  getSetting,
  setSetting
} = require("./fdb");
const { ensureSettings } = require("./settings");
const { migrateTeacherClassAssignments } = require("./class-access");

function subjectKey(name) {
  return encodeURIComponent(String(name || "").trim().toLowerCase().replace(/\s+/g, " "));
}

async function findSubjectByName(name) {
  const lock = docData(await col("subject_names").doc(subjectKey(name)).get());
  if (!lock) return null;
  return getDocById("subjects", lock.subjectId);
}

async function createSubject(name) {
  const clean = String(name || "").trim();
  const lockRef = col("subject_names").doc(subjectKey(clean));
  const counters = col("meta").doc("counters");
  return getDb().runTransaction(async tx => {
    const [lockSnap, counterSnap] = await Promise.all([tx.get(lockRef), tx.get(counters)]);
    if (lockSnap.exists) throw duplicateError("A subject with that name already exists.");
    const id = (counterSnap.exists ? Number(counterSnap.data().subjects || 0) : 0) + 1;
    tx.set(counters, { subjects: id }, { merge: true });
    tx.set(lockRef, { subjectId: id });
    tx.set(col("subjects").doc(String(id)), { id, name: clean, created_at: new Date() });
    return id;
  });
}

async function renameSubject(id, name) {
  const clean = String(name || "").trim();
  const ref = col("subjects").doc(String(id));
  const newLockRef = col("subject_names").doc(subjectKey(clean));
  return getDb().runTransaction(async tx => {
    const [snap, newLock] = await Promise.all([tx.get(ref), tx.get(newLockRef)]);
    if (!snap.exists) return false;
    if (newLock.exists && Number(newLock.data().subjectId) !== Number(id)) {
      throw duplicateError("A subject with that name already exists.");
    }
    const oldKey = subjectKey(snap.data().name);
    tx.update(ref, { name: clean });
    tx.set(newLockRef, { subjectId: Number(id) });
    if (oldKey !== subjectKey(clean)) tx.delete(col("subject_names").doc(oldKey));
    return true;
  });
}

async function deleteSubject(id) {
  const ref = col("subjects").doc(String(id));
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    tx.delete(ref);
    tx.delete(col("subject_names").doc(subjectKey(snap.data().name)));
    return true;
  });
}

async function listSubjects() {
  const rows = await listAll("subjects");
  return rows
    .map(row => ({ id: Number(row.id), name: row.name, createdAt: row.created_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureSubject(name) {
  const clean = String(name || "General").trim() || "General";
  const existing = await findSubjectByName(clean);
  if (existing) return Number(existing.id);
  try {
    return await createSubject(clean);
  } catch (error) {
    if (error && error.code === "ER_DUP_ENTRY") {
      const raced = await findSubjectByName(clean);
      if (raced) return Number(raced.id);
    }
    throw error;
  }
}

function subjectIdsOf(user) {
  if (!user || !Array.isArray(user.subject_ids)) return [];
  return user.subject_ids.map(Number).filter(Number.isInteger);
}

async function assertSubjectsAllowed(subjectIds, user) {
  const allowed = subjectIdsOf(user);
  if (!allowed.length) return false;
  const requested = [...new Set(subjectIds.map(Number))];
  return requested.length > 0 && requested.every(id => allowed.includes(id));
}

async function subjectMap() {
  const subjects = await listSubjects();
  return new Map(subjects.map(subject => [Number(subject.id), subject.name]));
}

/**
 * One-time upgrades for existing installs. Version 2 created the subject list
 * and assigned subjects to teachers. Version 3 moved teacher class scope from
 * "classes where they own a quiz" to an explicit admin-managed assignment.
 */
async function migrateSchema() {
  await ensureSettings();
  const version = Number(await getSetting("schema_version"));
  if (version >= 3) return;

  if (version < 2) {
    const generalId = await ensureSubject("General");
    const [questions, quizzes, users] = await Promise.all([
      listAll("questions"),
      listAll("quizzes"),
      listAll("users")
    ]);

    const byName = new Map([["general", generalId]]);
    const nameOf = row => String(row.subject || "General").trim() || "General";
    const updates = [];

    for (const question of questions) {
      const name = nameOf(question);
      const lower = name.toLowerCase();
      let id = byName.get(lower);
      if (!id) {
        id = await ensureSubject(name);
        byName.set(lower, id);
      }
      if (!question.subject_id || !question.subject) {
        updates.push({ collection: "questions", id: question.id, patch: { subject_id: id, subject: name } });
      }
    }

    for (const quiz of quizzes) {
      if (quiz.subject_id) continue;
      const name = nameOf(quiz);
      const lower = name.toLowerCase();
      let id = byName.get(lower);
      if (!id) {
        id = await ensureSubject(name);
        byName.set(lower, id);
      }
      updates.push({ collection: "quizzes", id: quiz.id, patch: { subject_id: id, subject: name, approved: true } });
    }

    const teacherSubjects = new Map();
    for (const update of updates) {
      if (update.collection !== "questions") continue;
      const owner = questions.find(question => Number(question.id) === Number(update.id));
      if (!owner) continue;
      const ids = teacherSubjects.get(Number(owner.created_by)) || new Set();
      ids.add(update.patch.subject_id);
      teacherSubjects.set(Number(owner.created_by), ids);
    }

    for (const user of users) {
      if (user.role !== "teacher" || subjectIdsOf(user).length) continue;
      const ids = teacherSubjects.get(Number(user.id));
      updates.push({
        collection: "users",
        id: user.id,
        patch: { subject_ids: ids ? [...ids] : [generalId] }
      });
    }

    for (let index = 0; index < updates.length; index += 400) {
      const batch = getDb().batch();
      for (const update of updates.slice(index, index + 400)) {
        batch.update(col(update.collection).doc(String(update.id)), update.patch);
      }
      await batch.commit();
    }

    await setSetting("schema_version", 2);
  }

  await migrateTeacherClassAssignments();
  await setSetting("schema_version", 3);
}

module.exports = {
  subjectKey,
  findSubjectByName,
  createSubject,
  renameSubject,
  deleteSubject,
  listSubjects,
  ensureSubject,
  subjectIdsOf,
  assertSubjectsAllowed,
  subjectMap,
  migrateSchema
};
