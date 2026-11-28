"use strict";

/**
 * Word Quest puzzle generator and scoring rules.
 *
 * Boards are procedural and never read from the question bank. The server
 * keeps each word's placement in the session document and only sends the
 * letters, clues and target words to the browser.
 */

const crypto = require("crypto");

const GRID_SIZE = 10;
const WORD_COUNT = 7;
const ROUND_SECONDS = 90;
const BASE_POINTS = 60;
const COMBO_STEP = 0.25;
const MAX_MULTIPLIER = 2.5;
const WRONG_PENALTY_MS = 3000;
const HINT_COST = 30;
const DAILY_BONUS_POINTS = 100;

const WORD_BANK = [
  { word: "FOCUS", clue: "Give your full attention" },
  { word: "MEMORY", clue: "What helps you recall facts" },
  { word: "NOTES", clue: "What you write while studying" },
  { word: "REVIEW", clue: "Go over material again" },
  { word: "PRACTICE", clue: "Repeated work that builds skill" },
  { word: "SKILL", clue: "Something you improve with practice" },
  { word: "GOAL", clue: "A target you aim for" },
  { word: "CURIOSITY", clue: "The spark behind good questions" },
  { word: "PROGRESS", clue: "How far you have come" },
  { word: "LEARN", clue: "Gain new knowledge" },
  { word: "SOLVE", clue: "Find the answer" },
  { word: "PATTERN", clue: "Something that repeats" },
  { word: "BRAIN", clue: "Your thinking organ" },
  { word: "FRACTION", clue: "Part of a whole" },
  { word: "GRAVITY", clue: "The force that pulls objects down" },
  { word: "SOLAR", clue: "Powered by the sun" }
];

const DIRECTIONS = [
  [0, 1], [1, 0], [1, 1], [1, -1],
  [0, -1], [-1, 0], [-1, 1], [-1, -1]
];

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

function cellIndex(row, col) {
  return row * GRID_SIZE + col;
}

function cellsFor(startRow, startCol, direction, length) {
  const [rowStep, colStep] = direction;
  const endRow = startRow + rowStep * (length - 1);
  const endCol = startCol + colStep * (length - 1);
  if (endRow < 0 || endRow >= GRID_SIZE || endCol < 0 || endCol >= GRID_SIZE) return null;

  return Array.from({ length }, (_, index) => {
    const row = startRow + rowStep * index;
    const col = startCol + colStep * index;
    return cellIndex(row, col);
  });
}

function placeWord(grid, word) {
  const options = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < GRID_SIZE; col += 1) {
      for (const direction of DIRECTIONS) {
        const cells = cellsFor(row, col, direction, word.length);
        if (!cells) continue;
        const valid = cells.every((index, position) => {
          const letter = grid[Math.floor(index / GRID_SIZE)][index % GRID_SIZE];
          return !letter || letter === word[position];
        });
        if (valid) options.push(cells);
      }
    }
  }
  if (!options.length) return null;

  const cells = pick(shuffle(options));
  cells.forEach((index, position) => {
    grid[Math.floor(index / GRID_SIZE)][index % GRID_SIZE] = word[position];
  });
  return cells;
}

function buildPuzzle() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const grid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(""));
    const entries = shuffle(WORD_BANK)
      .slice(0, WORD_COUNT)
      .sort((a, b) => b.word.length - a.word.length);
    const words = [];
    let placedAll = true;

    for (const entry of entries) {
      const cells = placeWord(grid, entry.word);
      if (!cells) {
        placedAll = false;
        break;
      }
      words.push({ word: entry.word, clue: entry.clue, cells, found: false });
    }
    if (!placedAll) continue;

    for (let row = 0; row < GRID_SIZE; row += 1) {
      for (let col = 0; col < GRID_SIZE; col += 1) {
        if (!grid[row][col]) grid[row][col] = String.fromCharCode(65 + randomInt(0, 25));
      }
    }

    return {
      size: GRID_SIZE,
      rows: grid.map(row => row.join("")),
      words
    };
  }
  throw new Error("Unable to build a word puzzle right now. Please start another round.");
}

function publicWords(words) {
  return (words || []).map(entry => ({
    word: entry.word,
    clue: entry.clue,
    length: entry.word.length,
    found: Boolean(entry.found),
    hintIndex: Number.isInteger(entry.hintIndex) ? entry.hintIndex : null
  }));
}

function multiplierForCombo(combo) {
  return Math.min(MAX_MULTIPLIER, 1 + Math.max(0, Number(combo) || 0) * COMBO_STEP);
}

function pointsForCombo(combo) {
  return Math.round(BASE_POINTS * multiplierForCombo(combo));
}

function sameCells(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const forward = right.every((value, index) => Number(value) === Number(left[index]));
  const backward = right.every((value, index) => Number(value) === Number(left[left.length - 1 - index]));
  return forward || backward;
}

module.exports = {
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
  pointsForCombo,
  publicWords,
  sameCells
};
