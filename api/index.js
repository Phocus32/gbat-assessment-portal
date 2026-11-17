"use strict";

/**
 * Vercel serverless entry. Every request is routed here by vercel.json.
 * `ensureBootstrapped()` is memoized per warm instance and only seeds data on
 * the very first cold start of a brand-new Firebase project.
 */

const app = require("../server/app");
const { ensureBootstrapped } = require("../server/bootstrap");

module.exports = async (req, res) => {
  try {
    await ensureBootstrapped();
  } catch (error) {
    console.error("[gbat] Bootstrap failed:", error);
    res.status(503).json({ error: "The service is starting up. Please retry in a moment." });
    return;
  }
  return app(req, res);
};
