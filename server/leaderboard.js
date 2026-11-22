"use strict";

const { listWhere, listWhereIn } = require("./fdb");
const { toBoolean } = require("./utils");

/**
 * Ranking rules are shared by the student endpoint and the read-only staff
 * view: each student's best percentage per non-archived class quiz is added.
 * That rewards both accuracy and completing more quizzes.
 */
function leaderboardTier(rank, points) {
  if (points <= 0) return { label: "Up & coming", tone: "warn" };
  if (rank === 1) return { label: "Champion", tone: "brand" };
  if (rank <= 3) return { label: "Star", tone: "ok" };
  if (rank <= 10) return { label: "Achiever", tone: "neutral" };
  return { label: "Climber", tone: "neutral" };
}

async function buildClassLeaderboard(cls, viewerId = null) {
  if (!cls) {
    return { class: null, quizCount: 0, leaderboard: [], you: null };
  }

  const classId = Number(cls.id);
  const classQuizzes = (await listWhere("quizzes", "class_id", classId))
    .filter(quiz => !quiz.is_deleted);
  const quizIds = classQuizzes.map(quiz => Number(quiz.id));

  const [members, submissions] = await Promise.all([
    listWhere("users", "class_id", classId),
    quizIds.length ? listWhereIn("submissions", "quiz_id", quizIds) : Promise.resolve([])
  ]);

  const students = members
    .filter(user => user.role === "student" && toBoolean(user.active))
    .sort((a, b) => a.name.localeCompare(b.name));

  const quizSet = new Set(quizIds);
  const bestByStudent = new Map();
  for (const submission of submissions) {
    const ownerId = Number(submission.student_id);
    const quizId = Number(submission.quiz_id);
    if (!quizSet.has(quizId)) continue;
    let bests = bestByStudent.get(ownerId);
    if (!bests) {
      bests = new Map();
      bestByStudent.set(ownerId, bests);
    }
    const pct = Number(submission.pct) || 0;
    if (pct > (bests.get(quizId) || -1)) bests.set(quizId, pct);
  }

  const ranked = students.map(student => {
    const sid = Number(student.id);
    const bests = bestByStudent.get(sid) || new Map();
    const pointList = [...bests.values()];
    return {
      studentId: sid,
      name: student.name,
      points: pointList.reduce((sum, value) => sum + value, 0),
      quizzesTaken: bests.size
    };
  });

  ranked.sort((a, b) =>
    b.points - a.points ||
    b.quizzesTaken - a.quizzesTaken ||
    a.name.localeCompare(b.name)
  );

  const leaderboard = ranked.map((row, index) => {
    const rank = index + 1;
    const tier = leaderboardTier(rank, row.points);
    return { rank, ...row, tier: tier.label, tierTone: tier.tone };
  });

  const me = viewerId === null || viewerId === undefined
    ? null
    : leaderboard.find(row => row.studentId === Number(viewerId)) || null;

  return {
    class: { id: Number(cls.id), name: cls.name },
    quizCount: quizIds.length,
    leaderboard,
    you: me ? {
      rank: me.rank,
      name: me.name,
      points: me.points,
      quizzesTaken: me.quizzesTaken
    } : null
  };
}

module.exports = { buildClassLeaderboard, leaderboardTier };
