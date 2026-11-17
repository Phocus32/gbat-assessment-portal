"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const config = require("../config");
const { query } = require("../db");
const { loginSchema, changePasswordSchema } = require("../validation");
const {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
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

router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);

  const rows = await query(
    `SELECT u.*, c.name AS class_name,
            CASE WHEN u.locked_until IS NOT NULL AND u.locked_until > NOW() THEN 1 ELSE 0 END AS is_locked,
            CASE WHEN u.locked_until IS NOT NULL AND u.locked_until <= NOW() THEN 1 ELSE 0 END AS lock_expired
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.username = ?
      LIMIT 1`,
    [input.username]
  );
  const user = rows[0];

  if (!user) {
    await verifyDummyPassword(input.password);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  if (toBoolean(user.is_locked)) {
    return res.status(429).json({ error: "Too many failed attempts. Please try again later." });
  }

  let failedAttempts = Number(user.failed_login_attempts) || 0;
  if (toBoolean(user.lock_expired)) {
    failedAttempts = 0;
    await query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?", [user.id]);
  }

  if (!toBoolean(user.active)) {
    await verifyDummyPassword(input.password);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const passwordOk = await verifyPassword(input.password, user.password_hash);
  if (!passwordOk) {
    failedAttempts += 1;
    if (failedAttempts >= config.loginMaxAttempts) {
      await query(
        "UPDATE users SET failed_login_attempts = ?, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?",
        [failedAttempts, config.loginLockMinutes, user.id]
      );
    } else {
      await query("UPDATE users SET failed_login_attempts = ?, locked_until = NULL WHERE id = ?", [failedAttempts, user.id]);
    }
    return res.status(401).json({ error: "Invalid username or password." });
  }

  await query(
    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?",
    [user.id]
  );

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

router.post("/change-password", authenticate, asyncHandler(async (req, res) => {
  const input = changePasswordSchema.parse(req.body);

  if (input.currentPassword === input.newPassword) {
    return res.status(400).json({ error: "The new password must be different from the current password." });
  }

  const rows = await query("SELECT password_hash FROM users WHERE id = ? LIMIT 1", [req.user.id]);
  if (!rows[0] || !(await verifyPassword(input.currentPassword, rows[0].password_hash))) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }

  const passwordHash = await hashPassword(input.newPassword);
  await query(
    `UPDATE users
        SET password_hash = ?,
            must_change_password = 0,
            token_version = token_version + 1,
            failed_login_attempts = 0,
            locked_until = NULL
      WHERE id = ?`,
    [passwordHash, req.user.id]
  );

  const updatedRows = await query(
    `SELECT u.*, c.name AS class_name
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = ?
      LIMIT 1`,
    [req.user.id]
  );
  const updated = updatedRows[0];
  const token = signSession(updated);
  setSessionCookie(res, token);
  await logActivity(updated, "Changed account password");

  return res.json({ user: publicUser(updated) });
}));

module.exports = router;
