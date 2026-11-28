"use strict";

/**
 * Firestore transactions for Word Quest. One active session is tracked per
 * student with a lock document, and every score is written at most once using
 * the session id as the score document id.
 */

const {
  col,
  docData,
  getDb
} = require("./fdb");
const {
  DAILY_BONUS_POINTS,
  GRID_SIZE,
  HINT_COST,
  ROUND_SECONDS,
  WRONG_PENALTY_MS,
  multiplierForCombo,
  pointsForCombo,
  sameCells
} = require("./word-search");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sessionDoc(sessionId) {
  return col("word_sessions").doc(String(sessionId));
}

function scoreDoc(sessionId) {
  return col("word_scores").doc(String(sessionId));
}

function activeDoc(studentId) {
  return col("word_active").doc(String(studentId));
}

function counterDoc() {
  return col("meta").doc("counters");
}

function utcDayKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

async function startWordSession({ studentId, studentName, puzzle }) {
  const db = getDb();
  const activeRef = activeDoc(studentId);
  const counters = counterDoc();

  return db.runTransaction(async tx => {
    const [activeSnap, counterSnap] = await Promise.all([
      tx.get(activeRef),
      tx.get(counters)
    ]);

    const previousId = activeSnap.exists ? activeSnap.data().session_id : null;
    let previousRef = null;
    if (previousId) {
      previousRef = sessionDoc(previousId);
      const previousSnap = await tx.get(previousRef);
      if (previousSnap.exists) {
        const previous = docData(previousSnap);
        const endsAt = previous.ends_at instanceof Date ? previous.ends_at.getTime() : 0;
        if (previous.status === "in_progress" && endsAt > Date.now()) {
          return { session: previous, resumed: true };
        }
        if (previous.status === "in_progress") {
          tx.update(previousRef, { status: "expired", expired_at: new Date() });
        }
      }
    }

    const current = counterSnap.exists ? Number(counterSnap.data().word_sessions || 0) : 0;
    const id = current + 1;
    const now = new Date();
    const session = {
      id,
      student_id: Number(studentId),
      student_name: studentName || null,
      status: "in_progress",
      started_at: now,
      ends_at: new Date(now.getTime() + ROUND_SECONDS * 1000),
      puzzle: {
        size: GRID_SIZE,
        rows: puzzle.rows,
        words: puzzle.words
      },
      score: 0,
      combo: 0,
      best_combo: 0,
      found: 0,
      wrong: 0,
      hints_used: 0,
      penalty_ms: 0
    };

    tx.set(counters, { word_sessions: id }, { merge: true });
    tx.set(sessionDoc(id), session);
    tx.set(activeRef, {
      student_id: Number(studentId),
      session_id: id,
      updated_at: now
    });

    return { session, resumed: false };
  });
}

async function findWord({ sessionId, studentId, word, cells }) {
  const ref = sessionDoc(sessionId);

  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Word Quest session not found.");

    const session = docData(snap);
    if (Number(session.student_id) !== Number(studentId)) {
      throw httpError(403, "This Word Quest session belongs to another student.");
    }
    if (session.status !== "in_progress") {
      throw httpError(409, "This round is no longer active.");
    }
    const endsAt = session.ends_at instanceof Date ? session.ends_at.getTime() : 0;
    if (Date.now() >= endsAt) {
      throw httpError(410, "Time is up. Finish the round to save your score.");
    }

    const words = session.puzzle.words || [];
    const target = words.find(entry => entry.word === word);
    if (target && target.found) {
      throw httpError(409, "You already found that word.");
    }
    const correct = Boolean(target)
      && Array.isArray(target.cells)
      && sameCells(target.cells, cells);

    const now = new Date();
    const earned = correct ? pointsForCombo(session.combo || 0) : 0;
    const combo = correct ? Number(session.combo || 0) + 1 : 0;
    const penaltyMs = correct ? Number(session.penalty_ms || 0) : Number(session.penalty_ms || 0) + WRONG_PENALTY_MS;
    const nextEndsAt = correct ? endsAt : endsAt + WRONG_PENALTY_MS;

    const patch = {
      score: Number(session.score || 0) + earned,
      combo,
      best_combo: Math.max(Number(session.best_combo || 0), combo),
      found: Number(session.found || 0) + (correct ? 1 : 0),
      wrong: Number(session.wrong || 0) + (correct ? 0 : 1),
      penalty_ms: penaltyMs,
      ends_at: new Date(nextEndsAt),
      last_answer_at: now
    };
    if (correct) {
      patch.puzzle = {
        ...session.puzzle,
        words: words.map(entry => entry.word === word ? { ...entry, found: true } : entry)
      };
    }

    tx.update(ref, patch);
    return {
      session: { ...session, ...patch },
      answer: {
        correct,
        word,
        earned,
        combo,
        penaltyMs: correct ? 0 : WRONG_PENALTY_MS,
        multiplier: correct ? multiplierForCombo(combo - 1) : 1
      }
    };
  });
}

async function hintWord({ sessionId, studentId }) {
  const ref = sessionDoc(sessionId);

  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Word Quest session not found.");

    const session = docData(snap);
    if (Number(session.student_id) !== Number(studentId)) {
      throw httpError(403, "This Word Quest session belongs to another student.");
    }
    if (session.status !== "in_progress") {
      throw httpError(409, "This round is no longer active.");
    }
    const endsAt = session.ends_at instanceof Date ? session.ends_at.getTime() : 0;
    if (Date.now() >= endsAt) {
      throw httpError(410, "Time is up. Finish the round to save your score.");
    }

    const words = session.puzzle.words || [];
    const target = words.find(entry => !entry.found && !Number.isInteger(entry.hintIndex));
    if (!target) throw httpError(409, "Every remaining word already has a hint.");

    const hintIndex = target.cells[Math.floor(target.cells.length / 2)];
    const cost = Math.min(HINT_COST, Number(session.score || 0));
    const patch = {
      score: Number(session.score || 0) - cost,
      hints_used: Number(session.hints_used || 0) + 1,
      puzzle: {
        ...session.puzzle,
        words: words.map(entry => entry.word === target.word ? { ...entry, hintIndex } : entry)
      }
    };

    tx.update(ref, patch);
    return {
      session: { ...session, ...patch },
      hint: {
        word: target.word,
        cellIndex: hintIndex,
        letter: session.puzzle.rows[Math.floor(hintIndex / GRID_SIZE)][hintIndex % GRID_SIZE],
        cost
      }
    };
  });
}

async function finishWordSession({ sessionId, studentId }) {
  const ref = sessionDoc(sessionId);
  const scoreRef = scoreDoc(sessionId);
  const now = new Date();
  const day = utcDayKey(now);

  return getDb().runTransaction(async tx => {
    const [snap, scoreSnap, dailySnap, activeSnap] = await Promise.all([
      tx.get(ref),
      tx.get(scoreRef),
      tx.get(col("word_daily").doc(`${studentId}:${day}`)),
      tx.get(activeDoc(studentId))
    ]);

    if (!snap.exists) throw httpError(404, "Word Quest session not found.");

    const session = docData(snap);
    if (Number(session.student_id) !== Number(studentId)) {
      throw httpError(403, "This Word Quest session belongs to another student.");
    }

    if (session.status === "completed" && scoreSnap.exists) {
      return { score: docData(scoreSnap), alreadyFinished: true };
    }
    if (session.status !== "in_progress") {
      throw httpError(409, "This round is no longer active.");
    }

    const dailyRef = col("word_daily").doc(`${studentId}:${day}`);
    const eligibleForBonus = Number(session.found || 0) > 0 && !dailySnap.exists;
    const dailyBonus = eligibleForBonus ? DAILY_BONUS_POINTS : 0;
    const baseScore = Math.max(0, Number(session.score || 0));
    const total = baseScore + dailyBonus;
    const found = Number(session.found || 0);
    const totalWords = (session.puzzle.words || []).length;
    const score = {
      id: Number(sessionId),
      session_id: Number(sessionId),
      student_id: Number(studentId),
      student_name: session.student_name || null,
      score: total,
      base_score: baseScore,
      daily_bonus: dailyBonus,
      day,
      found,
      total_words: totalWords,
      wrong: Number(session.wrong || 0),
      hints_used: Number(session.hints_used || 0),
      best_combo: Number(session.best_combo || 0),
      penalty_ms: Number(session.penalty_ms || 0),
      completed_at: now,
      duration_ms: now.getTime() - new Date(session.started_at).getTime()
    };

    if (eligibleForBonus) {
      tx.set(dailyRef, {
        student_id: Number(studentId),
        day,
        session_id: Number(sessionId),
        awarded_at: now
      });
    }
    tx.set(scoreRef, score);
    tx.update(ref, {
      status: "completed",
      finished_at: now,
      final_score: total,
      daily_bonus: dailyBonus
    });
    if (activeSnap.exists && Number(activeSnap.data().session_id) === Number(sessionId)) {
      tx.update(activeDoc(studentId), { session_id: null, updated_at: now });
    }

    return { score, alreadyFinished: false };
  });
}

async function findActiveWordSession(studentId) {
  const activeSnap = await activeDoc(studentId).get();
  if (!activeSnap.exists || !activeSnap.data().session_id) return null;
  const snap = await sessionDoc(activeSnap.data().session_id).get();
  if (!snap.exists) return null;
  const session = docData(snap);
  return session.status === "in_progress" ? session : null;
}

module.exports = {
  findActiveWordSession,
  findWord,
  finishWordSession,
  hintWord,
  httpError,
  startWordSession
};
