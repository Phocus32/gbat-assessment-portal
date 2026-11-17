"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { query } = require("./db");
const { applySchema } = require("./schema");
const { logActivity } = require("./utils");

const importQuestions = require("../scripts/import-html-questions");
const seedPortal = require("../scripts/seed-portal");

function credentialsPath() {
  const dataDir = config.db.dataDir || path.resolve(process.cwd(), "data");
  return path.join(dataDir, "initial-credentials.txt");
}

function saveCredentials(credentials) {
  if (!credentials.length) return null;
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
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
  const created = { credentials: [] };
  const admin = await seedPortal.ensureAdmin(created);
  await logActivity(null, `Created admin account "${admin.name}" (${admin.username})`);
  return created.credentials;
}

/**
 * Runs once at startup. Safe to call on every boot: it only creates data when
 * the database is empty and never overwrites existing accounts or quizzes.
 */
async function bootstrap() {
  if (config.autoMigrate) {
    await applySchema();
  }

  const stateRows = await query(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins`
  );
  if (Number(stateRows[0].admins) > 0) return [];

  // A partially initialized database (e.g. a crashed first run) still gets
  // an admin account, but we never duplicate existing users or quizzes.
  if (Number(stateRows[0].users) > 0) {
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
    console.log(`[gbat] Seeded ${seeded.classes.length} class(es) from index.html.`);
  } else {
    credentials = await createMinimalAdmin();
    console.log("[gbat] Created the initial admin account (demo data skipped).");
  }

  const file = saveCredentials(credentials);
  printCredentials(credentials, file);
  return credentials;
}

module.exports = { bootstrap };
