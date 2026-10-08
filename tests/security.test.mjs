// Security regression tests for Танга. They run only against the local Firestore emulator:
//   cd tests && npm install && npm test
// Each test states what must be allowed or refused; together they cover the rules and the answer-checking server code.
import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from "firebase/firestore";

// Use the functions' own firebase-admin so FieldValue sentinels match the database instance
const requireFn = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp } = requireFn("firebase-admin/app");
const { getFirestore } = requireFn("firebase-admin/firestore");
const game = requireFn("./game.js");

const PROJECT = "tanga-quiz";
let env, adminDb;
const NOW = Date.now();
const OLD = Timestamp.fromMillis(NOW - 3600e3);

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
  initializeApp({ projectId: PROJECT });
  adminDb = getFirestore();
});
after(async () => { await env?.cleanup(); });

const score = (o = {}) => ({ nick: "Champ", nickLower: "champ", period: 0, coins: 100, answered: ["q1"], day: "2026-01-01", dayCount: 1,
  dayCoins: 10, totalAnswered: 10, totalCorrect: 8, days: [], activity: [], wrong: ["q9", "q8"], wrongAns: { q9: 1, q8: 0 },
  hist: {}, quizDone: {}, lastTopic: "tajik", updatedAt: NOW - 3600e3, srvAt: OLD, ...o });

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const f = ctx.firestore(), w = (p, d) => setDoc(doc(f, p), d);
    await w("admins/boss", { role: "admin" });
    await w("questions/q1", { topic: "tajik", q: { tj: "Савол" }, opts: { tj: ["A", "B", "C", "D"] } });
    await w("answers/q1", { correct: 2 });
    await w("quizzes/z1", { title: { tj: "Q" }, bonus: 20, start: NOW - 864e5, end: NOW + 864e5, qids: ["q1"] });
    await w("config/rules", { coinsPerRight: 10, dailyLimit: 30, seconds: 20, roundDays: 14 });
    await w("config/topics", { list: [] });
    await w("scores/champ", score());
    await w("nicks/champ", { uid: "champ" });
    await w("contacts/champ", { name: "Champ", email: "c@x.com", phone: "+992 1", createdAt: NOW, updatedAt: NOW, agreedAt: NOW });
    await w("scores/p1", score({ nick: "Player", nickLower: "player", coins: 50 }));
    await w("nicks/player", { uid: "p1" });
    await w("contacts/p1", { name: "P", email: "p@x.com", phone: "+992 2", createdAt: NOW, updatedAt: NOW, agreedAt: NOW });
  });
}
const ctx = role => role === "anon" ? env.unauthenticatedContext().firestore() : env.authenticatedContext(role).firestore();
const allow = p => assertSucceeds(p), deny = p => assertFails(p);

// ---------------------------------------------------------------- 1. access matrix
// role: anon = not signed in, p1 = another player, boss = admin
const WRITE_DATA = {
  questions: { topic: "tajik", q: { tj: "x" }, opts: { tj: ["a", "b", "c", "d"] } },
  answers: { correct: 1 }, quizzes: { title: { tj: "x" }, bonus: 5, start: 0, end: 1, qids: [] },
  config: { coinsPerRight: 10 }, admins: { role: "admin" }, nicks: { uid: "p1" },
  scores: score({ coins: 999999 }), contacts: { name: "x" },
};
const TARGET = { questions: "q1", answers: "q1", quizzes: "z1", config: "rules", admins: "boss", nicks: "champ", scores: "champ", contacts: "champ" };
// expected outcome: [read, write, delete] per role
const MATRIX = {
  questions: { anon: [1, 0, 0], p1: [1, 0, 0], boss: [1, 1, 1] },
  answers:   { anon: [0, 0, 0], p1: [0, 0, 0], boss: [1, 1, 1] },
  quizzes:   { anon: [1, 0, 0], p1: [1, 0, 0], boss: [1, 1, 1] },
  config:    { anon: [1, 0, 0], p1: [1, 0, 0], boss: [1, 1, 1] },
  admins:    { anon: [0, 0, 0], p1: [0, 0, 0], boss: [1, 0, 0] },
  nicks:     { anon: [1, 0, 0], p1: [1, 0, 0], boss: [1, 0, 1] },
  scores:    { anon: [1, 0, 0], p1: [1, 0, 0], boss: [1, 1, 1] },
  contacts:  { anon: [0, 0, 0], p1: [0, 0, 0], boss: [1, 1, 1] },
};
describe("access matrix", () => {
  beforeEach(seed);
  for (const [col, roles] of Object.entries(MATRIX)) for (const [role, [r, w, d]] of Object.entries(roles)) {
    const path = `${col}/${TARGET[col]}`;
    test(`${role} ${r ? "can" : "cannot"} read ${path}`, () => (r ? allow : deny)(getDoc(doc(ctx(role), path))));
    test(`${role} ${w ? "can" : "cannot"} overwrite ${path}`, () => (w ? allow : deny)(setDoc(doc(ctx(role), path), WRITE_DATA[col])));
    test(`${role} ${d ? "can" : "cannot"} delete ${path}`, () => (d ? allow : deny)(deleteDoc(doc(ctx(role), path))));
  }
  test("anon cannot create a question", () => deny(setDoc(doc(ctx("anon"), "questions/new"), WRITE_DATA.questions)));
  test("player cannot create a quiz", () => deny(setDoc(doc(ctx("p1"), "quizzes/new"), WRITE_DATA.quizzes)));
  test("player cannot create config", () => deny(setDoc(doc(ctx("p1"), "config/main"), { prize: 1e6 })));
  test("player cannot make themselves admin", () => deny(setDoc(doc(ctx("p1"), "admins/p1"), { role: "admin" })));
  test("player can read their own contact", () => allow(getDoc(doc(ctx("p1"), "contacts/p1"))));
  test("admin cannot put the correct option into a public question", () =>
    deny(setDoc(doc(ctx("boss"), "questions/q2"), { ...WRITE_DATA.questions, correct: 1 })));
  test("admin cannot add the correct option to an existing question", () => deny(updateDoc(doc(ctx("boss"), "questions/q1"), { correct: 2 })));
});

// ---------------------------------------------------------------- 2. the player's own score
const profile = (f, fields, { claim = false, drop = "" } = {}) => {
  const data = { ...fields, updatedAt: Date.now(), srvAt: serverTimestamp() }, b = writeBatch(f);
  b.set(doc(f, "scores/p1"), data, { mergeFields: Object.keys(data) });
  if (claim) b.set(doc(f, `nicks/${fields.nickLower}`), { uid: "p1" });
  if (drop) b.delete(doc(f, `nicks/${drop}`));
  return b.commit();
};
describe("player score: only the profile can change", () => {
  beforeEach(seed);
  const img = "data:image/jpeg;base64," + "A".repeat(12000);
  test("change photo", () => allow(profile(ctx("p1"), { avatar: img })));
  test("remove photo", () => allow(profile(ctx("p1"), { avatar: "" })));
  test("clear mistakes list", () => allow(profile(ctx("p1"), { wrong: [], wrongAns: {} })));
  test("choose a region", () => allow(profile(ctx("p1"), { region: "TJ" })));
  test("clear the region", () => allow(profile(ctx("p1"), { region: "" })));
  for (const bad of ["tj", "TJK", "<b>", "T1", 42])
    test(`rejects region ${JSON.stringify(bad)}`, () => deny(profile(ctx("p1"), { region: bad })));
  test("rename to a free nickname", () => allow(profile(ctx("p1"), { nick: "Player2", nickLower: "player2" }, { claim: true, drop: "player" })));
  test("Cyrillic nickname", () => allow(profile(ctx("p1"), { nick: "Бозингар", nickLower: "бозингар" }, { claim: true, drop: "player" })));
  const PROGRESS = { coins: 999999, totalAnswered: 9999, totalCorrect: 9999, dayCount: 0, dayCoins: 5000, period: 99,
    answered: [], quizDone: { z1: [] }, hist: { "2026-01-01": 99 }, days: ["2026-01-01"], activity: [{ topic: "tajik", right: 99, total: 99, t: 1 }], lastQuiz: "z1",
    lastTopic: "english", day: "2099-01-01" };
  for (const [k, v] of Object.entries(PROGRESS)) test(`cannot change ${k}`, () => deny(profile(ctx("p1"), { [k]: v })));
  test("cannot add an unknown field", () => deny(profile(ctx("p1"), { isAdmin: true })));
  test("cannot add to the mistakes list", () => deny(profile(ctx("p1"), { wrong: ["q9", "q8", "q7"] })));
  test("cannot set the server time from the browser", () =>
    deny(setDoc(doc(ctx("p1"), "scores/p1"), { avatar: "", srvAt: Timestamp.fromMillis(Date.now()) }, { merge: true })));
  test("cannot write twice within a second", async () => {
    await allow(profile(ctx("p1"), { avatar: "" }));
    await deny(profile(ctx("p1"), { avatar: img }));
  });
  for (const bad of ["ab", "a".repeat(21), "<script>", "hello world", "nick!", "@nick", "ник-1", "a.b", "a:b"])
    test(`rejects nickname ${JSON.stringify(bad)}`, () =>
      deny(profile(ctx("p1"), { nick: bad, nickLower: bad.toLowerCase() }, { claim: true, drop: "player" })));
  test("rejects a nickLower with capitals", () => deny(profile(ctx("p1"), { nick: "Abcd", nickLower: "Abcd" }, { claim: true, drop: "player" })));
  test("cannot take someone else's nickname", () => deny(profile(ctx("p1"), { nick: "Champ", nickLower: "champ" }, { claim: true, drop: "player" })));
  test("cannot use a nickname without reserving it", () => deny(profile(ctx("p1"), { nick: "Ghost", nickLower: "ghost" })));
  for (const [name, v] of [["a link to another site", "https://evil.example/t.gif"], ["javascript:", "javascript:alert(1)"],
    ["an SVG", "data:image/svg+xml;base64,PHN2Zz4="], ["a GIF", "data:image/gif;base64,R0lGOD"], ["over 40 KB", "data:image/jpeg;base64," + "A".repeat(40001)],
    ["a number", 5]])
    test(`rejects avatar: ${name}`, () => deny(profile(ctx("p1"), { avatar: v })));
  test("another player cannot edit my profile", () => deny(setDoc(doc(ctx("champ"), "scores/p1"), { avatar: "" }, { merge: true })));
});

describe("new player registration", () => {
  beforeEach(seed);
  const fresh = o => ({ nick: "Newbie", nickLower: "newbie", period: 0, coins: 0, answered: [], day: "2026-01-01", dayCount: 0, dayCoins: 0,
    totalAnswered: 0, totalCorrect: 0, days: [], activity: [], wrong: [], updatedAt: Date.now(), srvAt: serverTimestamp(), ...o });
  const register = (uid, data, nick = data.nickLower) => {
    const f = ctx(uid), b = writeBatch(f);
    b.set(doc(f, `scores/${uid}`), data); if (nick) b.set(doc(f, `nicks/${nick}`), { uid });
    return b.commit();
  };
  test("registers from zero", () => allow(register("p2", fresh())));
  for (const [k, v] of [["coins", 500], ["totalAnswered", 5], ["totalCorrect", 5], ["dayCount", 3]])
    test(`cannot start with ${k}=${v}`, () => deny(register("p2", fresh({ [k]: v }))));
  test("must use the server time", () => deny(register("p2", fresh({ srvAt: Timestamp.now() }))));
  test("cannot register a nickname already taken", () => deny(register("p2", fresh({ nick: "Champ", nickLower: "champ" }))));
  test("cannot create a score for someone else", () => deny(setDoc(doc(ctx("p2"), "scores/p3"), fresh())));
  // Google sign-in creates the profile in one batch: nickname from the Google name, contact without a phone
  test("Google sign-in: profile, nickname and contact in one step", () => {
    const f = ctx("p2"), b = writeBatch(f);
    b.set(doc(f, "scores/p2"), fresh({ nick: "Аҳмад_Азимов", nickLower: "аҳмад_азимов" }));
    b.set(doc(f, "nicks/аҳмад_азимов"), { uid: "p2" });
    b.set(doc(f, "contacts/p2"), { name: "Аҳмад Азимов", email: "a@gmail.com", agreedAt: NOW, createdAt: NOW, updatedAt: NOW });
    return allow(b.commit());
  });
});

describe("nickname reservations", () => {
  beforeEach(seed);
  test("cannot reserve a nickname for another user", () => deny(setDoc(doc(ctx("p1"), "nicks/other"), { uid: "champ" })));
  test("cannot reserve a nickname that is not in my score", () => deny(setDoc(doc(ctx("p1"), "nicks/random"), { uid: "p1" })));
  test("cannot change a reservation", () => deny(setDoc(doc(ctx("p1"), "nicks/player"), { uid: "p1", extra: 1 })));
  test("cannot delete someone else's reservation", () => deny(deleteDoc(doc(ctx("p1"), "nicks/champ"))));
  test("can delete my own reservation", () => allow(deleteDoc(doc(ctx("p1"), "nicks/player"))));
  test("cannot reserve an upper-case id", () => deny(setDoc(doc(ctx("p1"), "nicks/Player"), { uid: "p1" })));
});

describe("contacts", () => {
  beforeEach(seed);
  const c = o => ({ name: "Ahmad", email: "a@b.com", phone: "+992 900", agreedAt: NOW, createdAt: NOW, updatedAt: NOW, ...o });
  test("save my contact", () => allow(setDoc(doc(ctx("p1"), "contacts/p1"), c())));
  test("rejects an unknown field", () => deny(setDoc(doc(ctx("p1"), "contacts/p1"), c({ role: "admin" }))));
  test("rejects a 61-char name", () => deny(setDoc(doc(ctx("p1"), "contacts/p1"), c({ name: "x".repeat(61) }))));
  test("rejects a 31-char phone", () => deny(setDoc(doc(ctx("p1"), "contacts/p1"), c({ phone: "1".repeat(31) }))));
  test("rejects a non-text name", () => deny(setDoc(doc(ctx("p1"), "contacts/p1"), c({ name: 42 }))));
  test("rejects a non-number date", () => deny(setDoc(doc(ctx("p1"), "contacts/p1"), c({ createdAt: "today" }))));
});

// ---------------------------------------------------------------- 3. answer checking on the server
describe("quiz entries (entry fee)", () => {
  beforeEach(seed);
  const entry = (o = {}) => ({ quizId: "z1", uid: "p1", nick: "Player", createdAt: NOW, paid: false, ...o });
  test("a player can ask to take part", () => allow(setDoc(doc(ctx("p1"), "entries/z1_p1"), entry())));
  test("cannot mark their own entry as paid", () => deny(setDoc(doc(ctx("p1"), "entries/z1_p1"), entry({ paid: true }))));
  test("cannot ask for someone else", () => deny(setDoc(doc(ctx("p1"), "entries/z1_champ"), entry({ uid: "champ" }))));
  test("the id must match quiz and player", () => deny(setDoc(doc(ctx("p1"), "entries/other_p1"), entry())));
  test("only for an existing quiz", () => deny(setDoc(doc(ctx("p1"), "entries/nope_p1"), entry({ quizId: "nope" }))));
  test("rejects extra fields", () => deny(setDoc(doc(ctx("p1"), "entries/z1_p1"), entry({ coins: 5 }))));
  test("signed-out visitors cannot ask", () => deny(setDoc(doc(ctx("anon"), "entries/z1_p1"), entry())));
  describe("after the request", () => {
    beforeEach(() => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), "entries/z1_p1"), entry())));
    test("the player sees their own entry", () => allow(getDoc(doc(ctx("p1"), "entries/z1_p1"))));
    test("another player cannot see it", () => deny(getDoc(doc(ctx("champ"), "entries/z1_p1"))));
    test("the player cannot confirm the payment", () => deny(updateDoc(doc(ctx("p1"), "entries/z1_p1"), { paid: true })));
    test("the admin confirms the payment", () => allow(updateDoc(doc(ctx("boss"), "entries/z1_p1"), { paid: true, paidAt: NOW })));
    test("the player can withdraw an unpaid request", () => allow(deleteDoc(doc(ctx("p1"), "entries/z1_p1"))));
  });
  test("quiz points stored by the server do not block profile changes", async () => {
    await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), "scores/p1"), score({ nick: "Player", nickLower: "player", quizCoins: { z1: 12 } })));
    await allow(updateDoc(doc(ctx("p1"), "scores/p1"), { region: "TJ", updatedAt: NOW, srvAt: serverTimestamp() }));
  });
  test("a player cannot give themselves quiz points", () =>
    deny(updateDoc(doc(ctx("p1"), "scores/p1"), { quizCoins: { z1: 999 }, updatedAt: NOW, srvAt: serverTimestamp() })));
});

describe("attacks found in the security audit", () => {
  beforeEach(seed);
  const fresh = o => ({ nick: "Newbie", nickLower: "newbie", period: 0, coins: 0, answered: [], day: "2026-01-01", dayCount: 0, dayCoins: 0,
    totalAnswered: 0, totalCorrect: 0, days: [], activity: [], wrong: [], updatedAt: Date.now(), srvAt: serverTimestamp(), ...o });
  const register = (uid, data) => { const f = ctx(uid), b = writeBatch(f);
    b.set(doc(f, `scores/${uid}`), data); b.set(doc(f, `nicks/${data.nickLower}`), { uid }); return b.commit(); };
  test("cannot register with quiz points (fake prize winner)", () => deny(register("p2", fresh({ quizCoins: { z1: 9999 } }))));
  test("cannot register with today's coins", () => deny(register("p2", fresh({ dayCoins: 500 }))));
  test("cannot register with a fake streak or history", () => deny(register("p2", fresh({ days: ["2026-01-01", "2026-01-02"] }))));
  test("cannot keep the old nickname reserved when changing it (squatting)", async () => {
    const f = ctx("p1"), b = writeBatch(f);
    b.update(doc(f, "scores/p1"), { nick: "Second", nickLower: "second", updatedAt: NOW, srvAt: serverTimestamp() });
    b.set(doc(f, "nicks/second"), { uid: "p1" });
    await deny(b.commit());
  });
  test("can change the nickname when the old one is released", async () => {
    const f = ctx("p1"), b = writeBatch(f);
    b.update(doc(f, "scores/p1"), { nick: "Second", nickLower: "second", updatedAt: NOW, srvAt: serverTimestamp() });
    b.set(doc(f, "nicks/second"), { uid: "p1" }); b.delete(doc(f, "nicks/player"));
    await allow(b.commit());
  });
  test("cannot delete the profile but keep the nickname", () => deny(deleteDoc(doc(ctx("p1"), "scores/p1"))));
  test("can delete the profile together with the nickname", async () => {
    const f = ctx("p1"), b = writeBatch(f); b.delete(doc(f, "scores/p1")); b.delete(doc(f, "nicks/player"));
    await allow(b.commit());
  });
  test("private quiz questions are hidden from players", async () => {
    await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), "qprivate/hq"), { q: { tj: "?" } }));
    await deny(getDoc(doc(ctx("p1"), "qprivate/hq"))); await deny(getDoc(doc(ctx("anon"), "qprivate/hq")));
    await allow(getDoc(doc(ctx("boss"), "qprivate/hq")));
    await deny(setDoc(doc(ctx("p1"), "qprivate/x"), { q: { tj: "?" } }));
  });
  test("an entry must carry the player's real nickname", () =>
    deny(setDoc(doc(ctx("p1"), "entries/z1_p1"), { quizId: "z1", uid: "p1", nick: "Champ", createdAt: NOW, paid: false })));
});

describe("submitAnswer (server)", () => {
  const T0 = Date.UTC(2026, 9, 5, 8);           // a fixed moment inside round 0 with the default settings
  const P0 = game.periodOf(game.readRules({ roundDays: 14, epoch: Date.UTC(2026, 8, 28) }), T0);
  const code = async (p, c) => assert.rejects(p, e => e.code === c);
  const put = (p, d) => adminDb.doc(p).set(d);
  beforeEach(async () => {
    await env.clearFirestore();
    await put("admins/boss", { role: "admin" });
    await put("config/rules", { coinsPerRight: 10, dailyLimit: 3, seconds: 20, roundDays: 14, epoch: Date.UTC(2026, 8, 28), base: 0 });
    for (let i = 1; i <= 6; i++) { await put(`questions/q${i}`, { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b", "c", "d"] } }); await put(`answers/q${i}`, { correct: 1 }); }
    await put("questions/legacy", { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b"] }, correct: 0 });
    await put("questions/noanswer", { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b"] } });
    await put("quizzes/z1", { bonus: 20, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5", "q6"] });
    await put("quizzes/ended", { bonus: 500, start: T0 - 9e8, end: T0 - 8e8, qids: ["q5"] });
    await put("quizzes/huge", { bonus: 1e9, start: T0 - 864e5, end: T0 + 864e5, qids: ["q6"] });
    await put("scores/u1", { nick: "U", nickLower: "u", period: P0, coins: 0, answered: [], day: game.dayKey(T0), dayCount: 0, totalAnswered: 0, totalCorrect: 0 });
  });
  const ask = (data, t = T0, uid = "u1") => game.submitAnswer(adminDb, uid, data, t);

  test("refuses a signed-out caller", () => code(ask({ qid: "q1", choice: 1 }, T0, null), "unauthenticated"));
  test("quiz with an entry fee: refused without a request", async () => {
    await put("quizzes/paid", { bonus: 4, entryFee: 5, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5"] });
    await code(ask({ qid: "q5", choice: 1, quizId: "paid" }), "failed-precondition");
  });
  test("quiz with an entry fee: refused while unpaid", async () => {
    await put("quizzes/paid", { bonus: 4, entryFee: 5, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5"] });
    await put("entries/paid_u1", { quizId: "paid", uid: "u1", nick: "U", createdAt: T0, paid: false });
    await code(ask({ qid: "q5", choice: 1, quizId: "paid" }), "failed-precondition");
  });
  // Paid quizzes: the server hands out each question (quizQuestion) and times it
  const serve = (t = T0, uid = "u1", quizId = "paid") => game.quizQuestion(adminDb, uid, { quizId }, t);
  const paidQuiz = (qids = ["q5", "q6"]) => put("quizzes/paid", { bonus: 4, entryFee: 5, start: T0 - 864e5, end: T0 + 864e5, qids });
  const paidEntry = (o = {}) => put("entries/paid_u1", { quizId: "paid", uid: "u1", nick: "U", createdAt: T0, paid: true, ...o });
  test("quiz with an entry fee: paid players play and their quiz points are kept", async () => {
    await paidQuiz(); await paidEntry();
    const q = await serve();
    assert.equal(q.q.id, "q5"); assert.equal("correct" in q.q, false); assert.equal(q.total, 2);
    const r = await ask({ qid: "q5", choice: 1, quizId: "paid" }, T0 + 1000);
    assert.equal(r.gain, 4); assert.equal(r.me.quizCoins.paid, 4);
    assert.equal((await serve(T0 + 2000)).q.id, "q6");
    await ask({ qid: "q6", choice: 0, quizId: "paid" }, T0 + 3000);
    assert.equal((await adminDb.doc("scores/u1").get()).data().quizCoins.paid, 4);
    assert.equal((await serve(T0 + 4000)).done, true);
  });
  test("re-registering does not reopen a paid quiz (replay attack)", async () => {
    await paidQuiz(); await paidEntry();
    await serve(); await ask({ qid: "q5", choice: 1, quizId: "paid" }, T0 + 1000);
    await put("scores/u1", { nick: "U", nickLower: "u", period: P0, coins: 0, answered: [], day: game.dayKey(T0), dayCount: 0, totalAnswered: 0, totalCorrect: 0 });
    await code(ask({ qid: "q5", choice: 1, quizId: "paid" }, T0 + 3000), "already-exists");
    assert.equal((await serve(T0 + 4000)).q.id, "q6");
    const r = await ask({ qid: "q6", choice: 1, quizId: "paid" }, T0 + 5000);
    assert.equal(r.me.quizCoins.paid, 8);                       // points from before re-registering are kept
  });
  test("a paid quiz does not reveal the correct option or store it publicly", async () => {
    await paidQuiz(["q5"]); await paidEntry(); await serve();
    const r = await ask({ qid: "q5", choice: 3, quizId: "paid" }, T0 + 1000);
    assert.equal(r.ok, false); assert.equal(r.correct, null);
    const s = (await adminDb.doc("scores/u1").get()).data();
    assert.equal(s.wrongAns?.q5, undefined); assert.equal((s.wrong || []).includes("q5"), false);
  });
  test("paid quiz: a question that was not handed out cannot be answered", async () => {
    await paidQuiz(); await paidEntry(); await serve();
    await code(ask({ qid: "q6", choice: 1, quizId: "paid" }, T0 + 1000), "failed-precondition");
  });
  test("paid quiz: an answer after the time limit counts as wrong (server timer)", async () => {
    await paidQuiz(); await paidEntry(); await serve();
    const r = await ask({ qid: "q5", choice: 1, quizId: "paid" }, T0 + 60000);       // limit is 20 s + 5 s
    assert.equal(r.ok, false); assert.equal(r.gain, 0);
  });
  test("paid quiz: reloading the page does not restart the timer", async () => {
    await paidQuiz(); await paidEntry(); await serve();
    const again = await serve(T0 + 15000);
    assert.equal(again.q.id, "q5"); assert.equal(again.remain, 5000);
  });
  test("paid quiz: an abandoned question counts as answered when the time is up", async () => {
    await paidQuiz(); await paidEntry(); await serve();
    const next = await serve(T0 + 60000);
    assert.equal(next.q.id, "q6");
    await code(ask({ qid: "q5", choice: 1, quizId: "paid" }, T0 + 61000), "already-exists");
  });
  test("paid quiz: questions are handed out only to paid players", async () => {
    await paidQuiz(); await code(serve(), "failed-precondition");
    await paidEntry({ paid: false }); await code(serve(), "failed-precondition");
  });
  test("free quizzes have no handed-out questions", () => code(serve(T0, "u1", "z1"), "failed-precondition"));
  test("handing out needs a valid quiz id", () => code(game.quizQuestion(adminDb, "u1", { quizId: "../x" }, T0), "invalid-argument"));
  test("private quiz questions cannot be answered in the normal game", async () => {
    await put("qprivate/hq", { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b", "c", "d"] } }); await put("answers/hq", { correct: 1 });
    await code(ask({ qid: "hq", choice: 1 }), "failed-precondition");
  });
  test("private quiz questions are served and checked in their paid quiz", async () => {
    await put("qprivate/hq", { topic: "tajik", q: { tj: "Hidden?" }, opts: { tj: ["a", "b", "c", "d"] } }); await put("answers/hq", { correct: 2 });
    await paidQuiz(["hq"]); await paidEntry();
    const q = await serve(); assert.equal(q.q.q.tj, "Hidden?");
    assert.equal((await ask({ qid: "hq", choice: 2, quizId: "paid" }, T0 + 1000)).ok, true);
  });
  test("quiz-only questions cannot be answered outside the quiz", async () => {
    await put("questions/q5", { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b", "c", "d"] }, quizOnly: true });
    await code(ask({ qid: "q5", choice: 1 }), "failed-precondition");
  });
  test("a paid entry for another quiz does not count", async () => {
    await put("quizzes/paid", { bonus: 4, entryFee: 5, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5"] });
    await put("entries/z1_u1", { quizId: "z1", uid: "u1", nick: "U", createdAt: T0, paid: true });
    await code(ask({ qid: "q5", choice: 1, quizId: "paid" }), "failed-precondition");
  });

  for (const [name, bad] of [["null", null], ["an array", []], ["a string", "q1"], ["an empty object", {}], ["a numeric id", { qid: 1, choice: 1 }],
    ["an id with a slash", { qid: "a/b", choice: 1 }], ["a 101-char id", { qid: "x".repeat(101), choice: 1 }], ["a text choice", { qid: "q1", choice: "1" }],
    ["a fractional choice", { qid: "q1", choice: 1.5 }], ["choice 99", { qid: "q1", choice: 99 }], ["choice -2", { qid: "q1", choice: -2 }],
    ["a path in quizId", { qid: "q1", choice: 1, quizId: "../x" }], ["a numeric quizId", { qid: "q1", choice: 1, quizId: 5 }]])
    test(`rejects ${name}`, () => code(ask(bad), "invalid-argument"));
  test("requires registration", () => code(ask({ qid: "q1", choice: 1 }, T0, "stranger"), "failed-precondition"));
  test("unknown question", () => code(ask({ qid: "nope", choice: 1 }), "not-found"));
  test("question without an answer", () => code(ask({ qid: "noanswer", choice: 1 }), "failed-precondition"));
  test("right answer gives the configured coins and reveals the answer only afterwards", async () => {
    const r = await ask({ qid: "q1", choice: 1 });
    assert.equal(r.ok, true); assert.equal(r.correct, 1); assert.equal(r.me.coins, 10);
  });
  test("wrong answer gives nothing and goes to the mistakes list", async () => {
    const r = await ask({ qid: "q1", choice: 3 });
    assert.equal(r.ok, false); assert.equal(r.me.coins, 0); assert.deepEqual(r.me.wrong, ["q1"]); assert.equal(r.me.wrongAns.q1, 1);
  });
  test("timeout (-1) counts as wrong", async () => assert.equal((await ask({ qid: "q1", choice: -1 })).ok, false));
  test("the same question cannot be answered twice", async () => { await ask({ qid: "q1", choice: 1 }); await code(ask({ qid: "q1", choice: 1 }, T0 + 5000), "already-exists"); });
  test("answers closer than 0.8 s are refused", async () => { await ask({ qid: "q1", choice: 1 }); await code(ask({ qid: "q2", choice: 1 }, T0 + 100), "resource-exhausted"); });
  test("daily limit is enforced", async () => {
    for (let i = 1; i <= 3; i++) await ask({ qid: `q${i}`, choice: 1 }, T0 + i * 2000);
    await code(ask({ qid: "q4", choice: 1 }, T0 + 9000), "resource-exhausted");
  });
  test("the daily limit restarts the next day", async () => {
    for (let i = 1; i <= 3; i++) await ask({ qid: `q${i}`, choice: 1 }, T0 + i * 2000);
    assert.equal((await ask({ qid: "q4", choice: 1 }, T0 + 864e5)).me.dayCount, 1);
  });
  test("quiz answer uses the quiz bonus", async () => assert.equal((await ask({ qid: "q5", choice: 1, quizId: "z1" })).me.coins, 20));
  test("quiz answers do not use the daily limit", async () => assert.equal((await ask({ qid: "q5", choice: 1, quizId: "z1" })).me.dayCount, 0));
  test("ended quiz is refused", () => code(ask({ qid: "q5", choice: 1, quizId: "ended" }), "failed-precondition"));
  test("unknown quiz is refused", () => code(ask({ qid: "q5", choice: 1, quizId: "ghost" }), "not-found"));
  test("a question outside the quiz is refused", () => code(ask({ qid: "q1", choice: 1, quizId: "z1" }), "invalid-argument"));
  test("a quiz question cannot be answered twice", async () => { await ask({ qid: "q5", choice: 1, quizId: "z1" }); await code(ask({ qid: "q5", choice: 1, quizId: "z1" }, T0 + 5000), "already-exists"); });
  test("an absurd quiz bonus falls back to the normal reward", async () => assert.equal((await ask({ qid: "q6", choice: 1, quizId: "huge" })).me.coins, 10));
  test("reward follows the admin settings", async () => { await put("config/rules", { coinsPerRight: 25, dailyLimit: 3, roundDays: 14, epoch: Date.UTC(2026, 8, 28) }); assert.equal((await ask({ qid: "q1", choice: 1 })).me.coins, 25); });
  test("out-of-range settings are ignored", async () => { await put("config/rules", { coinsPerRight: 5000, roundDays: 14, epoch: Date.UTC(2026, 8, 28) }); assert.equal((await ask({ qid: "q1", choice: 1 })).me.coins, 4); });   // falls back to the default of 4 coins
  test("the player's region survives answering", async () => {
    await put("scores/u1", { nick: "U", nickLower: "u", period: P0 - 1, coins: 0, region: "TJ" });
    assert.equal((await ask({ qid: "q1", choice: 1 })).me.region, "TJ");
  });
  test("a new round restarts coins but keeps totals", async () => {
    await put("scores/u1", { nick: "U", nickLower: "u", period: P0 - 1, coins: 900, answered: ["q1"], totalAnswered: 50, totalCorrect: 40 });
    const r = await ask({ qid: "q1", choice: 1 });
    assert.equal(r.me.coins, 10); assert.equal(r.me.totalAnswered, 51); assert.equal(r.me.period, P0);
  });
  test("garbage in a stored score does not break or inflate anything", async () => {
    await put("scores/u1", { nick: "U", nickLower: "u", period: P0, coins: "999999", answered: "x", dayCount: -5, totalAnswered: 1.5, hist: [], wrongAns: "y" });
    const r = await ask({ qid: "q1", choice: 1 });
    assert.equal(r.me.coins, 10); assert.deepEqual(r.me.answered, ["q1"]);
  });
  test("legacy questions with the answer inside still work", async () => assert.equal((await ask({ qid: "legacy", choice: 0 })).ok, true));
  test("the reply contains no other question's answer", async () => {
    const r = await ask({ qid: "q1", choice: 3 });
    assert.deepEqual(Object.keys(r).sort(), ["correct", "gain", "me", "ok"]); assert.deepEqual(Object.keys(r.me.wrongAns), ["q1"]);
  });
  test("two simultaneous answers to one question count once", async () => {
    const rs = await Promise.allSettled([ask({ qid: "q1", choice: 1 }), ask({ qid: "q1", choice: 1 })]);
    assert.equal(rs.filter(x => x.status === "fulfilled").length, 1);
    assert.equal((await adminDb.doc("scores/u1").get()).data().coins, 10);
  });
  test("only an admin can move answers", () => code(game.migrateAnswers(adminDb, "u1"), "permission-denied"));
  test("only an admin can import the cartoon questions", () => code(game.importCartoons(adminDb, "u1"), "permission-denied"));
  test("cartoon import keeps the answers private and follows the key", async () => {
    assert.equal((await game.importCartoons(adminDb, "boss")).added, 9);
    const q = (await adminDb.doc("questions/cartoon08").get()).data();
    assert.equal(q.topic, "cartoon"); assert.equal("correct" in q, false); assert.equal(q.img, "/img/cartoons/c08.jpg");
    const key = { cartoon05: 2, cartoon07: 2, cartoon08: 0, cartoon09: 1, cartoon10: 1, cartoon11: 1, cartoon12: 0, cartoon13: 1, cartoon14: 1 };
    for (const [id, c] of Object.entries(key)) assert.equal((await adminDb.doc(`answers/${id}`).get()).data().correct, c, id);
    await deny(getDoc(doc(ctx("u1"), "answers/cartoon08")));
    assert.equal((await ask({ qid: "cartoon08", choice: 0 })).ok, true);
  });
  test("moving answers strips them from public questions", async () => {
    const r = await game.migrateAnswers(adminDb, "boss");
    assert.equal(r.moved, 1);
    assert.equal("correct" in (await adminDb.doc("questions/legacy").get()).data(), false);
    assert.equal((await adminDb.doc("answers/legacy").get()).data().correct, 0);
  });
  test("players cannot read the moved answers", async () => {
    await game.migrateAnswers(adminDb, "boss");
    await deny(getDoc(doc(ctx("u1"), "answers/legacy")));
  });
});
