"use strict";

const crypto = require("crypto");
const express = require("express");
const {
  BASE_POINTS,
  DAILY_BONUS_POINTS,
  MAX_MULTIPLIER,
  MULTIPLIER_STEP,
  ROUND_SECONDS,
  WRONG_PENALTY_MS,
  createPuzzle,
  multiplierForStreak,
  publicPuzzle
} = require("../game");
const {
  findActiveGameSession,
  finishGameSession,
  startGameSession,
  answerGameSession
} = require("../game-store");
const { buildGameLeaderboard } = require("../game-leaderboard");
const { asyncHandler } = require("../utils");
const {
  gameAnswerSchema,
  gameFinishSchema,
  leaderboardPeriodSchema
} = require("../validation");

const router = express.Router();

const RULES = {
  roundSeconds: ROUND_SECONDS,
  basePoints: BASE_POINTS,
  multiplierStep: MULTIPLIER_STEP,
  maxMultiplier: MAX_MULTIPLIER,
  wrongPenaltySeconds: WRONG_PENALTY_MS / 1000,
  dailyBonusPoints: DAILY_BONUS_POINTS
};

function serializeSession(session) {
  if (!session) return null;
  const endsAt = session.ends_at instanceof Date ? session.ends_at : new Date(session.ends_at);
  return {
    sessionId: Number(session.id),
    status: session.status,
    position: Number(session.position || 0),
    puzzle: publicPuzzle(session.puzzle),
    score: Number(session.score || 0),
    streak: Number(session.streak || 0),
    bestStreak: Number(session.best_streak || 0),
    multiplier: multiplierForStreak(session.streak || 0),
    answered: Number(session.answered || 0),
    correct: Number(session.correct || 0),
    wrong: Number(session.wrong || 0),
    penaltySeconds: Number(session.penalty_ms || 0) / 1000,
    endsAt: endsAt.toISOString(),
    secondsRemaining: Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 1000))
  };
}

function serializeAnswer(answer, session) {
  return {
    ...answer,
    penaltySeconds: answer.penaltyMs / 1000,
    nextMultiplier: multiplierForStreak(session.streak || 0)
  };
}

router.get("/session", asyncHandler(async (req, res) => {
  const session = await findActiveGameSession(req.user.id);
  return res.json({ session: serializeSession(session), rules: RULES });
}));

router.post("/start", asyncHandler(async (req, res) => {
  const rotation = crypto.randomInt(0, 3);
  const { session } = await startGameSession({
    studentId: req.user.id,
    studentName: req.user.name,
    rotation,
    initialPuzzle: createPuzzle(0, rotation)
  });
  return res.json({ session: serializeSession(session), rules: RULES });
}));

router.post("/answer", asyncHandler(async (req, res) => {
  const input = gameAnswerSchema.parse(req.body);
  const result = await answerGameSession({
    sessionId: input.sessionId,
    studentId: req.user.id,
    position: input.position,
    chosenIndex: input.chosenIndex
  });
  return res.json({
    session: serializeSession(result.session),
    answer: serializeAnswer(result.answer, result.session)
  });
}));

router.post("/finish", asyncHandler(async (req, res) => {
  const input = gameFinishSchema.parse(req.body);
  const result = await finishGameSession({
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
      answered: Number(score.answered),
      correct: Number(score.correct),
      wrong: Number(score.wrong),
      bestStreak: Number(score.best_streak),
      completedAt: score.completed_at
    }
  });
}));

// Separate school-wide board. It reads game_scores only and has no connection
// to exam submissions, attempts, or the class leaderboard.
router.get("/leaderboard", asyncHandler(async (req, res) => {
  const periodKey = leaderboardPeriodSchema.parse(req.query.period);
  return res.json(await buildGameLeaderboard(req.user.id, periodKey));
}));

module.exports = router;
