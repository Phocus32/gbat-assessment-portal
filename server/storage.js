"use strict";

/**
 * Firebase Storage helpers for learning materials.
 *
 * Uploads use short-lived signed URLs so large files go straight from the
 * browser to Storage instead of passing through a Vercel function. Firestore
 * only keeps metadata and the storage path.
 */

const crypto = require("crypto");
const path = require("path");
const config = require("./config");
const { getDb } = require("./fdb");

const FILE_TYPES = [
  {
    key: "pdf",
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"]
  },
  {
    key: "slides",
    extensions: ["ppt", "pptx"],
    mimeTypes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ]
  },
  {
    key: "document",
    extensions: ["doc", "docx"],
    mimeTypes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ]
  },
  {
    key: "image",
    extensions: ["jpg", "jpeg", "png", "webp", "gif"],
    mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"]
  }
];

const TYPE_LABELS = {
  pdf: "PDF",
  slides: "Slides",
  document: "Document",
  image: "Image",
  video: "Video",
  link: "Link"
};

function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bucketName() {
  return config.storageBucket || `${config.firebase.projectId}.appspot.com`;
}

function storageAvailable() {
  // The Firestore emulator has no Storage companion in this project. Metadata
  // and link materials still work locally; file uploads need a real bucket.
  return !process.env.FIRESTORE_EMULATOR_HOST && Boolean(bucketName());
}

async function getBucket() {
  if (!storageAvailable()) {
    throw problem(503, "File storage is not configured. Set FIREBASE_STORAGE_BUCKET to enable uploads.");
  }
  // Initialise the shared Firebase app before asking for Storage.
  getDb();
  const { getStorage } = require("firebase-admin/storage");
  return getStorage().bucket(bucketName());
}

function safeFileName(fileName) {
  const base = path.basename(String(fileName || ""));
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "file";
}

function resolveFileType(fileName, contentType) {
  const extension = path.extname(String(fileName || "")).replace(/^\./, "").toLowerCase();
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  const match = FILE_TYPES.find(type =>
    type.extensions.includes(extension) || type.mimeTypes.includes(mime)
  );
  if (!match) {
    throw problem(400, "Only PDF, PowerPoint, Word and image files can be uploaded.");
  }
  if (!match.extensions.includes(extension) || !match.mimeTypes.includes(mime)) {
    throw problem(400, "The file extension and type do not match. Rename the file and try again.");
  }
  return match.key;
}

function storagePathFor(fileName) {
  return `materials/${crypto.randomUUID()}/${safeFileName(fileName)}`;
}

async function createUploadUrl({ storagePath, contentType, sizeBytes }) {
  const bucket = await getBucket();
  if (!Number.isInteger(sizeBytes) || sizeBytes > config.materialMaxUploadBytes) {
    throw problem(413, "That file is too large.");
  }
  const file = bucket.file(storagePath);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 15 * 60 * 1000,
    contentType
  });
  return url;
}

async function createReadUrl(storagePath) {
  const bucket = await getBucket();
  const file = bucket.file(storagePath);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 60 * 60 * 1000
  });
  return url;
}

async function fileExists(storagePath) {
  const bucket = await getBucket();
  const [exists] = await bucket.file(storagePath).exists();
  return exists;
}

async function deleteFile(storagePath) {
  if (!storagePath) return;
  try {
    const bucket = await getBucket();
    await bucket.file(storagePath).delete();
  } catch (error) {
    if (error && error.code !== 404) throw error;
  }
}

module.exports = {
  FILE_TYPES,
  TYPE_LABELS,
  storageAvailable,
  bucketName,
  resolveFileType,
  storagePathFor,
  createUploadUrl,
  createReadUrl,
  fileExists,
  deleteFile
};
