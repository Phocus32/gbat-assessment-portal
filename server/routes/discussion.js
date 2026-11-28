"use strict";

/**
 * Class-only discussion boards.
 *
 * Students read and write only inside their assigned class. Teachers see the
 * classes explicitly assigned to them; admins see every class. Posts appear
 * immediately, but simple filters and reporting/staff hiding keep the room
 * usable. Discussion records are isolated from exams, scores and progress.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  insertDoc,
  getDocById,
  updateDocById,
  listAll,
  listWhere,
  listWhereIn,
  listClasses
} = require("../fdb");
const { allowedClassIds, assertClassAllowed } = require("../class-access");
const { requireAnyRole } = require("../security");
const { asyncHandler, logActivity } = require("../utils");
const { checkDiscussionText } = require("../moderation");
const {
  idSchema,
  discussionThreadCreateSchema,
  discussionReplyCreateSchema,
  discussionReportCreateSchema,
  discussionModerationSchema,
  discussionReportStatusSchema
} = require("../validation");

const router = express.Router();
const STAFF_ROLES = ["admin", "teacher"];

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user && req.user.id ? req.user.id : "unknown"),
  handler: (req, res) => res.status(429).json({
    error: "You have posted a lot recently. Please wait a few minutes before posting again."
  })
});

function toIso(value) {
  return value instanceof Date ? value.toISOString() : (value ? String(value) : null);
}

function isStaff(user) {
  return STAFF_ROLES.includes(user.role);
}

function excerpt(text, length = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

async function classMap() {
  const classes = await listClasses();
  return new Map(classes.map(cls => [Number(cls.id), cls.name]));
}

async function visibleClassIds(user) {
  return [...(await allowedClassIds(user))].sort((a, b) => a - b);
}

function assertTextAllowed(value) {
  const result = checkDiscussionText(value);
  if (!result.ok) {
    const error = new Error(result.message);
    error.status = 400;
    error.code = result.reason;
    throw error;
  }
}

function threadVisible(thread, user) {
  return isStaff(user) || !thread.hidden;
}

function presentThread(thread, replies, names, user) {
  const visibleReplies = replies
    .filter(reply => isStaff(user) || !reply.hidden)
    .sort((a, b) => Number(a.id) - Number(b.id));

  return {
    id: Number(thread.id),
    classId: Number(thread.class_id),
    className: names.get(Number(thread.class_id)) || null,
    title: thread.title,
    body: thread.body,
    authorId: Number(thread.author_id),
    authorName: thread.author_name,
    authorRole: thread.author_role,
    hidden: Boolean(thread.hidden),
    replyCount: visibleReplies.length,
    createdAt: toIso(thread.created_at),
    updatedAt: toIso(thread.updated_at || thread.created_at),
    canModerate: isStaff(user),
    replies: visibleReplies.map(reply => ({
      id: Number(reply.id),
      authorId: Number(reply.author_id),
      authorName: reply.author_name,
      authorRole: reply.author_role,
      body: reply.body,
      hidden: Boolean(reply.hidden),
      createdAt: toIso(reply.created_at)
    }))
  };
}

function presentReport(report, names) {
  return {
    id: Number(report.id),
    classId: Number(report.class_id),
    className: names.get(Number(report.class_id)) || null,
    targetKind: report.target_kind,
    targetId: Number(report.target_id),
    threadId: Number(report.thread_id),
    title: report.target_title || "",
    excerpt: report.target_excerpt || "",
    authorName: report.author_name || "",
    reason: report.reason,
    status: report.status,
    reporterId: Number(report.reporter_id),
    reporterName: report.reporter_name,
    createdAt: toIso(report.created_at),
    resolvedAt: toIso(report.resolved_at),
    resolvedBy: report.resolved_by === null || report.resolved_by === undefined ? null : Number(report.resolved_by)
  };
}

async function classIdsForList(user, classIdQuery) {
  const allowed = await visibleClassIds(user);

  if (!isStaff(user)) {
    const ownId = Number(user.class_id);
    return Number.isInteger(ownId) && ownId > 0 ? allowed : [];
  }

  if (classIdQuery !== null) {
    const classId = idSchema.parse(classIdQuery);
    if (!allowed.includes(classId)) {
      const error = new Error("That class is not assigned to your account.");
      error.status = 403;
      throw error;
    }
    return [classId];
  }
  return allowed;
}

async function loadReports(user, status) {
  const allowed = await visibleClassIds(user);
  if (!allowed.length) return [];

  let rows = await listWhereIn("discussion_reports", "class_id", allowed);
  if (status && status !== "all") rows = rows.filter(row => row.status === status);
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  return rows;
}

async function safeLog(user, action) {
  try {
    await logActivity(user, action);
  } catch {
    // Discussion writes must succeed even if the auxiliary activity log fails.
  }
}

async function resolveThread(id, user) {
  const thread = await getDocById("discussion_threads", id);
  if (!thread) {
    const error = new Error("Discussion thread not found.");
    error.status = 404;
    throw error;
  }
  await assertClassAllowed(user, thread.class_id);
  return thread;
}

async function resolveReply(id, user) {
  const reply = await getDocById("discussion_replies", id);
  if (!reply) {
    const error = new Error("Reply not found.");
    error.status = 404;
    throw error;
  }
  await assertClassAllowed(user, reply.class_id);
  return reply;
}

router.get("/", asyncHandler(async (req, res) => {
  const classIdQuery = req.query.classId === undefined || req.query.classId === "" ? null : req.query.classId;
  const ids = await classIdsForList(req.user, classIdQuery);

  let threads = ids.length
    ? await listWhereIn("discussion_threads", "class_id", ids)
    : [];

  if (!isStaff(req.user)) threads = threads.filter(row => threadVisible(row, req.user));

  const term = String(req.query.q || "").trim().toLowerCase();
  if (term) {
    threads = threads.filter(row => [row.title, row.body, row.author_name]
      .some(value => String(value || "").toLowerCase().includes(term)));
  }

  threads.sort((a, b) => Number(b.id) - Number(a.id));
  threads = threads.slice(0, 200);

  const names = await classMap();
  const replies = threads.length
    ? await listWhereIn("discussion_replies", "thread_id", threads.map(row => Number(row.id)))
    : [];

  const rows = threads.map(thread => presentThread(
    thread,
    replies.filter(reply => Number(reply.thread_id) === Number(thread.id)),
    names,
    req.user
  ));

  return res.json({
    threads: rows,
    classes: [...names.entries()]
      .filter(([classId]) => ids.includes(classId))
      .map(([classId, name]) => ({ id: classId, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    stats: {
      total: rows.length,
      hidden: rows.filter(row => row.hidden).length
    }
  });
}));

router.get("/reports", requireAnyRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const status = String(req.query.status || "open").trim().toLowerCase();
  if (!["open", "resolved", "all"].includes(status)) {
    const error = new Error("Unknown report status.");
    error.status = 400;
    throw error;
  }
  const names = await classMap();
  const reports = (await loadReports(req.user, status)).map(row => presentReport(row, names));
  return res.json({ reports });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const thread = await resolveThread(id, req.user);
  if (!threadVisible(thread, req.user)) {
    return res.status(404).json({ error: "Discussion thread not found." });
  }

  const replies = await listWhere("discussion_replies", "thread_id", id);
  const names = await classMap();
  return res.json({ thread: presentThread(thread, replies, names, req.user) });
}));

router.post("/threads", writeLimiter, asyncHandler(async (req, res) => {
  const input = discussionThreadCreateSchema.parse(req.body);
  assertTextAllowed(`${input.title} ${input.body}`);

  let classId;
  if (isStaff(req.user)) {
    classId = idSchema.parse(req.body.classId);
    await assertClassAllowed(req.user, classId);
  } else {
    classId = Number(req.user.class_id);
    await assertClassAllowed(req.user, classId);
  }

  const now = new Date();
  const id = await insertDoc("discussion_threads", {
    class_id: classId,
    title: input.title,
    body: input.body,
    author_id: req.user.id,
    author_name: req.user.name,
    author_role: req.user.role,
    hidden: false,
    created_at: now,
    updated_at: now
  }, "discussion_threads");

  await safeLog(req.user, `Started discussion "${input.title}"`);
  const saved = await getDocById("discussion_threads", id);
  const names = await classMap();
  return res.status(201).json({ thread: presentThread(saved, [], names, req.user) });
}));

router.post("/threads/:id/replies", writeLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = discussionReplyCreateSchema.parse(req.body);
  assertTextAllowed(input.body);
  const thread = await resolveThread(id, req.user);
  if (!threadVisible(thread, req.user)) {
    return res.status(404).json({ error: "Discussion thread not found." });
  }

  const now = new Date();
  const replyId = await insertDoc("discussion_replies", {
    thread_id: id,
    class_id: thread.class_id,
    body: input.body,
    author_id: req.user.id,
    author_name: req.user.name,
    author_role: req.user.role,
    hidden: false,
    created_at: now
  }, "discussion_replies");

  await updateDocById("discussion_threads", id, { updated_at: now });
  await safeLog(req.user, `Replied to discussion "${thread.title}"`);

  const saved = await getDocById("discussion_replies", replyId);
  return res.status(201).json({ reply: {
    id: Number(saved.id),
    authorId: Number(saved.author_id),
    authorName: saved.author_name,
    authorRole: saved.author_role,
    body: saved.body,
    hidden: Boolean(saved.hidden),
    createdAt: toIso(saved.created_at)
  } });
}));

async function createReport(req, res, target, targetKind, threadId, title) {
  const input = discussionReportCreateSchema.parse(req.body);
  const classId = Number(target.class_id);
  await assertClassAllowed(req.user, classId);

  const existing = await listWhere("discussion_reports", "target_id", Number(target.id));
  const duplicate = existing.some(row =>
    row.target_kind === targetKind
    && Number(row.reporter_id) === Number(req.user.id)
    && row.status === "open");

  if (duplicate) {
    return res.status(409).json({ error: "You already reported this post." });
  }

  await insertDoc("discussion_reports", {
    class_id: classId,
    target_kind: targetKind,
    target_id: Number(target.id),
    thread_id: Number(threadId),
    target_title: String(title || "").slice(0, 160),
    target_excerpt: excerpt(target.body),
    author_name: target.author_name,
    reporter_id: req.user.id,
    reporter_name: req.user.name,
    reason: input.reason,
    status: "open",
    created_at: new Date(),
    resolved_at: null,
    resolved_by: null
  }, "discussion_reports");

  await safeLog(req.user, `Reported ${targetKind} "${String(title || "").slice(0, 80)}"`);
  return res.status(201).json({ ok: true });
}

router.post("/threads/:id/report", writeLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const thread = await resolveThread(id, req.user);
  return createReport(req, res, thread, "thread", id, thread.title);
}));

router.post("/replies/:id/report", writeLimiter, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const reply = await resolveReply(id, req.user);
  return createReport(req, res, reply, "reply", reply.thread_id, "Reply");
}));

router.patch("/threads/:id/visibility", requireAnyRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = discussionModerationSchema.parse(req.body);
  const thread = await resolveThread(id, req.user);

  await updateDocById("discussion_threads", id, { hidden: input.hidden });
  await safeLog(req.user, `${input.hidden ? "Hid" : "Unhid"} discussion "${thread.title}"`);
  return res.json({ ok: true, hidden: input.hidden });
}));

router.patch("/replies/:id/visibility", requireAnyRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = discussionModerationSchema.parse(req.body);
  await resolveReply(id, req.user);

  await updateDocById("discussion_replies", id, { hidden: input.hidden });
  await safeLog(req.user, `${input.hidden ? "Hid" : "Unhid"} a discussion reply`);
  return res.json({ ok: true, hidden: input.hidden });
}));

router.patch("/reports/:id", requireAnyRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = discussionReportStatusSchema.parse(req.body);
  const report = await getDocById("discussion_reports", id);
  if (!report) return res.status(404).json({ error: "Report not found." });
  await assertClassAllowed(req.user, report.class_id);

  await updateDocById("discussion_reports", id, {
    status: input.status,
    resolved_at: input.status === "resolved" ? new Date() : null,
    resolved_by: input.status === "resolved" ? req.user.id : null
  });
  await safeLog(req.user, `${input.status === "resolved" ? "Resolved" : "Reopened"} a discussion report`);
  return res.json({ ok: true });
}));

module.exports = router;
