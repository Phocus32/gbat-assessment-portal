"use strict";

/**
 * AI Guide endpoint.
 *
 * The browser sends only a short question and a mode. It never sends quiz
 * questions, options, solutions or Brain Sprint puzzle state. The safety gate
 * runs before Gemini, and every turn is logged for staff review.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const config = require("../config");
const { insertDoc, listAll, listWhereIn } = require("../fdb");
const { allowedClassIds } = require("../class-access");
const { requireAnyRole } = require("../security");
const { asyncHandler } = require("../utils");
const { evaluatePrompt } = require("../ai-safety");
const { generateText } = require("../gemini");
const { aiGuideSchema } = require("../validation");

const router = express.Router();
const STAFF_ROLES = ["admin", "teacher"];

const askLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user && req.user.id ? req.user.id : "unknown"),
  handler: (req, res) => res.status(429).json({
    error: "You have asked a lot of questions recently. Please wait a few minutes."
  })
});

function toIso(value) {
  return value instanceof Date ? value.toISOString() : (value ? String(value) : null);
}

async function safeLog(record) {
  try {
    await insertDoc("ai_guide_logs", {
      ...record,
      created_at: new Date()
    }, "ai_guide_logs");
  } catch {
    // A logging failure must not break the guide for the user.
  }
}

function classIdForUser(user) {
  return user.role === "student" && user.class_id !== null && user.class_id !== undefined
    ? Number(user.class_id)
    : null;
}

function presentLog(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    userName: row.user_name,
    userRole: row.user_role,
    classId: row.class_id === null || row.class_id === undefined ? null : Number(row.class_id),
    mode: row.mode,
    prompt: row.prompt,
    reply: row.reply,
    decision: row.decision,
    reason: row.reason,
    blocked: Boolean(row.blocked),
    configured: Boolean(row.configured),
    provider: row.provider || "gemini",
    model: row.model || null,
    interactionId: row.interaction_id || null,
    createdAt: toIso(row.created_at)
  };
}

router.post("/ask", askLimiter, asyncHandler(async (req, res) => {
  const input = aiGuideSchema.parse(req.body);
  const prompt = input.topic ? `Topic: ${input.topic}\nQuestion: ${input.prompt}` : input.prompt;
  const gate = evaluatePrompt(prompt, input.mode);
  const configured = Boolean(config.googleApiKey);

  if (gate.decision !== "allow") {
    await safeLog({
      user_id: req.user.id,
      user_name: req.user.name,
      user_role: req.user.role,
      class_id: classIdForUser(req.user),
      mode: input.mode,
      prompt,
      reply: gate.reply,
      decision: gate.decision,
      reason: gate.reason,
      blocked: true,
      configured
    });
    return res.json({
      reply: gate.reply,
      blocked: true,
      decision: gate.decision,
      reason: gate.reason,
      configured,
      model: null
    });
  }

  let result;
  try {
    result = await generateText({
      prompt,
      mode: input.mode,
      maxOutputTokens: config.aiMaxOutputTokens
    });
  } catch (error) {
    await safeLog({
      user_id: req.user.id,
      user_name: req.user.name,
      user_role: req.user.role,
      class_id: classIdForUser(req.user),
      mode: input.mode,
      prompt,
      reply: error.message,
      decision: "error",
      reason: "provider_error",
      blocked: false,
      configured
    });
    throw error;
  }

  await safeLog({
    user_id: req.user.id,
    user_name: req.user.name,
    user_role: req.user.role,
    class_id: classIdForUser(req.user),
    mode: input.mode,
    prompt,
    reply: result.text,
    decision: result.configured ? "allow" : "no_key",
    reason: result.configured ? "allowed" : "missing_api_key",
    blocked: false,
    configured: result.configured,
    provider: "gemini",
    model: result.model,
    interaction_id: result.interactionId
  });

  return res.json({
    reply: result.text,
    blocked: false,
    decision: result.configured ? "allow" : "no_key",
    reason: result.configured ? "allowed" : "missing_api_key",
    configured: result.configured,
    model: result.model
  });
}));

router.get("/logs", requireAnyRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  let rows;
  if (req.user.role === "admin") {
    rows = await listAll("ai_guide_logs");
  } else {
    const allowed = [...(await allowedClassIds(req.user))];
    const [classRows, ownRows] = await Promise.all([
      allowed.length ? listWhereIn("ai_guide_logs", "class_id", allowed) : Promise.resolve([]),
      listWhereIn("ai_guide_logs", "user_id", [req.user.id])
    ]);
    const seen = new Set();
    rows = [...classRows, ...ownRows].filter(row => {
      if (seen.has(Number(row.id))) return false;
      seen.add(Number(row.id));
      return true;
    });
  }

  rows.sort((a, b) => Number(b.id) - Number(a.id));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  return res.json({ logs: rows.slice(0, limit).map(presentLog) });
}));

module.exports = router;
