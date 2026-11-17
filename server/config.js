"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function resolveDataDirectory() {
  const configured = process.env.DATA_DIR || process.env.SQLITE_DIR;
  if (configured) return path.resolve(process.cwd(), configured);
  return path.resolve(process.cwd(), "data");
}

function resolveSqlitePath(dataDir) {
  const configured = process.env.SQLITE_PATH;
  if (!configured) return path.join(dataDir, "gbat.db");
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function parseDatabaseUrl(value) {
  const url = new URL(value);
  return {
    host: decodeURIComponent(url.hostname),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, ""))
  };
}

/**
 * A hosted deployment should never need to be configured by hand. When
 * JWT_SECRET is missing we create one once inside the data directory so it
 * survives restarts. Setting the variable explicitly always wins.
 */
function resolveJwtSecret(dataDir) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const secretPath = path.join(dataDir, "jwt-secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First run: generate below.
  }

  const generated = require("crypto").randomBytes(48).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  console.warn("[gbat] JWT_SECRET was not set. Generated a persistent secret at");
  console.warn(`[gbat]   ${secretPath}`);
  console.warn("[gbat] Back up this file together with the database.");
  return generated;
}

const port = Number(process.env.PORT || 3000);
const env = process.env.NODE_ENV || "development";
const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || "";
const requestedDriver = String(
  process.env.DB_DRIVER || (databaseUrl ? "mysql" : "sqlite")
).toLowerCase();

if (!["sqlite", "mysql"].includes(requestedDriver)) {
  throw new Error(`Unsupported DB_DRIVER "${requestedDriver}". Use "sqlite" or "mysql".`);
}

const dataDir = resolveDataDirectory();
const jwtSecret = resolveJwtSecret(dataDir);

if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long.");
}

const urlParts = databaseUrl ? parseDatabaseUrl(databaseUrl) : null;

const db = requestedDriver === "sqlite"
  ? {
      driver: "sqlite",
      dataDir,
      path: resolveSqlitePath(dataDir)
    }
  : {
      driver: "mysql",
      host: urlParts ? urlParts.host : required("DB_HOST"),
      port: Number((urlParts ? urlParts.port : process.env.DB_PORT) || 3306),
      user: urlParts ? urlParts.user : required("DB_USER"),
      password: urlParts ? urlParts.password : required("DB_PASSWORD"),
      database: urlParts ? urlParts.database : required("DB_NAME"),
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
      ssl: process.env.DB_SSL === "true"
        ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
        : undefined
    };

const config = {
  env,
  port,
  host: process.env.HOST || "0.0.0.0",
  appOrigin: process.env.APP_ORIGIN || `http://localhost:${port}`,
  trustProxy: process.env.TRUST_PROXY === "true" || env === "production",
  db,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "4h",
  cookieName: "gbat_session",
  secureCookies: process.env.COOKIE_SECURE === "true" || env === "production",
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  apiRateMax: Number(process.env.API_RATE_MAX || 5000),
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES || 15),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX || 100),
  examGraceSeconds: Number(process.env.EXAM_GRACE_SECONDS || 20),
  autoMigrate: process.env.AUTO_MIGRATE !== "false",
  seedDemo: env !== "test" && process.env.SEED_DEMO !== "false"
};

module.exports = config;
