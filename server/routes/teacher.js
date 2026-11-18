"use strict";

const express = require("express");
const {
  listWhere,
  listWhereIn,
  listClasses,
  getDocById,
  getManyByIds,
  insertDoc,
  updateDocById,
  deleteDocById,
  createQuizWithItems,
  listQuizItems,
  countQuizItems,
  recentDocs
} = require("../fdb");
const { getSettings } = require("../settings");
const { subjectIdsOf, assertSubjectsAllowed, subjectMap } = require("../subjects");
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
  announcementCreateSchema,
  teacherStudentUpdateSchema
} = require("../validation");

const router = express.Router();

function mapQuestion(row) {
  return {
    id: row.id,
    text: row.question_text,
    options: parseOptions(row.options),
    correctIndex: Number(row.correct_index),
    solution: row.solution,
    subject: row.subject || "General",
    subjectId: row.subject_id || null,
    diagramSvg: row.diagram_svg || null,
    creatorId: row.created_by,
    creatorName: row.creator_name || null,
    createdAt: row.created_at
  };
}

async function loadOwnedQuiz(quizId, teacherId) {
  const quiz = await getDocById("quizzes", quizId);
  if (!quiz || quiz.is_deleted || Number(quiz.teacher_id) !== Number(teacherId)) return null;
  const cls = await getDocById("classes", quiz.class_id);
  return { ...quiz, class_name: cls ? cls.name : null };
}

async function buildQuizResults(quiz) {
  const [rosterAll, submissions, items] = await Promise.all([
    listWhere("users", "class_id", quiz.class_id),
    listWhere("submissions", "quiz_id", quiz.id),
    listQuizItems(quiz.id)
  ]);

  const roster = rosterAll
    .filter(user => user.role === "student")
    .sort((a, b) => a.name.localeCompare(b.name));

  const studentIds = [...new Set(submissions.map(submission => Number(submission.student_id)))];
  const studentDocs = await getManyByIds("users", studentIds);
  const studentNameMap = new Map(studentDocs.map(user => [Number(user.id), user]));

  submissions.sort((a, b) => Number(b.pct) - Number(a.pct) || new Date(a.submitted_at) - new Date(b.submitted_at));

  const studentMap = new Map();
  for (const student of roster) {
    studentMap.set(Number(student.id), {
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

  for (const submission of submissions) {
    let entry = studentMap.get(Number(submission.student_id));
    if (!entry) {
      const doc = studentNameMap.get(Number(submission.student_id)) || {};
      entry = {
        studentId: submission.student_id,
        name: doc.name || "Former student",
        username: doc.username || "",
        attempts: 0,
        bestSubmissionId: null,
        bestPct: null,
        bestScore: null,
        bestTotal: null,
        bestMode: null,
        lastAttemptAt: null
      };
      studentMap.set(Number(submission.student_id), entry);
    }
    entry.attempts += 1;
    if (entry.bestPct === null || Number(submission.pct) > Number(entry.bestPct)) {
      entry.bestSubmissionId = submission.id;
      entry.bestPct = Number(submission.pct);
      entry.bestScore = Number(submission.score);
      entry.bestTotal = Number(submission.total);
      entry.bestMode = submission.mode;
    }
    if (!entry.lastAttemptAt || new Date(submission.submitted_at) > new Date(entry.lastAttemptAt)) {
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

  const tally = new Map();
  for (const submission of submissions) {
    for (const answer of submission.answers || []) {
      const key = Number(answer.position);
      const bucket = tally.get(key) || { attempts: 0, correct: 0 };
      bucket.attempts += 1;
      if (answer.is_correct) bucket.correct += 1;
      tally.set(key, bucket);
    }
  }

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
    accuracy: items.map(item => {
      const bucket = tally.get(Number(item.position)) || { attempts: 0, correct: 0 };
      return {
        position: Number(item.position),
        text: item.question_text,
        subject: item.subject || "General",
        attempts: bucket.attempts,
        correct: bucket.correct,
        accuracy: bucket.attempts ? Math.round((bucket.correct / bucket.attempts) * 100) : 0
      };
    })
  };
}

router.get("/students/template.xlsx", asyncHandler(async (req, res) => {
  const classes = await listClasses();
  const buffer = await buildStudentTemplate(classes.map(cls => cls.name));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=\"gbat-student-import-template.xlsx\"");
  return res.send(buffer);
}));

router.get("/bootstrap", asyncHandler(async (req, res) => {
  const teacherId = req.user.id;
  const allowedIds = subjectIdsOf(req.user);

  const [allQuestions, ownedQuizzes, classes, announcements, settings, allSubjects, students] = await Promise.all([
    listWhere("questions", "created_by", teacherId),
    listWhere("quizzes", "teacher_id", teacherId),
    listClasses(),
    recentDocs("announcements", 50),
    getSettings(),
    subjectMap(),
    listWhere("users", "role", "student")
  ]);

  const allowedSet = new Set(allowedIds);
  const subjectByName = new Map(
    [...allSubjects].map(([id, name]) => [String(name).toLowerCase(), id])
  );
  const inScope = row => {
    if (allowedSet.has(Number(row.subject_id))) return true;
    if (row.subject_id) return false;
    const id = subjectByName.get(String(row.subject || "General").toLowerCase());
    return id !== undefined && allowedSet.has(Number(id));
  };

  const questions = allQuestions.filter(inScope);
  const subjects = allowedIds
    .map(id => ({ id: Number(id), name: allSubjects.get(Number(id)) }))
    .filter(item => item.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  const classMap = new Map(classes.map(cls => [Number(cls.id), cls.name]));
  const quizzes = ownedQuizzes
    .filter(quiz => !quiz.is_deleted && inScope(quiz))
    .sort((a, b) => Number(b.id) - Number(a.id));
  const quizIds = quizzes.map(quiz => Number(quiz.id));

  const [questionCounts, submissions] = await Promise.all([
    Promise.all(quizIds.map(id => countQuizItems(id))),
    listWhereIn("submissions", "quiz_id", quizIds)
  ]);
  const questionCountMap = new Map(quizIds.map((id, index) => [id, questionCounts[index]]));

  submissions.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  const recentSubmissions = submissions.slice(0, 100);

  const quizMap = new Map(quizzes.map(quiz => [Number(quiz.id), quiz]));
  const peopleIds = [
    ...new Set([
      ...recentSubmissions.map(submission => Number(submission.student_id)),
      ...announcements.map(item => Number(item.author_id))
    ])
  ];
  const people = await getManyByIds("users", peopleIds);
  const peopleMap = new Map(people.map(user => [Number(user.id), user]));

  const statsSubmissions = submissions.length;
  const statsAverage = statsSubmissions
    ? Math.round(submissions.reduce((sum, row) => sum + Number(row.pct || 0), 0) / statsSubmissions)
    : 0;
  const statsHighest = statsSubmissions ? Math.max(...submissions.map(row => Number(row.pct || 0))) : 0;

  const itemText = new Map();
  for (const quiz of quizzes) {
    const items = await listQuizItems(quiz.id);
    for (const item of items) {
      itemText.set(`${Number(quiz.id)}:${Number(item.position)}`, item);
    }
  }
  const tally = new Map();
  for (const submission of recentSubmissions) {
    for (const answer of submission.answers || []) {
      const key = `${Number(submission.quiz_id)}:${Number(answer.position)}`;
      const bucket = tally.get(key) || { attempts: 0, correct: 0 };
      bucket.attempts += 1;
      if (answer.is_correct) bucket.correct += 1;
      tally.set(key, bucket);
    }
  }
  let hardest = null;
  for (const [key, bucket] of tally) {
    if (!bucket.attempts) continue;
    const item = itemText.get(key);
    if (!item) continue;
    const candidate = {
      text: item.question_text,
      quizTitle: quizMap.get(Number(key.split(":")[0]))?.title || "",
      attempts: bucket.attempts,
      accuracy: Math.round((bucket.correct / bucket.attempts) * 100)
    };
    if (
      !hardest ||
      candidate.accuracy < hardest.accuracy ||
      (candidate.accuracy === hardest.accuracy && candidate.attempts > hardest.attempts)
    ) {
      hardest = candidate;
    }
  }

  res.json({
    subjects,
    questions: questions
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map(question => mapQuestion({ ...question, creator_name: req.user.name })),
    quizzes: quizzes.map(quiz => ({
      id: quiz.id,
      title: quiz.title,
      classId: quiz.class_id,
      className: classMap.get(Number(quiz.class_id)) || null,
      subjectId: quiz.subject_id || null,
      subjectName: allSubjects.get(Number(quiz.subject_id)) || quiz.subject || "General",
      minutes: Number(quiz.minutes),
      shuffleQuestions: toBoolean(quiz.shuffle_questions),
      isOpen: toBoolean(quiz.is_open),
      approved: quiz.approved !== false,
      questionCount: questionCountMap.get(Number(quiz.id)) || 0,
      createdAt: quiz.created_at
    })),
    classes: classes.map(cls => ({ id: cls.id, name: cls.name })),
    students: students
      .filter(student => student.role === "student")
      .map(student => ({
        id: student.id,
        name: student.name,
        username: student.username,
        classId: student.class_id === null || student.class_id === undefined ? null : Number(student.class_id),
        className: classMap.get(Number(student.class_id)) || null,
        active: toBoolean(student.active)
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    submissions: recentSubmissions.map(submission => {
      const student = peopleMap.get(Number(submission.student_id)) || {};
      const quiz = quizMap.get(Number(submission.quiz_id)) || {};
      return {
        id: submission.id,
        quizId: submission.quiz_id,
        quizTitle: quiz.title || "",
        className: classMap.get(Number(submission.class_id)) || null,
        mode: submission.mode,
        score: Number(submission.score),
        total: Number(submission.total),
        pct: Number(submission.pct),
        submittedAt: submission.submitted_at,
        studentName: student.name || "Former student",
        studentUsername: student.username || ""
      };
    }),
    announcements: announcements.map(item => ({
      id: item.id,
      text: item.text,
      authorId: item.author_id,
      authorName: (peopleMap.get(Number(item.author_id)) || {}).name || "Unknown",
      createdAt: item.created_at
    })),
    stats: {
      submissions: statsSubmissions,
      average: statsAverage,
      highest: statsHighest
    },
    hardestQuestion: hardest,
    settings
  });
}));

router.post("/questions", asyncHandler(async (req, res) => {
  const input = questionCreateSchema.parse(req.body);
  if (!(await assertSubjectsAllowed([input.subjectId], req.user))) {
    return res.status(403).json({ error: "That subject is not assigned to your account." });
  }

  const names = await subjectMap();
  const subjectName = names.get(Number(input.subjectId)) || "General";
  const questionId = await insertDoc("questions", {
    question_text: input.questionText,
    options: input.options,
    correct_index: input.correctIndex,
    solution: input.solution,
    subject_id: Number(input.subjectId),
    subject: subjectName,
    diagram_svg: null,
    created_by: req.user.id,
    created_at: new Date(),
    updated_at: new Date()
  });
  await logActivity(req.user, `Added a question to ${subjectName}`);
  return res.status(201).json({
    question: {
      id: questionId,
      text: input.questionText,
      options: input.options,
      correctIndex: input.correctIndex,
      solution: input.solution,
      subject: subjectName,
      subjectId: Number(input.subjectId),
      creatorId: req.user.id,
      creatorName: req.user.name,
      createdAt: new Date().toISOString()
    }
  });
}));

router.delete("/questions/:id", asyncHandler(async (req, res) => {
  const questionId = idSchema.parse(req.params.id);
  const target = await getDocById("questions", questionId);
  if (!target) return res.status(404).json({ error: "Question not found." });
  if (Number(target.created_by) !== Number(req.user.id)) {
    return res.status(403).json({ error: "You can only delete questions that you created." });
  }
  if (target.subject_id && !(await assertSubjectsAllowed([target.subject_id], req.user))) {
    return res.status(403).json({ error: "That subject is no longer assigned to your account." });
  }
  await deleteDocById("questions", questionId);
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
  if (Array.isArray(value)) {
    const positions = value.map(Number).filter(Number.isInteger);
    return positions.length ? positions : fallback;
  }
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
  const settings = await getSettings();

  if (!(await assertSubjectsAllowed([input.subjectId], req.user))) {
    return res.status(403).json({ error: "That subject is not assigned to your account." });
  }
  if (input.minutes < settings.minQuizMinutes || input.minutes > settings.maxQuizMinutes) {
    return res.status(400).json({
      error: `Quiz duration must be between ${settings.minQuizMinutes} and ${settings.maxQuizMinutes} minutes.`
    });
  }
  if (input.questionIds.length < settings.minQuestions || input.questionIds.length > settings.maxQuestions) {
    return res.status(400).json({
      error: `A quiz must contain between ${settings.minQuestions} and ${settings.maxQuestions} questions.`
    });
  }

  const cls = await getDocById("classes", input.classId);
  if (!cls) return res.status(400).json({ error: "Class not found." });

  const questionDocs = await getManyByIds("questions", input.questionIds);
  const questionMap = new Map(
    questionDocs
      .filter(question =>
        Number(question.created_by) === Number(req.user.id) &&
        Number(question.subject_id) === Number(input.subjectId)
      )
      .map(question => [Number(question.id), question])
  );

  const ordered = input.questionIds.map(id => questionMap.get(Number(id)));
  if (ordered.some(row => !row)) {
    return res.status(400).json({ error: "One or more selected questions no longer exist in that subject." });
  }

  const names = await subjectMap();
  const subjectName = names.get(Number(input.subjectId)) || "General";
  const approved = !settings.requireApproval;
  const quizId = await createQuizWithItems(
    {
      title: input.title,
      class_id: input.classId,
      teacher_id: req.user.id,
      subject_id: Number(input.subjectId),
      subject: subjectName,
      minutes: input.minutes,
      shuffle_questions: Boolean(input.shuffleQuestions),
      is_open: true,
      is_deleted: false,
      approved,
      created_at: new Date()
    },
    ordered.map(question => ({
      question_text: question.question_text,
      options: parseOptions(question.options),
      correct_index: Number(question.correct_index),
      solution: question.solution,
      subject: subjectName,
      subject_id: Number(input.subjectId),
      diagram_svg: question.diagram_svg || null
    }))
  );

  await logActivity(req.user, `Created quiz "${input.title}" for ${cls.name}`);
  return res.status(201).json({
    quiz: {
      id: quizId,
      title: input.title,
      classId: input.classId,
      subjectId: Number(input.subjectId),
      minutes: input.minutes,
      shuffleQuestions: input.shuffleQuestions,
      approved
    },
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

  const patch = {};
  const actions = [];

  if (input.isOpen !== undefined) {
    patch.is_open = Boolean(input.isOpen);
    actions.push(`${input.isOpen ? "Opened" : "Closed"} quiz "${quiz.title}"`);
  }
  if (input.shuffleQuestions !== undefined) {
    const inProgress = (await listWhere("attempts", "quiz_id", quizId))
      .filter(attempt => attempt.status === "in_progress");
    const itemCount = await countQuizItems(quizId);
    const naturalOrder = Array.from({ length: itemCount }, (_, index) => index);

    for (const attempt of inProgress) {
      const currentOrder = parseQuestionOrder(attempt.question_order, naturalOrder);
      const nextOrder = input.shuffleQuestions ? shufflePositions(naturalOrder) : naturalOrder;
      if (JSON.stringify(currentOrder) !== JSON.stringify(nextOrder)) {
        await updateDocById("attempts", attempt.id, { question_order: nextOrder });
      }
    }

    patch.shuffle_questions = Boolean(input.shuffleQuestions);
    actions.push(`${input.shuffleQuestions ? "Enabled" : "Disabled"} question shuffling for "${quiz.title}"`);
  }

  await updateDocById("quizzes", quizId, patch);
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

  await updateDocById("quizzes", quizId, { is_deleted: true, is_open: false });
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

router.get("/students", asyncHandler(async (req, res) => {
  const [students, classes] = await Promise.all([
    listWhere("users", "role", "student"),
    listClasses()
  ]);
  const classMap = new Map(classes.map(cls => [Number(cls.id), cls.name]));
  return res.json({
    students: students
      .map(student => ({
        id: student.id,
        name: student.name,
        username: student.username,
        classId: student.class_id === null || student.class_id === undefined ? null : Number(student.class_id),
        className: classMap.get(Number(student.class_id)) || null,
        active: toBoolean(student.active)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  });
}));

router.patch("/students/:id", asyncHandler(async (req, res) => {
  const studentId = idSchema.parse(req.params.id);
  const input = teacherStudentUpdateSchema.parse(req.body);

  const target = await getDocById("users", studentId);
  if (!target || target.role !== "student") {
    return res.status(404).json({ error: "Student not found." });
  }
  const cls = await getDocById("classes", input.classId);
  if (!cls) return res.status(400).json({ error: "Class not found." });

  await updateDocById("users", studentId, { class_id: cls.id });
  await logActivity(req.user, `Moved ${target.name} to ${cls.name}`);
  return res.json({
    student: {
      id: target.id,
      name: target.name,
      username: target.username,
      classId: cls.id,
      className: cls.name,
      active: toBoolean(target.active)
    }
  });
}));

router.post("/announcements", asyncHandler(async (req, res) => {
  const input = announcementCreateSchema.parse(req.body);
  const announcementId = await insertDoc("announcements", {
    author_id: req.user.id,
    text: input.text,
    created_at: new Date()
  });
  await logActivity(req.user, "Posted an announcement");
  return res.status(201).json({
    announcement: {
      id: announcementId,
      text: input.text,
      authorName: req.user.name,
      createdAt: new Date().toISOString()
    }
  });
}));

router.delete("/announcements/:id", asyncHandler(async (req, res) => {
  const announcementId = idSchema.parse(req.params.id);
  const target = await getDocById("announcements", announcementId);
  if (!target) return res.status(404).json({ error: "Announcement not found." });
  if (Number(target.author_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: "You can only delete announcements that you posted." });
  }
  await deleteDocById("announcements", announcementId);
  await logActivity(req.user, "Deleted an announcement");
  return res.json({ ok: true });
}));

module.exports = router;
