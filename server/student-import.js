"use strict";

const { query } = require("./db");
const { hashPassword } = require("./security");
const { logActivity } = require("./utils");
const { nameSchema, usernameSchema } = require("./validation");
const {
  ExcelInputError,
  readStudentRows,
  usernameBase,
  temporaryPassword
} = require("./excel");

function classKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function uniqueUsername(base) {
  let candidate = base;
  let suffix = 2;
  while (true) {
    const rows = await query("SELECT id FROM users WHERE username = ? LIMIT 1", [candidate]);
    if (!rows.length) return candidate;
    const text = String(suffix);
    candidate = `${base.slice(0, 80 - text.length)}${text}`;
    suffix += 1;
  }
}

async function importStudentsFromWorkbook(buffer, actor) {
  const rows = await readStudentRows(buffer);
  const classRows = await query("SELECT id, name FROM classes ORDER BY name");
  const classMap = new Map(classRows.map(cls => [classKey(cls.name), cls]));

  const created = [];
  const skipped = [];
  const failed = [];

  for (const row of rows) {
    const name = row.name;
    const nameResult = nameSchema.safeParse(name);
    if (!nameResult.success) {
      failed.push({ rowNumber: row.rowNumber, name, reason: nameResult.error.issues[0].message });
      continue;
    }
    if (!row.lastName) {
      failed.push({ rowNumber: row.rowNumber, name, reason: "Last name is required." });
      continue;
    }

    const cls = classMap.get(classKey(row.className));
    if (!cls) {
      failed.push({
        rowNumber: row.rowNumber,
        name,
        reason: `Class "${row.className || ""}" does not exist.`
      });
      continue;
    }

    const duplicate = await query(
      `SELECT id FROM users
        WHERE role = 'student' AND class_id = ? AND LOWER(name) = LOWER(?)
        LIMIT 1`,
      [cls.id, name]
    );
    if (duplicate.length) {
      skipped.push({ rowNumber: row.rowNumber, name, reason: "Already exists in this class." });
      continue;
    }

    let username = row.username;
    if (username) {
      const usernameResult = usernameSchema.safeParse(username);
      if (!usernameResult.success) {
        failed.push({ rowNumber: row.rowNumber, name, reason: usernameResult.error.issues[0].message });
        continue;
      }
      const existing = await query("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
      if (existing.length) {
        failed.push({ rowNumber: row.rowNumber, name, reason: `Username "${username}" is already in use.` });
        continue;
      }
    } else {
      username = await uniqueUsername(usernameBase(row.firstName, row.lastName, cls.name));
    }

    const password = temporaryPassword(row.firstName, row.lastName);
    const passwordHash = await hashPassword(password);

    await query(
      `INSERT INTO users (name, username, password_hash, role, class_id, must_change_password)
       VALUES (?, ?, ?, 'student', ?, 1)`,
      [name, username, passwordHash, cls.id]
    );

    created.push({
      rowNumber: row.rowNumber,
      name,
      className: cls.name,
      username,
      temporaryPassword: password
    });
  }

  if (created.length) {
    await logActivity(actor, `Imported ${created.length} student account(s) from Excel`);
  }

  return {
    created,
    skipped,
    failed,
    summary: {
      total: rows.length,
      created: created.length,
      skipped: skipped.length,
      failed: failed.length
    }
  };
}

module.exports = { importStudentsFromWorkbook, ExcelInputError };
