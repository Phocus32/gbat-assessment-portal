"use strict";

const fs = require("fs");
const path = require("path");
const {
  listClasses,
  findUserByUsername,
  createUser,
  close
} = require("../server/fdb");
const { hashPassword } = require("../server/security");
const { generateTemporaryPassword, logActivity, csvCell } = require("../server/utils");
const { nameSchema, usernameSchema } = require("../server/validation");

function parseArgs(argv) {
  const options = { file: null, out: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.out = argv[index + 1] || null;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (!options.file) {
      options.file = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.file) throw new Error("Usage: npm run import-students -- <file.csv> [--out credentials.csv] [--dry-run]");
  return options;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(item => item.some(value => value.trim()));
}

function slugUsername(name, className) {
  const base = String(name)
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  const suffix = String(className)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const combined = `${base || "student"}.${suffix}`.slice(0, 80);
  return combined.length >= 3 ? combined : `student.${suffix}`.slice(0, 80);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) throw new Error(`CSV file not found: ${filePath}`);

  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  if (!rows.length) throw new Error("The CSV file is empty.");

  const header = rows[0].map(value => value.trim().toLowerCase());
  const hasHeader = header.includes("name");
  const nameIndex = hasHeader ? header.indexOf("name") : 0;
  const usernameIndex = hasHeader ? header.findIndex(value => value === "username" || value === "index") : 1;
  const classIndex = hasHeader
    ? header.findIndex(value => value === "class" || value === "class_name" || value === "classname")
    : 2;

  if (nameIndex < 0 || classIndex < 0) {
    throw new Error("CSV columns must be: name, username, class");
  }

  const classRows = await listClasses();
  const classMap = new Map(classRows.map(cls => [cls.name.toLowerCase(), cls]));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const created = [];
  const skipped = [];
  const failed = [];

  for (let index = 0; index < dataRows.length; index += 1) {
    const line = index + (hasHeader ? 2 : 1);
    const row = dataRows[index];
    const name = String(row[nameIndex] || "").trim();
    const className = String(row[classIndex] || "").trim();
    let username = usernameIndex >= 0 ? String(row[usernameIndex] || "").trim() : "";

    const nameResult = nameSchema.safeParse(name);
    if (!nameResult.success) {
      failed.push(`Line ${line}: ${nameResult.error.issues[0].message}`);
      continue;
    }

    const cls = classMap.get(className.toLowerCase());
    if (!cls) {
      failed.push(`Line ${line}: class "${className}" does not exist.`);
      continue;
    }

    if (!username) username = slugUsername(name, cls.name);
    const usernameResult = usernameSchema.safeParse(username);
    if (!usernameResult.success) {
      failed.push(`Line ${line}: ${usernameResult.error.issues[0].message}`);
      continue;
    }

    if (await findUserByUsername(username)) {
      skipped.push(`Line ${line}: username "${username}" already exists.`);
      continue;
    }

    const temporaryPassword = generateTemporaryPassword();
    if (!options.dryRun) {
      const passwordHash = await hashPassword(temporaryPassword);
      await createUser({
        name,
        username,
        password_hash: passwordHash,
        role: "student",
        class_id: cls.id,
        must_change_password: true
      });
      await logActivity(null, `Imported student account "${name}" (${username}) into ${cls.name}`);
    }

    created.push({ name, username, className: cls.name, password: temporaryPassword });
  }

  console.log(`CSV rows processed: ${dataRows.length}`);
  console.log(`Students ${options.dryRun ? "validated" : "created"}: ${created.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Failed: ${failed.length}`);

  if (created.length) {
    console.log("");
    console.log("STUDENT CREDENTIALS (temporary passwords, shown once):");
    for (const item of created) {
      console.log(`  ${item.name} | ${item.className} | ${item.username} | ${item.password}`);
    }
    console.log("");
    console.log("Students must change their password at first sign-in.");
  }

  for (const message of skipped) console.log(`SKIP ${message}`);
  for (const message of failed) console.log(`FAIL ${message}`);

  if (options.out && created.length) {
    const outputPath = path.resolve(options.out);
    const lines = [
      ["name", "username", "class", "temporary_password"].map(csvCell).join(","),
      ...created.map(item =>
        [item.name, item.username, item.className, item.password].map(csvCell).join(",")
      )
    ];
    fs.writeFileSync(outputPath, `\uFEFF${lines.join("\r\n")}`, { encoding: "utf8", mode: 0o600 });
    console.log("");
    console.log(`Credentials written to ${outputPath}. Protect or delete this file after distributing them.`);
  }
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(`Student import failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await close();
    });
}

module.exports = { main, parseArgs, parseCsv, slugUsername };
