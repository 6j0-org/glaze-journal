// Signing in with a 6j0 ID, against a stand-in ID server that only serves its JWKS: temporary (unsaved) IDs show up
// in /api/state until a sign-in says they're saved, and a signed deletion notice at /api/id/deleted erases the
// account with its journal, photos, sessions, and feedback. Sign-in tokens and deletion notices can't stand in for
// each other. Runs its own Glaze Journal server with sign-in (the shared test server is a demo), with its data in
// the test's scratch directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { TMP, wait } from "../lib.mjs";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// The stand-in ID server: an Ed25519 key, and its JWKS.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }), kid = "test-key";
const idServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: "EdDSA", use: "sig" }] }));
});
const ID_ORIGIN = `http://127.0.0.1:${await listen(idServer)}`;
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "EdDSA", typ: "JWT", kid });
  const body = enc({ iss: ID_ORIGIN, aud: "glaze-journal", iat: now, exp: now + 120, jti: randomBytes(16).toString("base64url"), ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}
const DELETED = { "6j0/v1/identity-deleted": {} };
const nonce = () => randomBytes(16).toString("base64url");

// Glaze Journal with sign-in, on a free port.
const port = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
let log = "";
const app = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, DEMO: "", ID_ORIGIN, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: mkdtempSync(join(TMP, "id-")) },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.on("data", (d) => (log += d)); app.stderr.on("data", (d) => (log += d));
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
    await wait(100);
  }

  const call = async (method, path, body, cookie = "") => {
    const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: r.status === 204 ? null : await r.json().catch(() => ({})), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
  };
  const signIn = async (claims) => { const n = nonce(); return call("POST", "/api/id/login", { token: token({ nonce: n, ...claims }), nonce: n }); };

  assert.deepEqual((await call("GET", "/api/config")).data, { idOrigin: ID_ORIGIN, idApp: "glaze-journal" });

  // A saved 6j0 ID (no saved claim counts as saved): nothing to warn about.
  const a = await signIn({ sub: "sub-a" });
  assert.equal(a.status, 200, a.data.error);
  let st = (await call("GET", "/api/state", undefined, a.cookie)).data;
  assert.equal(st.idUnsaved, undefined, "a token without saved counts as saved");

  // A temporary one: /api/state says so until a sign-in says it's saved, and older sessions see the change too.
  const u = await signIn({ sub: "sub-temp", saved: false });
  st = (await call("GET", "/api/state", undefined, u.cookie)).data;
  assert.deepEqual([st.idUnsaved, st.idRecheck], [true, false], "unsaved, and just checked");
  const u2 = await signIn({ sub: "sub-temp", saved: false });
  assert.equal((await call("GET", "/api/state", undefined, u2.cookie)).data.idUnsaved, true, "still unsaved");
  await signIn({ sub: "sub-temp", saved: true });
  assert.equal((await call("GET", "/api/state", undefined, u.cookie)).data.idUnsaved, undefined, "saved now, in every session");

  // Give account a a journal, a photo, and feedback, to see them go.
  const ENC = "AAAAAAAAAAAAAAAA.AAAA";
  await call("PUT", "/api/key", { wrappedKey: ENC }, a.cookie);
  const photo = await fetch(BASE + "/api/photos", { method: "POST", headers: { "Content-Type": "application/octet-stream", Cookie: a.cookie }, body: new Uint8Array([1, 2, 3]) });
  const { id: photoId } = await photo.json();
  assert.equal((await call("PUT", "/api/logs/e1", { enc: ENC, photos: [photoId] }, a.cookie)).status, 200);
  assert.equal((await call("POST", "/api/feedback", { body: "Lovely" }, a.cookie)).status, 201);
  assert.equal((await call("GET", "/api/feedback", undefined, u.cookie)).data.items.length, 1, "others see it");

  // Sign-in tokens aren't deletion notices, deletion notices aren't sign-in tokens, and the audience must match.
  const n = nonce();
  assert.equal((await call("POST", "/api/id/deleted", { token: token({ sub: "sub-a", nonce: n }) })).status, 401, "a sign-in token is no notice");
  assert.equal((await call("POST", "/api/id/deleted", { token: token({ sub: "sub-a", nonce: n, events: DELETED }) })).status, 401, "a notice has no nonce");
  assert.equal((await signIn({ sub: "sub-a", events: DELETED })).status, 401, "a notice is no sign-in token");
  assert.equal((await call("POST", "/api/id/deleted", { token: token({ sub: "sub-a", aud: "other-app", events: DELETED }) })).status, 401, "for another app");
  assert.equal((await call("GET", "/api/state", undefined, a.cookie)).status, 200, "still there");

  // The real notice erases everything; replaying it is refused, and a notice for an unknown ID is fine.
  const notice = token({ sub: "sub-a", events: DELETED });
  assert.deepEqual((await call("POST", "/api/id/deleted", { token: notice })).data, { ok: true });
  assert.equal((await call("GET", "/api/state", undefined, a.cookie)).status, 401, "the session is gone");
  assert.deepEqual((await call("GET", "/api/feedback", undefined, u.cookie)).data.items, [], "and the feedback");
  assert.equal((await call("POST", "/api/id/deleted", { token: notice })).status, 401, "a notice is used once");
  assert.equal((await call("POST", "/api/id/deleted", { token: token({ sub: "nobody", events: DELETED }) })).status, 200, "unknown IDs are fine");
  const again = await signIn({ sub: "sub-a" });
  st = (await call("GET", "/api/state", undefined, again.cookie)).data;
  assert.deepEqual([st.wrappedKey, st.logs], [null, []], "signing in again starts a new, empty journal");
  console.log("server id: ok");
} catch (e) {
  console.log(log);
  throw e;
} finally {
  app.kill(); idServer.close();
}
