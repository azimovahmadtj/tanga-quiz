// Server-side game logic for Танга. Answers are checked here, so the correct option never reaches the browser.
// Kept free of Cloud Functions specifics so the security tests can run it directly against the emulator.
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

// Same defaults and limits as the site (public/index.html → CFG, RULE_LIMITS)
const DEFAULTS = { coinsPerRight: 10, dailyLimit: 30, seconds: 20, roundDays: 14, epoch: Date.UTC(2026, 8, 28), base: 0 };
const LIMITS = { seconds: [5, 300], coinsPerRight: [1, 1000], dailyLimit: [1, 1000], roundDays: [1, 365] };
const KEEP = ["hist", "quizDone", "avatar", "nick", "nickLower", "totalAnswered", "totalCorrect", "days", "lastTopic",
  "lastQuiz", "activity", "wrong", "wrongAns", "day", "dayCount", "region"];
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MIN_GAP_MS = 800;

class GameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function readRules(d) {
  const c = { ...DEFAULTS };
  if (!d) return c;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (Number.isInteger(d[k]) && d[k] >= lo && d[k] <= hi) c[k] = d[k];
  if (Number.isFinite(d.epoch) && d.epoch) c.epoch = d.epoch;
  if (Number.isInteger(d.base)) c.base = d.base;
  return c;
}
const periodOf = (c, now) => c.base + Math.floor((now - c.epoch) / (c.roundDays * 864e5));
// Days are counted in Tajikistan time (UTC+5), the same as the site
const dayKey = now => new Date(now + 5 * 36e5).toISOString().slice(0, 10);
const int = v => (Number.isInteger(v) && v >= 0 ? v : 0);
const list = v => (Array.isArray(v) ? v : []);
const map = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// Bring a stored score up to date: new round → coins restart, new day → daily counter restarts
function normalize(d, period, day) {
  let m = { ...d };
  if (m.period !== period) {
    const f = { period, coins: 0, answered: [], dayCoins: 0 };
    for (const k of KEEP) if (m[k] !== undefined) f[k] = m[k];
    m = f;
  }
  if (m.day !== day) { m.day = day; m.dayCount = 0; m.dayCoins = 0; }
  for (const k of ["coins", "dayCount", "dayCoins", "totalAnswered", "totalCorrect"]) m[k] = int(m[k]);
  for (const k of ["answered", "days", "activity", "wrong"]) m[k] = list(m[k]);
  for (const k of ["hist", "quizDone", "wrongAns"]) m[k] = { ...map(m[k]) };
  return m;
}

function validate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new GameError("invalid-argument", "bad request");
  const { qid, choice, quizId } = data;
  if (typeof qid !== "string" || !ID_RE.test(qid)) throw new GameError("invalid-argument", "bad question id");
  if (!Number.isInteger(choice) || choice < -1 || choice > 9) throw new GameError("invalid-argument", "bad choice");
  if (quizId !== undefined && quizId !== null && (typeof quizId !== "string" || !ID_RE.test(quizId)))
    throw new GameError("invalid-argument", "bad quiz id");
  return { qid, choice, quizId: quizId || null };
}

async function submitAnswer(db, uid, data, now = Date.now()) {
  if (!uid) throw new GameError("unauthenticated", "sign in first");
  const { qid, choice, quizId } = validate(data);
  const scoreRef = db.doc(`scores/${uid}`);
  return db.runTransaction(async tx => {
    const [sS, qS, aS, cS, zS] = await Promise.all([
      tx.get(scoreRef), tx.get(db.doc(`questions/${qid}`)), tx.get(db.doc(`answers/${qid}`)),
      tx.get(db.doc("config/rules")), quizId ? tx.get(db.doc(`quizzes/${quizId}`)) : Promise.resolve(null)]);
    if (!sS.exists || !sS.data().nick) throw new GameError("failed-precondition", "register first");
    if (!qS.exists) throw new GameError("not-found", "no such question");
    const correct = aS.exists ? aS.data().correct : qS.data().correct;
    if (!Number.isInteger(correct)) throw new GameError("failed-precondition", "question has no answer");

    const c = readRules(cS.exists ? cS.data() : null);
    const m = normalize(sS.data(), periodOf(c, now), dayKey(now));
    const last = sS.data().srvAt?.toMillis?.() || 0;
    if (now - last < MIN_GAP_MS) throw new GameError("resource-exhausted", "too fast");

    let gain, topic;
    if (quizId) {
      if (!zS.exists) throw new GameError("not-found", "no such quiz");
      const z = zS.data();
      if (!(now >= z.start && now <= z.end)) throw new GameError("failed-precondition", "quiz is not active");
      if (!list(z.qids).includes(qid)) throw new GameError("invalid-argument", "question is not in this quiz");
      const done = list(m.quizDone[quizId]);
      if (done.includes(qid)) throw new GameError("already-exists", "already answered");
      m.quizDone[quizId] = [...done, qid];
      m.lastQuiz = quizId;
      gain = Number.isInteger(z.bonus) && z.bonus >= 1 && z.bonus <= 1000 ? z.bonus : c.coinsPerRight;
      topic = "quiz:" + quizId;
    } else {
      if (m.answered.includes(qid)) throw new GameError("already-exists", "already answered");
      if (m.dayCount >= c.dailyLimit) throw new GameError("resource-exhausted", "daily limit");
      m.answered.push(qid);
      if (m.answered.length > 3000) m.answered = m.answered.slice(-3000);
      m.dayCount++;
      gain = c.coinsPerRight;
      topic = String(qS.data().topic || "");
      m.lastTopic = topic;
    }
    m.totalAnswered++;
    const ok = choice === correct;
    if (ok) {
      m.coins += gain; m.dayCoins += gain; m.totalCorrect++;
      m.wrong = m.wrong.filter(x => x !== qid); delete m.wrongAns[qid];
    } else {
      m.wrong = [qid, ...m.wrong.filter(x => x !== qid)].slice(0, 60);
      m.wrongAns[qid] = correct;
      for (const k of Object.keys(m.wrongAns)) if (!m.wrong.includes(k)) delete m.wrongAns[k];
    }
    const today = dayKey(now);
    m.hist[today] = int(m.hist[today]) + 1;
    const hk = Object.keys(m.hist).sort();
    if (hk.length > 60) hk.slice(0, hk.length - 60).forEach(k => delete m.hist[k]);
    if (!m.days.includes(today)) m.days = [today, ...m.days].slice(0, 120);
    const a = m.activity[0];
    if (a && a.topic === topic && now - a.t < 30 * 6e4) m.activity[0] = { ...a, right: int(a.right) + (ok ? 1 : 0), total: int(a.total) + 1, t: now };
    else m.activity = [{ topic, right: ok ? 1 : 0, total: 1, t: now }, ...m.activity].slice(0, 8);
    m.updatedAt = now;
    delete m.dayStart; delete m.srvAt;
    tx.set(scoreRef, { ...m, srvAt: Timestamp.fromMillis(now) });
    return { ok, correct, gain: ok ? gain : 0, me: m };
  });
}

// One-off move of the correct options out of the public questions into the admin-only answers collection
async function migrateAnswers(db, uid) {
  if (!uid || !(await db.doc(`admins/${uid}`).get()).exists) throw new GameError("permission-denied", "admins only");
  const qs = await db.collection("questions").get();
  let moved = 0, batch = db.batch(), n = 0;
  for (const d of qs.docs) {
    const v = d.data().correct;
    if (v === undefined) continue;
    if (Number.isInteger(v)) batch.set(db.doc(`answers/${d.id}`), { correct: v });
    batch.update(d.ref, { correct: FieldValue.delete() });
    moved++;
    if (++n >= 200) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n) await batch.commit();
  return { moved };
}

module.exports = { submitAnswer, migrateAnswers, GameError, readRules, periodOf, dayKey };
