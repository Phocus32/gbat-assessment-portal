"use strict";

/**
 * Firestore-backed upload fallback.
 *
 * New Firebase projects can have no Cloud Storage bucket while still having a
 * working Firestore database. Small learning materials are therefore stored as
 * base64 chunks in Firestore when Storage is unavailable. Each chunk stays
 * well below Firestore's 1 MiB per-document limit.
 */

const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { col, getDb, docData } = require("./fdb");

function blobIdFor(storagePath) {
  return crypto.createHash("sha256").update(String(storagePath)).digest("hex");
}

async function saveChunk(input) {
  const blobId = blobIdFor(input.storagePath);
  const ref = col("material_blobs").doc(blobId);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      id: blobId,
      storage_path: input.storagePath,
      file_name: input.fileName,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      chunk_count: input.total,
      received_chunks: 0,
      complete: false,
      class_ids: input.classIds.map(Number),
      subject_id: input.subjectId === undefined ? null : input.subjectId,
      uploaded_by: input.uploadedBy,
      created_at: new Date(),
      updated_at: new Date()
    });
  }

  const batch = getDb().batch();
  batch.set(ref, {
    received_chunks: FieldValue.increment(1),
    updated_at: new Date()
  }, { merge: true });
  batch.set(ref.collection("chunks").doc(String(input.index)), {
    index: input.index,
    data: input.data,
    updated_at: new Date()
  });
  if (input.index === input.total - 1) {
    batch.update(ref, { complete: true, updated_at: new Date() });
  }
  await batch.commit();
  return { blobId, complete: input.index === input.total - 1 };
}

async function getBlob(storagePath) {
  return docData(await col("material_blobs").doc(blobIdFor(storagePath)).get());
}

async function blobExists(storagePath) {
  return Boolean(await getBlob(storagePath));
}

async function readBlob(storagePath) {
  const blob = await getBlob(storagePath);
  if (!blob || !blob.complete) return null;
  const snapshot = await col("material_blobs").doc(blobIdFor(storagePath)).collection("chunks").get();
  const chunks = snapshot.docs
    .map(doc => docData(doc))
    .sort((a, b) => Number(a.index) - Number(b.index));
  if (chunks.length !== Number(blob.chunk_count)) return null;
  return {
    blob,
    buffer: Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, "base64")))
  };
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
