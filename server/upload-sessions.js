"use strict";

/**
 * Short-lived, server-issued upload records.
 *
 * The browser never supplies its own storage path or file metadata when it
 * finalizes a material. Every upload is tied to the signed-in user, the class
 * scope and the exact file type/size that were validated when the upload began.
 */

const crypto = require("crypto");
const { col, getDb } = require("./fdb");
const config = require("./config");

const UPLOAD_TTL_MS = 30 * 60 * 1000;

function docRef(uploadId) {
  return col("uploads").doc(String(uploadId));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isInteger(id) && id > 0))];
}

function sameIds(left, right) {
  const a = asIds(left).sort((x, y) => x - y);
  const b = asIds(right).sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

async function createUploadSession(user, input, meta) {
  const id = crypto.randomUUID();
  const now = new Date();
  const session = {
    id,
    status: "pending",
    uploaded_by: user.id,
    backend: meta.backend,
    storage_path: meta.storagePath,
    file_name: meta.fileName,
    content_type: meta.contentType,
    file_type: meta.fileType,
    size_bytes: meta.sizeBytes,
    chunk_size: meta.chunkSize || null,
    chunk_count: meta.chunkCount || null,
    class_ids: asIds(meta.classIds),
    subject_id: meta.subjectId === undefined || meta.subjectId === null ? null : Number(meta.subjectId),
    created_at: now,
    updated_at: now,
    expires_at: new Date(now.getTime() + UPLOAD_TTL_MS)
  };
  await docRef(id).set(session);
  return session;
}

async function getUploadSession(uploadId) {
  if (typeof uploadId !== "string" || !uploadId) return null;
  const snap = await docRef(uploadId).get();
  if (!snap.exists) return null;
  const session = snap.data();
  session.expires_at = asDate(session.expires_at);
  session.created_at = asDate(session.created_at);
  session.updated_at = asDate(session.updated_at);
  return session;
}

function assertSessionOwner(session, user) {
  if (!session) throw httpError(404, "Upload session not found.");
  if (Number(session.uploaded_by) !== Number(user.id)) {
    throw httpError(403, "That upload does not belong to your account.");
  }
  return session;
}

function assertSessionScope(session, classIds, subjectId) {
  if (!sameIds(session.class_ids, classIds)) {
    throw httpError(403, "Upload class scope does not match this material.");
  }
  const wantedSubject = subjectId === undefined || subjectId === null ? null : Number(subjectId);
  if (Number(session.subject_id) !== wantedSubject) {
    throw httpError(403, "Upload subject does not match this material.");
  }
  return session;
}

function assertSessionActive(session) {
  const expiresAt = asDate(session.expires_at);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    throw httpError(410, "This upload has expired. Start the upload again.");
  }
  if (session.status === "used") {
    throw httpError(409, "This upload has already been attached to a material.");
  }
  return session;
}

async function setUploadStatus(uploadId, status) {
  await docRef(uploadId).update({ status, updated_at: new Date() });
}

/**
 * Atomically mark an upload as used so two simultaneous material posts cannot
 * attach the same file twice.
 */
async function consumeUploadSession(uploadId, user, classIds, subjectId) {
  const ref = docRef(uploadId);
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Upload session not found.");
    const session = snap.data();
    session.expires_at = asDate(session.expires_at);
    assertSessionOwner(session, user);
    assertSessionScope(session, classIds, subjectId);
    assertSessionActive(session);
    if (session.status !== "uploaded") {
      throw httpError(400, "The file was not uploaded completely.");
    }
    tx.update(ref, { status: "used", updated_at: new Date() });
    return session;
  });
}

function expectedChunkCount(session) {
  return Math.max(1, Math.ceil(Number(session.size_bytes) / Number(session.chunk_size)));
}

module.exports = {
  UPLOAD_TTL_MS,
  createUploadSession,
  getUploadSession,
  assertSessionOwner,
  assertSessionScope,
  assertSessionActive,
  setUploadStatus,
  consumeUploadSession,
  expectedChunkCount,
  sameIds
};
