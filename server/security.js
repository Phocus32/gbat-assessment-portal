"use strict";

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const config = require("./config");
const { getDocById, withClassName } = require("./fdb");
const { publicUser } = require("./utils");

async function hashPassword(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

async function verifyDummyPassword(password) {
  const dummyHash = await bcrypt.hash("dummy-password-does-not-exist", config.bcryptRounds);
  await bcrypt.compare(password, dummyHash);
}

function sessionMaxAge() {
  const match = /^(\d+)\s*([smhd])$/i.exec(String(config.jwtExpiresIn || "4h").trim());
  if (!match) return 4 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
  return amount * multiplier;
}

function signSession(user) {
  const payload = {
    sub: String(user.id),
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    classId: user.class_id ?? null,
    tokenVersion: Number(user.token_version || 0)
  };

  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function setSessionCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
    path: "/",
    maxAge: sessionMaxAge()
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
    path: "/"
  });
}

async function authenticate(req, res, next) {
  const token = req.cookies && req.cookies[config.cookieName];
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await withClassName(await getDocById("users", payload.id));

    if (!user || !user.active) {
      return res.status(401).json({ error: "Authentication required." });
    }

    if (Number(user.token_version) !== Number(payload.tokenVersion)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    req.user = user;
    req.publicUser = publicUser(user);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Authentication required." });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "Forbidden." });
    }
    return next();
  };
}

function requirePasswordChanged(req, res, next) {
  if (req.user && Number(req.user.must_change_password) === 1) {
    return res.status(403).json({
      code: "PASSWORD_CHANGE_REQUIRED",
      error: "Password change required before continuing."
    });
  }
  return next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  authenticate,
  requireRole,
  requirePasswordChanged
};
