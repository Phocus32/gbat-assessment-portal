"use strict";

const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const { query, withTransaction } = require("../db");
const { asyncHandler, parseOptions, toBoolean, logActivity } = require("../utils");
const { idSchema, startAttemptSchema, answerSchema } = require("../validation");

const router = express.Router();

async function loadQuizForStudent(quizId, user) {
  const rows = await query(
    `SELECT q.id, q.title, q.class_id, q.minutes, q.shuffle_questions, q.is_open, c.name AS class_name
       FROM quizzes q
       JOIN classes c ON c.id = q.class_id
      WHERE q.id = ? AND q.is_deleted = 0
      LIMIT 1`,
    [quizId]
  );
  const quiz = rows[0];
  if (!quiz) return { error: { status: 404, message: "Quiz not found." } };
  if (Number(quiz.class_id) !== Number(user.class_id)) {
    return { error: { status: 403, message: "This quiz is not assigned to your class." } };
  }
  return { quiz };
}

async function expireStaleExamAttempts(studentId, quizId) {
  await query(
    `UPDATE quiz_attempts
        SET status = 'expired'
      WHERE student_id = ? AND quiz_id = ? AND mode = 'Exam'
        AND status = 'in_progress' AND expires_at IS NOT NULL AND expires_at <= NOW()`,
    [studentId, quizId]
  );
}

async function findInProgressAttempt(studentId, quizId, mode) {
  const rows = await query(
    `SELECT id, mode, question_order_json, started_at, expires_at, status,
            CASE WHEN expires_at IS NULL THEN NULL
                 ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), expires_at)) END AS seconds_remaining
       FROM quiz_attempts
      WHERE student_id = ? AND quiz_id = ? AND mode = ? AND status = 'in_progress'
      ORDER BY id DESC
      LIMIT 1`,
    [studentId, quizId, mode]
  );
  return rows[0] || null;
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

async function buildAttemptPayload(attempt, quiz) {
  const [questionRows, answerRows] = await Promise.all([
    query(
      `SELECT position, question_text, options_json, subject, diagram_svg
         FROM quiz_questions
        WHERE quiz_id = ?
        ORDER BY position`,
      [quiz.id]
    ),
    query(
      `SELECT aa.position, aa.chosen_index, qq.correct_index, qq.solution
         FROM attempt_answers aa
         JOIN quiz_questions qq ON qq.quiz_id = ? AND qq.position = aa.position
        WHERE aa.attempt_id = ?
        ORDER BY aa.position`,
      [quiz.id, attempt.id]
    )
  ]);

  const naturalOrder = questionRows.map(question => Number(question.position));
  const order = parseQuestionOrder(attempt.question_order_json, naturalOrder);
  const questionMap = new Map(questionRows.map(question => [Number(question.position), question]));
  const orderedQuestions = order.map(position => questionMap.get(position)).filter(Boolean);
  for (const question of questionRows) {
    if (!order.includes(Number(question.position))) orderedQuestions.push(question);
  }

  const practice = attempt.mode === "Practice";
  const answers = answerRows.map(answer => {
    if (!practice) {
      return { position: answer.position, chosenIndex: answer.chosen_index };
    }
    return {
      position: answer.position,
      chosenIndex: answer.chosen_index,
      correctIndex: Number(answer.correct_index),
      solution: answer.solution,
      isCorrect: Number(answer.chosen_index) === Number(answer.correct_index)
    };
  });

  return {
    attemptId: attempt.id,
    status: "in_progress",
    mode: attempt.mode,
    startedAt: attempt.started_at,
    expiresAt: attempt.expires_at,
    secondsRemaining: attempt.seconds_remaining === null || attempt.seconds_remaining === undefined
      ? null
      : Number(attempt.seconds_remaining),
    quiz: {
      id: quiz.id,
      title: quiz.title,
      minutes: Number(quiz.minutes),
      className: quiz.class_name
    },
    questions: orderedQuestions.map(question => ({
      position: question.position,
      text: question.question_text,
      options: parseOptions(question.options_json),
      subject: question.subject || "General",
      diagramSvg: question.diagram_svg || null
    })),
    answers
  };
}

router.get("/dashboard", asyncHandler(async (req, res) => {
  const studentId = req.user.id;
  const classId = req.user.class_id;

  const [quizzes, announcements, submissions, statsRows] = await Promise.all([
    query(
      `SELECT q.id, q.title, q.minutes, q.is_open, q.created_at,
              (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count,
              (SELECT COUNT(*) FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.student_id = ? AND a.status = 'submitted') AS submitted_attempts,
              (SELECT MAX(s.pct) FROM submissions s WHERE s.quiz_id = q.id AND s.student_id = ?) AS best_pct,
              (SELECT MAX(s.submitted_at) FROM submissions s WHERE s.quiz_id = q.id AND s.student_id = ?) AS last_submitted_at
         FROM quizzes q
        WHERE q.class_id = ? AND q.is_deleted = 0
        ORDER BY q.is_open DESC, q.id DESC`,
      [studentId, studentId, studentId, classId]
    ),
    query(
      `SELECT a.id, a.text, a.created_at, a.author_id, u.name AS author_name
         FROM announcements a
         JOIN users u ON u.id = a.author_id
        ORDER BY a.id DESC
        LIMIT 50`
    ),
    query(
      `SELECT s.id, s.quiz_id, q.title AS quiz_title, s.mode, s.score, s.total, s.pct, s.submitted_at
         FROM submissions s
         JOIN quizzes q ON q.id = s.quiz_id
        WHERE s.student_id = ?
        ORDER BY s.submitted_at DESC
        LIMIT 200`,
      [studentId]
    ),
    query(
      `SELECT COUNT(*) AS quizzes_taken,
              ROUND(AVG(best_pct)) AS average,
              SUM(CASE WHEN best_pct >= 50 THEN 1 ELSE 0 END) AS passed
         FROM (
           SELECT quiz_id, MAX(pct) AS best_pct
             FROM submissions
            WHERE student_id = ?
            GROUP BY quiz_id
         ) AS best_results`,
      [studentId]
    )
  ]);

  const stats = statsRows[0];
  res.json({
    class: req.publicUser.classId ? { id: req.publicUser.classId, name: req.publicUser.className } : null,
    quizzes: quizzes.map(quiz => ({
      id: quiz.id,
      title: quiz.title,
      minutes: Number(quiz.minutes),
      isOpen: toBoolean(quiz.is_open),
      questionCount: Number(quiz.question_count),
      attempts: Number(quiz.submitted_attempts),
      bestPct: quiz.best_pct === null ? null : Number(quiz.best_pct),
      lastSubmittedAt: quiz.last_submitted_at,
      createdAt: quiz.created_at
    })),
    announcements: announcements.map(item => ({
      id: item.id,
      text: item.text,
      authorId: item.author_id,
      authorName: item.author_name,
      createdAt: item.created_at
    })),
    submissions: submissions.map(submission => ({
      id: submission.id,
      quizId: submission.quiz_id,
      quizTitle: submission.quiz_title,
      mode: submission.mode,
      score: Number(submission.score),
      total: Number(submission.total),
      pct: Number(submission.pct),
      submittedAt: submission.submitted_at
    })),
    stats: {
      quizzesTaken: Number(stats.quizzes_taken),
      average: Number(stats.average || 0),
      passed: Number(stats.passed || 0),
      available: quizzes.filter(quiz => toBoolean(quiz.is_open)).length
    }
  });
}));

router.post("/quizzes/:id/start", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const input = startAttemptSchema.parse(req.body);

  const { quiz, error } = await loadQuizForStudent(quizId, req.user);
  if (error) return res.status(error.status).json({ error: error.message });

  await expireStaleExamAttempts(req.user.id, quizId);

  let attempt = await findInProgressAttempt(req.user.id, quizId, input.mode);
  let created = false;

  if (!attempt) {
    if (!toBoolean(quiz.is_open)) {
      return res.status(403).json({ error: "This quiz is closed." });
    }

    const positionRows = await query(
      "SELECT position FROM quiz_questions WHERE quiz_id = ? ORDER BY position",
      [quizId]
    );
    let order = positionRows.map(row => Number(row.position));
    if (toBoolean(quiz.shuffle_questions)) order = shufflePositions(order);

    await query(
      `INSERT INTO quiz_attempts (quiz_id, student_id, mode, question_order_json, expires_at)
       VALUES (?, ?, ?, ?, CASE WHEN ? = 'Exam' THEN DATE_ADD(NOW(), INTERVAL ? MINUTE) ELSE NULL END)`,
      [quizId, req.user.id, input.mode, JSON.stringify(order), input.mode, quiz.minutes]
    );

    attempt = await findInProgressAttempt(req.user.id, quizId, input.mode);
    if (!attempt) {
      return res.status(500).json({ error: "Could not start this attempt." });
    }
    created = true;
  }

  if (input.mode === "Exam" && Number(attempt.seconds_remaining) <= 0) {
    await query("UPDATE quiz_attempts SET status = 'expired' WHERE id = ?", [attempt.id]);
    return res.status(410).json({ error: "Time has expired for this attempt." });
  }

  if (created) {
    await logActivity(req.user, `Started a ${input.mode.toLowerCase()} attempt for "${quiz.title}"`);
  }

  return res.json(await buildAttemptPayload(attempt, quiz));
}));

router.get("/attempts/:id", asyncHandler(async (req, res) => {
  const attemptId = idSchema.parse(req.params.id);
  const rows = await query(
    `SELECT a.*, q.title, q.minutes, q.class_id, c.name AS class_name,
            CASE WHEN a.expires_at IS NULL THEN NULL
                 ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), a.expires_at)) END AS seconds_remaining
       FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       JOIN classes c ON c.id = q.class_id
      WHERE a.id = ? AND a.student_id = ?
      LIMIT 1`,
    [attemptId, req.user.id]
  );
  const attempt = rows[0];
  if (!attempt) return res.status(404).json({ error: "Attempt not found." });

  if (attempt.status === "submitted") {
    const submissionRows = await query("SELECT id FROM submissions WHERE attempt_id = ? LIMIT 1", [attemptId]);
    return res.json({
      status: "submitted",
      attemptId,
      submissionId: submissionRows[0] ? submissionRows[0].id : null,
      quizTitle: attempt.title
    });
  }

  if (attempt.status === "expired") {
    return res.status(410).json({ error: "This attempt has expired." });
  }

  if (attempt.mode === "Exam" && Number(attempt.seconds_remaining) <= 0) {
    await query("UPDATE quiz_attempts SET status = 'expired' WHERE id = ?", [attemptId]);
    return res.status(410).json({ error: "Time has expired for this attempt." });
  }

  return res.json(await buildAttemptPayload(attempt, {
    id: attempt.quiz_id,
    title: attempt.title,
    minutes: attempt.minutes,
    class_name: attempt.class_name
  }));
}));

router.post("/attempts/:id/answer", asyncHandler(async (req, res) => {
  const attemptId = idSchema.parse(req.params.id);
  const input = answerSchema.parse(req.body);

  const rows = await query(
    `SELECT a.*, q.title,
            CASE WHEN a.expires_at IS NULL THEN NULL
                 ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), a.expires_at)) END AS seconds_remaining
       FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.id = ? AND a.student_id = ?
      LIMIT 1`,
    [attemptId, req.user.id]
  );
  const attempt = rows[0];
  if (!attempt) return res.status(404).json({ error: "Attempt not found." });

  if (attempt.status === "submitted") {
    const submissionRows = await query("SELECT id FROM submissions WHERE attempt_id = ? LIMIT 1", [attemptId]);
    return res.status(409).json({
      error: "This attempt has already been submitted.",
      submissionId: submissionRows[0] ? submissionRows[0].id : null
    });
  }

  if (attempt.status === "expired") {
    return res.status(410).json({ error: "This attempt has expired." });
  }

  if (attempt.mode === "Exam" && Number(attempt.seconds_remaining) <= 0) {
    await query("UPDATE quiz_attempts SET status = 'expired' WHERE id = ?", [attemptId]);
    return res.status(410).json({ error: "Time has expired for this attempt." });
  }

  const questionRows = await query(
    `SELECT correct_index, solution
       FROM quiz_questions
      WHERE quiz_id = ? AND position = ?
      LIMIT 1`,
    [attempt.quiz_id, input.position]
  );
  const question = questionRows[0];
  if (!question) return res.status(400).json({ error: "That question is not part of this attempt." });

  const existing = await query(
    "SELECT id FROM attempt_answers WHERE attempt_id = ? AND position = ? LIMIT 1",
    [attemptId, input.position]
  );
  if (existing.length) {
    return res.status(409).json({ error: "This answer is already locked." });
  }

  try {
    await query(
      "INSERT INTO attempt_answers (attempt_id, position, chosen_index) VALUES (?, ?, ?)",
      [attemptId, input.position, input.chosenIndex]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "This answer is already locked." });
    }
    throw err;
  }

  if (attempt.mode === "Practice") {
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

  const rows = await query(
    `SELECT a.*, q.title, q.class_id
       FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.id = ? AND a.student_id = ?
      LIMIT 1`,
    [attemptId, req.user.id]
  );
  const attempt = rows[0];
  if (!attempt) return res.status(404).json({ error: "Attempt not found." });

  if (attempt.status === "submitted") {
    const existingRows = await query(
      "SELECT id, score, total, pct FROM submissions WHERE attempt_id = ? LIMIT 1",
      [attemptId]
    );
    if (existingRows[0]) {
      return res.json({
        submissionId: existingRows[0].id,
        score: Number(existingRows[0].score),
        total: Number(existingRows[0].total),
        pct: Number(existingRows[0].pct)
      });
    }
    return res.status(409).json({ error: "This attempt was already submitted." });
  }

  if (attempt.status === "expired") {
    return res.status(410).json({ error: "This attempt has expired and cannot be submitted." });
  }

  if (attempt.mode === "Exam" && attempt.expires_at) {
    const graceRows = await query(
      `SELECT TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(expires_at, INTERVAL ? SECOND)) AS seconds_left
         FROM quiz_attempts
        WHERE id = ?
        LIMIT 1`,
      [config.examGraceSeconds, attemptId]
    );
    if (Number(graceRows[0].seconds_left) < 0) {
      await query("UPDATE quiz_attempts SET status = 'expired' WHERE id = ? AND status = 'in_progress'", [attemptId]);
      return res.status(410).json({ error: "Time has expired for this attempt." });
    }
  }

  const [questionRows, answerRows] = await Promise.all([
    query(
      `SELECT position, correct_index FROM quiz_questions WHERE quiz_id = ? ORDER BY position`,
      [attempt.quiz_id]
    ),
    query(
      `SELECT position, chosen_index FROM attempt_answers WHERE attempt_id = ?`,
      [attemptId]
    )
  ]);

  if (!questionRows.length) {
    return res.status(409).json({ error: "This quiz has no questions and cannot be graded." });
  }

  const answerMap = new Map(answerRows.map(answer => [answer.position, answer]));
  let score = 0;
  const graded = questionRows.map(question => {
    const answer = answerMap.get(question.position);
    const chosenIndex = answer ? Number(answer.chosen_index) : null;
    const isCorrect = chosenIndex !== null && chosenIndex === Number(question.correct_index);
    if (isCorrect) score += 1;
    return {
      position: question.position,
      chosenIndex,
      correctIndex: Number(question.correct_index),
      isCorrect
    };
  });

  const total = questionRows.length;
  const pct = Math.round((score / total) * 100);

  let submissionId;
  try {
    submissionId = await withTransaction(async connection => {
      const [result] = await connection.execute(
        `INSERT INTO submissions (quiz_id, student_id, attempt_id, class_id, mode, score, total, pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [attempt.quiz_id, req.user.id, attemptId, attempt.class_id, attempt.mode, score, total, pct]
      );

      for (const answer of graded) {
        await connection.execute(
          `INSERT INTO submission_answers
             (submission_id, position, chosen_index, correct_index, is_correct)
           VALUES (?, ?, ?, ?, ?)`,
          [result.insertId, answer.position, answer.chosenIndex, answer.correctIndex, answer.isCorrect ? 1 : 0]
        );
      }

      await connection.execute(
        "UPDATE quiz_attempts SET status = 'submitted', submitted_at = NOW() WHERE id = ?",
        [attemptId]
      );

      return result.insertId;
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const existingRows = await query(
        "SELECT id, score, total, pct FROM submissions WHERE attempt_id = ? LIMIT 1",
        [attemptId]
      );
      if (existingRows[0]) {
        return res.json({
          submissionId: existingRows[0].id,
          score: Number(existingRows[0].score),
          total: Number(existingRows[0].total),
          pct: Number(existingRows[0].pct)
        });
      }
    }
    throw err;
  }

  await logActivity(req.user, `Submitted "${attempt.title}" (${score}/${total}, ${pct}%)`);
  return res.status(201).json({ submissionId, score, total, pct });
}));

module.exports = router;
