// Keeps the Content-Security-Policy in firebase.json in step with the inline <script> blocks of the pages.
//   node scripts/csp.mjs          -> recompute the script hashes and write them into firebase.json
//   node scripts/csp.mjs --check  -> fail if firebase.json is out of date (runs before every `firebase deploy`)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pages = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".html")) pages.push(p);
  }
})(join(root, "public"));

const hashes = new Set();
for (const p of pages) {
  const html = readFileSync(p, "utf8");
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g))
    hashes.add(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
}

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(" ")} https://www.gstatic.com https://apis.google.com https://www.google.com/recaptcha/`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "connect-src 'self' https://*.googleapis.com https://apis.google.com https://www.google.com/recaptcha/",
  "frame-src https://tanga-quiz.firebaseapp.com https://accounts.google.com https://www.google.com/recaptcha/",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const file = join(root, "firebase.json");
const cfg = JSON.parse(readFileSync(file, "utf8"));
const all = cfg.hosting.headers.find(h => h.source === "**");
const cur = all && all.headers.find(h => h.key === "Content-Security-Policy");
if (process.argv.includes("--check")) {
  if (!cur || cur.value !== csp) {
    console.error("firebase.json: Content-Security-Policy is out of date. Run:  node scripts/csp.mjs");
    process.exit(1);
  }
  console.log("CSP is up to date");
} else {
  cur.value = csp;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`CSP updated (${hashes.size} inline scripts)`);
}
