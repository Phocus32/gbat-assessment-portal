"use strict";

const express = require("express");
const { getDocById, listClasses } = require("../fdb");
const { allowedClassIds } = require("../class-access");
const { asyncHandler } = require("../utils");
const { leaderboardPeriodSchema } = require("../validation");
const {
  buildClassLeaderboard,
  resolveLeaderboardPeriod,
  serializePeriod
} = require("../leaderboard");

const router = express.Router();

async function visibleClasses(user) {
  const [classes, allowed] = await Promise.all([
    listClasses(),
    allowedClassIds(user)
  ]);
  return classes
    .filter(cls => allowed.has(Number(cls.id)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Read-only staff view. Students keep their own class-only endpoint; teachers
// may only select classes assigned to their account, and admins may select any class.
router.get("/", asyncHandler(async (req, res) => {
  const periodKey = leaderboardPeriodSchema.parse(req.query.period);
  const classes = await visibleClasses(req.user);
  const classOptions = classes.map(cls => ({ id: Number(cls.id), name: cls.name }));
  if (!classes.length) {
    return res.json({
      class: null,
      quizCount: 0,
      period: serializePeriod(resolveLeaderboardPeriod(periodKey)),
      leaderboard: [],
      classes: classOptions
    });
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
    ...(await buildClassLeaderboard(selected, null, periodKey)),
    classes: classOptions
  });
}));

module.exports = router;
