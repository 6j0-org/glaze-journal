// Glaze Journal server: zero dependencies (Node >= 24 for node:sqlite).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { importProduct, fetchImage } from "./importer.js";
import { SOURCES, sourceById, linesByBrand, completeItem } from "./catalog.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const PUBLIC_DIR = path.join(import.meta.dirname, "public");
const PASSWORD = process.env.APP_PASSWORD || "";
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

const DEFAULT_LISTS = {
  brands: ["Mayco", "Amaco", "Freeform", "Velvet Underglaze"],
  types: ["Stable", "Float", "Fluid"],
  clays: ["Laguna Speckled Buff", "Laguna Dover White"],
};
const PHOTO_TYPES = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif",
};
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
// Files the browser fetches without credentials (install prompts, icons).
const PUBLIC_UNAUTHED = new Set(["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"]);

fs.mkdirSync(PHOTO_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "glaze-journal.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (coll, id)
  );
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL
  );
`);

const q = {
  all: db.prepare("SELECT id, data FROM docs WHERE coll = ?"),
  get: db.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?"),
  put: db.prepare("INSERT INTO docs (coll, id, data) VALUES (?, ?, ?) ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data"),
  del: db.prepare("DELETE FROM docs WHERE coll = ? AND id = ?"),
  photo: db.prepare("SELECT type FROM photos WHERE id = ?"),
  addPhoto: db.prepare("INSERT INTO photos (id, type, size, created) VALUES (?, ?, ?, ?)"),
  delPhoto: db.prepare("DELETE FROM photos WHERE id = ?"),
  oldPhotos: db.prepare("SELECT id, type FROM photos WHERE created < ?"),
};

const listDocs = (coll) => q.all.all(coll).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
const getDoc = (coll, id) => { const r = q.get.get(coll, id); return r ? JSON.parse(r.data) : null; };

// ---------- validation ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const str = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 200)).filter(Boolean))] : []);
const isColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const isPhotoId = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

function cleanLists(b) {
  return { brands: strList(b.brands), types: strList(b.types), clays: strList(b.clays) };
}
function cleanGlaze(b, prev) {
  const sourceUrl = /^https?:\/\//i.test(str(b.sourceUrl)) ? str(b.sourceUrl) : "";
  const g = {
    brand: str(b.brand, 200), line: str(b.line, 200), name: str(b.name, 200), code: str(b.code, 40), type: str(b.type, 200),
    color: isColor(b.color) ? b.color : "#888888",
    description: str(b.description, 2000), sourceUrl, image: cleanPhoto(b.image),
  };
  if (!g.brand || !g.name) throw new HttpError(400, "A glaze needs a brand and a name.");
  g.createdAt = prev?.createdAt || Date.now();
  return g;
}
function cleanPhoto(p) {
  if (!p) return null;
  if (!isPhotoId(p.id) || !q.photo.get(p.id)) throw new HttpError(400, "That photo upload wasn't found. Try adding it again.");
  return { id: p.id };
}
function cleanLog(b, prev) {
  const glazes = (Array.isArray(b.glazes) ? b.glazes : []).slice(0, 50).map((x) => ({
    glazeId: str(x?.glazeId, 100), application: str(x?.application),
    name: str(x?.name, 200), brand: str(x?.brand, 200), type: str(x?.type, 200),
    color: isColor(x?.color) ? x.color : "",
  })).filter((x) => x.glazeId);
  return {
    kind: b.kind === "piece" ? "piece" : "tile",
    title: str(b.title, 300),
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : new Date().toISOString().slice(0, 10),
    clay: str(b.clay, 200),
    firing: str(b.firing, 300),
    glazes,
    notes: str(b.notes, 20000),
    pre: cleanPhoto(b.pre),
    post: cleanPhoto(b.post),
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------- photos ----------
async function saveRemoteImage(imageUrl) {
  if (!imageUrl) return { image: null, imageNote: "No product image was found." };
  try {
    const { type, buf } = await fetchImage(imageUrl);
    if (PHOTO_TYPES[type] && buf.length) return { image: { id: storePhoto(type, buf) }, imageNote: "" };
    return { image: null, imageNote: "The product image is in a format the journal can't store." };
  } catch (e) { return { image: null, imageNote: e.message || "Couldn't download the product image." }; }
}
function referencedPhotoIds() {
  const ids = new Set();
  for (const l of listDocs("logs")) { if (l.pre?.id) ids.add(l.pre.id); if (l.post?.id) ids.add(l.post.id); }
  for (const g of listDocs("glazes")) if (g.image?.id) ids.add(g.image.id);
  return ids;
}
function storePhoto(type, buf) {
  const id = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(PHOTO_DIR, id + PHOTO_TYPES[type]), buf);
  q.addPhoto.run(id, type, buf.length, Date.now());
  return id;
}
const photoIdsOf = (coll, doc) => (coll === "logs" ? [doc?.pre?.id, doc?.post?.id] : [doc?.image?.id]);
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
sweepOrphans();
setInterval(sweepOrphans, 6 * 3600 * 1000).unref();

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
const sha = (s) => crypto.createHash("sha256").update(s).digest();
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const pass = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
  return crypto.timingSafeEqual(sha(pass), sha(PASSWORD));
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

  if (!PUBLIC_UNAUTHED.has(p) && !authorized(req)) {
    return send(res, 401, { error: "Password required" }, { "WWW-Authenticate": 'Basic realm="Glaze Journal", charset="UTF-8"' });
  }

  if (p === "/healthz") return send(res, 200, { ok: true });

  if (p === "/api/state" && req.method === "GET") {
    return send(res, 200, { lists: getDoc("config", "lists") || DEFAULT_LISTS, glazes: listDocs("glazes"), logs: listDocs("logs") }, { "Cache-Control": "no-store" });
  }

  if (p === "/api/lists" && req.method === "PUT") {
    const lists = cleanLists(await readJson(req));
    q.put.run("config", "lists", JSON.stringify(lists));
    return send(res, 200, lists);
  }

  let m = /^\/api\/(glazes|logs)(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(p);
  if (m) {
    const [, coll, id] = m;
    const clean = coll === "glazes" ? cleanGlaze : cleanLog;
    if (!id && req.method === "POST") {
      const newId = crypto.randomUUID();
      const doc = clean(await readJson(req), null);
      q.put.run(coll, newId, JSON.stringify(doc));
      return send(res, 201, { id: newId, ...doc });
    }
    if (id && req.method === "PUT") {
      const prev = getDoc(coll, id);
      if (!prev) throw new HttpError(404, "That record no longer exists.");
      const doc = clean(await readJson(req), prev);
      q.put.run(coll, id, JSON.stringify(doc));
      dropUnreferenced(photoIdsOf(coll, prev));
      return send(res, 200, { id, ...doc });
    }
    if (id && req.method === "DELETE") {
      const prev = getDoc(coll, id);
      q.del.run(coll, id);
      if (prev) dropUnreferenced(photoIdsOf(coll, prev));
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  if (p === "/api/photos" && req.method === "POST") {
    const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!PHOTO_TYPES[type]) throw new HttpError(415, "Photos must be JPEG, PNG, WebP, GIF, HEIC or AVIF.");
    const buf = await readBody(req, MAX_PHOTO_BYTES);
    if (!buf.length) throw new HttpError(400, "The photo was empty.");
    return send(res, 201, { id: storePhoto(type, buf) });
  }

  // Read a manufacturer's product page and save its image locally.
  if (p === "/api/import" && req.method === "POST") {
    const { url: productUrl } = await readJson(req);
    const found = await importProduct(productUrl);
    const { image, imageNote } = await saveRemoteImage(found.imageUrl);
    return send(res, 200, { ...found, image, imageNote });
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
    const { image, imageNote } = await saveRemoteImage(full.image);
    return send(res, 200, {
      brand: str(full.brand, 200), line: str(full.line, 200), code: str(full.code, 40), name: str(full.name, 200),
      description: str(full.description, 2000), sourceUrl: str(full.url, 2000), image, imageNote,
    });
  }

  m = /^\/photos\/([0-9a-f]{32})$/.exec(p);
  if (m && req.method === "GET") {
    const row = q.photo.get(m[1]);
    if (!row) return send(res, 404, { error: "Not found" });
    return fs.readFile(path.join(PHOTO_DIR, m[1] + PHOTO_TYPES[row.type]), (err, buf) => {
      if (err) return send(res, 404, { error: "Not found" });
      send(res, 200, buf, { "Content-Type": row.type, "Cache-Control": "private, max-age=31536000, immutable" });
    });
  }

  if (p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
  return serveStatic(res, p);
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "Something went wrong on the server." });
  });
}).listen(PORT, HOST, () => {
  console.log(`Glaze Journal on http://${HOST}:${PORT}  (data: ${DATA_DIR}${PASSWORD ? ", password on" : ", no password"})`);
});
