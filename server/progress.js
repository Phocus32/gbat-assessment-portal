"use strict";

/**
 * Student reward progress, derived entirely from existing submission records.
 * Nothing is persisted: XP, levels, streaks and badges are recalculated from
 * the student's attempt history so they can never drift out of sync.
 */

const LEVEL_TITLES = [
  "Starter", "Explorer", "Scholar", "Rising star",
  "Achiever", "Champion", "Legend"
];

const DAY_MS = 24 * 60 * 60 * 1000;
const COMEBACK_GAP = 20;

function clampPct(value) {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Effort XP: every attempt earns something, accuracy and mastery earn more,
// and practice attempts count for half so exam results still feel special.
function xpForSubmission(submission, passMark) {
  const pct = clampPct(submission && submission.pct);
  let xp = Math.round(pct / 5) * 5;
  if (pct >= passMark) xp += 15;
  if (pct === 100) xp += 35;
  if (String(submission && submission.mode).toLowerCase() === "practice") {
    xp = Math.round(xp / 2);
  }
  return Math.max(5, xp);
}

// Triangular curve: level 2 at 100 XP, level 3 at 300, level 4 at 600, ...
function xpRequiredForLevel(level) {
  return 50 * level * (level - 1);
}

function levelForXp(xp) {
  let number = 1;
  while (number < 99 && xp >= xpRequiredForLevel(number + 1)) number += 1;
  const currentFloor = xpRequiredForLevel(number);
  const nextTarget = xpRequiredForLevel(number + 1);
  const xpForLevel = nextTarget - currentFloor;
  const xpIntoLevel = xp - currentFloor;
  return {
    number,
    title: LEVEL_TITLES[Math.min(number - 1, LEVEL_TITLES.length - 1)],
    xp,
    xpIntoLevel,
    xpForLevel,
    xpToNext: Math.max(0, nextTarget - xp),
    nextNumber: number + 1,
    progressPct: Math.min(100, Math.round((xpIntoLevel / xpForLevel) * 100))
  };
}

function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftDay(key, delta) {
  const stamp = Date.parse(`${key}T00:00:00Z`) + delta * DAY_MS;
  if (Number.isNaN(stamp)) return key;
  return dayKey(new Date(stamp));
}

function streakFromDates(keys) {
  const days = [...new Set(keys.filter(Boolean))].sort((a, b) => b.localeCompare(a));
  if (!days.length) return { current: 0, longest: 0, activeToday: false };

  const today = dayKey(new Date());
  const activeToday = days[0] === today;
  // Yesterday still counts so a streak survives until the day is over.
  let expected = activeToday ? days[0] : (days[0] === shiftDay(today, -1) ? days[0] : null);
  let current = 0;
  if (expected) {
    for (const day of days) {
      if (day > expected) continue;
      if (day < expected) break;
      current += 1;
      expected = shiftDay(expected, -1);
    }
  }

  let longest = 0;
  let run = 0;
  let previous = null;
  for (const day of [...days].reverse()) {
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  return { current, longest, activeToday };
}

function badge(id, icon, name, description, value, goal) {
  const earned = value >= goal;
  return {
    id,
    icon,
    name,
    description,
    earned,
    value: Math.min(value, goal),
    goal,
    progressPct: goal > 0 ? Math.min(100, Math.round((value / goal) * 100)) : 0,
    progressText: earned ? "Earned" : `${Math.max(0, value)} of ${goal}`
  };
}

function buildStudentProgress({ submissions = [], quizDocs = [], classQuizzes = [], passMark = 70 }) {
  const chronological = [...submissions].sort(
    (a, b) => new Date(a.submitted_at) - new Date(b.submitted_at)
  );

  const xp = chronological.reduce((sum, submission) => sum + xpForSubmission(submission, passMark), 0);

  const byQuiz = new Map();
  for (const submission of chronological) {
    const quizId = Number(submission.quiz_id);
    const bucket = byQuiz.get(quizId) || { best: -1, scores: [] };
    const pct = clampPct(submission.pct);
    bucket.best = Math.max(bucket.best, pct);
    bucket.scores.push(pct);
    byQuiz.set(quizId, bucket);
  }

  const bests = [...byQuiz.values()].map(bucket => bucket.best).filter(value => value >= 0);
  const passes = bests.filter(value => value >= passMark).length;
  const perfectScores = chronological.reduce(
    (count, submission) => count + (clampPct(submission.pct) === 100 ? 1 : 0), 0
  );

  let bestComeback = 0;
  for (const bucket of byQuiz.values()) {
    let lowest = Infinity;
    for (const score of bucket.scores) {
      if (score - lowest >= COMEBACK_GAP) bestComeback = Math.max(bestComeback, score - lowest);
      lowest = Math.min(lowest, score);
    }
  }

  const subjects = new Set(
    quizDocs
      .map(quiz => Number(quiz.subject_id))
      .filter(value => Number.isFinite(value))
  );
  const classQuizIds = new Set(
    classQuizzes.filter(quiz => !quiz.is_deleted).map(quiz => Number(quiz.id))
  );
  const completedInClass = [...classQuizIds].filter(id => byQuiz.has(id)).length;

  const streak = streakFromDates(chronological.map(submission => dayKey(submission.submitted_at)));
  const badges = [
    badge("first-steps", "🎯", "First steps", "Submit your first quiz.", chronological.length, 1),
    badge("perfect-score", "💯", "Bullseye", "Score 100% on any quiz.", perfectScores, 1),
    badge("on-a-roll", "🔥", "On a roll", "Keep a 3-day quiz streak.", streak.longest, 3),
    badge("week-warrior", "📅", "Week warrior", "Keep a 7-day quiz streak.", streak.longest, 7),
    badge("pass-parade", "✅", "Pass parade", `Pass 5 quizzes (${passMark}% or more).`, passes, 5),
    badge("comeback", "🚀", "Comeback kid", "Improve a quiz score by 20 points.", bestComeback >= COMEBACK_GAP ? 1 : 0, 1),
    badge("explorer", "🧭", "Explorer", "Try quizzes in 3 different subjects.", subjects.size, 3),
    badge("quiz-master", "🏆", "Quiz master", "Complete every quiz in your class.", completedInClass, Math.max(1, classQuizIds.size)),
    badge("dedicated", "⭐", "Dedicated", "Earn 1,000 XP in total.", xp, 1000)
  ];

  const nextBadge = badges
    .filter(item => !item.earned)
    .sort((a, b) => b.progressPct - a.progressPct || b.value - a.value)[0] || null;
  const earnedCount = badges.filter(item => item.earned).length;

  const nudge = !streak.current
    ? "Take a quiz today to start your streak!"
    : nextBadge
      ? `${nextBadge.name} · ${nextBadge.progressText}`
      : "Every badge earned — you're a legend!";

  return {
    level: levelForXp(xp),
    streak,
    badges,
    badgesEarned: earnedCount,
    badgeCount: badges.length,
    nextBadge,
    nudge,
    stats: {
      attempts: chronological.length,
      quizzesTaken: byQuiz.size,
      passes,
      perfectScores,
      subjects: subjects.size,
      longestStreak: streak.longest
    }
  };
}

module.exports = { buildStudentProgress, xpForSubmission, levelForXp, streakFromDates };
