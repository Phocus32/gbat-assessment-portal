"use strict";

/**
 * Firestore data layer.
 *
 * The app was originally written for SQL; this module keeps the same domain
 * shape (numeric ids, snake_case fields) on top of Cloud Firestore so the
 * routes stay small. Conventions:
 *
 * - Every top-level document carries a numeric `id` and lives at
 *   `<collection>/<id>`. Ids come from the `meta/counters` document.
 * - Quiz questions live in `quizzes/<id>/items/<position>`, attempt answers
 *   in `attempts/<id>/answers/<position>` (atomic "answer lock" via create()).
 * - Submission answers are embedded in the submission document (`answers`),
 *   which removes an entire join and keeps grading reads to one document.
 * - Username and class-name uniqueness is enforced by lock documents in
 *   `usernames/<lowercase>` and `class_names/<lowercase>` inside transactions.
 * - Timestamps are stored as Firestore Timestamps and surfaced as JS Dates.
 */

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const config = require("./config");

let adminApp = null;
let firestore = null;

function buildApp() {
  const { projectId, clientEmail, privateKey, serviceAccountJson } = config.firebase;

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: projectId || process.env.GCLOUD_PROJECT || "demo-gbat" });
  }

  if (serviceAccountJson) {
    return initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  }

  if (clientEmail && privateKey) {
    return initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, "\n")
      })
    });
  }

  return initializeApp({ credential: applicationDefault(), projectId });
}

function getApp() {
  if (!adminApp) adminApp = buildApp();
  return adminApp;
}

function getDb() {
  if (firestore) return firestore;
  firestore = getFirestore(getApp());
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

function col(name) {
  return getDb().collection(name);
}

function counterRef() {
  return col("meta").doc("counters");
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function normalizeValue(value) {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = normalizeValue(entry);
    return out;
  }
  return value;
}

function docData(snap) {
  if (!snap || !snap.exists) return null;
  const data = normalizeValue(snap.data());
  data.id = Number(data.id === undefined ? snap.id : data.id);
  return data;
}

function docsData(snapshot) {
  return snapshot.docs.map(docData);
}

function duplicateError(message) {
  const error = new Error(message);
  error.code = "ER_DUP_ENTRY";
  return error;
}

// ---------------------------------------------------------------------------
// Id allocation (single-document counter; trivial at school scale)
// ---------------------------------------------------------------------------

async function nextId(counter) {
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(counterRef());
    const current = snap.exists ? Number(snap.data()[counter] || 0) : 0;
    const id = current + 1;
    tx.set(counterRef(), { [counter]: id }, { merge: true });
    return id;
  });
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function insertDoc(collection, data, counter = collection) {
  const id = await nextId(counter);
  await col(collection).doc(String(id)).set({ ...data, id });
  return id;
}

async function getDocById(collection, id) {
  return docData(await col(collection).doc(String(id)).get());
}

async function updateDocById(collection, id, patch) {
  await col(collection).doc(String(id)).update(patch);
}

async function deleteDocById(collection, id) {
  await col(collection).doc(String(id)).delete();
}

async function listAll(collection) {
  return docsData(await col(collection).get());
}

async function listWhere(collection, field, value) {
  return docsData(await col(collection).where(field, "==", value).get());
}

async function listWhereIn(collection, field, values) {
  if (!values.length) return [];
  const out = [];
  for (let index = 0; index < values.length; index += 30) {
    const chunk = values.slice(index, index + 30);
    out.push(...docsData(await col(collection).where(field, "in", chunk).get()));
  }
  return out;
}

async function getManyByIds(collection, ids) {
  if (!ids.length) return [];
  const refs = ids.map(id => col(collection).doc(String(id)));
  const snaps = await getDb().getAll(...refs);
  return snaps.map(docData).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Classes (uniqueness via class_names lock docs)
// ---------------------------------------------------------------------------

function classKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Firestore document ids cannot contain "/", so encode the lock key.
function classLockKey(name) {
  return encodeURIComponent(classKey(name));
}

async function findClassByName(name) {
  const lock = docData(await col("class_names").doc(classLockKey(name)).get());
  if (!lock) return null;
  return getDocById("classes", lock.classId);
}

async function createClass(name) {
  const lockRef = col("class_names").doc(classLockKey(name));
  const counters = counterRef();
  return getDb().runTransaction(async tx => {
    const [lockSnap, counterSnap] = await Promise.all([tx.get(lockRef), tx.get(counters)]);
    if (lockSnap.exists) throw duplicateError("A class with that name already exists.");
    const id = (counterSnap.exists ? Number(counterSnap.data().classes || 0) : 0) + 1;
    tx.set(counters, { classes: id }, { merge: true });
    tx.set(lockRef, { classId: id });
    tx.set(col("classes").doc(String(id)), { id, name, created_at: new Date() });
    return id;
  });
}

async function renameClass(id, name) {
  const ref = col("classes").doc(String(id));
  const newLockRef = col("class_names").doc(classLockKey(name));
  return getDb().runTransaction(async tx => {
    const [snap, newLock] = await Promise.all([tx.get(ref), tx.get(newLockRef)]);
    if (!snap.exists) return false;
    if (newLock.exists && Number(newLock.data().classId) !== Number(id)) {
      throw duplicateError("A class with that name already exists.");
    }
    const oldKey = classLockKey(snap.data().name);
    tx.update(ref, { name });
    tx.set(newLockRef, { classId: Number(id) });
    if (oldKey !== classLockKey(name)) tx.delete(col("class_names").doc(oldKey));
    return true;
  });
}

async function deleteClass(id) {
  const ref = col("classes").doc(String(id));
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    tx.delete(ref);
    tx.delete(col("class_names").doc(classLockKey(snap.data().name)));
    return true;
  });
}

async function listClasses() {
  const rows = await listAll("classes");
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Users (uniqueness via usernames lock docs, case-insensitive login lookup)
// ---------------------------------------------------------------------------

// Firestore document ids cannot contain "/", so encode the lock key. Valid
// usernames (letters, numbers, dot, dash, underscore) are unchanged, while a
// malformed login attempt still produces a safe lookup instead of an error.
function usernameLockKey(username) {
  return encodeURIComponent(String(username || "").trim().toLowerCase());
}

async function findUserByUsername(username) {
  const lock = docData(await col("usernames").doc(usernameLockKey(username)).get());
  if (!lock) return null;
  return getDocById("users", lock.userId);
}

async function createUser(data) {
  const lockRef = col("usernames").doc(usernameLockKey(data.username));
  const counters = counterRef();
  const record = {
    name: data.name,
    username: data.username,
    password_hash: data.password_hash,
    role: data.role,
    class_id: data.class_id === undefined ? null : data.class_id,
    class_ids: data.class_ids === undefined ? [] : data.class_ids,
    subject_ids: data.subject_ids === undefined ? [] : data.subject_ids,
    active: data.active === undefined ? true : data.active,
    must_change_password: data.must_change_password === undefined ? false : data.must_change_password,
    failed_login_attempts: data.failed_login_attempts || 0,
    locked_until: data.locked_until === undefined ? null : data.locked_until,
    token_version: data.token_version || 0,
    last_login_at: data.last_login_at === undefined ? null : data.last_login_at,
    created_at: data.created_at || new Date()
  };

  return getDb().runTransaction(async tx => {
    const [lockSnap, counterSnap] = await Promise.all([tx.get(lockRef), tx.get(counters)]);
    if (lockSnap.exists) throw duplicateError("That username is already in use.");
    const id = (counterSnap.exists ? Number(counterSnap.data().users || 0) : 0) + 1;
    tx.set(counters, { users: id }, { merge: true });
    tx.set(lockRef, { userId: id });
    tx.set(col("users").doc(String(id)), { ...record, id });
    return id;
  });
}

async function deleteUser(id) {
  const ref = col("users").doc(String(id));
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    tx.delete(ref);
    tx.delete(col("usernames").doc(usernameLockKey(snap.data().username)));
    return true;
  });
}

async function withClassName(user) {
  if (!user) return null;
  if (user.class_id === null || user.class_id === undefined) {
    return { ...user, class_name: null };
  }
  const cls = await getDocById("classes", user.class_id);
  return { ...user, class_name: cls ? cls.name : null };
}

async function hasAdmin() {
  const snap = await col("users").where("role", "==", "admin").limit(1).get();
  return !snap.empty;
}

// ---------------------------------------------------------------------------
// Quizzes and their item subcollections
// ---------------------------------------------------------------------------

async function createQuizWithItems(data, items) {
  const counters = counterRef();
  return getDb().runTransaction(async tx => {
    const counterSnap = await tx.get(counters);
    const id = (counterSnap.exists ? Number(counterSnap.data().quizzes || 0) : 0) + 1;
    const ref = col("quizzes").doc(String(id));
    tx.set(counters, { quizzes: id }, { merge: true });
    tx.set(ref, { ...data, id });
    items.forEach((item, position) => {
      tx.set(ref.collection("items").doc(String(position)), { ...item, position });
    });
    return id;
  });
}

async function listQuizItems(quizId) {
  const snap = await col("quizzes").doc(String(quizId)).collection("items").get();
  const items = docsData(snap);
  items.forEach(item => {
    item.position = Number(item.position === undefined ? item.id : item.position);
  });
  return items.sort((a, b) => a.position - b.position);
}

async function getQuizItem(quizId, position) {
  const snap = await col("quizzes").doc(String(quizId)).collection("items").doc(String(position)).get();
  const item = docData(snap);
  if (item) item.position = Number(item.position === undefined ? item.id : item.position);
  return item;
}

async function countQuizItems(quizId) {
  const snap = await col("quizzes").doc(String(quizId)).collection("items").count().get();
  return snap.data().count;
}

// ---------------------------------------------------------------------------
// Attempts and their answer subcollections
// ---------------------------------------------------------------------------

async function saveAnswer(attemptId, position, chosenIndex) {
  const ref = col("attempts").doc(String(attemptId)).collection("answers").doc(String(position));
  try {
    await ref.create({ position, chosen_index: chosenIndex, answered_at: new Date() });
  } catch (error) {
    // gRPC ALREADY_EXISTS
    if (error && (error.code === 6 || error.code === "ALREADY_EXISTS")) {
      throw duplicateError("This answer is already locked.");
    }
    throw error;
  }
}

async function listAttemptAnswers(attemptId) {
  const snap = await col("attempts").doc(String(attemptId)).collection("answers").get();
  return docsData(snap).sort((a, b) => Number(a.position) - Number(b.position));
}

// ---------------------------------------------------------------------------
// Submissions (answers embedded; one document per graded attempt)
// ---------------------------------------------------------------------------

/**
 * Grades and submits an attempt atomically. Reading the quiz items and answer
 * subcollection inside the transaction means a late answer write cannot be
 * missed between grading and saving the result.
 */
async function submitAttemptResults({ attempt }) {
  const attemptRef = col("attempts").doc(String(attempt.id));
  const quizRef = col("quizzes").doc(String(attempt.quiz_id));
  const counters = counterRef();

  return getDb().runTransaction(async tx => {
    const [attemptSnap, counterSnap, quizSnap, itemsSnap, answersSnap] = await Promise.all([
      tx.get(attemptRef),
      tx.get(counters),
      tx.get(quizRef),
      tx.get(quizRef.collection("items")),
      tx.get(attemptRef.collection("answers"))
    ]);

    if (!attemptSnap.exists || attemptSnap.data().status !== "in_progress") {
      throw duplicateError("This attempt was already submitted.");
    }

    const items = docsData(itemsSnap).sort((a, b) => Number(a.position) - Number(b.position));
    if (!items.length) {
      const error = new Error("This quiz has no questions and cannot be graded.");
      error.status = 409;
      throw error;
    }

    const answerMap = new Map(
      docsData(answersSnap).map(answer => [Number(answer.position), answer])
    );

    let score = 0;
    const graded = items.map(item => {
      const answer = answerMap.get(Number(item.position));
      const chosenIndex = answer ? Number(answer.chosen_index) : null;
      const isCorrect = chosenIndex !== null && chosenIndex === Number(item.correct_index);
      if (isCorrect) score += 1;
      return {
        position: Number(item.position),
        chosen_index: chosenIndex,
        correct_index: Number(item.correct_index),
        is_correct: isCorrect
      };
    });

    const total = items.length;
    const pct = Math.round((score / total) * 100);
    const id = (counterSnap.exists ? Number(counterSnap.data().submissions || 0) : 0) + 1;
    const classId = attempt.class_id === undefined || attempt.class_id === null
      ? (quizSnap.exists ? quizSnap.data().class_id : null)
      : attempt.class_id;

    tx.set(counters, { submissions: id }, { merge: true });
    tx.set(col("submissions").doc(String(id)), {
      id,
      quiz_id: attempt.quiz_id,
      class_id: classId,
      student_id: attempt.student_id,
      attempt_id: attempt.id,
      mode: attempt.mode,
      score,
      total,
      pct,
      answers: graded,
      submitted_at: new Date()
    });
    tx.update(attemptRef, { status: "submitted", submitted_at: new Date() });

    return { submissionId: id, score, total, pct };
  });
}

async function findSubmissionByAttempt(attemptId) {
  const rows = await listWhere("submissions", "attempt_id", attemptId);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Complaint replies (transactional so concurrent replies are never lost)
// ---------------------------------------------------------------------------

async function addComplaintReply(complaintId, reply) {
  const ref = col("complaints").doc(String(complaintId));
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const complaint = normalizeValue(snap.data());
    complaint.id = Number(complaint.id === undefined ? snap.id : complaint.id);
    const replies = Array.isArray(complaint.replies) ? [...complaint.replies] : [];
    const nextId = replies.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const now = new Date();
    const entry = {
      id: nextId,
      author_id: reply.authorId,
      author_name: reply.authorName,
      author_role: reply.authorRole,
      message: reply.message,
      created_at: now
    };
    replies.push(entry);

    const patch = { replies, updated_at: now };
    // A reply on a closed complaint is still recorded, but closing is an
    // explicit admin decision that a new message must not silently undo.
    if (complaint.status !== "closed") patch.status = "replied";
    tx.update(ref, patch);

    return { complaint, reply: entry };
  });
}

// ---------------------------------------------------------------------------
// Logs, announcements, settings
// ---------------------------------------------------------------------------

async function recentDocs(collection, limit) {
  return docsData(await col(collection).orderBy("id", "desc").limit(limit).get());
}

async function getSetting(key) {
  const doc = docData(await col("settings").doc(key).get());
  return doc ? doc.value : null;
}

async function setSetting(key, value) {
  await col("settings").doc(key).set({ value });
}

// ---------------------------------------------------------------------------

async function close() {
  if (adminApp) await adminApp.delete();
  adminApp = null;
  firestore = null;
}

module.exports = {
  getApp,
  getDb,
  col,
  docData,
  docsData,
  duplicateError,
  nextId,
  insertDoc,
  getDocById,
  updateDocById,
  deleteDocById,
  listAll,
  listWhere,
  listWhereIn,
  getManyByIds,
  classKey,
  findClassByName,
  createClass,
  renameClass,
  deleteClass,
  listClasses,
  findUserByUsername,
  createUser,
  deleteUser,
  withClassName,
  hasAdmin,
  addComplaintReply,
  createQuizWithItems,
  listQuizItems,
  getQuizItem,
  countQuizItems,
  saveAnswer,
  listAttemptAnswers,
  submitAttemptResults,
  findSubmissionByAttempt,
  recentDocs,
  getSetting,
  setSetting,
  close
};
