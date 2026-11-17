"use strict";

const express = require("express");
const { query } = require("../db");
const { asyncHandler, parseOptions } = require("../utils");
const { idSchema } = require("../validation");

const router = express.Router();

router.get("/:id", asyncHandler(async (req, res) => {
  const submissionId = idSchema.parse(req.params.id);

  const rows = await query(
    `SELECT s.*, q.title AS quiz_title, q.teacher_id,
            c.name AS class_name, u.name AS student_name, u.username AS student_username
       FROM submissions s
       JOIN quizzes q ON q.id = s.quiz_id
       JOIN classes c ON c.id = s.class_id
       JOIN users u ON u.id = s.student_id
      WHERE s.id = ?
      LIMIT 1`,
    [submissionId]
  );
  const submission = rows[0];
  if (!submission) return res.status(404).json({ error: "Submission not found." });

  const role = req.user.role;
  const allowed =
    role === "admin" ||
    (role === "teacher" && submission.teacher_id === req.user.id) ||
    (role === "student" && submission.student_id === req.user.id);

  if (!allowed) {
    return res.status(403).json({ error: "You do not have access to this submission." });
  }

  const answers = await query(
    `SELECT sa.position, sa.chosen_index, sa.correct_index, sa.is_correct,
            qq.question_text, qq.options_json, qq.solution, qq.subject, qq.diagram_svg
       FROM submission_answers sa
       JOIN quiz_questions qq ON qq.quiz_id = ? AND qq.position = sa.position
      WHERE sa.submission_id = ?
      ORDER BY sa.position`,
    [submission.quiz_id, submissionId]
  );

  return res.json({
    submission: {
      id: submission.id,
      quizId: submission.quiz_id,
      quizTitle: submission.quiz_title,
      className: submission.class_name,
      studentName: submission.student_name,
      studentUsername: submission.student_username,
      mode: submission.mode,
      score: Number(submission.score),
      total: Number(submission.total),
      pct: Number(submission.pct),
      submittedAt: submission.submitted_at,
      questions: answers.map(answer => ({
        position: Number(answer.position),
        text: answer.question_text,
        options: parseOptions(answer.options_json),
        chosenIndex: answer.chosen_index === null ? null : Number(answer.chosen_index),
        correctIndex: Number(answer.correct_index),
        solution: answer.solution,
        subject: answer.subject || "General",
        diagramSvg: answer.diagram_svg || null,
        isCorrect: Boolean(answer.is_correct)
      }))
    }
  });
}));

module.exports = router;
