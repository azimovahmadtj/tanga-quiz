// Firebase Cloud Functions side of the game (Blaze plan). The rules themselves are in core.js.
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { GameError, readRules, periodOf, dayKey, validate, applyAnswer, pickQuizQuestion, leaveQuiz, answersToMove, ID_RE } = require("./core");

async function submitAnswer(db, uid, data, now = Date.now()) {
  if (!uid) throw new GameError("unauthenticated", "sign in first");
  const { qid, choice, quizId } = validate(data);
  const scoreRef = db.doc(`scores/${uid}`);
  return db.runTransaction(async tx => {
    const [sS, qS, aS, cS, zS, eS, hS, mS] = await Promise.all([
      tx.get(scoreRef), tx.get(db.doc(`questions/${qid}`)), tx.get(db.doc(`answers/${qid}`)),
      tx.get(db.doc("config/rules")), quizId ? tx.get(db.doc(`quizzes/${quizId}`)) : Promise.resolve(null),
      quizId ? tx.get(db.doc(`entries/${quizId}_${uid}`)) : Promise.resolve(null), tx.get(db.doc(`qprivate/${qid}`)), tx.get(db.doc(`mistakes/${uid}`))]);
    const d = x => (x && x.exists ? x.data() : null);
    const { m, me, ok, correct, gain, entry, mistakes } = applyAnswer({
      score: d(sS), lastMs: d(sS)?.srvAt?.toMillis?.() || 0, question: d(qS) ?? d(hS), hidden: !d(qS) && !!d(hS), answer: d(aS), rules: d(cS), quiz: d(zS), entry: d(eS), mistakes: d(mS),
      qid, choice, quizId, now });
    tx.set(scoreRef, { ...m, srvAt: Timestamp.fromMillis(now) });
    if (entry) tx.set(db.doc(`entries/${quizId}_${uid}`), entry, { merge: true });
    if (mistakes) tx.set(db.doc(`mistakes/${uid}`), mistakes);
    return { ok, correct, gain, me };
  });
}

// Next question of a paid quiz, handed out by the server with its own timer (see core.pickQuizQuestion)
async function quizQuestion(db, uid, data, now = Date.now()) {
  if (!uid) throw new GameError("unauthenticated", "sign in first");
  const quizId = data && data.quizId;
  if (typeof quizId !== "string" || !ID_RE.test(quizId)) throw new GameError("invalid-argument", "bad quiz id");
  const entryRef = db.doc(`entries/${quizId}_${uid}`);
  const { res, quiz } = await db.runTransaction(async tx => {
    const [sS, zS, eS, cS] = await Promise.all([tx.get(db.doc(`scores/${uid}`)), tx.get(db.doc(`quizzes/${quizId}`)), tx.get(entryRef), tx.get(db.doc("config/rules"))]);
    const d = x => (x.exists ? x.data() : null);
    if (!d(sS)?.nick) throw new GameError("failed-precondition", "register first");
    const res = pickQuizQuestion({ quiz: d(zS), entry: d(eS), rules: d(cS), now });
    if (res.update) tx.set(entryRef, res.update, { merge: true });
    return { res, quiz: d(zS) };
  });
  if (res.locked) throw new GameError("failed-precondition", "left the quiz");
  const total = (quiz.qids || []).length, index = res.done.length;
  if (!res.qid) return { done: true, index, total };
  const [p, h] = await Promise.all([db.doc(`questions/${res.qid}`).get(), db.doc(`qprivate/${res.qid}`).get()]);
  const q = p.exists ? p.data() : h.exists ? h.data() : null;
  if (!q) throw new GameError("not-found", "question was deleted");
  return { done: false, index, total, remain: res.remainMs, q: { id: res.qid, topic: q.topic || "", q: q.q || {}, opts: q.opts || {}, img: q.img || "" } };
}

// The page reports that the player left a paid quiz: the quiz is closed for them (see core.leaveQuiz)
async function quizLeave(db, uid, data, now = Date.now()) {
  if (!uid) throw new GameError("unauthenticated", "sign in first");
  const quizId = data && data.quizId;
  if (typeof quizId !== "string" || !ID_RE.test(quizId)) throw new GameError("invalid-argument", "bad quiz id");
  const entryRef = db.doc(`entries/${quizId}_${uid}`);
  return db.runTransaction(async tx => {
    const [zS, eS] = await Promise.all([tx.get(db.doc(`quizzes/${quizId}`)), tx.get(entryRef)]);
    const entry = eS.exists ? eS.data() : null, update = leaveQuiz({ quiz: zS.exists ? zS.data() : null, entry, now });
    if (!update) return { locked: !!(entry && entry.locked) };
    tx.set(entryRef, update, { merge: true });
    return { locked: true };
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

module.exports = { submitAnswer, quizQuestion, quizLeave, migrateAnswers, importCartoons, GameError, readRules, periodOf, dayKey };
