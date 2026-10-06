// Game rules for Танга, shared by every server that checks answers: Firebase Cloud Functions (game.js)
// and the Cloudflare Worker (worker/). Plain JavaScript without database code, so both use exactly the same logic.

// Same defaults and limits as the site (public/index.html → CFG, RULE_LIMITS)
const DEFAULTS = { coinsPerRight: 4, dailyLimit: 30, seconds: 20, roundDays: 14, epoch: Date.UTC(2026, 8, 28), base: 0 };
const LIMITS = { seconds: [5, 300], coinsPerRight: [1, 1000], dailyLimit: [1, 1000], roundDays: [1, 365] };
const KEEP = ["hist", "quizDone", "avatar", "nick", "nickLower", "totalAnswered", "totalCorrect", "days", "lastTopic",
  "lastQuiz", "activity", "wrong", "wrongAns", "day", "dayCount", "region", "quizCoins"];
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
  for (const k of ["hist", "quizDone", "wrongAns", "quizCoins"]) m[k] = { ...map(m[k]) };
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

// Applies one answer to a player's score. Inputs are plain document data (null when the document is missing);
// lastMs is the time of the player's previous server write. Returns the new score, or throws a GameError.
// entry is the player's /entries/{quizId}_{uid} document: quizzes with an entry fee only count paid players.
function applyAnswer({ score, lastMs, question, answer, rules, quiz, entry, qid, choice, quizId, now }) {
  if (!score || !score.nick) throw new GameError("failed-precondition", "register first");
  if (!question) throw new GameError("not-found", "no such question");
  const correct = answer ? answer.correct : question.correct;
  if (!Number.isInteger(correct)) throw new GameError("failed-precondition", "question has no answer");

  const c = readRules(rules);
  const m = normalize(score, periodOf(c, now), dayKey(now));
  if (now - (lastMs || 0) < MIN_GAP_MS) throw new GameError("resource-exhausted", "too fast");

  let gain, topic, entryOut = null, hide = false;
  if (quizId) {
    if (!quiz) throw new GameError("not-found", "no such quiz");
    const z = quiz;
    if (!(now >= z.start && now <= z.end)) throw new GameError("failed-precondition", "quiz is not active");
    if (!list(z.qids).includes(qid)) throw new GameError("invalid-argument", "question is not in this quiz");
    const paid = Number(z.entryFee) > 0;
    if (paid && !(entry && entry.paid === true)) throw new GameError("failed-precondition", "entry fee not paid");
    // In a paid quiz the progress also lives in the entry, which the player cannot change or delete,
    // so deleting and re-creating the profile does not allow answering the same questions again
    const done = [...new Set([...list(m.quizDone[quizId]), ...(paid ? list(entry.done) : [])])];
    if (done.includes(qid)) throw new GameError("already-exists", "already answered");
    m.quizDone[quizId] = [...done, qid];
    if (paid) { hide = true; entryOut = { done: m.quizDone[quizId], coins: int(entry.coins) }; }
    m.lastQuiz = quizId;
    gain = Number.isInteger(z.bonus) && z.bonus >= 1 && z.bonus <= 1000 ? z.bonus : c.coinsPerRight;
    topic = "quiz:" + quizId;
  } else {
    // Questions reserved for a quiz are never answered (and so never revealed) in the normal game
    if (question.quizOnly === true) throw new GameError("failed-precondition", "quiz only");
    if (m.answered.includes(qid)) throw new GameError("already-exists", "already answered");
    if (m.dayCount >= c.dailyLimit) throw new GameError("resource-exhausted", "daily limit");
    m.answered.push(qid);
    if (m.answered.length > 3000) m.answered = m.answered.slice(-3000);
    m.dayCount++;
    gain = c.coinsPerRight;
    topic = String(question.topic || "");
    m.lastTopic = topic;
  }
  m.totalAnswered++;
  const ok = choice === correct;
  if (ok) {
    m.coins += gain; m.dayCoins += gain; m.totalCorrect++;
    // Points in each quiz, for its winners table (prizes go to the top 3)
    if (quizId) {
      if (entryOut) entryOut.coins += gain;
      m.quizCoins[quizId] = entryOut ? entryOut.coins : int(m.quizCoins[quizId]) + gain;
      const ks = Object.keys(m.quizCoins); if (ks.length > 150) delete m.quizCoins[ks[0]];
    }
    m.wrong = m.wrong.filter(x => x !== qid); delete m.wrongAns[qid];
  } else if (hide) {
    // Paid quiz: the correct option is not stored in the public score (others could read it)
    if (entryOut.coins) m.quizCoins[quizId] = entryOut.coins;
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
  // In a paid quiz the correct option is not revealed, so players cannot pass answers to each other
  return { m, ok, correct: hide ? null : correct, gain: ok ? gain : 0, entry: entryOut };
}

// Questions whose correct option is still public: [{ id, correct }]
function answersToMove(questions) {
  return questions.filter(q => q.data.correct !== undefined).map(q => ({ id: q.id, correct: q.data.correct }));
}

module.exports = { GameError, readRules, periodOf, dayKey, validate, applyAnswer, answersToMove, ID_RE };
