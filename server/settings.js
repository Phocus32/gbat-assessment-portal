"use strict";

/**
 * Admin-controlled portal settings.
 *
 * Every value lives in its own `settings/<key>` document so an admin change is
 * visible to every warm serverless instance on its next read. Numeric values
 * are stored as numbers (older installs kept `default_quiz_minutes` as a
 * string, so reads still coerce it).
 */

const { getSetting, setSetting } = require("./fdb");
const { toBoolean } = require("./utils");

const STORAGE_KEYS = {
  defaultQuizMinutes: "default_quiz_minutes",
  minQuizMinutes: "min_quiz_minutes",
  maxQuizMinutes: "max_quiz_minutes",
  minQuestions: "min_questions",
  maxQuestions: "max_questions",
  passMark: "pass_mark",
  maxAttempts: "max_attempts",
  requireApproval: "require_approval",
  showSolutions: "show_solutions",
  allowRetakes: "allow_retakes"
};

const NUMERIC_KEYS = new Set([
  "defaultQuizMinutes", "minQuizMinutes", "maxQuizMinutes",
  "minQuestions", "maxQuestions", "passMark", "maxAttempts"
]);

const BOOLEAN_KEYS = new Set(["requireApproval", "showSolutions", "allowRetakes"]);

// Settings are read on nearly every request but written rarely. A short TTL
// removes the ten Firestore reads per request without making an admin change
// stale for long; saveSettings() invalidates immediately for the same instance.
const CACHE_TTL_MS = 5000;
let cachedSettings = null;
let cacheExpiresAt = 0;

function invalidateSettingsCache() {
  cachedSettings = null;
  cacheExpiresAt = 0;
}

const DEFAULTS = {
  defaultQuizMinutes: 45,
  minQuizMinutes: 1,
  maxQuizMinutes: 240,
  minQuestions: 1,
  maxQuestions: 200,
  passMark: 50,
  maxAttempts: 0,
  requireApproval: false,
  showSolutions: true,
  allowRetakes: true
};

function coerce(key, value) {
  if (value === null || value === undefined) return DEFAULTS[key];
  if (NUMERIC_KEYS.has(key)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : DEFAULTS[key];
  }
  if (BOOLEAN_KEYS.has(key)) return toBoolean(value) || value === "true";
  return value;
}

async function getSettings() {
  if (cachedSettings && Date.now() < cacheExpiresAt) return { ...cachedSettings };

  const entries = await Promise.all(
    Object.entries(STORAGE_KEYS).map(async ([key, docKey]) => [key, await getSetting(docKey)])
  );
  const output = {};
  for (const [key, value] of entries) output[key] = coerce(key, value);
  cachedSettings = output;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return { ...output };
}

async function ensureSettings() {
  for (const [key, docKey] of Object.entries(STORAGE_KEYS)) {
    if ((await getSetting(docKey)) === null) await setSetting(docKey, DEFAULTS[key]);
  }
  invalidateSettingsCache();
}

async function saveSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(STORAGE_KEYS, key)) continue;
    await setSetting(STORAGE_KEYS[key], coerce(key, value));
  }
  invalidateSettingsCache();
}

module.exports = {
  DEFAULTS,
  STORAGE_KEYS,
  getSettings,
  ensureSettings,
  saveSettings
};
