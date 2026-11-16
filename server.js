// Glaze Journal server: zero dependencies (Node >= 24 for node:sqlite).
// Journals are end-to-end encrypted: the browser encrypts every record and photo with a key the server never sees
// (public/secure.js), so this server stores and serves ciphertext. Product images from manufacturer sites are public,
// so they're the exception: one unencrypted copy each, in a cache all accounts share (/products/:id). Which glazes
// use which product image is inside the encrypted records.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { importProduct, fetchImage, ImportError } from "./importer.js";
import { SOURCES, sourceById, linesByBrand, completeItem } from "./catalog.js";
import { verifyIdToken, IdTokenError } from "./idtoken.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const PRODUCT_DIR = path.join(DATA_DIR, "products");
const PUBLIC_DIR = path.join(import.meta.dirname, "public");
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const SESSION_DAYS = 30;

// People sign in with an identity from a 6j0.org identity server at ID_ORIGIN. The browser goes to
// ID_ORIGIN/authorize and comes back with a signed token in the URL fragment, which this server verifies.
// ID_APP is this app's name in the identity server's APPS list. ID_JWKS_URL overrides where its public keys are
// fetched from (e.g. an in-cluster Service URL). ORIGIN (e.g. https://glaze.6j0.org) turns on Secure cookies.
// Journals made before sign-in existed are unencrypted and belong to nobody until claimed: by the identity
// ID_OWNER_SUB if it is set, otherwise by the first account that signs in. The owner's browser then encrypts them.
const ID = (() => {
  const origin = process.env.ID_ORIGIN || "";
  if (!origin || new URL(origin).origin !== origin) throw new Error("ID_ORIGIN is required, e.g. ID_ORIGIN=https://id.6j0.org");
  return { origin, app: process.env.ID_APP || "glaze-journal", jwksUrl: process.env.ID_JWKS_URL || `${origin}/.well-known/jwks.json` };
})();
const SECURE_COOKIE = String(process.env.ORIGIN || "").startsWith("https:") ? "; Secure" : "";
const OWNER_SUB = process.env.ID_OWNER_SUB || "";
const UNCLAIMED = 0; // user_id of data from before sign-in existed
const MAX_JSON_BYTES = 1024 * 1024;

// Encrypted photos are stored as application/octet-stream. The image types are for unencrypted photos from before
// encryption, until their owner's browser re-encrypts them.
const ENCRYPTED = "application/octet-stream";
const PHOTO_TYPES = {
  [ENCRYPTED]: ".bin",
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif",
};
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(PRODUCT_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "glaze-journal.db"));
// These CREATE TABLEs are the original schema and never change. Every change since is a numbered migration below,
// tracked in PRAGMA user_version. Append new ones; never edit or reorder old ones.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (coll, id)
  );
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL
  );
`);
const MIGRATIONS = [
  // 1: accounts and encryption. Each 6j0.org identity (sub) gets its own journal; existing rows get user_id 0
  // (unclaimed). guid is a random public ID for the account (never the sub); wrapped_key is the journal key,
  // encrypted in the browser under a key derived from this app's 6j0.org app key.
  `CREATE TABLE users (
     id          INTEGER PRIMARY KEY,
     sub         TEXT NOT NULL UNIQUE,
     guid        TEXT NOT NULL UNIQUE,
     wrapped_key TEXT,
     created     INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created    INTEGER NOT NULL
   );
   CREATE TABLE docs_v1 (
     user_id INTEGER NOT NULL, coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (user_id, coll, id)
   );
   INSERT INTO docs_v1 (user_id, coll, id, data) SELECT 0, coll, id, data FROM docs;
   DROP TABLE docs;
   ALTER TABLE docs_v1 RENAME TO docs;
   ALTER TABLE photos ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;`,
  // 2: shared cache of manufacturer product images, unencrypted. id is the SHA-256 of the image URL, which is kept
  // so a missing file can be downloaded again.
  `CREATE TABLE product_images (
     id      TEXT PRIMARY KEY,
     url     TEXT NOT NULL,
     type    TEXT NOT NULL,
     size    INTEGER NOT NULL,
     fetched INTEGER NOT NULL
   );`,
];
for (let v = db.prepare("PRAGMA user_version").get().user_version; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

const q = {
  all: db.prepare("SELECT id, data FROM docs WHERE user_id = ? AND coll = ?"),
  get: db.prepare("SELECT data FROM docs WHERE user_id = ? AND coll = ? AND id = ?"),
  put: db.prepare("INSERT INTO docs (user_id, coll, id, data) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, coll, id) DO UPDATE SET data = excluded.data"),
  del: db.prepare("DELETE FROM docs WHERE user_id = ? AND coll = ? AND id = ?"),
  allPhotoRefs: db.prepare("SELECT data FROM docs WHERE coll IN ('logs', 'glazes')"),
  photo: db.prepare("SELECT type, user_id FROM photos WHERE id = ?"),
  addPhoto: db.prepare("INSERT INTO photos (id, type, size, created, user_id) VALUES (?, ?, ?, ?, ?)"),
  delPhoto: db.prepare("DELETE FROM photos WHERE id = ?"),
  oldPhotos: db.prepare("SELECT id, type FROM photos WHERE created < ?"),
  product: db.prepare("SELECT url, type FROM product_images WHERE id = ?"),
  putProduct: db.prepare(`INSERT INTO product_images (id, url, type, size, fetched) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET type = excluded.type, size = excluded.size, fetched = excluded.fetched`),
  userBySub: db.prepare("SELECT id FROM users WHERE sub = ?"),
  user: db.prepare("SELECT guid, wrapped_key FROM users WHERE id = ?"),
  addUser: db.prepare("INSERT INTO users (sub, guid, created) VALUES (?, ?, ?)"),
  setKey: db.prepare("UPDATE users SET wrapped_key = ? WHERE id = ? AND wrapped_key IS NULL"),
  firstUser: db.prepare("SELECT MIN(id) id FROM users"),
  claimDocs: db.prepare(`UPDATE docs SET user_id = ? WHERE user_id = ${UNCLAIMED}`),
  claimPhotos: db.prepare(`UPDATE photos SET user_id = ? WHERE user_id = ${UNCLAIMED}`),
  addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created) VALUES (?, ?, ?)"),
  session: db.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND created > ?"),
  delSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  oldSessions: db.prepare("DELETE FROM sessions WHERE created <= ?"),
};

const listDocs = (uid, coll) => q.all.all(uid, coll).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
const getDoc = (uid, coll, id) => { const r = q.get.get(uid, coll, id); return r ? JSON.parse(r.data) : null; };

// ---------- validation ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const str = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isPhotoId = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

const isSealed = (v) => typeof v === "string" && v.length <= MAX_JSON_BYTES && /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(v);
function cleanPhoto(id, uid) {
  if (!isPhotoId(id) || q.photo.get(id)?.user_id !== uid) throw new HttpError(400, "That photo upload wasn't found. Try adding it again.");
  return id;
}
// A stored record: the browser's ciphertext plus the IDs of the photos it uses, so unused photos can be cleaned up.
function cleanRecord(b, uid) {
  if (!isSealed(b.enc)) throw new HttpError(400, "Expected an encrypted record.");
  const photos = [...new Set(Array.isArray(b.photos) ? b.photos : [])];
  if (photos.length > 3) throw new HttpError(400, "Too many photos.");
  return { enc: b.enc, photos: photos.map((id) => cleanPhoto(id, uid)) };
}
// Photo IDs a stored record uses: encrypted records list them; unencrypted ones from before encryption hold them inline.
const photoRefs = (d) => (Array.isArray(d?.photos) ? d.photos : [d?.pre?.id, d?.post?.id, d?.image?.id].filter(Boolean));
// What the browser gets: ciphertext, or an unencrypted record from before encryption for it to encrypt.
const forClient = (id, d) => (typeof d.enc === "string" ? { id, enc: d.enc } : { id, legacy: d });

// ---------- photos ----------
// ---------- shared product image cache ----------
// Each manufacturer image is downloaded once and shared by every account that imports it.
const productId = (url) => crypto.createHash("sha256").update(url).digest("hex");
const productFile = (id, type) => path.join(PRODUCT_DIR, id + PHOTO_TYPES[type]);
const fetchingProducts = new Map(); // id -> promise, so simultaneous imports of one image download it once
function cacheProduct(url) {
  const id = productId(url), row = q.product.get(id);
  if (row && fs.existsSync(productFile(id, row.type))) return Promise.resolve(id);
  if (!fetchingProducts.has(id)) {
    fetchingProducts.set(id, (async () => {
      const { type, buf } = await fetchImage(url);
      if (!PHOTO_TYPES[type] || type === ENCRYPTED || !buf.length) throw new HttpError(415, "The product image is in a format the journal can't store.");
      fs.writeFileSync(productFile(id, type), buf);
      q.putProduct.run(id, url, type, buf.length, Date.now());
      return id;
    })().finally(() => fetchingProducts.delete(id)));
  }
  return fetchingProducts.get(id);
}
// For import responses: { productImage: id } on success, or a note saying why there's no image.
async function remoteImage(imageUrl) {
  if (!imageUrl) return { productImage: null, imageNote: "No product image was found." };
  try { return { productImage: await cacheProduct(imageUrl), imageNote: "" }; }
  catch (e) { return { productImage: null, imageNote: e.message || "Couldn't download the product image." }; }
}
// Photo IDs are random and unique across all journals, so one global set is enough.
function referencedPhotoIds() {
  const ids = new Set();
  for (const { data } of q.allPhotoRefs.all()) for (const id of photoRefs(JSON.parse(data))) ids.add(id);
  return ids;
}
function storePhoto(type, buf, uid) {
  const id = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(PHOTO_DIR, id + PHOTO_TYPES[type]), buf);
  q.addPhoto.run(id, type, buf.length, Date.now(), uid);
  return id;
}
function deletePhoto(id, type) {
  q.delPhoto.run(id);
  fs.rm(path.join(PHOTO_DIR, id + (PHOTO_TYPES[type] || "")), { force: true }, () => {});
}
function dropUnreferenced(candidates) {
  const used = referencedPhotoIds();
  for (const id of candidates) {
    if (!id || used.has(id)) continue;
    const row = q.photo.get(id);
    if (row) deletePhoto(id, row.type);
  }
}
// Uploads that were never attached to a saved entry (e.g. a cancelled save) are removed after a day.
function sweepOrphans() {
  const used = referencedPhotoIds();
  for (const r of q.oldPhotos.all(Date.now() - 24 * 3600 * 1000)) if (!used.has(r.id)) deletePhoto(r.id, r.type);
}
function sweep() {
  sweepOrphans();
  q.oldSessions.run(Date.now() - SESSION_DAYS * 86400 * 1000);
}
sweep();
setInterval(sweep, 6 * 3600 * 1000).unref();

// ---------- accounts & sessions ----------
// The session cookie holds a random token; the database stores only its SHA-256.
const tokenHash = (t) => crypto.createHash("sha256").update(t).digest("hex");
function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function sessionUser(req) {
  const { sid } = parseCookies(req.headers.cookie);
  if (!sid) return null;
  return q.session.get(tokenHash(sid), Date.now() - SESSION_DAYS * 86400 * 1000)?.user_id ?? null;
}
function newSessionCookie(uid) {
  const token = crypto.randomBytes(32).toString("base64url");
  q.addSession.run(tokenHash(token), uid, Date.now());
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE}`;
}
// Find or create the account for a verified identity, and hand it any unclaimed (pre-sign-in) journal.
function accountFor(sub) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const uid = q.userBySub.get(sub)?.id ?? Number(q.addUser.run(sub, crypto.randomUUID(), Date.now()).lastInsertRowid);
    if (OWNER_SUB ? sub === OWNER_SUB : uid === q.firstUser.get().id) { q.claimDocs.run(uid); q.claimPhotos.run(uid); }
    db.exec("COMMIT");
    return uid;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---------- http helpers ----------
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data: https://www.maycocolors.com https://cdn11.bigcommerce.com https://static.wixstatic.com; connect-src 'self'; frame-ancestors 'none'",
};
function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && !Buffer.isBuffer(body) && typeof body !== "string";
  res.writeHead(status, { ...SECURITY_HEADERS, ...(isJson ? { "Content-Type": "application/json" } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "That file is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  try {
    const v = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "Request body must be a JSON object."); }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: "Not found" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "Not found" });
    const type = STATIC_TYPES[path.extname(file)] || "application/octet-stream";
    send(res, 200, buf, { "Content-Type": type, "Cache-Control": rel === "/index.html" ? "no-cache" : "public, max-age=3600" });
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // State changes only from this app's own pages. (The session cookie is SameSite=Lax as well.)
  const site = req.headers["sec-fetch-site"];
  if (!["GET", "HEAD"].includes(req.method) && site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-site requests aren't allowed.");
  }

  if (p === "/healthz") return send(res, 200, { ok: true });

  // ---------- sign-in (no session needed) ----------
  if (p === "/api/config" && req.method === "GET") return send(res, 200, { idOrigin: ID.origin, idApp: ID.app });

  // The browser came back from ID_ORIGIN/authorize with a signed token for the nonce it made.
  if (p === "/api/id/login" && req.method === "POST") {
    const body = await readJson(req);
    let claims;
    try {
      claims = await verifyIdToken(body.token, { issuer: ID.origin, audience: ID.app, nonce: body.nonce, jwksUrl: ID.jwksUrl });
    } catch (e) {
      if (e instanceof IdTokenError) throw new HttpError(401, e.message);
      console.error(e);
      throw new HttpError(502, "Couldn't reach the 6j0.org identity server. Please try again.");
    }
    const uid = accountFor(claims.sub), u = q.user.get(uid);
    return send(res, 200, { guid: u.guid, wrappedKey: u.wrapped_key }, { "Set-Cookie": newSessionCookie(uid), "Cache-Control": "no-store" });
  }

  if (p === "/api/logout" && req.method === "POST") {
    const { sid } = parseCookies(req.headers.cookie);
    if (sid) q.delSession.run(tokenHash(sid));
    return send(res, 200, { ok: true }, { "Set-Cookie": `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE}` });
  }

  // The page and its scripts load without a session; it shows a sign-in screen when the API says 401.
  if (!p.startsWith("/api/") && !p.startsWith("/photos/") && !p.startsWith("/products/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    return serveStatic(res, p);
  }

  // ---------- everything below needs a session and only sees that account's journal ----------
  const uid = sessionUser(req);
  if (uid === null) return send(res, 401, { error: "Please sign in." }, { "Cache-Control": "no-store" });

  // The journal key, wrapped in the browser. Set once, on the account's first sign-in.
  if (p === "/api/key" && req.method === "PUT") {
    const { wrappedKey } = await readJson(req);
    if (!isSealed(wrappedKey) || wrappedKey.length > 200) throw new HttpError(400, "Bad wrapped key.");
    if (!q.setKey.run(wrappedKey, uid).changes) throw new HttpError(409, "This account already has a journal key.");
    return send(res, 200, { ok: true });
  }

  if (p === "/api/state" && req.method === "GET") {
    const u = q.user.get(uid), lists = getDoc(uid, "config", "lists");
    return send(res, 200, {
      guid: u.guid, wrappedKey: u.wrapped_key,
      lists: lists ? forClient("lists", lists) : null,
      glazes: listDocs(uid, "glazes").map(({ id, ...d }) => forClient(id, d)),
      logs: listDocs(uid, "logs").map(({ id, ...d }) => forClient(id, d)),
    }, { "Cache-Control": "no-store" });
  }

  if (p === "/api/lists" && req.method === "PUT") {
    const b = await readJson(req);
    if (!isSealed(b.enc)) throw new HttpError(400, "Expected an encrypted record.");
    const prev = getDoc(uid, "config", "lists");
    q.put.run(uid, "config", "lists", JSON.stringify({ enc: b.enc }));
    if (prev && typeof prev.enc !== "string") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return send(res, 200, { ok: true });
  }

  // Records are created and updated with PUT; the browser picks the ID, since the ID is part of the encryption.
  let m = /^\/api\/(glazes|logs)\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (m) {
    const [, coll, id] = m;
    if (req.method === "PUT") {
      const prev = getDoc(uid, coll, id);
      const doc = cleanRecord(await readJson(req), uid);
      q.put.run(uid, coll, id, JSON.stringify(doc));
      if (prev) dropUnreferenced(photoRefs(prev));
      // Replacing an unencrypted record from before encryption: don't leave its old copy in the write-ahead log.
      // (secure_delete zeroes it in the database file itself.)
      if (prev && typeof prev.enc !== "string") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return send(res, 200, { id });
    }
    if (req.method === "DELETE") {
      const prev = getDoc(uid, coll, id);
      q.del.run(uid, coll, id);
      if (prev) dropUnreferenced(photoRefs(prev));
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  if (p === "/api/photos" && req.method === "POST") {
    const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== ENCRYPTED) throw new HttpError(415, "Photos must be encrypted (application/octet-stream).");
    const buf = await readBody(req, MAX_PHOTO_BYTES);
    if (!buf.length) throw new HttpError(400, "The photo was empty.");
    return send(res, 201, { id: storePhoto(type, buf, uid) });
  }

  // Read a manufacturer's product page and save its image locally.
  if (p === "/api/import" && req.method === "POST") {
    const { url: productUrl } = await readJson(req);
    const { imageUrl, ...found } = await importProduct(productUrl);
    return send(res, 200, { ...found, ...(await remoteImage(imageUrl)) });
  }

  // Manufacturer catalogs: sources -> product lines -> glazes.
  if (p === "/api/catalog" && req.method === "GET") {
    return send(res, 200, SOURCES.map((s) => ({ id: s.id, name: s.name, brands: s.brands })));
  }
  if (p === "/api/catalog/lines-by-brand" && req.method === "GET") {
    return send(res, 200, await linesByBrand());
  }
  m = /^\/api\/catalog\/([a-z]+)\/lines(?:\/([A-Za-z0-9_-]{1,80}))?$/.exec(p);
  if (m && req.method === "GET") {
    const source = sourceById(m[1]);
    if (!source) throw new HttpError(404, "Unknown catalog.");
    return send(res, 200, m[2] ? await source.items(m[2]) : await source.lines());
  }
  if (p === "/api/catalog/item" && req.method === "POST") {
    const { item } = await readJson(req);
    const full = await completeItem(item);
    return send(res, 200, {
      brand: str(full.brand, 200), line: str(full.line, 200), code: str(full.code, 40), name: str(full.name, 200),
      description: str(full.description, 2000), sourceUrl: str(full.url, 2000), ...(await remoteImage(full.image)),
    });
  }

  m = /^\/products\/([0-9a-f]{64})$/.exec(p);
  if (m && req.method === "GET") {
    const row = q.product.get(m[1]);
    if (!row) return send(res, 404, { error: "Not found" });
    let file = productFile(m[1], row.type);
    if (!fs.existsSync(file)) { // the file went missing: download it again from the URL it came from
      try { await cacheProduct(row.url); file = productFile(m[1], q.product.get(m[1]).type); }
      catch { return send(res, 404, { error: "Not found" }); }
    }
    const type = q.product.get(m[1]).type;
    return fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: "Not found" });
      send(res, 200, buf, { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable" });
    });
  }

  m = /^\/photos\/([0-9a-f]{32})$/.exec(p);
  if (m && req.method === "GET") {
    const row = q.photo.get(m[1]);
    if (!row || row.user_id !== uid) return send(res, 404, { error: "Not found" });
    return fs.readFile(path.join(PHOTO_DIR, m[1] + PHOTO_TYPES[row.type]), (err, buf) => {
      if (err) return send(res, 404, { error: "Not found" });
      send(res, 200, buf, { "Content-Type": row.type, "Cache-Control": "private, max-age=31536000, immutable" });
    });
  }

  return send(res, 404, { error: "Not found" });
}

// Requests this slow are close to the gateway's 15 s timeout: log them even when they succeed.
const SLOW_MS = 10_000;
// Log the path only: query strings and bodies may carry tokens or user data.
const reqLabel = (req) => `${req.method} ${(req.url || "").split("?")[0]}`;

http.createServer((req, res) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (ms >= SLOW_MS) console.warn(`slow: ${reqLabel(req)} ${res.statusCode} in ${ms} ms`);
  });
  handle(req, res).catch((err) => {
    if (!err.status) console.error(`${reqLabel(req)} failed:`, err);
    // Manufacturer-site failures (unreachable, timeouts, bad responses) go to the user as messages; log them too.
    else if (err instanceof ImportError) console.warn(`${reqLabel(req)} ${err.status}: ${err.message} (${Date.now() - start} ms)`);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "Something went wrong on the server." });
  });
}).listen(PORT, HOST, () => {
  console.log(`Glaze Journal on http://${HOST}:${PORT}  (data: ${DATA_DIR}, sign-in: ${ID.origin} as "${ID.app}")`);
});
