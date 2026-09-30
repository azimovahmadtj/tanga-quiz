// Minimal Firestore REST client for the Worker: reads, transactions and batched writes as the service account.
// Timestamps travel as { __ts: milliseconds }.
export function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object" && typeof v.__ts === "number") return { timestampValue: new Date(v.__ts).toISOString() };
  if (typeof v === "object") return { mapValue: { fields: fields(v) } };
  throw new Error("cannot store " + typeof v);
}
export function fields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encode(v);
  return out;
}
export function decode(v) {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return { __ts: Date.parse(v.timestampValue) };
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;   // references, geo points, bytes: never used by the game
}
export const fromFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));

export class FirestoreError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export class Firestore {
  // token: async () => access token; emulatorHost: "127.0.0.1:8085" in tests
  constructor({ projectId, token, emulatorHost }) {
    this.root = `projects/${projectId}/databases/(default)/documents`;
    this.base = (emulatorHost ? `http://${emulatorHost}` : "https://firestore.googleapis.com") + "/v1/";
    this.token = emulatorHost ? async () => "owner" : token;
  }
  name(path) { return `${this.root}/${path}`; }
  async req(method, url, body) {
    const r = await fetch(this.base + url, { method, headers: { Authorization: "Bearer " + (await this.token()), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new FirestoreError(r.status, j.error?.message || "firestore error");
    return j;
  }
  async get(path) {
    try { return fromFields((await this.req("GET", this.name(path))).fields); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  async list(collection) {
    const out = []; let page = "";
    do {
      const j = await this.req("GET", `${this.name(collection)}?pageSize=300${page ? "&pageToken=" + encodeURIComponent(page) : ""}`);
      for (const d of j.documents || []) out.push({ id: d.name.split("/").pop(), data: fromFields(d.fields) });
      page = j.nextPageToken || "";
    } while (page);
    return out;
  }
  async begin() { return (await this.req("POST", `${this.root}:beginTransaction`, { options: { readWrite: {} } })).transaction; }
  async rollback(transaction) { try { await this.req("POST", `${this.root}:rollback`, { transaction }); } catch { /* already over */ } }
  // Reads several documents inside a transaction; returns data (or null) in the same order
  async getAll(paths, transaction) {
    const res = await this.req("POST", `${this.root}:batchGet`, { documents: paths.map(p => this.name(p)), transaction });
    const byName = {};
    for (const x of res) if (x.found) byName[x.found.name] = { data: fromFields(x.found.fields) };
    return paths.map(p => byName[this.name(p)]?.data ?? null);
  }
  commit(writes, transaction) { return this.req("POST", `${this.root}:commit`, transaction ? { writes, transaction } : { writes }); }
  set(path, data) { return { update: { name: this.name(path), fields: fields(data) } }; }
  // Removes the listed fields from an existing document
  removeFields(path, fieldPaths) { return { update: { name: this.name(path), fields: {} }, updateMask: { fieldPaths }, currentDocument: { exists: true } }; }
}
