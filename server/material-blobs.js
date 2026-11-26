"use strict";

/**
 * Firestore-backed upload fallback.
 *
 * New Firebase projects can have no Cloud Storage bucket while still having a
 * working Firestore database. Small learning materials are therefore stored as
 * base64 chunks in Firestore when Storage is unavailable. Each chunk stays
 * well below Firestore's 1 MiB per-document limit, and every write is bound to
 * the server-issued upload session that created it.
 */

const crypto = require("crypto");
const { col, getDb } = require("./fdb");

function blobIdFor(storagePath) {
  return crypto.createHash("sha256").update(String(storagePath)).digest("hex");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

function sameIds(left, right) {
  const a = normalizeIds(left);
  const b = normalizeIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function expectedChunkSize(session, index) {
  const chunkSize = Number(session.chunk_size);
  const total = Number(session.chunk_count);
  if (index === total - 1) {
    return Number(session.size_bytes) - chunkSize * (total - 1);
  }
  return chunkSize;
}

async function saveChunk({ session, index, data }) {
  const total = Number(session.chunk_count);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw httpError(400, "Invalid chunk position.");
  }

  const buffer = Buffer.from(data, "base64");
  const expected = expectedChunkSize(session, index);
  if (buffer.length !== expected) {
    throw httpError(400, "Upload chunk size did not match the original file.");
  }

  const ref = col("material_blobs").doc(blobIdFor(session.storage_path));
  return getDb().runTransaction(async tx => {
    // Firestore transactions reject reads after writes, so collect everything
    // needed for validation before staging any updates.
    const chunksRef = ref.collection("chunks");
    const snap = await tx.get(ref);
    const existingChunk = await tx.get(chunksRef.doc(String(index)));
    const chunksSnap = await tx.get(chunksRef);
    const metadata = {
      id: ref.id,
      storage_path: session.storage_path,
      upload_id: session.id,
      file_name: session.file_name,
      content_type: session.content_type,
      file_type: session.file_type,
      size_bytes: Number(session.size_bytes),
      chunk_count: total,
      chunk_size: Number(session.chunk_size),
      class_ids: normalizeIds(session.class_ids),
      subject_id: session.subject_id === undefined || session.subject_id === null ? null : Number(session.subject_id),
      uploaded_by: Number(session.uploaded_by),
      updated_at: new Date()
    };

    if (snap.exists) {
      const existing = snap.data();
      if (String(existing.upload_id || "") !== String(session.id)) {
        throw httpError(409, "This upload path belongs to a different upload.");
      }
      if (Number(existing.size_bytes) !== Number(session.size_bytes)
        || Number(existing.chunk_count) !== total
        || !sameIds(existing.class_ids, session.class_ids)) {
        throw httpError(409, "Upload details changed after the upload started.");
      }
      if (existing.complete && !existingChunk.exists) {
        throw httpError(409, "This upload is already complete.");
      }
    } else {
      metadata.received_chunks = 0;
      metadata.complete = false;
      metadata.created_at = new Date();
    }

    if (existingChunk.exists && existingChunk.data().data !== data) {
      throw httpError(409, "A different version of this chunk was already uploaded.");
    }
    if (!existingChunk.exists) {
      tx.set(chunksRef.doc(String(index)), {
        index,
        data,
        bytes: buffer.length,
        updated_at: new Date()
      });
    }

    // chunksSnap was read before this transaction's write, so include the
    // chunk being staged when deciding whether the upload is complete.
    const indices = new Set(chunksSnap.docs.map(doc => Number(doc.data().index)));
    indices.add(index);
    const count = indices.size;
    let complete = true;
    for (let position = 0; position < total; position += 1) {
      if (!indices.has(position)) {
        complete = false;
        break;
      }
    }
    tx.set(ref, { ...metadata, received_chunks: count, complete }, { merge: true });
    return { blobId: ref.id, complete };
  });
}

async function getBlob(storagePath) {
  const snap = await col("material_blobs").doc(blobIdFor(storagePath)).get();
  if (!snap.exists) return null;
  const blob = snap.data();
  blob.id = refId(storagePath);
  return blob;
}

function refId(storagePath) {
  return blobIdFor(storagePath);
}

async function blobExists(storagePath) {
  const blob = await getBlob(storagePath);
  return Boolean(blob && blob.complete);
}

async function readBlob(storagePath) {
  const blob = await getBlob(storagePath);
  if (!blob || !blob.complete) return null;
  const snapshot = await col("material_blobs").doc(blobIdFor(storagePath)).collection("chunks").get();
  const chunks = snapshot.docs
    .map(doc => doc.data())
    .sort((a, b) => Number(a.index) - Number(b.index));

  const total = Number(blob.chunk_count);
  if (chunks.length !== total) return null;
  for (let index = 0; index < total; index += 1) {
    if (Number(chunks[index].index) !== index) return null;
  }

  const buffers = chunks.map(chunk => Buffer.from(chunk.data, "base64"));
  const buffer = Buffer.concat(buffers);
  if (buffer.length !== Number(blob.size_bytes)) return null;
  return { blob, buffer };
}

async function deleteBlob(storagePath) {
  const ref = col("material_blobs").doc(blobIdFor(storagePath));
  const snapshot = await ref.collection("chunks").get();
  const batch = getDb().batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  batch.delete(ref);
  await batch.commit();
}

module.exports = {
  blobIdFor,
  saveChunk,
  getBlob,
  blobExists,
  readBlob,
  deleteBlob
};
