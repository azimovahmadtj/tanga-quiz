// Firebase Console → Project settings → General → "Your apps" → Web app → SDK setup and configuration
// These keys are public by design; security comes from firestore.rules
export const firebaseConfig = {
  apiKey: "AIzaSyCOKw4K83HO7bIxaaDCbW9_ubZqQfcq5gQ",
  authDomain: "tanga-quiz.firebaseapp.com",
  projectId: "tanga-quiz",
  storageBucket: "tanga-quiz.firebasestorage.app",
  messagingSenderId: "409648955196",
  appId: "1:409648955196:web:03374047bc28e84dac6839",
  measurementId: "G-JEY1K4E972"
};

// Optional protection against bots and request floods (Firebase App Check with reCAPTCHA v3).
// Leave empty to turn it off. See README → "App Check" for how to get a key.
export const appCheckSiteKey = "";

// Address of the Cloudflare Worker that checks answers (see worker/wrangler.toml), for example
// "https://tanga-api.yourname.workers.dev". Leave empty to use Firebase Cloud Functions instead (Blaze plan).
export const apiUrl = "https://tanga-api.tanga-quiz.workers.dev";
