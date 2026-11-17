"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { getDb, col, hasAdmin, getSetting, setSetting, listAll } = require("./fdb");
const { logActivity } = require("./utils");

const importQuestions = require("../scripts/import-html-questions");
const seedPortal = require("../scripts/seed-portal");

function credentialsPath() {
  return path.join(config.dataDir, "initial-credentials.txt");
}

function saveCredentials(credentials) {
  if (!credentials.length) return null;
  const file = credentialsPath();
  const lines = [
    "GBAT Assessment Portal - initial credentials",
    "These accounts must change their password at first sign-in.",
    ""
  ];
  for (const item of credentials) {
    lines.push(`${item.role}: ${item.name}`);
    lines.push(`  username: ${item.username}`);
    lines.push(`  password: ${item.password}`);
    lines.push("");
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  } catch {
    // Read-only filesystem (serverless): credentials are only printed to logs.
    return null;
  }
  return file;
}

function printCredentials(credentials, file) {
  console.log("");
  console.log("============================================================");
  console.log(" GBAT portal is ready");
  console.log("============================================================");
  for (const item of credentials) {
    console.log(` ${item.role}: ${item.username} / ${item.password}`);
  }
  if (file) {
    console.log("");
    console.log(` Saved once to: ${file}`);
    console.log(" Change these passwords after your first sign-in.");
  }
  console.log("============================================================");
  console.log("");
}

async function createMinimalAdmin() {
  const created = { credentials: [], classes: 0, quizzes: 0, announcements: 0 };
  const admin = await seedPortal.ensureAdmin(created);
  await logActivity(null, `Created admin account "${admin.name}" (${admin.username})`);
  return created.credentials;
}

async function ensureDefaultSettings() {
  if ((await getSetting("default_quiz_minutes")) === null) {
    await setSetting("default_quiz_minutes", "45");
  }
}

/**
 * Seeds the database when it is empty. Safe to run on every boot and from
 * several cold serverless instances at once: a `meta/bootstrap` lock document
 * (created atomically) makes sure only one instance seeds.
 */
async function bootstrap() {
  await ensureDefaultSettings();
  if (await hasAdmin()) return [];

  // A partially initialized database (e.g. a crashed first run) still gets
  // an admin account, but we never duplicate existing users or quizzes.
  if ((await listAll("users")).length > 0) {
    const credentials = await createMinimalAdmin();
    const file = saveCredentials(credentials);
    printCredentials(credentials, file);
    return credentials;
  }

  let credentials = [];
  if (config.seedDemo) {
    const imported = await importQuestions.main({}, { quiet: true });
    const seeded = await seedPortal.main({}, { quiet: true });
    credentials = [...(imported.credentials || []), ...(seeded.created.credentials || [])];
    console.log(`[gbat] Seeded ${seeded.classes.length} class(es) from questions-source.html.`);
  } else {
    credentials = await createMinimalAdmin();
    console.log("[gbat] Created the initial admin account (demo data skipped).");
  }

  const file = saveCredentials(credentials);
  printCredentials(credentials, file);
  return credentials;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lockTime(value) {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/**
 * A lock older than two minutes is treated as abandoned (a cold instance may
 * have died mid-seed), so a new project can never stay empty forever.
 */
async function acquireBootstrapLock(lockRef) {
  return getDb().runTransaction(async tx => {
    const snap = await tx.get(lockRef);
    const stale = !snap.exists || Date.now() - lockTime(snap.data().at) > 120000;
    if (!stale) return false;
    tx.set(lockRef, { at: new Date() });
    return true;
  });
}

async function bootstrapWithLock() {
  await ensureDefaultSettings();
  if (await hasAdmin()) return [];

  const lockRef = col("meta").doc("bootstrap");
  const locked = await acquireBootstrapLock(lockRef);

  if (!locked) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(1000);
      if (await hasAdmin()) return [];
      if (!(await lockRef.get()).exists) break;
    }
    const error = new Error("Timed out waiting for portal bootstrap.");
    error.status = 503;
    throw error;
  }

  try {
    return await bootstrap();
  } finally {
    await lockRef.delete().catch(() => {});
  }
}

let bootPromise = null;

function ensureBootstrapped() {
  if (!bootPromise) {
    bootPromise = bootstrapWithLock().catch(error => {
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}

module.exports = { bootstrap, ensureBootstrapped };
