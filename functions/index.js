// Cloud Functions for Танга (requires the Blaze plan). Region is close to Central Asia.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const game = require("./game");

initializeApp();
const db = getFirestore();
// Set to true once App Check is set up (README → App Check): then only the real site can call these
const ENFORCE_APP_CHECK = false;
const opts = { region: "europe-west1", enforceAppCheck: ENFORCE_APP_CHECK, maxInstances: 10, memory: "256MiB", timeoutSeconds: 10 };

const wrap = fn => async req => {
  try { return await fn(req); }
  catch (e) {
    if (e instanceof game.GameError) throw new HttpsError(e.code, e.message);
    console.error(e);
    throw new HttpsError("internal", "server error");
  }
};

exports.submitAnswer = onCall(opts, wrap(req => game.submitAnswer(db, req.auth?.uid, req.data)));
exports.migrateAnswers = onCall(opts, wrap(req => game.migrateAnswers(db, req.auth?.uid)));
exports.importCartoons = onCall(opts, wrap(req => game.importCartoons(db, req.auth?.uid)));
