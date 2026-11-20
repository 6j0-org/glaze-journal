// The API against a demo-mode server: demo accounts, the journal key, photo uploads, the per-entry photo limit, and
// that one account can't see another's records or photos. The records here are stand-in ciphertext: the server
// never decrypts anything, it only checks the shape.
import assert from "node:assert/strict";
import { BASE, demoAccount } from "../lib.mjs";

const ENC = "AAAAAAAAAAAAAAAA.AAAA"; // the shape of an encrypted record: base64url IV "." ciphertext

const config = await (await fetch(BASE + "/api/config")).json();
assert.deepEqual(config, { demo: true }, "/api/config says it's a demo");
assert.equal((await fetch(BASE + "/api/state")).status, 401, "no session, no journal");
assert.equal((await fetch(BASE + "/api/id/login", { method: "POST", body: "{}" })).status, 401, "no 6j0.org sign-in in a demo");

const a = await demoAccount(), b = await demoAccount();
assert.notEqual(a.guid, b.guid);
let state = await a.api("GET", "/api/state");
assert.equal(state.guid, a.guid);
assert.equal(state.wrappedKey, null, "a new demo account has no journal key yet");
await a.api("PUT", "/api/key", { wrappedKey: ENC });
await assert.rejects(a.api("PUT", "/api/key", { wrappedKey: ENC }), { status: 409 }, "the key is set once");

const upload = async (acct) => (await acct.api("POST", "/api/photos", new Uint8Array([1, 2, 3, 4]), { type: "application/octet-stream" })).id;
await assert.rejects(a.api("POST", "/api/photos", new Uint8Array([1]), { type: "image/jpeg" }), { status: 415 }, "photos must be encrypted");

// Many photos on one entry: up to 60.
const ids = [];
for (let i = 0; i < 61; i++) ids.push(await upload(a));
await a.api("PUT", "/api/logs/entry1", { enc: ENC, photos: ids.slice(0, 60) });
await assert.rejects(a.api("PUT", "/api/logs/entry2", { enc: ENC, photos: ids }), { status: 400 }, "61 photos is too many");
state = await a.api("GET", "/api/state");
assert.deepEqual(state.logs, [{ id: "entry1", enc: ENC }]);

// Photos are private to their account.
assert.equal((await a.api("GET", "/photos/" + ids[0], undefined, { raw: true })).status, 200);
assert.equal((await b.api("GET", "/photos/" + ids[0], undefined, { raw: true })).status, 404, "another account can't load the photo");
await assert.rejects(b.api("PUT", "/api/logs/x", { enc: ENC, photos: [ids[0]] }), { status: 400 }, "or attach it to its own entry");
assert.deepEqual((await b.api("GET", "/api/state")).logs, [], "or see the entry");

// Dropping photos from an entry deletes them; the unused 61st photo stays until the daily sweep.
await a.api("PUT", "/api/logs/entry1", { enc: ENC, photos: ids.slice(0, 2) });
assert.equal((await a.api("GET", "/photos/" + ids[2], undefined, { raw: true })).status, 404, "a photo no entry uses is deleted");
assert.equal((await a.api("GET", "/photos/" + ids[1], undefined, { raw: true })).status, 200);
await a.api("DELETE", "/api/logs/entry1");
assert.equal((await a.api("GET", "/photos/" + ids[0], undefined, { raw: true })).status, 404, "deleting the entry deletes its photos");

// Feedback: in the demo, each visitor sees only their own; the 2048-character limit; deleting your own.
assert.equal((await fetch(BASE + "/api/feedback")).status, 401, "feedback needs a session");
const f1 = await a.api("POST", "/api/feedback", { body: "Photo viewer please" });
assert.equal(f1.mine, true);
assert.equal(f1.user, undefined, "the author's ID isn't returned");
let fl = await a.api("GET", "/api/feedback");
assert.deepEqual([fl.items.map((i) => i.body), fl.maxLength, fl.isAdmin, fl.demo], [["Photo viewer please"], 2048, false, true]);
assert.deepEqual((await b.api("GET", "/api/feedback")).items, [], "another demo visitor doesn't see it");
await assert.rejects(b.api("DELETE", "/api/feedback/" + f1.id), { status: 404 }, "or delete it");
await assert.rejects(a.api("POST", "/api/feedback", { body: "x".repeat(2049) }), { status: 400 });
await assert.rejects(a.api("POST", "/api/feedback", { body: "" }), { status: 400 });
await a.api("DELETE", "/api/feedback/" + f1.id);
assert.deepEqual((await a.api("GET", "/api/feedback")).items, []);

console.log("server api: ok");
