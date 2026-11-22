"use strict";

const express = require("express");
const { getDocById, listClasses, listWhere } = require("../fdb");
const { asyncHandler } = require("../utils");
const { buildClassLeaderboard } = require("../leaderboard");

const router = express.Router();

async function visibleClasses(user) {
  const [classes, ownedQuizzes] = await Promise.all([
    listClasses(),
    user.role === "teacher"
      ? listWhere("quizzes", "teacher_id", user.id)
      : Promise.resolve([])
  ]);

  let allowed = classes;
  if (user.role === "teacher") {
    const ownedIds = new Set(
      ownedQuizzes
        .map(quiz => Number(quiz.class_id))
        .filter(id => Number.isInteger(id) && id > 0)
    );
    allowed = classes.filter(cls => ownedIds.has(Number(cls.id)));
  }

  return [...allowed].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Read-only staff view. Students keep their own class-only endpoint; teachers
// may only select classes they own a quiz for, and admins may select any class.
router.get("/", asyncHandler(async (req, res) => {
  const classes = await visibleClasses(req.user);
  const classOptions = classes.map(cls => ({ id: Number(cls.id), name: cls.name }));
  if (!classes.length) {
    return res.json({ class: null, quizCount: 0, leaderboard: [], classes: classOptions });
  }

  const requested = req.query.classId;
  let selected = classes[0];
  if (requested !== undefined && requested !== "") {
    const classId = Number(requested);
    selected = classes.find(cls => Number(cls.id) === classId);
    if (!selected) {
      const exists = Number.isInteger(classId) && classId > 0
        ? await getDocById("classes", classId)
        : null;
      return res.status(exists ? 403 : 404).json({
        error: exists ? "That class is outside your scope." : "Class not found."
      });
    }
  }

  return res.json({
    ...(await buildClassLeaderboard(selected, null)),
    classes: classOptions
  });
}));

module.exports = router;
