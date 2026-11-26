"use strict";

/**
 * Brain Sprint puzzle generator and scoring rules.
 *
 * Puzzles are procedural and never read from the question bank. The server
 * generates each puzzle, keeps the answer key in the session document, and
 * sends only the public shape to the browser.
 */

const crypto = require("crypto");

const ROUND_SECONDS = 60;
const WRONG_PENALTY_MS = 5000;
const BASE_POINTS = 100;
const MULTIPLIER_STEP = 0.25;
const MAX_MULTIPLIER = 3;
const DAILY_BONUS_POINTS = 100;

const PUZZLE_TYPES = ["target", "sequence", "grid"];
const PUZZLE_LABELS = {
  target: "Number Target",
  sequence: "Sequence Snap",
  grid: "Pattern Grid"
};

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

function shuffle(values) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function optionValues(correct, candidates) {
  const unique = [correct];
  for (const value of candidates) {
    if (unique.length >= 4) break;
    if (!Number.isInteger(value) || value < 0 || unique.includes(value)) continue;
    unique.push(value);
  }
  // The generator always supplies enough candidates; this is only a safety net.
  let fallback = 1;
  while (unique.length < 4) {
    const value = correct + fallback;
    if (!unique.includes(value) && value >= 0) unique.push(value);
    fallback += 1;
  }
  const options = shuffle(unique).map(String);
  return { options, correctIndex: options.indexOf(String(correct)) };
}

function buildTarget() {
  const form = randomInt(0, 2);
  let expression;
  let target;

  if (form === 0) {
    const a = randomInt(2, 9);
    const b = randomInt(2, 9);
    const c = randomInt(1, 9);
    expression = `${a} × ${b} + ${c}`;
    target = a * b + c;
  } else if (form === 1) {
    const a = randomInt(2, 7);
    const b = randomInt(2, 6);
    const c = randomInt(2, 6);
    expression = `${a} × (${b} + ${c})`;
    target = a * (b + c);
  } else {
    const a = randomInt(3, 8);
    const b = randomInt(2, 7);
    const c = randomInt(2, 6);
    const d = randomInt(1, 5);
    expression = `(${a} + ${b}) × ${c} − ${d}`;
    target = (a + b) * c - d;
  }

  const candidates = shuffle([
    target - 1, target + 1, target - 2, target + 2,
    target - 3, target + 3, target - 10, target + 10
  ]);
  return {
    type: "target",
    label: PUZZLE_LABELS.target,
    prompt: "What value hits the target?",
    expression,
    ...optionValues(target, candidates)
  };
}

function buildSequence() {
  const geometric = randomInt(0, 1) === 1;
  let values;
  let next;
  let candidates;

  if (geometric) {
    const start = randomInt(2, 5);
    const factor = randomInt(2, 3);
    values = Array.from({ length: 5 }, (_, index) => start * factor ** index);
    next = values[4] * factor;
    candidates = [next + factor, next - factor, next * 2, next + 1, next - 1, next + factor * 2];
  } else {
    const start = randomInt(1, 12);
    const step = randomInt(2, 9);
    values = Array.from({ length: 5 }, (_, index) => start + step * index);
    next = start + step * 5;
    candidates = [next + step, next - step, next + 1, next - 1, next + step * 2, next + 2];
  }

  return {
    type: "sequence",
    label: PUZZLE_LABELS.sequence,
    prompt: "Which number comes next in the sequence?",
    sequence: values,
    ...optionValues(next, shuffle(candidates))
  };
}

function buildGrid() {
  const base = randomInt(1, 9);
  const rowStep = randomInt(1, 5);
  const colStep = randomInt(1, 5);
  const missingIndex = randomInt(0, 8);
  const solvedCells = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    return base + row * rowStep + column * colStep;
  });
  const correct = solvedCells[missingIndex];
  const cells = solvedCells.map((value, index) => index === missingIndex ? null : value);
  const candidates = shuffle([
    correct + rowStep, correct - rowStep, correct + colStep, correct - colStep,
    correct + 1, correct - 1, correct + 2, correct - 2
  ]);

  return {
    type: "grid",
    label: PUZZLE_LABELS.grid,
    prompt: "Which number completes the pattern?",
    cells,
    missingIndex,
    ...optionValues(correct, candidates)
  };
}

function createPuzzle(position, rotation = 0) {
  const type = PUZZLE_TYPES[(Number(position) + Number(rotation)) % PUZZLE_TYPES.length];
  const puzzle = type === "target" ? buildTarget()
    : type === "sequence" ? buildSequence()
      : buildGrid();
  return { position: Number(position), ...puzzle };
}

function publicPuzzle(puzzle) {
  if (!puzzle) return null;
  const { correctIndex, ...visible } = puzzle;
  return visible;
}

function multiplierForStreak(streak) {
  const earnedSteps = Math.max(0, Number(streak) || 0);
  return Math.min(MAX_MULTIPLIER, 1 + earnedSteps * MULTIPLIER_STEP);
}

function scoreForStreak(streak) {
  return Math.round(BASE_POINTS * multiplierForStreak(streak));
}

module.exports = {
  BASE_POINTS,
  DAILY_BONUS_POINTS,
  MAX_MULTIPLIER,
  MULTIPLIER_STEP,
  PUZZLE_TYPES,
  ROUND_SECONDS,
  WRONG_PENALTY_MS,
  createPuzzle,
  multiplierForStreak,
  publicPuzzle,
  scoreForStreak
};
