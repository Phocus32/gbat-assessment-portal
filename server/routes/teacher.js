"use strict";

const express = require("express");
const { query, withTransaction } = require("../db");
const { buildStudentTemplate } = require("../excel");
const {
  asyncHandler,
  parseOptions,
  csvCell,
  toBoolean,
  logActivity
} = require("../utils");
const {
  idSchema,
  questionCreateSchema,
  quizCreateSchema,
  quizUpdateSchema,
  announcementCreateSchema
} = require("../validation");

const router = express.Router();

function mapQuestion(row) {
  return {
    id: row.id,
    text: row.question_text,
    options: parseOptions(row.options_json),
    correctIndex: Number(row.correct_index),
    solution: row.solution,
    subject: row.subject || "General",
    diagramSvg: row.diagram_svg || null,
    creatorId: row.created_by,
    creatorName: row.creator_name || null,
    createdAt: row.created_at
  };
}

async function loadOwnedQuiz(quizId, teacherId) {
  const rows = await query(
    `SELECT q.id, q.title, q.class_id, q.teacher_id, q.minutes, q.shuffle_questions, q.is_open, q.created_at,
            c.name AS class_name
       FROM quizzes q
       JOIN classes c ON c.id = q.class_id
      WHERE q.id = ? AND q.teacher_id = ? AND q.is_deleted = 0
      LIMIT 1`,
    [quizId, teacherId]
  );
  return rows[0] || null;
}

async function buildQuizResults(quiz) {
  const [roster, submissionRows, accuracyRows] = await Promise.all([
    query(
      `SELECT id, name, username
         FROM users
        WHERE role = 'student' AND class_id = ?
        ORDER BY name`,
      [quiz.class_id]
    ),
    query(
      `SELECT s.id, s.student_id, s.mode, s.score, s.total, s.pct, s.submitted_at,
              u.name AS student_name, u.username AS student_username
         FROM submissions s
         JOIN users u ON u.id = s.student_id
        WHERE s.quiz_id = ?
        ORDER BY s.pct DESC, s.submitted_at ASC`,
      [quiz.id]
    ),
    query(
      `SELECT qq.position, qq.question_text, qq.subject,
              COUNT(sa.id) AS attempts,
              COALESCE(SUM(sa.is_correct), 0) AS correct_count
         FROM quiz_questions qq
         LEFT JOIN submission_answers sa
           ON sa.position = qq.position
          AND sa.submission_id IN (SELECT id FROM submissions WHERE quiz_id = ?)
        WHERE qq.quiz_id = ?
        GROUP BY qq.id, qq.position, qq.question_text, qq.subject
        ORDER BY qq.position`,
      [quiz.id, quiz.id]
    )
  ]);

  const studentMap = new Map();
  for (const student of roster) {
    studentMap.set(student.id, {
      studentId: student.id,
      name: student.name,
      username: student.username,
      attempts: 0,
      bestSubmissionId: null,
      bestPct: null,
      bestScore: null,
      bestTotal: null,
      bestMode: null,
      lastAttemptAt: null
    });
  }

  for (const submission of submissionRows) {
    let entry = studentMap.get(submission.student_id);
    if (!entry) {
      entry = {
        studentId: submission.student_id,
        name: submission.student_name,
        username: submission.student_username,
        attempts: 0,
        bestSubmissionId: null,
        bestPct: null,
        bestScore: null,
        bestTotal: null,
        bestMode: null,
        lastAttemptAt: null
      };
      studentMap.set(submission.student_id, entry);
    }
    entry.attempts += 1;
    if (entry.bestPct === null || Number(submission.pct) > Number(entry.bestPct)) {
      entry.bestSubmissionId = submission.id;
      entry.bestPct = Number(submission.pct);
      entry.bestScore = Number(submission.score);
      entry.bestTotal = Number(submission.total);
      entry.bestMode = submission.mode;
    }
    if (!entry.lastAttemptAt || submission.submitted_at > entry.lastAttemptAt) {
      entry.lastAttemptAt = submission.submitted_at;
    }
  }

  const students = Array.from(studentMap.values())
    .map(entry => ({ ...entry, status: entry.attempts > 0 ? "Completed" : "Not attempted" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const attempted = students.filter(student => student.bestPct !== null);
  const average = attempted.length
    ? Math.round(attempted.reduce((sum, student) => sum + student.bestPct, 0) / attempted.length)
    : 0;
  const highest = attempted.length ? Math.max(...attempted.map(student => student.bestPct)) : 0;
  const lowest = attempted.length ? Math.min(...attempted.map(student => student.bestPct)) : 0;

  return {
    quiz: {
      id: quiz.id,
      title: quiz.title,
      className: quiz.class_name,
      classId: quiz.class_id,
      minutes: Number(quiz.minutes),
      shuffleQuestions: toBoolean(quiz.shuffle_questions),
      isOpen: toBoolean(quiz.is_open)
    },
    students,
    kpis: {
      assigned: students.length,
      completed: attempted.length,
      average,
      highest,
      lowest
    },
    accuracy: accuracyRows.map(row => {
      const attempts = Number(row.attempts);
      const correct = Number(row.correct_count);
      return {
        position: Number(row.position),
        text: row.question_text,
        subject: row.subject || "General",
        attempts,
        correct,
        accuracy: attempts ? Math.round((correct / attempts) * 100) : 0
      };
    })
  };
}

router.get("/students/template.xlsx", asyncHandler(async (req, res) => {
  const classes = await query("SELECT name FROM classes ORDER BY name");
  const buffer = await buildStudentTemplate(classes.map(cls => cls.name));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=\"gbat-student-import-template.xlsx\"");
  return res.send(buffer);
}));

router.get("/bootstrap", asyncHandler(async (req, res) => {
  const [questions, quizzes, classes, submissions, announcements, statsRows, hardestRows, settingsRows] = await Promise.all([
    query(
      `SELECT q.*, u.name AS creator_name
         FROM questions q
         JOIN users u ON u.id = q.created_by
        WHERE q.created_by = ?
        ORDER BY q.id DESC`,
      [req.user.id]
    ),
    query(
      `SELECT q.id, q.title, q.class_id, c.name AS class_name, q.minutes, q.shuffle_questions, q.is_open, q.created_at,
              (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
         FROM quizzes q
         JOIN classes c ON c.id = q.class_id
        WHERE q.teacher_id = ? AND q.is_deleted = 0
        ORDER BY q.id DESC`,
      [req.user.id]
    ),
    query("SELECT id, name FROM classes ORDER BY name"),
    query(
      `SELECT s.id, s.quiz_id, s.mode, s.score, s.total, s.pct, s.submitted_at,
              q.title AS quiz_title, c.name AS class_name,
              u.name AS student_name, u.username AS student_username
         FROM submissions s
         JOIN quizzes q ON q.id = s.quiz_id
         JOIN classes c ON c.id = q.class_id
         JOIN users u ON u.id = s.student_id
        WHERE q.teacher_id = ?
        ORDER BY s.submitted_at DESC
        LIMIT 1000`,
      [req.user.id]
    ),
    query(
      `SELECT a.id, a.text, a.created_at, a.author_id, u.name AS author_name
         FROM announcements a
         JOIN users u ON u.id = a.author_id
        ORDER BY a.id DESC
        LIMIT 50`
    ),
    query(
      `SELECT COUNT(*) AS submissions, ROUND(AVG(s.pct)) AS average, MAX(s.pct) AS highest
         FROM submissions s
         JOIN quizzes q ON q.id = s.quiz_id
        WHERE q.teacher_id = ?`,
      [req.user.id]
    ),
    query(
      `SELECT qq.question_text, q.title AS quiz_title,
              COUNT(sa.id) AS attempts,
              COALESCE(SUM(sa.is_correct), 0) AS correct_count
         FROM quiz_questions qq
         JOIN quizzes q ON q.id = qq.quiz_id AND q.teacher_id = ?
         JOIN submissions s ON s.quiz_id = q.id
         JOIN submission_answers sa ON sa.submission_id = s.id AND sa.position = qq.position
        GROUP BY qq.id, qq.question_text, q.title
       HAVING attempts > 0
        ORDER BY (SUM(sa.is_correct) / COUNT(sa.id)) ASC, attempts DESC
        LIMIT 1`,
      [req.user.id]
    ),
    query("SELECT setting_value FROM settings WHERE setting_key = 'default_quiz_minutes' LIMIT 1")
  ]);

  const hardest = hardestRows[0];
  const defaultQuizMinutes = Number(settingsRows[0] ? settingsRows[0].setting_value : 45);

  res.json({
    questions: questions.map(mapQuestion),
    quizzes: quizzes.map(quiz => ({
      id: quiz.id,
      title: quiz.title,
      classId: quiz.class_id,
      className: quiz.class_name,
      minutes: Number(quiz.minutes),
      shuffleQuestions: toBoolean(quiz.shuffle_questions),
      isOpen: toBoolean(quiz.is_open),
      questionCount: Number(quiz.question_count),
      createdAt: quiz.created_at
    })),
    classes,
    submissions: submissions.map(submission => ({
      id: submission.id,
      quizId: submission.quiz_id,
      quizTitle: submission.quiz_title,
      className: submission.class_name,
      mode: submission.mode,
      score: Number(submission.score),
      total: Number(submission.total),
      pct: Number(submission.pct),
      submittedAt: submission.submitted_at,
      studentName: submission.student_name,
      studentUsername: submission.student_username
    })),
    announcements: announcements.map(item => ({
      id: item.id,
      text: item.text,
      authorId: item.author_id,
      authorName: item.author_name,
      createdAt: item.created_at
    })),
    stats: {
      submissions: Number(statsRows[0].submissions),
      average: Number(statsRows[0].average || 0),
      highest: Number(statsRows[0].highest || 0)
    },
    hardestQuestion: hardest
      ? {
          text: hardest.question_text,
          quizTitle: hardest.quiz_title,
          attempts: Number(hardest.attempts),
          accuracy: Math.round((Number(hardest.correct_count) / Number(hardest.attempts)) * 100)
        }
      : null,
    settings: { defaultQuizMinutes }
  });
}));

router.post("/questions", asyncHandler(async (req, res) => {
  const input = questionCreateSchema.parse(req.body);
  const result = await query(
    `INSERT INTO questions (question_text, options_json, correct_index, solution, subject, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.questionText, JSON.stringify(input.options), input.correctIndex, input.solution, input.subject, req.user.id]
  );
  await logActivity(req.user, "Added a question to the bank");
  return res.status(201).json({
    question: {
      id: result.insertId,
      text: input.questionText,
      options: input.options,
      correctIndex: input.correctIndex,
      solution: input.solution,
      subject: input.subject,
      creatorId: req.user.id,
      creatorName: req.user.name,
      createdAt: new Date().toISOString()
    }
  });
}));

router.delete("/questions/:id", asyncHandler(async (req, res) => {
  const questionId = idSchema.parse(req.params.id);
  const rows = await query("SELECT id, created_by FROM questions WHERE id = ? LIMIT 1", [questionId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "Question not found." });
  if (target.created_by !== req.user.id) {
    return res.status(403).json({ error: "You can only delete questions that you created." });
  }
  await query("DELETE FROM questions WHERE id = ?", [questionId]);
  await logActivity(req.user, "Deleted a question from the bank");
  return res.json({ ok: true });
}));

function shufflePositions(positions) {
  const shuffled = [...positions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function parseQuestionOrder(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return fallback;
    const positions = parsed.map(Number).filter(number => Number.isInteger(number));
    return positions.length ? positions : fallback;
  } catch {
    return fallback;
  }
}

router.post("/quizzes", asyncHandler(async (req, res) => {
  const input = quizCreateSchema.parse(req.body);

  const classRows = await query("SELECT id, name FROM classes WHERE id = ? LIMIT 1", [input.classId]);
  if (!classRows[0]) return res.status(400).json({ error: "Class not found." });

  const placeholders = input.questionIds.map(() => "?").join(", ");
  const questionRows = await query(
    `SELECT id, question_text, options_json, correct_index, solution, subject, diagram_svg
       FROM questions
      WHERE created_by = ? AND id IN (${placeholders})`,
    [req.user.id, ...input.questionIds]
  );
  const questionMap = new Map(questionRows.map(row => [row.id, row]));

  const ordered = input.questionIds.map(id => questionMap.get(id));
  if (ordered.some(row => !row)) {
    return res.status(400).json({ error: "One or more selected questions no longer exist." });
  }

  const quizId = await withTransaction(async connection => {
    const [result] = await connection.execute(
      `INSERT INTO quizzes (title, class_id, teacher_id, minutes, shuffle_questions, is_open)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [input.title, input.classId, req.user.id, input.minutes, input.shuffleQuestions ? 1 : 0]
    );

    for (let position = 0; position < ordered.length; position += 1) {
      const question = ordered[position];
      await connection.execute(
        `INSERT INTO quiz_questions
           (quiz_id, position, question_text, options_json, correct_index, solution, subject, diagram_svg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.insertId,
          position,
          question.question_text,
          question.options_json,
          question.correct_index,
          question.solution,
          question.subject || "General",
          question.diagram_svg
        ]
      );
    }
    return result.insertId;
  });

  await logActivity(req.user, `Created quiz "${input.title}" for ${classRows[0].name}`);
  return res.status(201).json({
    quiz: { id: quizId, title: input.title, classId: input.classId, minutes: input.minutes, shuffleQuestions: input.shuffleQuestions },
    id: quizId,
    title: input.title,
    classId: input.classId,
    minutes: input.minutes,
    shuffleQuestions: input.shuffleQuestions
  });
}));

router.patch("/quizzes/:id", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const input = quizUpdateSchema.parse(req.body);
  const quiz = await loadOwnedQuiz(quizId, req.user.id);
  if (!quiz) return res.status(404).json({ error: "Quiz not found." });

  const updates = [];
  const params = [];
  const actions = [];

  if (input.isOpen !== undefined) {
    updates.push("is_open = ?");
    params.push(input.isOpen ? 1 : 0);
    actions.push(`${input.isOpen ? "Opened" : "Closed"} quiz "${quiz.title}"`);
  }
  if (input.shuffleQuestions !== undefined) {
    const questionOrder = await query(
      "SELECT id, question_order_json FROM quiz_attempts WHERE quiz_id = ? AND status = 'in_progress'",
      [quizId]
    );
    const naturalOrder = Array.from({ length: Number((await query("SELECT COUNT(*) AS count FROM quiz_questions WHERE quiz_id = ?", [quizId]))[0].count || 0) }, (_, index) => index);

    for (const attempt of questionOrder) {
      const currentOrder = parseQuestionOrder(attempt.question_order_json, naturalOrder);
      const nextOrder = input.shuffleQuestions ? shufflePositions(naturalOrder) : naturalOrder;
      if (JSON.stringify(currentOrder) !== JSON.stringify(nextOrder)) {
        await query("UPDATE quiz_attempts SET question_order_json = ? WHERE id = ?", [JSON.stringify(nextOrder), attempt.id]);
      }
    }

    updates.push("shuffle_questions = ?");
    params.push(input.shuffleQuestions ? 1 : 0);
    actions.push(`${input.shuffleQuestions ? "Enabled" : "Disabled"} question shuffling for "${quiz.title}"`);
  }

  params.push(quizId);
  await query(`UPDATE quizzes SET ${updates.join(", ")} WHERE id = ?`, params);
  for (const action of actions) await logActivity(req.user, action);
  return res.json({
    isOpen: input.isOpen === undefined ? toBoolean(quiz.is_open) : input.isOpen,
    shuffleQuestions: input.shuffleQuestions === undefined
      ? toBoolean(quiz.shuffle_questions)
      : input.shuffleQuestions,
    quiz: {
      id: quiz.id,
      title: quiz.title,
      shuffleQuestions: input.shuffleQuestions === undefined ? toBoolean(quiz.shuffle_questions) : input.shuffleQuestions,
      isOpen: input.isOpen === undefined ? toBoolean(quiz.is_open) : input.isOpen
    }
  });
}));

router.delete("/quizzes/:id", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const quiz = await loadOwnedQuiz(quizId, req.user.id);
  if (!quiz) return res.status(404).json({ error: "Quiz not found." });

  await query("UPDATE quizzes SET is_deleted = 1, is_open = 0 WHERE id = ?", [quizId]);
  await logActivity(req.user, `Archived quiz "${quiz.title}"`);
  return res.json({ ok: true });
}));

router.get("/quizzes/:id/results", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const quiz = await loadOwnedQuiz(quizId, req.user.id);
  if (!quiz) return res.status(404).json({ error: "Quiz not found." });
  res.json(await buildQuizResults(quiz));
}));

router.get("/quizzes/:id/results.csv", asyncHandler(async (req, res) => {
  const quizId = idSchema.parse(req.params.id);
  const quiz = await loadOwnedQuiz(quizId, req.user.id);
  if (!quiz) return res.status(404).json({ error: "Quiz not found." });

  const results = await buildQuizResults(quiz);
  const lines = [
    [csvCell("Quiz"), csvCell(results.quiz.title)].join(","),
    [csvCell("Class"), csvCell(results.quiz.className)].join(","),
    "",
    ["Student", "Username", "Attempts", "Best score", "Best %", "Last attempt"]
      .map(csvCell)
      .join(",")
  ];

  for (const student of results.students) {
    lines.push([
      csvCell(student.name),
      csvCell(student.username),
      csvCell(student.attempts),
      csvCell(student.bestScore === null ? "" : `${student.bestScore}/${student.bestTotal}`),
      csvCell(student.bestPct === null ? "" : student.bestPct),
      csvCell(student.lastAttemptAt || "")
    ].join(","));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="quiz_${quizId}_results.csv"`);
  res.send(`\uFEFF${lines.join("\r\n")}`);
}));

router.post("/announcements", asyncHandler(async (req, res) => {
  const input = announcementCreateSchema.parse(req.body);
  const result = await query(
    "INSERT INTO announcements (author_id, text) VALUES (?, ?)",
    [req.user.id, input.text]
  );
  await logActivity(req.user, "Posted an announcement");
  return res.status(201).json({
    announcement: {
      id: result.insertId,
      text: input.text,
      authorName: req.user.name,
      createdAt: new Date().toISOString()
    }
  });
}));

router.delete("/announcements/:id", asyncHandler(async (req, res) => {
  const announcementId = idSchema.parse(req.params.id);
  const rows = await query("SELECT id, author_id FROM announcements WHERE id = ? LIMIT 1", [announcementId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "Announcement not found." });
  if (target.author_id !== req.user.id) {
    return res.status(403).json({ error: "You can only delete announcements that you posted." });
  }
  await query("DELETE FROM announcements WHERE id = ?", [announcementId]);
  await logActivity(req.user, "Deleted an announcement");
  return res.json({ ok: true });
}));

module.exports = router;
