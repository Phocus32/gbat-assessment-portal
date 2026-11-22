"use strict";

/**
 * Shared helpers for optional quiz start/end windows.
 *
 * A blank begin or end means "no restriction" on that side. Timestamps are
 * stored as Firestore Timestamps and surfaced as JS Dates by the data layer.
 */

function readDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function assertQuizWindow(startAt, endAt) {
  const start = readDate(startAt);
  const end = readDate(endAt);
  if (start && end && end.getTime() <= start.getTime()) {
    const error = new Error("Quiz end time must be after the begin time.");
    error.status = 400;
    throw error;
  }
  return { startAt: start, endAt: end };
}

/** `ready` means the date window itself is not blocking access. */
function quizWindow(quiz, now = new Date()) {
  const startAt = readDate(quiz && quiz.start_at);
  const endAt = readDate(quiz && quiz.end_at);
  const time = now.getTime();
  let state = "ready";

  if (startAt && time < startAt.getTime()) state = "scheduled";
  else if (endAt && time >= endAt.getTime()) state = "expired";

  return { startAt, endAt, state, available: state === "ready" };
}

/** Exam attempts must never run past a scheduled quiz end. */
function effectiveDeadline(quiz, fallback) {
  const { endAt } = quizWindow(quiz);
  if (!endAt) return fallback;
  return endAt.getTime() < fallback.getTime() ? new Date(endAt.getTime()) : fallback;
}

function whenText(date) {
  return readDate(date).toLocaleString();
}

module.exports = {
  assertQuizWindow,
  effectiveDeadline,
  quizWindow,
  readDate,
  whenText
};
