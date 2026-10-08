// Tests for the Cloudflare Worker API (worker/src). They call the real request handler against the Firestore emulator,
// with Firebase-style ID tokens signed by a test key.
import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { handle } from "../worker/src/index.js";
import { testHooks } from "../worker/src/auth.js";

const requireFn = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, getApps } = requireFn("firebase-admin/app");
const { getFirestore } = requireFn("firebase-admin/firestore");

const PROJECT = "tanga-quiz", ORIGIN = "https://tanga-quiz.web.app";
const env = { PROJECT_ID: PROJECT, ALLOWED_ORIGINS: ORIGIN, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST };
const T0 = Date.UTC(2026, 9, 5, 8);
let adminDb, signKey, otherKey;

const b64u = buf => Buffer.from(buf).toString("base64url");
async function token({ uid = "u1", key = signKey, kid = "k1", aud = PROJECT, iss = `https://securetoken.google.com/${PROJECT}`, now = T0, exp, alg = "RS256" } = {}) {
  const t = Math.floor(now / 1000);
  const h = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const p = b64u(JSON.stringify({ aud, iss, sub: uid, user_id: uid, iat: t, auth_time: t, exp: exp ?? t + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(h + "." + p));
  return `${h}.${p}.${b64u(sig)}`;
}
const call = async (path, body, { tok, origin = ORIGIN, method = "POST", now = T0, raw } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (tok !== null) headers.Authorization = "Bearer " + (tok ?? await token({ now }));
  const res = await handle(new Request("https://api.test/" + path, { method, headers, body: method === "POST" ? (raw ?? JSON.stringify(body ?? {})) : undefined }), env, now);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const put = (p, d) => adminDb.doc(p).set(d);

before(async () => {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  signKey = await gen(); otherKey = await gen();
  testHooks.jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", signKey.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  adminDb = getFirestore();
});

async function seed() {
  const all = await adminDb.listCollections();
  for (const c of all) for (const d of (await c.get()).docs) await d.ref.delete();
  await put("admins/boss", { role: "admin" });
  await put("config/rules", { coinsPerRight: 10, dailyLimit: 3, roundDays: 14, epoch: Date.UTC(2026, 8, 28), base: 0 });
  for (let i = 1; i <= 5; i++) { await put(`questions/q${i}`, { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b", "c", "d"] } }); await put(`answers/q${i}`, { correct: 1 }); }
  await put("questions/legacy", { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b"] }, correct: 0 });
  await put("quizzes/z1", { bonus: 20, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5"] });
  await put("scores/u1", { nick: "U", nickLower: "u", period: 0, coins: 0, answered: [], day: "2026-10-05", dayCount: 0, totalAnswered: 0, totalCorrect: 0 });
}

describe("worker: request checks", () => {
  beforeEach(seed);
  test("CORS preflight from the site is allowed", async () => {
    const r = await call("submitAnswer", null, { method: "OPTIONS", tok: null });
    assert.equal(r.status, 204); assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });
  test("other websites are refused", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { origin: "https://evil.example" })).status, 403));
  test("GET is refused", async () => assert.equal((await call("submitAnswer", null, { method: "GET" })).status, 400));
  test("unknown endpoint", async () => assert.equal((await call("deleteEverything", {})).status, 404));
  test("no token", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: null })).status, 401));
  test("garbage token", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: "abc.def.ghi" })).status, 401));
  test("token signed by someone else", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ key: otherKey }) })).status, 401));
  test("token with an unknown key id", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ kid: "zz" }) })).status, 401));
  test("expired token", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ exp: Math.floor(T0 / 1000) - 1 }) })).status, 401));
  test("token for another project", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ aud: "other" }) })).status, 401));
  test("token from another issuer", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ iss: "https://evil.example" }) })).status, 401));
  test("unsigned token (alg none)", async () => {
    const [h, p] = (await token()).split(".");
    const none = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
    assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: `${none}.${p}.` })).status, 401);
    assert.ok(h);
  });
  test("oversized request", async () => assert.equal((await call("submitAnswer", null, { raw: JSON.stringify({ qid: "q1", choice: 1, pad: "x".repeat(5000) }) })).status, 400));
  test("broken JSON", async () => assert.equal((await call("submitAnswer", null, { raw: "{nope" })).status, 400));
  test("invalid answer data", async () => assert.equal((await call("submitAnswer", { qid: "../q1", choice: 1 })).body.error.code, "invalid-argument"));
});

describe("worker: answers", () => {
  beforeEach(seed);
  test("unregistered player", async () => assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ uid: "nobody" }) })).status, 412));
  test("right answer is saved on the server", async () => {
    const r = await call("submitAnswer", { qid: "q1", choice: 1 });
    assert.equal(r.status, 200); assert.equal(r.body.result.ok, true); assert.equal(r.body.result.me.coins, 10);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    const s = (await adminDb.doc("scores/u1").get()).data();
    assert.equal(s.coins, 10); assert.deepEqual(s.answered, ["q1"]); assert.equal(s.srvAt.toMillis(), T0);
  });
  test("wrong answer goes to the mistakes list", async () => {
    const r = (await call("submitAnswer", { qid: "q1", choice: 3 })).body.result;
    assert.equal(r.ok, false); assert.equal(r.correct, 1); assert.deepEqual(Object.keys(r.me.wrongAns), ["q1"]);
  });
  test("the reply holds only this question's answer", async () => assert.deepEqual(Object.keys((await call("submitAnswer", { qid: "q1", choice: 1 })).body.result).sort(), ["correct", "gain", "me", "ok"]));
  test("answering twice is refused", async () => {
    await call("submitAnswer", { qid: "q1", choice: 1 });
    assert.equal((await call("submitAnswer", { qid: "q1", choice: 1 }, { now: T0 + 5000, tok: await token({ now: T0 + 5000 }) })).status, 409);
  });
  test("answers closer than 0.8 s are refused", async () => {
    await call("submitAnswer", { qid: "q1", choice: 1 });
    assert.equal((await call("submitAnswer", { qid: "q2", choice: 1 }, { now: T0 + 100, tok: await token({ now: T0 + 100 }) })).status, 429);
  });
  test("daily limit", async () => {
    for (let i = 1; i <= 3; i++) assert.equal((await call("submitAnswer", { qid: `q${i}`, choice: 1 }, { now: T0 + i * 2000, tok: await token({ now: T0 + i * 2000 }) })).status, 200);
    assert.equal((await call("submitAnswer", { qid: "q4", choice: 1 }, { now: T0 + 9000, tok: await token({ now: T0 + 9000 }) })).status, 429);
  });
  test("quiz bonus", async () => assert.equal((await call("submitAnswer", { qid: "q5", choice: 1, quizId: "z1" })).body.result.me.coins, 20));
  test("quiz with an entry fee needs a confirmed payment and a handed-out question", async () => {
    await put("quizzes/paid", { bonus: 4, entryFee: 5, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5"] });
    assert.equal((await call("quizQuestion", { quizId: "paid" })).status, 412);
    await put("entries/paid_u1", { quizId: "paid", uid: "u1", nick: "U", createdAt: T0, paid: true });
    assert.equal((await call("submitAnswer", { qid: "q5", choice: 1, quizId: "paid" })).status, 412);   // not handed out yet
    const q = await call("quizQuestion", { quizId: "paid" });
    assert.equal(q.status, 200); assert.equal(q.body.result.q.id, "q5"); assert.equal("correct" in q.body.result.q, false);
    const r = await call("submitAnswer", { qid: "q5", choice: 1, quizId: "paid" }, { now: T0 + 2000, tok: await token({ now: T0 + 2000 }) });
    assert.equal(r.status, 200); assert.equal(r.body.result.me.quizCoins.paid, 4); assert.equal(r.body.result.correct, null);
  });
  test("leaving a paid quiz closes it", async () => {
    await put("quizzes/paid", { bonus: 4, entryFee: 5, start: T0 - 864e5, end: T0 + 864e5, qids: ["q5", "q6"] });
    await put("entries/paid_u1", { quizId: "paid", uid: "u1", nick: "U", createdAt: T0, paid: true });
    await call("quizQuestion", { quizId: "paid" });
    assert.deepEqual((await call("quizLeave", { quizId: "paid" })).body.result, { locked: true });
    assert.equal((await call("quizQuestion", { quizId: "paid" })).status, 412);
  });
  test("private quiz questions stay hidden in the normal game", async () => {
    await put("qprivate/hq", { topic: "tajik", q: { tj: "?" }, opts: { tj: ["a", "b", "c", "d"] } }); await put("answers/hq", { correct: 1 });
    assert.equal((await call("submitAnswer", { qid: "hq", choice: 1 })).status, 412);
  });
  test("a player can only change their own score", async () => {
    await put("scores/u2", { nick: "V", nickLower: "v", period: 0, coins: 5 });
    await call("submitAnswer", { qid: "q1", choice: 1 }, { tok: await token({ uid: "u2" }) });
    assert.equal((await adminDb.doc("scores/u1").get()).data().coins, 0);
    assert.equal((await adminDb.doc("scores/u2").get()).data().coins, 15);
  });
  test("two simultaneous answers count once", async () => {
    const tok = await token();
    const rs = await Promise.all([call("submitAnswer", { qid: "q1", choice: 1 }, { tok }), call("submitAnswer", { qid: "q1", choice: 1 }, { tok })]);
    assert.equal(rs.filter(r => r.status === 200).length, 1);
    assert.equal((await adminDb.doc("scores/u1").get()).data().coins, 10);
  });
});

describe("worker: admin actions", () => {
  beforeEach(seed);
  test("players cannot move answers", async () => assert.equal((await call("migrateAnswers", {})).status, 403));
  test("admin moves answers out of public questions", async () => {
    const r = await call("migrateAnswers", {}, { tok: await token({ uid: "boss" }) });
    assert.equal(r.body.result.moved, 1);
    assert.equal("correct" in (await adminDb.doc("questions/legacy").get()).data(), false);
    assert.equal((await adminDb.doc("answers/legacy").get()).data().correct, 0);
  });
  test("players cannot import cartoons", async () => assert.equal((await call("importCartoons", {})).status, 403));
  test("admin imports the cartoon questions with hidden answers", async () => {
    assert.equal((await call("importCartoons", {}, { tok: await token({ uid: "boss" }) })).body.result.added, 9);
    const q = (await adminDb.doc("questions/cartoon10").get()).data();
    assert.equal(q.topic, "cartoon"); assert.equal("correct" in q, false);
    assert.equal((await adminDb.doc("answers/cartoon10").get()).data().correct, 1);
  });
});
