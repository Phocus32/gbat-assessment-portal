"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const config = require("../config");
const {
  findUserByUsername,
  withClassName,
  getDocById,
  updateDocById
} = require("../fdb");
const { loginSchema, changePasswordSchema } = require("../validation");
const {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  sessionSettings,
  sessionExpiry,
  touchLastActivity,
  authenticate
} = require("../security");
const { asyncHandler, publicUser, toBoolean, logActivity } = require("../utils");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many login attempts. Please try again later." });
  }
});

function lockState(user) {
  const lockedUntil = user.locked_until instanceof Date ? user.locked_until : null;
  const now = Date.now();
  return {
    isLocked: Boolean(lockedUntil && lockedUntil.getTime() > now),
    lockExpired: Boolean(lockedUntil && lockedUntil.getTime() <= now)
  };
}

router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);

  const found = await findUserByUsername(input.username);
  const user = found ? await withClassName(found) : null;

  if (!user) {
    await verifyDummyPassword(input.password);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const { isLocked, lockExpired } = lockState(user);
  if (isLocked) {
    return res.status(429).json({ error: "Too many failed attempts. Please try again later." });
  }

  let failedAttempts = Number(user.failed_login_attempts) || 0;
  if (lockExpired) {
    failedAttempts = 0;
    await updateDocById("users", user.id, { failed_login_attempts: 0, locked_until: null });
  }

  if (!toBoolean(user.active)) {
    await verifyDummyPassword(input.password);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const passwordOk = await verifyPassword(input.password, user.password_hash);
  if (!passwordOk) {
    failedAttempts += 1;
    if (failedAttempts >= config.loginMaxAttempts) {
      await updateDocById("users", user.id, {
        failed_login_attempts: failedAttempts,
        locked_until: new Date(Date.now() + config.loginLockMinutes * 60000)
      });
    } else {
      await updateDocById("users", user.id, {
        failed_login_attempts: failedAttempts,
        locked_until: null
      });
    }
    return res.status(401).json({ error: "Invalid username or password." });
  }

  await updateDocById("users", user.id, {
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: new Date(),
    last_activity_at: new Date()
  });

  const token = signSession(user);
  setSessionCookie(res, token);
  return res.json({ user: publicUser(user) });
}));

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.publicUser });
});

// Browser countdown settings. Returns the server clock so a device with a
// skewed clock cannot keep a session alive longer than the server allows.
router.get("/session", authenticate, (req, res) => {
  res.json({
    ...req.sessionSettings,
    serverNow: new Date().toISOString(),
    expiresAt: req.sessionExpiresAt
  });
});

// Activity heartbeat. Authenticated requests already touch the timestamp, but
// an explicit ping lets the browser keep a session alive during an exam where
// the student may be reading without moving the mouse.
router.post("/activity", authenticate, asyncHandler(async (req, res) => {
  const touchedAt = await touchLastActivity(req.user);
  res.json({
    ok: true,
    serverNow: new Date(touchedAt).toISOString(),
    expiresAt: sessionExpiry(req.user.last_activity_at)
  });
}));

router.post("/change-password", authenticate, asyncHandler(async (req, res) => {
  const input = changePasswordSchema.parse(req.body);

  if (input.currentPassword === input.newPassword) {
    return res.status(400).json({ error: "The new password must be different from the current password." });
  }

  const current = await getDocById("users", req.user.id);
  if (!current || !(await verifyPassword(input.currentPassword, current.password_hash))) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }

  const passwordHash = await hashPassword(input.newPassword);
  await updateDocById("users", req.user.id, {
    password_hash: passwordHash,
    must_change_password: false,
    token_version: Number(current.token_version || 0) + 1,
    failed_login_attempts: 0,
    locked_until: null
  });

  const updated = await withClassName(await getDocById("users", req.user.id));
  const token = signSession(updated);
  setSessionCookie(res, token);
  await logActivity(updated, "Changed account password");

  return res.json({ user: publicUser(updated) });
}));

module.exports = router;
