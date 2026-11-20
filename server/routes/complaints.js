"use strict";

/**
 * Complaints from teachers and students, with admin replies.
 *
 * All access is derived from the authenticated user: teachers and students can
 * only read and create their own complaints, while admins can read, filter,
 * reply to and close any complaint. Replies are embedded in the complaint
 * document because a complaint is small and always read as a whole.
 */

const express = require("express");
const {
  insertDoc,
  getDocById,
  updateDocById,
  addComplaintReply,
  listAll,
  listClasses
} = require("../fdb");
const { requireAnyRole } = require("../security");
const { asyncHandler, logActivity } = require("../utils");
const {
  idSchema,
  complaintCreateSchema,
  complaintReplySchema,
  complaintStatusSchema
} = require("../validation");

const router = express.Router();

const PARTICIPANT_ROLES = ["teacher", "student"];

function statusOf(complaint) {
  if (complaint.status === "closed") return "closed";
  return Array.isArray(complaint.replies) && complaint.replies.length ? "replied" : "open";
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : (value ? String(value) : null);
}

function present(complaint, classMap) {
  const replies = Array.isArray(complaint.replies) ? complaint.replies : [];
  return {
    id: complaint.id,
    subject: complaint.subject,
    message: complaint.message,
    category: complaint.category || "other",
    senderId: complaint.sender_id,
    senderName: complaint.sender_name,
    senderRole: complaint.sender_role,
    senderClassName: complaint.class_id === null || complaint.class_id === undefined
      ? null
      : (classMap.get(Number(complaint.class_id)) || null),
    status: statusOf(complaint),
    createdAt: toIso(complaint.created_at),
    updatedAt: toIso(complaint.updated_at || complaint.created_at),
    replyCount: replies.length,
    replies: replies.map(reply => ({
      id: reply.id,
      authorId: reply.author_id,
      authorName: reply.author_name,
      authorRole: reply.author_role,
      message: reply.message,
      createdAt: toIso(reply.created_at)
    }))
  };
}

async function classNames() {
  const classes = await listClasses();
  return new Map(classes.map(cls => [Number(cls.id), cls.name]));
}

function canView(user, complaint) {
  if (user.role === "admin") return true;
  return Number(complaint.sender_id) === Number(user.id);
}

function matchesFilters(complaint, query) {
  const status = String(query.status || "").trim().toLowerCase();
  if (status && status !== "all" && statusOf(complaint) !== status) return false;

  const role = String(query.role || "").trim().toLowerCase();
  if (role && role !== "all" && complaint.sender_role !== role) return false;

  if (query.classId && Number(complaint.class_id) !== Number(query.classId)) {
    return false;
  }

  const term = String(query.q || "").trim().toLowerCase();
  if (!term) return true;
  return [complaint.subject, complaint.message, complaint.sender_name, complaint.sender_role]
    .some(value => String(value || "").toLowerCase().includes(term));
}

router.get("/", asyncHandler(async (req, res) => {
  const classMap = await classNames();
  let complaints = await listAll("complaints");

  if (req.user.role !== "admin") {
    complaints = complaints.filter(row => Number(row.sender_id) === Number(req.user.id));
  }
  complaints = complaints.filter(row => matchesFilters(row, req.query));
  complaints.sort((a, b) => Number(b.id) - Number(a.id));

  const rows = complaints.map(row => present(row, classMap));
  res.json({
    complaints: rows,
    stats: {
      total: rows.length,
      open: rows.filter(row => row.status === "open").length,
      replied: rows.filter(row => row.status === "replied").length,
      closed: rows.filter(row => row.status === "closed").length
    }
  });
}));

router.post("/", requireAnyRole(...PARTICIPANT_ROLES), asyncHandler(async (req, res) => {
  const input = complaintCreateSchema.parse(req.body);
  const now = new Date();
  const id = await insertDoc("complaints", {
    subject: input.subject,
    message: input.message,
    category: input.category,
    sender_id: req.user.id,
    sender_name: req.user.name,
    sender_role: req.user.role,
    class_id: req.user.role === "student" ? (req.user.class_id ?? null) : null,
    status: "open",
    replies: [],
    created_at: now,
    updated_at: now
  }, "complaints");

  await logActivity(req.user, `Submitted complaint "${input.subject}"`);
  const saved = await getDocById("complaints", id);
  return res.status(201).json({ complaint: present(saved, await classNames()) });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const complaint = await getDocById("complaints", id);
  if (!complaint || !canView(req.user, complaint)) {
    return res.status(404).json({ error: "Complaint not found." });
  }
  return res.json({ complaint: present(complaint, await classNames()) });
}));

router.post("/:id/replies", requireAnyRole("admin"), asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = complaintReplySchema.parse(req.body);

  const result = await addComplaintReply(id, {
    authorId: req.user.id,
    authorName: req.user.name,
    authorRole: req.user.role,
    message: input.message
  });
  if (!result) return res.status(404).json({ error: "Complaint not found." });

  await logActivity(req.user, `Replied to complaint "${result.complaint.subject}"`);
  const saved = await getDocById("complaints", id);
  return res.status(201).json({ complaint: present(saved, await classNames()) });
}));

router.patch("/:id/status", requireAnyRole("admin"), asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = complaintStatusSchema.parse(req.body);
  const complaint = await getDocById("complaints", id);
  if (!complaint) return res.status(404).json({ error: "Complaint not found." });

  await updateDocById("complaints", id, {
    status: input.status,
    updated_at: new Date()
  });

  await logActivity(req.user, `${input.status === "closed" ? "Closed" : "Reopened"} complaint "${complaint.subject}"`);
  const saved = await getDocById("complaints", id);
  return res.json({ complaint: present(saved, await classNames()) });
}));

module.exports = router;
