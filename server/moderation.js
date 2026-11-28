"use strict";

/**
 * Lightweight, deterministic filters for class discussion posts.
 *
 * These are deliberately conservative: posts appear immediately, but obviously
 * abusive or spammy text is rejected before it is stored. Staff can still hide
 * anything that slips through, and every post can be reported by classmates.
 */

const PROFANITY = [
  "asshole", "bastard", "bitch", "bullshit", "cunt", "damn", "dick",
  "fuck", "fucking", "idiot", "nigger", "piss", "shit", "slut", "stupid", "whore"
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasProfanity(text) {
  return PROFANITY.some(word => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text));
}

function hasSpamPatterns(text) {
  if (/(.)\1{6,}/i.test(text)) return true;
  if (/\b(\w{3,})(?:\s+\1){3,}\b/i.test(text)) return true;

  const urls = text.match(/https?:\/\//gi) || [];
  if (urls.length > 2) return true;

  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 20) {
    const upper = (letters.match(/[A-Z]/g) || []).length;
    if (upper / letters.length > 0.65) return true;
  }

  return false;
}

/**
 * @param {string} value
 * @returns {{ok: true}|{ok: false, reason: string, message: string}}
 */
function checkDiscussionText(value) {
  const text = String(value || "").trim();

  if (hasProfanity(text)) {
    return {
      ok: false,
      reason: "profanity",
      message: "Please rephrase without insults or strong language."
    };
  }

  if (hasSpamPatterns(text)) {
    return {
      ok: false,
      reason: "spam",
      message: "That looks like spam. Try writing a shorter, original message."
    };
  }

  return { ok: true };
}

module.exports = {
  PROFANITY,
  checkDiscussionText
};
