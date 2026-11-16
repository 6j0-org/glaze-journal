// Glaze Journal client-side encryption. The server only ever stores ciphertext for journals.
//
// Keys
// - Sign-in goes through a 6j0.org identity server (see the handoff below). Besides a signed token, it hands this
//   page Glaze Journal's own 32-byte *app key*, encrypted to a one-time key the page made. Other 6j0.org apps get
//   different app keys, so they can't read journals.
// - HKDF turns the app key into a key-encryption key (KEK) that wraps the account's random 256-bit *journal key*.
//   The server stores only the wrapped copy and never sees the app key or the journal key.
// - The journal key encrypts every record (glazes, firing log entries, lists) and every photo with AES-256-GCM.
//   Records are bound to their collection and ID as additional data, so the server can't swap them around.
// - After sign-in the journal key is kept in IndexedDB as a non-extractable CryptoKey, so a reload doesn't need to
//   sign in again. Signing out deletes it.
//
// Encrypted records are "iv.ciphertext" in base64url (12-byte IV). Encrypted photos are binary:
// iv (12 bytes) || AES-GCM(type length (1 byte) || MIME type || image bytes).

const subtle = crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
const APP_SALT = "glaze-journal";

// ---------- encoding ----------
export const b64u = {
  enc: (buf) => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (str) => {
    const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

// ---------- AES-GCM helpers ----------
async function seal(key, bytesOrString, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof bytesOrString === "string" ? te.encode(bytesOrString) : bytesOrString;
  const params = { name: "AES-GCM", iv, ...(aad ? { additionalData: te.encode(aad) } : {}) };
  return `${b64u.enc(iv)}.${b64u.enc(await subtle.encrypt(params, key, data))}`;
}
async function openBytes(key, sealed, aad) {
  const [iv, ct] = String(sealed).split(".");
  const params = { name: "AES-GCM", iv: b64u.dec(iv), ...(aad ? { additionalData: te.encode(aad) } : {}) };
  return new Uint8Array(await subtle.decrypt(params, key, b64u.dec(ct)));
}
async function hkdfKey(secret, salt, info) {
  const base = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode(salt), info: te.encode(info) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ---------- key storage (IndexedDB holds CryptoKeys without exposing their bytes) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("glaze-journal-keys", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", mode), req = fn(tx.objectStore("keys"));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

let session = null; // { guid, key }

// Load the journal key for this account (guid) from an earlier sign-in on this device.
export async function loadKey(guid) {
  if (session?.guid === guid) return true;
  try {
    const k = await idbDo("readonly", (s) => s.get("session"));
    session = k && k.guid === guid ? k : null;
  } catch { session = null; }
  return Boolean(session);
}
export async function clearKey() {
  session = null;
  try { await idbDo("readwrite", (s) => s.delete("session")); } catch {}
}
async function installKey(guid, key) {
  session = { guid, key };
  try { await idbDo("readwrite", (s) => s.put(session, "session")); } catch {}
}
function needKey() {
  if (!session) throw new Error("Your journal is locked on this device. Please sign in again.");
  return session.key;
}

// ---------- records and photos ----------
const recordAad = (coll, id) => `${APP_SALT}/v1/${coll}/${id}`;
export const encryptRecord = (coll, id, obj) => seal(needKey(), JSON.stringify(obj), recordAad(coll, id));
export const decryptRecord = async (coll, id, sealed) => JSON.parse(td.decode(await openBytes(needKey(), sealed, recordAad(coll, id))));

export async function encryptPhoto(blob) {
  const type = te.encode((blob.type || "image/jpeg").slice(0, 100));
  const body = new Uint8Array(1 + type.length + blob.size);
  body[0] = type.length; body.set(type, 1); body.set(new Uint8Array(await blob.arrayBuffer()), 1 + type.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, needKey(), body));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
export async function decryptPhoto(buf) {
  const bytes = new Uint8Array(buf);
  const body = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, needKey(), bytes.subarray(12)));
  const n = body[0];
  return new Blob([body.subarray(1 + n)], { type: td.decode(body.subarray(1, 1 + n)) });
}

// ---------- 6j0.org identity handoff ----------
// 1. startIdSignIn: make an ephemeral ECDH P-256 key pair and a random nonce, keep them in IndexedDB, and go to
//    <idOrigin>/authorize?app=<idApp>&nonce=<nonce>&epk=<x>.<y>.
// 2. The identity server signs the person in, derives this app's key, encrypts it to our public key, and sends the
//    browser back here with #id_token=<signed token>&epk=<its public key>&key=<iv.ciphertext>&state=<nonce>.
//    The fragment never reaches any server.
// 3. finishIdSignIn: check the nonce, decrypt the app key, have the server verify the token (which starts a
//    session), then unwrap the journal key, or make one on the account's first sign-in.
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const kekFromAppKey = (appKey) => hkdfKey(appKey, APP_SALT, "journal-kek-6j0-v1");

export const hasIdCallback = () => new URLSearchParams(location.hash.slice(1)).has("id_token");

export async function startIdSignIn({ idOrigin, idApp }) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const { x, y } = await subtle.exportKey("jwk", pair.publicKey);
  const nonce = b64u.enc(crypto.getRandomValues(new Uint8Array(24)));
  await idbDo("readwrite", (s) => s.put({ nonce, privateKey: pair.privateKey, app: idApp, created: Date.now() }, "pending"));
  location.assign(`${idOrigin}/authorize?${new URLSearchParams({ app: idApp, nonce, epk: `${x}.${y}` })}`);
}

// api(method, url, body) is the app's JSON helper; it throws errors with .status set.
export async function finishIdSignIn(api) {
  const frag = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search); // drop the token and key from the address bar
  let pending = null;
  try { pending = await idbDo("readonly", (s) => s.get("pending")); await idbDo("readwrite", (s) => s.delete("pending")); } catch {}
  if (!pending || pending.nonce !== frag.get("state") || Date.now() - pending.created > PENDING_MAX_AGE_MS)
    throw new Error("That sign-in link expired or was started somewhere else. Please sign in again.");

  const [x, y] = String(frag.get("epk") || "").split(".");
  const peer = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, pending.privateKey, 256);
  const appKey = await openBytes(await hkdfKey(new Uint8Array(shared), pending.nonce, `6j0/v1/handoff/${pending.app}`), frag.get("key"));
  const kek = await kekFromAppKey(appKey);
  appKey.fill(0);

  const res = await api("POST", "/api/id/login", { token: frag.get("id_token"), nonce: pending.nonce });
  let wrapped = res.wrappedKey;
  if (!wrapped) {
    // First sign-in: make the journal key. If another device got there first (409), use its key instead.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    try {
      await api("PUT", "/api/key", { wrappedKey: await seal(kek, raw) });
      wrapped = null;
      await installKey(res.guid, await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    } catch (e) {
      if (e.status !== 409) throw e;
      wrapped = (await api("GET", "/api/state")).wrappedKey;
    } finally { raw.fill(0); }
  }
  if (wrapped) {
    let raw;
    try { raw = await openBytes(kek, wrapped); } catch { throw new Error("Couldn't unlock your journal with this identity."); }
    await installKey(res.guid, await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    raw.fill(0);
  }
}
