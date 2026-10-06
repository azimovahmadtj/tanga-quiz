// Firebase sign-in check (ID tokens) and Google service-account access tokens, using only Web Crypto.
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const enc = new TextEncoder();
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const toB64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonPart = s => JSON.parse(new TextDecoder().decode(b64url(s)));

// Tests can provide the signing keys instead of downloading Google's
export const testHooks = { jwks: null };
let jwksCache = { keys: null, until: 0 };

async function signingKeys(now) {
  if (testHooks.jwks) return testHooks.jwks.keys;
  if (jwksCache.keys && now < jwksCache.until) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error("cannot load Google signing keys");
  const maxAge = +(/max-age=(\d+)/.exec(r.headers.get("Cache-Control") || "") || [0, 3600])[1];
  jwksCache = { keys: (await r.json()).keys, until: now + maxAge * 1000 };
  return jwksCache.keys;
}

export class AuthError extends Error {}

// Returns the player's uid when the Firebase ID token is genuine, current and issued for this project
export async function verifyIdToken(token, projectId, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  let header, p;
  try { header = jsonPart(parts[0]); p = jsonPart(parts[1]); } catch { throw new AuthError("malformed token"); }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("unexpected algorithm");
  const t = Math.floor(now / 1000);
  if (p.aud !== projectId || p.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError("wrong project");
  if (!(p.exp > t) || !(p.iat <= t + 300) || !(p.auth_time <= t + 300)) throw new AuthError("expired token");
  if (typeof p.sub !== "string" || !p.sub || p.sub.length > 128) throw new AuthError("no user");
  const jwk = (await signingKeys(now)).find(k => k.kid === header.kid);
  if (!jwk) throw new AuthError("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new AuthError("bad signature");
  return p.sub;
}

// OAuth access token for the service account (to use Firestore as the server), cached until shortly before expiry
let saCache = { token: null, until: 0 };
export async function serviceAccountToken(saJson, now = Date.now()) {
  if (saCache.token && now < saCache.until) return saCache.token;
  const sa = typeof saJson === "string" ? JSON.parse(saJson) : saJson;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", b64url(pem.replace(/\+/g, "-").replace(/\//g, "_")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const head = toB64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = toB64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })));
  const sig = toB64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head + "." + body)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + body + "." + sig });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("service account login failed: " + (j.error_description || j.error || r.status));
  saCache = { token: j.access_token, until: now + (j.expires_in - 120) * 1000 };
  return saCache.token;
}
