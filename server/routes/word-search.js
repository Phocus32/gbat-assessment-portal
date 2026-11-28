"use strict";

const express = require("express");
const {
  BASE_POINTS,
  COMBO_STEP,
  DAILY_BONUS_POINTS,
  GRID_SIZE,
  HINT_COST,
  MAX_MULTIPLIER,
  ROUND_SECONDS,
  WORD_COUNT,
  WRONG_PENALTY_MS,
  buildPuzzle,
  multiplierForCombo,
  publicWords
} = require("../word-search");
const {
  findActiveWordSession,
  findWord,
  finishWordSession,
  hintWord,
  startWordSession
} = require("../word-store");
const { buildWordLeaderboard } = require("../word-leaderboard");
const { asyncHandler } = require("../utils");
const {
  leaderboardPeriodSchema,
  wordFindSchema,
  wordFinishSchema,
  wordHintSchema
} = require("../validation");

const router = express.Router();

const RULES = {
  roundSeconds: ROUND_SECONDS,
  gridSize: GRID_SIZE,
  wordCount: WORD_COUNT,
  basePoints: BASE_POINTS,
  comboStep: COMBO_STEP,
  maxMultiplier: MAX_MULTIPLIER,
  wrongPenaltySeconds: WRONG_PENALTY_MS / 1000,
  hintCost: HINT_COST,
  dailyBonusPoints: DAILY_BONUS_POINTS
};

function serializeSession(session) {
  if (!session) return null;
  const words = session.puzzle.words || [];
  const endsAt = session.ends_at instanceof Date ? session.ends_at : new Date(session.ends_at);

  return {
    sessionId: Number(session.id),
    status: session.status,
    size: Number(session.puzzle.size || GRID_SIZE),
    rows: session.puzzle.rows,
    words: publicWords(words),
    score: Number(session.score || 0),
    combo: Number(session.combo || 0),
    bestCombo: Number(session.best_combo || 0),
    found: Number(session.found || 0),
    total: words.length,
    wrong: Number(session.wrong || 0),
    hintsUsed: Number(session.hints_used || 0),
    penaltySeconds: Number(session.penalty_ms || 0) / 1000,
    foundCells: words.filter(entry => entry.found).flatMap(entry => entry.cells),
    endsAt: endsAt.toISOString(),
    secondsRemaining: Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 1000))
  };
}

function serializeAnswer(answer) {
  return {
    ...answer,
    penaltySeconds: answer.penaltyMs / 1000
  };
}

router.get("/session", asyncHandler(async (req, res) => {
  const session = await findActiveWordSession(req.user.id);
  return res.json({ session: serializeSession(session), rules: RULES });
}));

router.post("/start", asyncHandler(async (req, res) => {
  const { session } = await startWordSession({
    studentId: req.user.id,
    studentName: req.user.name,
    puzzle: buildPuzzle()
  });
  return res.json({ session: serializeSession(session), rules: RULES });
}));

router.post("/find", asyncHandler(async (req, res) => {
  const input = wordFindSchema.parse(req.body);
  const result = await findWord({
    sessionId: input.sessionId,
    studentId: req.user.id,
    word: input.word.toUpperCase(),
    cells: input.cells
  });
  return res.json({
    session: serializeSession(result.session),
    answer: serializeAnswer(result.answer)
  });
}));

router.post("/hint", asyncHandler(async (req, res) => {
  const input = wordHintSchema.parse(req.body);
  const result = await hintWord({
    sessionId: input.sessionId,
    studentId: req.user.id
  });
  return res.json({
    session: serializeSession(result.session),
    hint: result.hint
  });
}));

router.post("/finish", asyncHandler(async (req, res) => {
  const input = wordFinishSchema.parse(req.body);
  const result = await finishWordSession({
    sessionId: input.sessionId,
    studentId: req.user.id
  });
  const score = result.score;
  return res.json({
    alreadyFinished: result.alreadyFinished,
    summary: {
      sessionId: Number(score.session_id),
      score: Number(score.score),
      baseScore: Number(score.base_score),
      dailyBonus: Number(score.daily_bonus),
      found: Number(score.found),
      totalWords: Number(score.total_words),
      wrong: Number(score.wrong),
      hintsUsed: Number(score.hints_used),
      bestCombo: Number(score.best_combo),
      completedAt: score.completed_at,
      durationMs: Number(score.duration_ms)
    }
  });
}));

// Separate school-wide board. It reads word_scores only and has no connection
// to exams, attempts, class standings or Brain Sprint.
router.get("/leaderboard", asyncHandler(async (req, res) => {
  const periodKey = leaderboardPeriodSchema.parse(req.query.period);
  return res.json(await buildWordLeaderboard(req.user.id, periodKey));
}));

module.exports = router;
