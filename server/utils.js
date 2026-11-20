"use strict";

const crypto = require("crypto");
const { insertDoc } = require("./fdb");

function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function toBoolean(value) {
  return value === true || value === 1 || value === "1";
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    classId: row.class_id === null || row.class_id === undefined ? null : row.class_id,
    className: row.class_name || null,
    active: toBoolean(row.active),
    mustChangePassword: toBoolean(row.must_change_password)
  };
}

function parseOptions(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function generateTemporaryPassword(length = 16) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const all = upper + lower + digits + symbols;
  const chars = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)]
  ];

  while (chars.length < length) {
    chars.push(all[crypto.randomInt(all.length)]);
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function logActivity(actor, action, context = {}) {
  const isActorObject = actor && typeof actor === "object";
  const actorName = isActorObject ? (actor.name || actor.username || "System") : (typeof actor === "string" ? actor : "System");
  const actorId = isActorObject ? actor.id : null;

  const record = {
    actor_user_id: actorId,
    actor_name: String(actorName).slice(0, 120),
    action: String(action).slice(0, 255),
    created_at: new Date()
  };

  // Optional context used for security events. Only known fields are copied so
  // callers cannot inject arbitrary metadata into the activity log.
  if (context && typeof context === "object") {
    if (context.event !== undefined) record.event = String(context.event).slice(0, 64);
    if (context.ip !== undefined) record.ip = String(context.ip).slice(0, 64);
    if (context.userAgent !== undefined) record.user_agent = String(context.userAgent).slice(0, 255);
    if (context.username !== undefined) record.username = String(context.username).slice(0, 120);
    if (context.outcome !== undefined) record.outcome = String(context.outcome).slice(0, 64);
  }

  await insertDoc("activity_logs", record, "logs");
}

function dateTimeLabel(value) {
  if (!value) return "";
  return String(value).replace("T", " ").slice(0, 16);
}

module.exports = {
  asyncHandler,
  toBoolean,
  publicUser,
  parseOptions,
  generateTemporaryPassword,
  csvCell,
  logActivity,
  dateTimeLabel
};
