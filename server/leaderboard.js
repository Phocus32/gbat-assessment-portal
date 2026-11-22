"use strict";

const { listWhere, listWhereIn } = require("./fdb");
const { toBoolean } = require("./utils");

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_LABELS = {
  week: "This week",
  "last-week": "Last week",
  all: "All time"
};

/**
 * Ranking rules are shared by the student endpoint and the read-only staff
 * view. Practice attempts earn XP and badges but are deliberately excluded:
 * only exam submissions count towards leaderboard points.
 *
 * Weekly windows use UTC Monday → Sunday so every viewer agrees on the same
 * week, including serverless instances that do not share a local timezone.
 */
function utcDayStart(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function startOfUtcWeek(value) {
  const date = utcDayStart(value);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date;
}

function formatPeriodDate(value) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(value);
}

function resolveLeaderboardPeriod(key = "week", now = new Date()) {
  const periodKey = Object.prototype.hasOwnProperty.call(PERIOD_LABELS, key) ? key : "week";
  if (periodKey === "all") {
    return { key: periodKey, label: PERIOD_LABELS[periodKey], start: null, end: null };
  }

  const thisWeek = startOfUtcWeek(now);
  const start = periodKey === "last-week"
    ? new Date(thisWeek.getTime() - 7 * DAY_MS)
    : thisWeek;
  const end = new Date(start.getTime() + 7 * DAY_MS);
  return {
    key: periodKey,
    label: `${formatPeriodDate(start)} – ${formatPeriodDate(new Date(end.getTime() - 1))}`,
    start,
    end
  };
}

function serializePeriod(period) {
  return {
    key: period.key,
    label: period.label,
    start: period.start ? period.start.toISOString() : null,
    end: period.end ? period.end.toISOString() : null
  };
}

function readTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isExamSubmission(submission) {
  return String(submission.mode || "").toLowerCase() === "exam";
}

function inPeriod(submission, period) {
  if (!period.start || !period.end) return true;
  const submittedAt = readTimestamp(submission.submitted_at);
  return Boolean(submittedAt && submittedAt >= period.start && submittedAt < period.end);
}

function leaderboardTier(rank, points) {
  if (points <= 0) return { label: "Up & coming", tone: "warn" };
  if (rank === 1) return { label: "Champion", tone: "brand" };
  if (rank <= 3) return { label: "Star", tone: "ok" };
  if (rank <= 10) return { label: "Achiever", tone: "neutral" };
  return { label: "Climber", tone: "neutral" };
}

async function buildClassLeaderboard(cls, viewerId = null, periodKey = "week") {
  const period = resolveLeaderboardPeriod(periodKey);
  const serializedPeriod = serializePeriod(period);
  if (!cls) {
    return {
      class: null,
      quizCount: 0,
      period: serializedPeriod,
      leaderboard: [],
      you: null
    };
  }

  const classId = Number(cls.id);
  const classQuizzes = (await listWhere("quizzes", "class_id", classId))
    .filter(quiz => !quiz.is_deleted);
  const quizIds = classQuizzes.map(quiz => Number(quiz.id));

  const [members, allSubmissions] = await Promise.all([
    listWhere("users", "class_id", classId),
    quizIds.length ? listWhereIn("submissions", "quiz_id", quizIds) : Promise.resolve([])
  ]);

  const students = members
    .filter(user => user.role === "student" && toBoolean(user.active))
    .sort((a, b) => a.name.localeCompare(b.name));

  const quizSet = new Set(quizIds);
  const bestByStudent = new Map();
  for (const submission of allSubmissions) {
    const ownerId = Number(submission.student_id);
    const quizId = Number(submission.quiz_id);
    if (!quizSet.has(quizId)) continue;
    if (!isExamSubmission(submission) || !inPeriod(submission, period)) continue;

    let bests = bestByStudent.get(ownerId);
    if (!bests) {
      bests = new Map();
      bestByStudent.set(ownerId, bests);
    }
    const pct = Number(submission.pct) || 0;
    if (pct > (bests.get(quizId) || -1)) bests.set(quizId, pct);
  }

  const scoreRow = student => {
    const sid = Number(student.id);
    const bests = bestByStudent.get(sid) || new Map();
    const pointList = [...bests.values()];
    const points = pointList.reduce((sum, value) => sum + value, 0);
    return {
      studentId: sid,
      name: student.name,
      points,
      averagePct: pointList.length ? Math.round(points / pointList.length) : 0,
      quizzesTaken: bests.size
    };
  };

  const ranked = students
    .map(scoreRow)
    .filter(row => row.quizzesTaken > 0)
    .sort((a, b) =>
      b.points - a.points ||
      b.averagePct - a.averagePct ||
      b.quizzesTaken - a.quizzesTaken ||
      a.name.localeCompare(b.name)
    );

  const leaderboard = ranked.map((row, index) => {
    const rank = index + 1;
    const tier = leaderboardTier(rank, row.points);
    return { rank, ...row, tier: tier.label, tierTone: tier.tone };
  });

  const unranked = students
    .filter(student => !bestByStudent.has(Number(student.id)))
    .map(student => {
      const tier = leaderboardTier(null, 0);
      return {
        rank: null,
        ...scoreRow(student),
        tier: tier.label,
        tierTone: tier.tone
      };
    });

  const allRows = [...leaderboard, ...unranked];
  const me = viewerId === null || viewerId === undefined
    ? null
    : allRows.find(row => row.studentId === Number(viewerId)) || null;

  return {
    class: { id: Number(cls.id), name: cls.name },
    quizCount: quizIds.length,
    period: serializedPeriod,
    leaderboard: allRows,
    you: me ? {
      rank: me.rank,
      name: me.name,
      points: me.points,
      averagePct: me.averagePct,
      quizzesTaken: me.quizzesTaken
    } : null
  };
}

module.exports = {
  buildClassLeaderboard,
  leaderboardTier,
  resolveLeaderboardPeriod,
  serializePeriod
};
