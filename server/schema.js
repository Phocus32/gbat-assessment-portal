"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { getSqliteDatabase, query } = require("./db");

const COLUMN_MIGRATIONS = [
  ["questions", "subject", "ALTER TABLE questions ADD COLUMN subject VARCHAR(120) NOT NULL DEFAULT 'General' AFTER solution"],
  ["quiz_questions", "subject", "ALTER TABLE quiz_questions ADD COLUMN subject VARCHAR(120) NOT NULL DEFAULT 'General' AFTER solution"],
  ["quizzes", "shuffle_questions", "ALTER TABLE quizzes ADD COLUMN shuffle_questions TINYINT(1) NOT NULL DEFAULT 0 AFTER minutes"],
  ["quiz_attempts", "question_order_json", "ALTER TABLE quiz_attempts ADD COLUMN question_order_json TEXT NULL AFTER mode"],
  ["questions", "diagram_svg", "ALTER TABLE questions ADD COLUMN diagram_svg MEDIUMTEXT NULL AFTER subject"],
  ["quiz_questions", "diagram_svg", "ALTER TABLE quiz_questions ADD COLUMN diagram_svg MEDIUMTEXT NULL AFTER subject"]
];

async function applySqliteSchema() {
  const schemaPath = path.join(__dirname, "..", "db", "sqlite-schema.sql");
  getSqliteDatabase().exec(fs.readFileSync(schemaPath, "utf8"));
}

async function applyMysqlSchema() {
  const mysql = require("mysql2/promise");
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  const { host, port, user, password, database, ssl } = config.db;

  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    ssl,
    multipleStatements: true,
    charset: "utf8mb4"
  });

  try {
    await connection.query(schema);
    for (const [table, column, statement] of COLUMN_MIGRATIONS) {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ? AND column_name = ?
          LIMIT 1`,
        [database, table, column]
      );
      if (!rows.length) {
        await connection.query(statement);
        console.log(`[gbat] Added ${table}.${column}.`);
      }
    }
  } finally {
    await connection.end();
  }
}

async function applySchema() {
  if (config.db.driver === "sqlite") {
    await applySqliteSchema();
  } else {
    await applyMysqlSchema();
  }
  // The settings seed is part of both schema files, but older databases may
  // not have it. Upsert it in a driver-neutral way.
  await query(
    `INSERT INTO settings (setting_key, setting_value)
     VALUES ('default_quiz_minutes', '45')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`
  );
}

module.exports = { applySchema };
