// Firebase Cloud Functions side of the game (Blaze plan). The rules themselves are in core.js.
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { GameError, readRules, periodOf, dayKey, validate, applyAnswer, answersToMove } = require("./core");

async function submitAnswer(db, uid, data, now = Date.now()) {
  if (!uid) throw new GameError("unauthenticated", "sign in first");
  const { qid, choice, quizId } = validate(data);
  const scoreRef = db.doc(`scores/${uid}`);
  return db.runTransaction(async tx => {
    const [sS, qS, aS, cS, zS] = await Promise.all([
      tx.get(scoreRef), tx.get(db.doc(`questions/${qid}`)), tx.get(db.doc(`answers/${qid}`)),
      tx.get(db.doc("config/rules")), quizId ? tx.get(db.doc(`quizzes/${quizId}`)) : Promise.resolve(null)]);
    const d = x => (x && x.exists ? x.data() : null);
    const { m, ok, correct, gain } = applyAnswer({
      score: d(sS), lastMs: d(sS)?.srvAt?.toMillis?.() || 0, question: d(qS), answer: d(aS), rules: d(cS), quiz: d(zS),
      qid, choice, quizId, now });
    tx.set(scoreRef, { ...m, srvAt: Timestamp.fromMillis(now) });
    return { ok, correct, gain, me: m };
  });
}

// One-off move of the correct options out of the public questions into the admin-only answers collection
async function migrateAnswers(db, uid) {
  if (!uid || !(await db.doc(`admins/${uid}`).get()).exists) throw new GameError("permission-denied", "admins only");
  const qs = await db.collection("questions").get();
  let moved = 0, batch = db.batch(), n = 0;
  for (const { id, correct } of answersToMove(qs.docs.map(d => ({ id: d.id, data: d.data() })))) {
    if (Number.isInteger(correct)) batch.set(db.doc(`answers/${id}`), { correct });
    batch.update(db.doc(`questions/${id}`), { correct: FieldValue.delete() });
    moved++;
    if (++n >= 200) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n) await batch.commit();
  return { moved };
}

// Adds the built-in "Карикатура" questions (public part to /questions, correct option to /answers). Safe to run again.
async function importCartoons(db, uid) {
  if (!uid || !(await db.doc(`admins/${uid}`).get()).exists) throw new GameError("permission-denied", "admins only");
  const items = require("./seed/cartoons"), batch = db.batch(), now = Date.now();
  for (const { id, correct, ...q } of items) {
    batch.set(db.doc(`questions/${id}`), { ...q, topic: "cartoon", createdAt: now });
    batch.set(db.doc(`answers/${id}`), { correct });
  }
  await batch.commit();
  return { added: items.length };
}

module.exports = { submitAnswer, migrateAnswers, importCartoons, GameError, readRules, periodOf, dayKey };
