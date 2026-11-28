"use strict";

/**
 * School-wide Word Quest standings. This reads only word_scores documents;
 * exam submissions, attempts and Brain Sprint scores are never touched here.
 */

const { getManyByIds, listAll } = require("./fdb");
const {
  resolveLeaderboardPeriod,
  serializePeriod
} = require("./leaderboard");

function readTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inPeriod(score, period) {
  if (!period.start || !period.end) return true;
  const completedAt = readTimestamp(score.completed_at);
  return Boolean(completedAt && completedAt >= period.start && completedAt < period.end);
}

function tierFor(rank) {
  if (rank === 1) return { label: "Word Master", tone: "brand" };
  if (rank <= 3) return { label: "Seeker", tone: "ok" };
  if (rank <= 10) return { label: "Solver", tone: "neutral" };
  return { label: "Explorer", tone: "neutral" };
}

async function buildWordLeaderboard(viewerId = null, periodKey = "week") {
  const period = resolveLeaderboardPeriod(periodKey);
  const allScores = (await listAll("word_scores")).filter(score => inPeriod(score, period));
  const userIds = [...new Set(allScores.map(score => Number(score.student_id)))];
  const users = await getManyByIds("users", userIds);
  const userMap = new Map(users.map(user => [Number(user.id), user]));

  const byStudent = new Map();
  for (const score of allScores) {
    const studentId = Number(score.student_id);
    const user = userMap.get(studentId);
    if (!user || user.role !== "student" || user.active === false) continue;

    const row = byStudent.get(studentId) || {
      studentId,
      name: user.name || score.student_name || "Student",
      points: 0,
      bestScore: 0,
      rounds: 0
    };
    const points = Number(score.score) || 0;
    row.points += points;
    row.bestScore = Math.max(row.bestScore, points);
    row.rounds += 1;
    byStudent.set(studentId, row);
  }

  const ranked = [...byStudent.values()]
    .sort((a, b) =>
      b.points - a.points ||
      b.bestScore - a.bestScore ||
      b.rounds - a.rounds ||
      a.name.localeCompare(b.name)
    )
    .map((row, index) => {
      const rank = index + 1;
      const tier = tierFor(rank);
      return { rank, ...row, tier: tier.label, tierTone: tier.tone };
    });

  const viewerIdNumber = viewerId === null || viewerId === undefined ? null : Number(viewerId);
  const viewer = viewerIdNumber === null
    ? null
    : ranked.find(row => row.studentId === viewerIdNumber) || null;

  return {
    period: serializePeriod(period),
    leaderboard: ranked,
    roundsCount: allScores.length,
    you: viewer ? {
      rank: viewer.rank,
      name: viewer.name,
      points: viewer.points,
      bestScore: viewer.bestScore,
      rounds: viewer.rounds
    } : null
  };
}

module.exports = {
  buildWordLeaderboard
};
