"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

function resolveDataDirectory() {
  const configured = process.env.DATA_DIR;
  if (configured) return path.resolve(process.cwd(), configured);
  return path.resolve(process.cwd(), "data");
}

/**
 * On a laptop the JWT secret is generated once into the data directory so it
 * survives restarts. In production (Vercel) the filesystem is ephemeral, so
 * JWT_SECRET must be set as a real environment variable there.
 */
function resolveJwtSecret(dataDir, env) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (env === "production") {
    throw new Error("Set the JWT_SECRET environment variable in production.");
  }

  const secretPath = path.join(dataDir, "jwt-secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First run: generate below.
  }

  const generated = require("crypto").randomBytes(48).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  } catch {
    // Read-only filesystem: fall back to an in-memory secret for this run.
  }
  console.warn("[gbat] JWT_SECRET was not set; generated a development secret.");
  return generated;
}

const port = Number(process.env.PORT || 3000);
const env = process.env.NODE_ENV || "development";
const dataDir = resolveDataDirectory();
const jwtSecret = resolveJwtSecret(dataDir, env);

if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long.");
}

const config = {
  env,
  port,
  host: process.env.HOST || "0.0.0.0",
  trustProxy: process.env.TRUST_PROXY === "true" || env === "production",
  dataDir,
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "gbat-quiz",
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
    privateKey: process.env.FIREBASE_PRIVATE_KEY || "",
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT || "",
    // Firebase Storage bucket for learning materials. When unset, the classic
    // <project-id>.appspot.com bucket is used.
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || ""
  },
  materialMaxUploadBytes: Math.max(
    1024 * 1024,
    Number(process.env.MATERIAL_UPLOAD_MAX_MB || 50) * 1024 * 1024
  ),
  // Fallback used only when the Firebase project has no Cloud Storage bucket.
  // Files are chunked into Firestore documents, each safely below the 1 MiB
  // per-document limit.
  materialFirestoreMaxBytes: 10 * 1024 * 1024,
  materialChunkBase64Bytes: 600 * 1024,
  // Signed Storage URLs are browser-facing, so the bucket must allow the app
  // origin. "*" is safe here because the short-lived signature is the actual
  // access control; set MATERIAL_CORS_ORIGINS to lock it down if needed.
  materialCorsOrigins: String(process.env.MATERIAL_CORS_ORIGINS || "*")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "4h",
  // Inactivity timeout. The browser counts real user activity; the server also
  // enforces it so a stale cookie cannot be reused by somebody else.
  idleTimeoutMinutes: Math.max(1, Number(process.env.IDLE_TIMEOUT_MINUTES || 1)),
  idleWarningSeconds: Math.max(5, Number(process.env.IDLE_WARNING_SECONDS || 15)),
  idleHeartbeatSeconds: Math.max(5, Number(process.env.IDLE_HEARTBEAT_SECONDS || 15)),
  activityWriteIntervalSeconds: Math.max(5, Number(process.env.ACTIVITY_WRITE_INTERVAL_SECONDS || 15)),
  cookieName: "gbat_session",
  secureCookies: process.env.COOKIE_SECURE === "true" || env === "production",
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  apiRateMax: Number(process.env.API_RATE_MAX || 5000),
  // Gemini guide. GOOGLE_API_KEY is the documented variable; GEMINI_API_KEY is
  // accepted as a fallback because the official SDK uses that name.
  googleApiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "",
  aiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  aiMaxOutputTokens: Math.max(200, Number(process.env.AI_MAX_OUTPUT_TOKENS || 600)),
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES || 15),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX || 100),
  examGraceSeconds: Number(process.env.EXAM_GRACE_SECONDS || 20),
  seedDemo: env !== "test" && process.env.SEED_DEMO !== "false"
};

module.exports = config;
