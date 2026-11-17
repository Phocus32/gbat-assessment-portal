"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * The application was originally written for MySQL. This module keeps the
 * exact same `query()` / `withTransaction()` contract while translating the
 * handful of MySQL-specific expressions to SQLite. That lets the whole app
 * run as a single process with one database file and no external service.
 */

let sqliteDatabase = null;
let mysqlPool = null;

function getMysqlPool() {
  if (mysqlPool) return mysqlPool;
  const mysql = require("mysql2/promise");
  const { host, port, user, password, database, connectionLimit, ssl } = config.db;
  mysqlPool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    ssl,
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    charset: "utf8mb4",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false
  });
  return mysqlPool;
}

function getSqliteDatabase() {
  if (sqliteDatabase) return sqliteDatabase;

  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
  sqliteDatabase = new DatabaseSync(config.db.path);
  sqliteDatabase.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  return sqliteDatabase;
}

function translateDateAdd(expression, amount, unit) {
  return `datetime(${expression}, '+' || (${amount}) || ' ${unit.toLowerCase()}s')`;
}

function translateTimestampDiff(expression) {
  return `CAST((julianday(${expression}) - julianday(CURRENT_TIMESTAMP)) * 86400 AS INTEGER)`;
}

function translateSql(sql) {
  let translated = sql;

  // TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(expires_at, INTERVAL ? SECOND))
  translated = translated.replace(
    /TIMESTAMPDIFF\(\s*SECOND\s*,\s*NOW\(\)\s*,\s*DATE_ADD\(([^)]*)\)\s*\)/gi,
    (_match, dateAddArgs) => {
      const nested = `DATE_ADD(${dateAddArgs})`;
      const inner = nested.replace(
        /DATE_ADD\(\s*(NOW\(\)|[a-z_][\w.]*)\s*,\s*INTERVAL\s+(\?|\d+)\s+(MINUTE|SECOND|HOUR|DAY)\s*\)/gi,
        (_m, expression, amount, unit) => translateDateAdd(expression, amount, unit)
      );
      return translateTimestampDiff(inner);
    }
  );

  // TIMESTAMPDIFF(SECOND, NOW(), expires_at)
  translated = translated.replace(
    /TIMESTAMPDIFF\(\s*SECOND\s*,\s*NOW\(\)\s*,\s*([a-z_][\w.]*)\s*\)/gi,
    (_match, expression) => translateTimestampDiff(expression)
  );

  // DATE_ADD(NOW(), INTERVAL ? MINUTE) / DATE_ADD(a.expires_at, INTERVAL ? SECOND)
  translated = translated.replace(
    /DATE_ADD\(\s*(NOW\(\)|[a-z_][\w.]*)\s*,\s*INTERVAL\s+(\?|\d+)\s+(MINUTE|SECOND|HOUR|DAY)\s*\)/gi,
    (_match, expression, amount, unit) => translateDateAdd(expression, amount, unit)
  );

  translated = translated.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");
  translated = translated.replace(/\bGREATEST\s*\(/gi, "MAX(");

  translated = translated.replace(
    /ORDER BY FIELD\(u\.role,\s*'admin',\s*'teacher',\s*'student'\)/i,
    "ORDER BY CASE u.role WHEN 'admin' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END"
  );

  translated = translated.replace(
    /ON DUPLICATE KEY UPDATE setting_value = VALUES\(setting_value\)/i,
    "ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value"
  );

  // SQLite does integer division for INTEGER / INTEGER; force a real ratio.
  translated = translated.replace(
    /SUM\(sa\.is_correct\) \/ COUNT\(sa\.id\)/gi,
    "CAST(SUM(sa.is_correct) AS REAL) / COUNT(sa.id)"
  );

  return translated;
}

function normalizeParams(params) {
  return (params || []).map(value => (value === undefined ? null : value));
}

function normalizeSqliteError(error) {
  const message = String(error && error.message ? error.message : "");
  const code = String(error && error.code ? error.code : "");
  error.sqliteCode = code;
  if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message) || code.includes("CONSTRAINT_UNIQUE")) {
    error.code = "ER_DUP_ENTRY";
  } else if (/FOREIGN KEY constraint failed/i.test(message) || code.includes("CONSTRAINT_FOREIGNKEY")) {
    error.code = "ER_NO_REFERENCED_ROW_2";
  }
  return error;
}

function sqliteWriteResult(runResult) {
  return {
    insertId: Number(runResult.lastInsertRowid),
    affectedRows: Number(runResult.changes)
  };
}

async function query(sql, params = []) {
  if (config.db.driver === "mysql") {
    const pool = getMysqlPool();
    const [rows] = await pool.execute(sql, params);
    return rows;
  }

  const database = getSqliteDatabase();
  const translated = translateSql(sql);
  const values = normalizeParams(params);

  try {
    if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(translated)) {
      return database.prepare(translated).all(...values);
    }

    const result = sqliteWriteResult(database.prepare(translated).run(...values));
    // The array shape keeps `const [result] = await query(...)` working;
    // the properties keep `const result = await query(...); result.insertId`.
    const rows = [];
    rows.insertId = result.insertId;
    rows.affectedRows = result.affectedRows;
    rows.result = result;
    return rows;
  } catch (error) {
    throw normalizeSqliteError(error);
  }
}

const sqliteConnection = {
  async execute(sql, params = []) {
    const database = getSqliteDatabase();
    try {
      const result = database.prepare(translateSql(sql)).run(...normalizeParams(params));
      return [sqliteWriteResult(result)];
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }
};

async function withTransaction(work) {
  if (config.db.driver === "mysql") {
    const pool = getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const database = getSqliteDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = await work(sqliteConnection);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors; the original error is more useful.
    }
    throw error;
  }
}

async function close() {
  if (config.db.driver === "mysql") {
    if (mysqlPool) await mysqlPool.end();
    mysqlPool = null;
    return;
  }
  if (sqliteDatabase) sqliteDatabase.close();
  sqliteDatabase = null;
}

const pool = {
  async end() {
    await close();
  }
};

module.exports = {
  query,
  withTransaction,
  pool,
  close,
  getSqliteDatabase,
  translateSql,
  driver: config.db.driver
};
