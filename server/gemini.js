"use strict";

/**
 * Server-side Gemini adapter. The API key never leaves the server and the
 * browser only talks to our own /api/ai-guide endpoint.
 */

const config = require("./config");
const { systemInstruction } = require("./ai-safety");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Test hook: replace the HTTP implementation without changing the route. */
function setFetchImpl(impl) {
  fetchImpl = typeof impl === "function" ? impl : (...args) => globalThis.fetch(...args);
}

function extractText(payload) {
  if (!payload || !Array.isArray(payload.steps)) return "";
  const chunks = [];

  for (const step of payload.steps) {
    if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        chunks.push(item.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

/**
 * @param {{prompt: string, mode: string, maxOutputTokens?: number}} input
 * @returns {Promise<{configured: boolean, text: string, interactionId: string|null, model: string|null, usage: object|null}>}
 */
async function generateText({ prompt, mode, maxOutputTokens }) {
  if (!config.googleApiKey) {
    return {
      configured: false,
      text: "The AI guide is not configured yet. Ask your administrator to add the Gemini API key.",
      interactionId: null,
      model: null,
      usage: null
    };
  }

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.googleApiKey,
        "Api-Revision": API_REVISION
      },
      body: JSON.stringify({
        model: config.aiModel,
        input: String(prompt),
        system_instruction: systemInstruction(mode),
        generation_config: {
          max_output_tokens: Math.min(1200, Math.max(200, Number(maxOutputTokens) || 600))
        },
        safety_settings: [
          { type: "hate_speech", threshold: "block_medium_and_above" },
          { type: "dangerous_content", threshold: "block_medium_and_above" },
          { type: "harassment", threshold: "block_medium_and_above" },
          { type: "sexually_explicit", threshold: "block_medium_and_above" },
          { type: "jailbreak", threshold: "block_medium_and_above" }
        ],
        store: false
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    const failure = new Error("The AI guide is temporarily unavailable. Please try again shortly.");
    failure.status = 502;
    failure.cause = error;
    throw failure;
  }

  if (!response.ok) {
    const failure = new Error("The AI guide is temporarily unavailable. Please try again shortly.");
    failure.status = 502;
    failure.upstreamStatus = response.status;
    throw failure;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const failure = new Error("The AI guide returned an unexpected response.");
    failure.status = 502;
    throw failure;
  }

  const text = extractText(payload);
  if (!text) {
    const failure = new Error("The AI guide returned an empty response. Please try again.");
    failure.status = 502;
    throw failure;
  }

  return {
    configured: true,
    text,
    interactionId: typeof payload.id === "string" ? payload.id : null,
    model: typeof payload.model === "string" ? payload.model : config.aiModel,
    usage: payload.usage || null
  };
}

module.exports = {
  ENDPOINT,
  API_REVISION,
  setFetchImpl,
  extractText,
  generateText
};
