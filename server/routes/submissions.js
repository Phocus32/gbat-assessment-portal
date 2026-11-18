"use strict";

const express = require("express");
const { getDocById, listQuizItems } = require("../fdb");
const { asyncHandler, parseOptions } = require("../utils");
const { getSettings } = require("../settings");
const { idSchema } = require("../validation");

const router = express.Router();

router.get("/:id", asyncHandler(async (req, res) => {
  const submissionId = idSchema.parse(req.params.id);

  const submission = await getDocById("submissions", submissionId);
  if (!submission) return res.status(404).json({ error: "Submission not found." });

  const [quiz, cls, student] = await Promise.all([
    getDocById("quizzes", submission.quiz_id),
    getDocById("classes", submission.class_id),
    getDocById("users", submission.student_id)
  ]);

  const role = req.user.role;
  const allowed =
    role === "admin" ||
    (role === "teacher" && quiz && Number(quiz.teacher_id) === Number(req.user.id)) ||
    (role === "student" && Number(submission.student_id) === Number(req.user.id));

  if (!allowed) {
    return res.status(403).json({ error: "You do not have access to this submission." });
  }

  const [items, settings] = await Promise.all([
    listQuizItems(submission.quiz_id),
    getSettings()
  ]);
  const itemMap = new Map(items.map(item => [Number(item.position), item]));
  const hideAnswers = role === "student" && !settings.showSolutions;

  return res.json({
    submission: {
      id: submission.id,
      quizId: submission.quiz_id,
      quizTitle: quiz ? quiz.title : "",
      className: cls ? cls.name : null,
      studentName: student ? student.name : "Former student",
      studentUsername: student ? student.username : "",
      mode: submission.mode,
      score: Number(submission.score),
      total: Number(submission.total),
      pct: Number(submission.pct),
      submittedAt: submission.submitted_at,
      questions: (submission.answers || [])
        .slice()
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(answer => {
          const item = itemMap.get(Number(answer.position)) || {};
          return {
            position: Number(answer.position),
            text: item.question_text || "",
            options: parseOptions(item.options),
            chosenIndex: answer.chosen_index === null || answer.chosen_index === undefined
              ? null
              : Number(answer.chosen_index),
            ...(hideAnswers
              ? {}
              : {
                correctIndex: Number(answer.correct_index),
                solution: item.solution || "",
                isCorrect: Boolean(answer.is_correct)
              }),
            subject: item.subject || "General",
            diagramSvg: item.diagram_svg || null
          };
        })
    }
  });
}));

module.exports = router;
