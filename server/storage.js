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
const { getApp } = require("./fdb");

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
  return config.firebase.storageBucket || `${config.firebase.projectId}.appspot.com`;
}

function candidateBucketNames() {
  if (config.firebase.storageBucket) return [config.firebase.storageBucket];
  const project = config.firebase.projectId;
  // Older Firebase projects use appspot.com; newer ones use firebasestorage.app.
  return [`${project}.appspot.com`, `${project}.firebasestorage.app`];
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
  getApp();
  const { getStorage } = require("firebase-admin/storage");
  return getStorage().bucket(await resolveBucketName());
}

let resolvedBucketName = null;

/**
 * New Firebase projects use a .firebasestorage.app bucket rather than the
 * legacy .appspot.com name. Probe once per process so deployments that never
 * set FIREBASE_STORAGE_BUCKET still target the real bucket.
 */
async function resolveBucketName() {
  if (config.firebase.storageBucket) return config.firebase.storageBucket;
  if (resolvedBucketName) return resolvedBucketName;

  getApp();
  const { getStorage } = require("firebase-admin/storage");
  const candidates = candidateBucketNames();
  for (const name of candidates) {
    try {
      await getStorage().bucket(name).getMetadata();
      resolvedBucketName = name;
      return name;
    } catch (error) {
      // 404 means the bucket does not exist. Any other error (for example a
      // service account without bucket.get) means probing is unreliable, so
      // fall back to the legacy name instead of failing every upload.
      if (!error || error.code !== 404) break;
    }
  }
  resolvedBucketName = candidates[0];
  return resolvedBucketName;
}

/**
 * Browser uploads go straight to storage.googleapis.com, which is a different
 * origin from the app. Without bucket CORS the preflight fails before the
 * signed PUT is sent, and the browser only reports a generic TypeError.
 */
function storageCorsConfiguration() {
  return [
    {
      maxAgeSeconds: 3600,
      method: ["GET", "PUT", "HEAD"],
      origin: config.materialCorsOrigins.length ? config.materialCorsOrigins : ["*"],
      responseHeader: ["Content-Type"]
    }
  ];
}

async function configureStorageCors() {
  getApp();
  const { getStorage } = require("firebase-admin/storage");
  const storage = getStorage();
  const candidates = candidateBucketNames();
  let lastError = null;

  for (const name of candidates) {
    const bucket = storage.bucket(name);
    try {
      await bucket.getMetadata();
      await bucket.setCorsConfiguration(storageCorsConfiguration());
      return { bucket: bucket.name, cors: storageCorsConfiguration() };
    } catch (error) {
      lastError = error;
      if (!error || error.code !== 404) throw error;
    }
  }

  throw problem(
    404,
    `No Storage bucket found. Checked: ${candidates.join(", ")}. Set FIREBASE_STORAGE_BUCKET to the correct bucket. ${lastError ? `Last error: ${lastError.message}` : ""}`.trim()
  );
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

/**
 * HTML form uploads are a simple cross-origin POST, so the browser does not
 * send a CORS preflight. The signed policy still limits the object path, size
 * and content type, and redirects back to the app only after Storage accepts
 * the bytes.
 */
async function createUploadForm({ storagePath, contentType, sizeBytes, successActionRedirect }) {
  const bucket = await getBucket();
  if (!Number.isInteger(sizeBytes) || sizeBytes > config.materialMaxUploadBytes) {
    throw problem(413, "That file is too large.");
  }
  const file = bucket.file(storagePath);
  const [policy] = await file.generateSignedPostPolicyV4({
    expires: Date.now() + 15 * 60 * 1000,
    conditions: [["content-length-range", 1, sizeBytes]],
    fields: {
      "Content-Type": contentType,
      success_action_redirect: successActionRedirect
    }
  });
  return policy;
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
  candidateBucketNames,
  resolveBucketName,
  storageCorsConfiguration,
  configureStorageCors,
  resolveFileType,
  storagePathFor,
  createUploadUrl,
  createUploadForm,
  createReadUrl,
  fileExists,
  deleteFile
};
