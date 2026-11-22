"use strict";

const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const {
  listWhere,
  getDocById,
  getManyByIds,
  insertDoc,
  updateDocById,
  listQuizItems,
  getQuizItem,
  countQuizItems,
  saveAnswer,
  listAttemptAnswers,
  submitAttemptResults,
  findSubmissionByAttempt,
  recentDocs
} = require("../fdb");
const { asyncHandler, parseOptions, toBoolean, logActivity } = require("../utils");
const { getSettings } = require("../settings");
const { buildStudentProgress } = require("../progress");
const { buildClassLeaderboard } = require("../leaderboard");
const { effectiveDeadline, quizWindow, whenText } = require("../quiz-window");
const { idSchema, startAttemptSchema, answerSchema } = require("../validation");

const router = express.Router();

function secondsRemaining(attempt) {
  if (!(attempt.expires_at instanceof Date)) return null;
  return Math.max(0, Math.floor((attempt.expires_at.getTime() - Date.now()) / 1000));
}

// Older quizzes without the field keep the original behaviour (practice on).
function practiceAllowed(quiz) {
  return quiz && quiz.allow_practice !== false;
}

async function loadQuizForStudent(quizId, user) {
  const quiz = await getDocById("quizzes", quizId);
  if (!quiz || quiz.is_deleted) return { error: { status: 404, message: "Quiz not found." } };
  if (Number(quiz.class_id) !== Number(user.class_id)) {
    return { error: { status: 403, message: "This quiz is not assigned to your class." } };
  }
  const open = toBoolean(quiz.is_open);
  const approved = quiz.approved !== false;
  if (!open || !approved) {
    return { error: { status: 403, message: "This quiz is not available yet." } };
  }
  const window = quizWindow(quiz);
  if (window.state === "scheduled") {
    return { error: { status: 403, message: `This quiz opens ${whenText(window.startAt)}.` } };
  }
  if (window.state === "expired") {
    return { error: { status: 403, message: `This quiz closed ${whenText(window.endAt)}.` } };
  }
  const cls = await getDocById("classes", quiz.class_id);
  return { quiz: { ...quiz, class_name: cls ? cls.name : null } };
}

async function studentAttemptsForQuiz(studentId, quizId) {
  const attempts = await listWhere("attempts", "student_id", studentId);
  return attempts.filter(attempt => Number(attempt.quiz_id) === Number(quizId));
}

async function expireStaleExamAttempts(studentId, quizId) {
  const now = Date.now();
  const stale = (await studentAttemptsForQuiz(studentId, quizId)).filter(attempt =>
    attempt.mode === "Exam" &&
    attempt.status === "in_progress" &&
    attempt.expires_at instanceof Date &&
    attempt.expires_at.getTime() <= now
  );
  for (const attempt of stale) {
    await updateDocById("attempts", attempt.id, { status: "expired" });
  }
}

async function findInProgressAttempt(studentId, quizId, mode) {
  const matches = (await studentAttemptsForQuiz(studentId, quizId))
    .filter(attempt => attempt.mode === mode && attempt.status === "in_progress")
    .sort((a, b) => Number(b.id) - Number(a.id));
  const attempt = matches[0] || null;
  if (attempt) attempt.seconds_remaining = secondsRemaining(attempt);
  return attempt;
}

function shufflePositions(positions) {
  const shuffled = [...positions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function parseQuestionOrder(value, fallback) {
  if (Array.isArray(value)) {
    const positions = value.map(Number).filter(Number.isInteger);
    return positions.length ? positions : fallback;
  }
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return fallback;
    const positions = parsed.map(Number).filter(Number.isInteger);
    return positions.length ? positions : fallback;
  } catch {
    return fallback;
  }
}

async function buildAttemptPayload(attempt, quiz, showSolutions = true) {
  const [questionRows, answerRows] = await Promise.all([
    listQuizItems(quiz.id),
    listAttemptAnswers(attempt.id)
  ]);

  const naturalOrder = questionRows.map(question => Number(question.position));
  const order = parseQuestionOrder(attempt.question_order, naturalOrder);
  const questionMap = new Map(questionRows.map(question => [Number(question.position), question]));
  const orderedQuestions = order.map(position => questionMap.get(position)).filter(Boolean);
  for (const question of questionRows) {
    if (!order.includes(Number(question.position))) orderedQuestions.push(question);
  }

  const practice = attempt.mode === "Practice";
  const answers = answerRows.map(answer => {
    const question = questionMap.get(Number(answer.position));
    if (!practice || !question || !showSolutions) {
      return { position: answer.position, chosenIndex: answer.chosen_index };
    }
    return {
      position: answer.position,
      chosenIndex: answer.chosen_index,
      correctIndex: Number(question.correct_index),
      solution: question.solution,
      isCorrect: Number(answer.chosen_index) === Number(question.correct_index)
    };
  });

  const remaining = attempt.seconds_remaining !== undefined
    ? attempt.seconds_remaining
    : secondsRemaining(attempt);

  return {
    attemptId: attempt.id,
    status: "in_progress",
    mode: attempt.mode,
    startedAt: attempt.started_at,
    expiresAt: attempt.expires_at,
    secondsRemaining: remaining === null || remaining === undefined ? null : Number(remaining),
    quiz: {
      id: quiz.id,
      title: quiz.title,
      minutes: Number(quiz.minutes),
      className: quiz.class_name
    },
    questions: orderedQuestions.map(question => ({
      position: question.position,
      text: question.question_text,
      options: parseOptions(question.options),
      subject: question.subject || "General",
      diagramSvg: question.diagram_svg || null
    })),
    answers
  };
}

router.get("/dashboard", asyncHandler(async (req, res) => {
  const studentId = req.user.id;
  const classId = req.user.class_id;

  const [classQuizzes, announcements, mySubmissions, settings] = await Promise.all([
    classId === null || classId === undefined ? Promise.resolve([]) : listWhere("quizzes", "class_id", classId),
    recentDocs("announcements", 50),
    listWhere("submissions", "student_id", studentId),
    getSettings()
  ]);

  const quizzes = classQuizzes
    .filter(quiz => !quiz.is_deleted && toBoolean(quiz.is_open) && quiz.approved !== false)
    .sort((a, b) => Number(b.id) - Number(a.id));

  const [questionCounts, authorDocs, submissionQuizDocs] = await Promise.all([
    Promise.all(quizzes.map(quiz => countQuizItems(quiz.id))),
    getManyByIds("users", [...new Set(announcements.map(item => Number(item.author_id)))]),
    getManyByIds("quizzes", [...new Set(mySubmissions.map(submission => Number(submission.quiz_id)))])
  ]);
  const questionCountMap = new Map(quizzes.map((quiz, index) => [Number(quiz.id), questionCounts[index]]));
  const authorMap = new Map(authorDocs.map(user => [Number(user.id), user]));
  const quizTitleMap = new Map(submissionQuizDocs.map(quiz => [Number(quiz.id), quiz.title]));

  const byQuiz = new Map();
  for (const submission of mySubmissions) {
    const key = Number(submission.quiz_id);
    const bucket = byQuiz.get(key) || { attempts: 0, bestPct: null, lastSubmittedAt: null };
    bucket.attempts += 1;
    if (bucket.bestPct === null || Number(submission.pct) > bucket.bestPct) {
      bucket.bestPct = Number(submission.pct);
    }
    if (!bucket.lastSubmittedAt || new Date(submission.submitted_at) > new Date(bucket.lastSubmittedAt)) {
      bucket.lastSubmittedAt = submission.submitted_at;
    }
    byQuiz.set(key, bucket);
  }

  const bestPcts = Array.from(byQuiz.values()).map(bucket => bucket.bestPct).filter(value => value !== null);
  const availableCount = quizzes.filter(quiz => quizWindow(quiz).available).length;

  const sortedSubmissions = [...mySubmissions]
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
    .slice(0, 200);

  res.json({
    class: req.publicUser.classId ? { id: req.publicUser.classId, name: req.publicUser.className } : null,
    quizzes: quizzes.map(quiz => {
      const bucket = byQuiz.get(Number(quiz.id)) || { attempts: 0, bestPct: null, lastSubmittedAt: null };
      const window = quizWindow(quiz);
      return {
        id: quiz.id,
        title: quiz.title,
        minutes: Number(quiz.minutes),
        isOpen: toBoolean(quiz.is_open),
        availability: window.state === "scheduled" ? "scheduled"
          : window.state === "expired" ? "closed"
            : "open",
        startAt: window.startAt,
        endAt: window.endAt,
        allowPractice: practiceAllowed(quiz),
        questionCount: questionCountMap.get(Number(quiz.id)) || 0,
        attempts: bucket.attempts,
        bestPct: bucket.bestPct,
        lastSubmittedAt: bucket.lastSubmittedAt,
        createdAt: quiz.created_at
      };
    }),
    announcements: announcements.map(item => ({
      id: item.id,
      text: item.text,
      authorId: item.author_id,
      authorName: (authorMap.get(Number(item.author_id)) || {}).name || "Unknown",
      createdAt: item.created_at
    })),
    submissions: sortedSubmissions.map(submission => ({
      id: submission.id,
      quizId: submission.quiz_id,
      quizTitle: quizTitleMap.get(Number(submission.quiz_id)) || "",
      mode: submission.mode,
      score: Number(submission.score),
      total: Number(submission.total),
      pct: Number(submission.pct),
      submittedAt: submission.submitted_at
    })),
    settings: {
      passMark: settings.passMark,
      showSolutions: settings.showSolutions,
      maxAttempts: settings.maxAttempts,
      allowRetakes: settings.allowRetakes
    },
    stats: {
      quizzesTaken: byQuiz.size,
      average: bestPcts.length ? Math.round(bestPcts.reduce((sum, value) => sum + value, 0) / bestPcts.length) : 0,
      passed: bestPcts.filter(value => value >= settings.passMark).length,
      available: availableCount
    }
  });
}));

// Class leaderboard. The ranking logic lives in server/leaderboard.js so staff
// can see the same standings without widening student-route permissions.
router.get("/leaderboard", asyncHandler(async (req, res) => {
  const classId = req.user.class_id;
  const cls = classId === null || classId === undefined
    ? null
    : await getDocById("classes", classId);

  return res.json(await buildClassLeaderboard(cls, req.user.id));
}));

// Rewards progress (XP, levels, streaks and badges) derived from the
// student's existing submission history. No extra collection is maintained.
router.get("/progress", asyncHandler(async (req, res) => {
  const studentId = req.user.id;
  const classId = req.user.class_id;

  const hasClass = classId !== null && classId !== undefined;
  const [submissions, classQuizzes, classSubmissions, members, cls, settings] = await Promise.all([
    listWhere("submissions", "student_id", studentId),
    hasClass ? listWhere("quizzes", "class_id", classId) : Promise.resolve([]),
    hasClass ? listWhere("submissions", "class_id", classId) : Promise.resolve([]),
    hasClass ? listWhere("users", "class_id", classId) : Promise.resolve([]),
    hasClass ? getDocById("classes", classId) : Promise.resolve(null),
    getSettings()
  ]);
  const quizDocs = await getManyByIds(
    "quizzes",
    [...new Set(submissions.map(submission => Number(submission.quiz_id)))]
  );

  return res.json(buildStudentProgress({
    submissions,
    quizDocs,
    classQuizzes,
    classSubmissions,
    members,
    className: cls ? cls.name : "",
    studentId,
    passMark: settings.passMark
  }));
}));

router.post("/quizzes/:id/start", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const input = startAttemptSchema.parse(req.body);

  const { quiz, error } = await loadQuizForStudent(quizId, req.user);
  if (error) return res.status(error.status).json({ error: error.message });

  if (input.mode === "Practice" && !practiceAllowed(quiz)) {
    return res.status(403).json({ error: "Practice is disabled for this quiz." });
  }

  const settings = await getSettings();
  await expireStaleExamAttempts(req.user.id, quizId);

  let attempt = await findInProgressAttempt(req.user.id, quizId, input.mode);
  let created = false;

  if (!attempt) {
    if (!toBoolean(quiz.is_open)) {
      return res.status(403).json({ error: "This quiz is closed." });
    }

    const priorSubmissions = (await listWhere("submissions", "student_id", req.user.id))
      .filter(submission => Number(submission.quiz_id) === Number(quizId));
    if (!settings.allowRetakes && priorSubmissions.length > 0) {
      return res.status(403).json({ error: "Retakes are disabled for this quiz." });
    }
    if (settings.maxAttempts > 0 && priorSubmissions.length >= settings.maxAttempts) {
      return res.status(403).json({ error: `You have reached the limit of ${settings.maxAttempts} attempt(s) for this quiz.` });
    }

    const items = await listQuizItems(quizId);
    let order = items.map(item => Number(item.position));
    if (toBoolean(quiz.shuffle_questions)) order = shufflePositions(order);

    const attemptId = await insertDoc("attempts", {
      quiz_id: quizId,
      class_id: quiz.class_id,
      student_id: req.user.id,
      mode: input.mode,
      question_order: order,
      status: "in_progress",
      started_at: new Date(),
      expires_at: input.mode === "Exam"
        ? effectiveDeadline(quiz, new Date(Date.now() + Number(quiz.minutes) * 60000))
        : null,
      submitted_at: null
    }, "attempts");

    attempt = await findInProgressAttempt(req.user.id, quizId, input.mode);
    if (!attempt || Number(attempt.id) !== Number(attemptId)) {
      return res.status(500).json({ error: "Could not start this attempt." });
    }
    created = true;
  }

  if (
    input.mode === "Exam" &&
    attempt.seconds_remaining !== null &&
    attempt.seconds_remaining !== undefined &&
    Number(attempt.seconds_remaining) <= 0
  ) {
    await updateDocById("attempts", attempt.id, { status: "expired" });
    return res.status(410).json({ error: "Time has expired for this attempt." });
  }

  if (created) {
    await logActivity(req.user, `Started a ${input.mode.toLowerCase()} attempt for "${quiz.title}"`);
  }

  return res.json(await buildAttemptPayload(attempt, quiz, settings.showSolutions));
}));

router.get("/attempts/:id", asyncHandler(async (req, res) => {
  const attemptId = idSchema.parse(req.params.id);
  const attempt = await getDocById("attempts", attemptId);
  if (!attempt || Number(attempt.student_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: "Attempt not found." });
  }

  const quiz = await getDocById("quizzes", attempt.quiz_id);
  const cls = quiz ? await getDocById("classes", quiz.class_id) : null;
  const remaining = secondsRemaining(attempt);

  if (attempt.status === "submitted") {
    const submission = await findSubmissionByAttempt(attemptId);
    return res.json({
      status: "submitted",
      attemptId,
      submissionId: submission ? submission.id : null,
      quizTitle: quiz ? quiz.title : ""
    });
  }

  if (attempt.status === "expired") {
    return res.status(410).json({ error: "This attempt has expired." });
  }

  if (attempt.mode === "Practice" && !practiceAllowed(quiz)) {
    return res.status(403).json({ error: "Practice is disabled for this quiz." });
  }

  if (attempt.mode === "Exam" && remaining !== null && Number(remaining) <= 0) {
    await updateDocById("attempts", attemptId, { status: "expired" });
    return res.status(410).json({ error: "Time has expired for this attempt." });
  }

  const settings = await getSettings();
  return res.json(await buildAttemptPayload({ ...attempt, seconds_remaining: remaining }, {
    id: attempt.quiz_id,
    title: quiz ? quiz.title : "",
    minutes: quiz ? quiz.minutes : 0,
    class_name: cls ? cls.name : null
  }, settings.showSolutions));
}));

router.post("/attempts/:id/answer", asyncHandler(async (req, res) => {
  const attemptId = idSchema.parse(req.params.id);
  const input = answerSchema.parse(req.body);

  const attempt = await getDocById("attempts", attemptId);
  if (!attempt || Number(attempt.student_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: "Attempt not found." });
  }

  if (attempt.status === "submitted") {
    const submission = await findSubmissionByAttempt(attemptId);
    return res.status(409).json({
      error: "This attempt has already been submitted.",
      submissionId: submission ? submission.id : null
    });
  }

  if (attempt.status === "expired") {
    return res.status(410).json({ error: "This attempt has expired." });
  }

  const remaining = secondsRemaining(attempt);
  if (attempt.mode === "Exam" && remaining !== null && Number(remaining) <= 0) {
    await updateDocById("attempts", attemptId, { status: "expired" });
    return res.status(410).json({ error: "Time has expired for this attempt." });
  }

  if (attempt.mode === "Practice") {
    const quiz = await getDocById("quizzes", attempt.quiz_id);
    if (!practiceAllowed(quiz)) {
      return res.status(403).json({ error: "Practice is disabled for this quiz." });
    }
  }

  const question = await getQuizItem(attempt.quiz_id, input.position);
  if (!question) return res.status(400).json({ error: "That question is not part of this attempt." });

  try {
    await saveAnswer(attemptId, input.position, input.chosenIndex);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "This answer is already locked." });
    }
    throw err;
  }

  if (attempt.mode === "Practice") {
    const settings = await getSettings();
    if (!settings.showSolutions) return res.json({ saved: true });
    return res.json({
      saved: true,
      feedback: {
        position: input.position,
        correctIndex: Number(question.correct_index),
        solution: question.solution,
        isCorrect: input.chosenIndex === Number(question.correct_index)
      }
    });
  }

  return res.json({ saved: true });
}));

router.post("/attempts/:id/submit", asyncHandler(async (req, res) => {
  const attemptId = idSchema.parse(req.params.id);

  const attempt = await getDocById("attempts", attemptId);
  if (!attempt || Number(attempt.student_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: "Attempt not found." });
  }

  if (attempt.status === "submitted") {
    const existing = await findSubmissionByAttempt(attemptId);
    if (existing) {
      return res.json({
        submissionId: existing.id,
        score: Number(existing.score),
        total: Number(existing.total),
        pct: Number(existing.pct)
      });
    }
    return res.status(409).json({ error: "This attempt was already submitted." });
  }

  if (attempt.status === "expired") {
    return res.status(410).json({ error: "This attempt has expired and cannot be submitted." });
  }

  if (attempt.mode === "Exam" && attempt.expires_at instanceof Date) {
    const secondsLeft = Math.floor(
      (attempt.expires_at.getTime() + config.examGraceSeconds * 1000 - Date.now()) / 1000
    );
    if (secondsLeft < 0) {
      await updateDocById("attempts", attemptId, { status: "expired" });
      return res.status(410).json({ error: "Time has expired for this attempt." });
    }
  }

  const quiz = await getDocById("quizzes", attempt.quiz_id);
  if (attempt.mode === "Practice" && !practiceAllowed(quiz)) {
    return res.status(403).json({ error: "Practice is disabled for this quiz." });
  }

  let result;
  try {
    result = await submitAttemptResults({ attempt });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const existing = await findSubmissionByAttempt(attemptId);
      if (existing) {
        return res.json({
          submissionId: existing.id,
          score: Number(existing.score),
          total: Number(existing.total),
          pct: Number(existing.pct)
        });
      }
    }
    throw err;
  }

  await logActivity(
    req.user,
    `Submitted "${quiz ? quiz.title : "quiz"}" (${result.score}/${result.total}, ${result.pct}%)`
  );
  return res.status(201).json(result);
}));

module.exports = router;
