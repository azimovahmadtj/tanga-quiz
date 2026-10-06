// Cloudflare Worker API for Танга: checks answers on the server so the correct option never reaches the browser.
// Uses the same game rules as the Firebase Cloud Functions (functions/core.js).
import core from "../../functions/core.js";
import cartoons from "../../functions/seed/cartoons.js";
import { verifyIdToken, serviceAccountToken, AuthError } from "./auth.js";
import { Firestore, FirestoreError } from "./firestore.js";

const { GameError, validate, applyAnswer, answersToMove } = core;
const STATUS = { "invalid-argument": 400, unauthenticated: 401, "permission-denied": 403, "not-found": 404, "already-exists": 409,
  "failed-precondition": 412, "resource-exhausted": 429, internal: 500 };
const MAX_BODY = 4096;

const json = (status, body, cors) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
const fail = (code, message, cors) => json(STATUS[code] || 500, { error: { code, message } }, cors);

function db(env) {
  return new Firestore({ projectId: env.PROJECT_ID, emulatorHost: env.FIRESTORE_EMULATOR_HOST,
    token: () => serviceAccountToken(env.SERVICE_ACCOUNT) });
}
async function requireAdmin(store, uid) {
  if (!(await store.get(`admins/${uid}`))) throw new GameError("permission-denied", "admins only");
}

async function submitAnswer(store, uid, data, now) {
  const { qid, choice, quizId } = validate(data);
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = await store.begin();
    const [score, question, answer, rules, quiz, entry] = await store.getAll(
      [`scores/${uid}`, `questions/${qid}`, `answers/${qid}`, "config/rules", ...(quizId ? [`quizzes/${quizId}`, `entries/${quizId}_${uid}`] : [])], tx);
    let res;
    try {
      res = applyAnswer({ score, lastMs: score?.srvAt?.__ts || 0, question, answer, rules, quiz: quiz ?? null, entry: entry ?? null, qid, choice, quizId, now });
    } catch (e) { await store.rollback(tx); throw e; }
    try {
      const writes = [store.set(`scores/${uid}`, { ...res.m, srvAt: { __ts: now } })];
      if (res.entry) writes.push(store.set(`entries/${quizId}_${uid}`, { ...entry, ...res.entry }));
      await store.commit(writes, tx);
      return { ok: res.ok, correct: res.correct, gain: res.gain, me: res.m };
    } catch (e) {
      if (e instanceof FirestoreError && (e.status === 409 || e.status === 400 && /transaction/i.test(e.message))) continue;   // lost a race: retry
      throw e;
    }
  }
  throw new GameError("resource-exhausted", "busy, try again");
}

async function migrateAnswers(store, uid) {
  await requireAdmin(store, uid);
  const moves = answersToMove(await store.list("questions"));
  for (let i = 0; i < moves.length; i += 200) {
    const writes = [];
    for (const { id, correct } of moves.slice(i, i + 200)) {
      if (Number.isInteger(correct)) writes.push(store.set(`answers/${id}`, { correct }));
      writes.push(store.removeFields(`questions/${id}`, ["correct"]));
    }
    await store.commit(writes);
  }
  return { moved: moves.length };
}

async function importCartoons(store, uid, _data, now) {
  await requireAdmin(store, uid);
  const writes = [];
  for (const { id, correct, ...q } of cartoons) {
    writes.push(store.set(`questions/${id}`, { ...q, topic: "cartoon", createdAt: now }));
    writes.push(store.set(`answers/${id}`, { correct }));
  }
  await store.commit(writes);
  return { added: cartoons.length };
}

const ROUTES = { submitAnswer, migrateAnswers, importCartoons };

export async function handle(req, env, now = Date.now()) {
  const origin = req.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const cors = origin && allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  if (origin && !cors["Access-Control-Allow-Origin"]) return fail("permission-denied", "origin not allowed", {});
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
  if (req.method !== "POST") return fail("invalid-argument", "use POST", cors);
  const route = ROUTES[new URL(req.url).pathname.replace(/^\/+|\/+$/g, "")];
  if (!route) return fail("not-found", "no such endpoint", cors);

  const text = await req.text();
  if (text.length > MAX_BODY) return fail("invalid-argument", "request too large", cors);
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { return fail("invalid-argument", "bad JSON", cors); }

  let uid;
  try { uid = await verifyIdToken((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""), env.PROJECT_ID, now); }
  catch (e) { return fail("unauthenticated", e instanceof AuthError ? e.message : "sign in first", cors); }

  try { return json(200, { result: await route(db(env), uid, data, now) }, cors); }
  catch (e) {
    if (e instanceof GameError) return fail(e.code, e.message, cors);
    console.error(e);
    // The reason (e.g. a bad SERVICE_ACCOUNT secret or a Firestore error) helps the admin fix the setup; it holds no secrets
    return fail("internal", "server error: " + String(e?.message || e).slice(0, 300), cors);
  }
}

export default { fetch: (req, env) => handle(req, env) };
