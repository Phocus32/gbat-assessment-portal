"use strict";

/**
 * Firestore transactions for Brain Sprint. One active session is tracked per
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
  ROUND_SECONDS,
  WRONG_PENALTY_MS,
  createPuzzle,
  multiplierForStreak,
  scoreForStreak
} = require("./game");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sessionDoc(sessionId) {
  return col("game_sessions").doc(String(sessionId));
}

function scoreDoc(sessionId) {
  return col("game_scores").doc(String(sessionId));
}

function activeDoc(studentId) {
  return col("game_active").doc(String(studentId));
}

function counterDoc() {
  return col("meta").doc("counters");
}

function utcDayKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

async function startGameSession({ studentId, studentName, rotation, initialPuzzle }) {
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

    const current = counterSnap.exists ? Number(counterSnap.data().game_sessions || 0) : 0;
    const id = current + 1;
    const now = new Date();
    const session = {
      id,
      student_id: Number(studentId),
      student_name: studentName || null,
      status: "in_progress",
      started_at: now,
      ends_at: new Date(now.getTime() + ROUND_SECONDS * 1000),
      rotation,
      position: 0,
      puzzle: initialPuzzle,
      score: 0,
      streak: 0,
      best_streak: 0,
      answered: 0,
      correct: 0,
      wrong: 0,
      penalty_ms: 0
    };

    tx.set(counters, { game_sessions: id }, { merge: true });
    tx.set(sessionDoc(id), session);
    tx.set(activeRef, {
      student_id: Number(studentId),
      session_id: id,
      updated_at: now
    });

    return { session, resumed: false };
  });
}

async function answerGameSession({ sessionId, studentId, position, chosenIndex }) {
  const ref = sessionDoc(sessionId);

  return getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Game session not found.");

    const session = docData(snap);
    if (Number(session.student_id) !== Number(studentId)) {
      throw httpError(403, "This game session belongs to another student.");
    }
    if (session.status !== "in_progress") {
      throw httpError(409, "This round is no longer active.");
    }
    const endsAt = session.ends_at instanceof Date ? session.ends_at.getTime() : 0;
    if (Date.now() >= endsAt) {
      throw httpError(410, "Time is up. Finish the round to save your score.");
    }
    if (Number(session.position) !== Number(position)) {
      throw httpError(409, "That puzzle is no longer active.");
    }

    const correct = Number(chosenIndex) === Number(session.puzzle.correctIndex);
    const now = new Date();
    const streak = correct ? Number(session.streak || 0) + 1 : 0;
    const earned = correct ? scoreForStreak(Number(session.streak || 0)) : 0;
    const penaltyMs = correct
      ? Number(session.penalty_ms || 0)
      : Number(session.penalty_ms || 0) + WRONG_PENALTY_MS;
    const nextEndsAt = correct ? endsAt : endsAt + WRONG_PENALTY_MS;
    const nextPosition = Number(session.position) + 1;

    const patch = {
      position: nextPosition,
      puzzle: createPuzzle(nextPosition, session.rotation),
      score: Number(session.score || 0) + earned,
      streak,
      best_streak: Math.max(Number(session.best_streak || 0), streak),
      answered: Number(session.answered || 0) + 1,
      correct: Number(session.correct || 0) + (correct ? 1 : 0),
      wrong: Number(session.wrong || 0) + (correct ? 0 : 1),
      penalty_ms: penaltyMs,
      ends_at: new Date(nextEndsAt),
      last_answer_at: now
    };

    tx.update(ref, patch);
    return {
      session: { ...session, ...patch },
      answer: {
        correct,
        earned,
        chosenIndex: Number(chosenIndex),
        correctIndex: Number(session.puzzle.correctIndex),
        correctOption: String(session.puzzle.options[Number(session.puzzle.correctIndex)] || ""),
        penaltyMs: correct ? 0 : WRONG_PENALTY_MS,
        multiplier: multiplierForStreak(Number(session.streak || 0))
      }
    };
  });
}

async function finishGameSession({ sessionId, studentId }) {
  const ref = sessionDoc(sessionId);
  const scoreRef = scoreDoc(sessionId);
  const now = new Date();
  const day = utcDayKey(now);

  return getDb().runTransaction(async tx => {
    const [snap, scoreSnap, dailySnap, activeSnap] = await Promise.all([
      tx.get(ref),
      tx.get(scoreRef),
      tx.get(col("game_daily").doc(`${studentId}:${day}`)),
      tx.get(activeDoc(studentId))
    ]);

    if (!snap.exists) throw httpError(404, "Game session not found.");

    const session = docData(snap);
    if (Number(session.student_id) !== Number(studentId)) {
      throw httpError(403, "This game session belongs to another student.");
    }

    if (session.status === "completed" && scoreSnap.exists) {
      return { score: docData(scoreSnap), alreadyFinished: true };
    }
    if (session.status !== "in_progress") {
      throw httpError(409, "This round is no longer active.");
    }

    const dailyRef = col("game_daily").doc(`${studentId}:${day}`);
    const eligibleForBonus = Number(session.answered || 0) > 0 && !dailySnap.exists;
    const dailyBonus = eligibleForBonus ? DAILY_BONUS_POINTS : 0;
    const baseScore = Number(session.score || 0);
    const total = baseScore + dailyBonus;
    const score = {
      id: Number(sessionId),
      session_id: Number(sessionId),
      student_id: Number(studentId),
      student_name: session.student_name || null,
      score: total,
      base_score: baseScore,
      daily_bonus: dailyBonus,
      day,
      answered: Number(session.answered || 0),
      correct: Number(session.correct || 0),
      wrong: Number(session.wrong || 0),
      best_streak: Number(session.best_streak || 0),
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

async function findActiveGameSession(studentId) {
  const activeSnap = await activeDoc(studentId).get();
  if (!activeSnap.exists || !activeSnap.data().session_id) return null;
  const snap = await sessionDoc(activeSnap.data().session_id).get();
  if (!snap.exists) return null;
  const session = docData(snap);
  return session.status === "in_progress" ? session : null;
}

module.exports = {
  answerGameSession,
  findActiveGameSession,
  finishGameSession,
  httpError,
  startGameSession
};
