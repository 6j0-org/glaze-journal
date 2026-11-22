// feedback.js on its own: posting and its limits, who sees and deletes what, threads (replies and closing), and the JSON Lines file (kept across
// restarts, compacted so deleted text leaves the disk, and a line cut short by a crash).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFeedback, FeedbackError } from "../../feedback.js";

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP || "/tmp", "feedback-"));
const file = path.join(dir, "sub", "feedback.jsonl");
let clock = 1_800_000_000_000;
const now = () => clock;
const open = (opts = {}) => createFeedback({ file, now, perUserPerDay: 3, perDay: 7, ...opts });
const ann = { user: "ann" }, bob = { user: "bob" }, admin = { user: "dev", admin: true };
const fails = (fn, status, re) => assert.throws(fn, (e) => e instanceof FeedbackError && e.status === status && (!re || re.test(e.message)));

let fb = open();
assert.deepEqual(fb.list(ann), { items: [], maxLength: 2048, isAdmin: false });

// Posting: cleaned up, limited in length, and never showing who wrote it.
const a1 = fb.post(ann, "  The viewer is great.\r\nCould it zoom?\u0007  ");
assert.equal(a1.body, "The viewer is great.\nCould it zoom?", "trimmed, CRLF to LF, control characters dropped");
assert.deepEqual(Object.keys(a1).sort(), ["admin", "body", "canDelete", "created", "id", "mine", "replies", "status", "updated"]);
assert.deepEqual([a1.status, a1.replies], ["open", 0]);
fails(() => fb.post(ann, "   "), 400, /Write something/);
fails(() => fb.post(ann, 42), 400);
fails(() => fb.post(ann, "x".repeat(2049)), 400, /up to 2048/);
fails(() => fb.post({ user: "" }, "hi"), 401);
fails(() => fb.list(null), 401);
clock += 1000;
const b1 = fb.post(bob, "x".repeat(2048));
assert.equal(b1.body.length, 2048, "exactly the limit is fine");

// Everyone sees every post, newest first, and only their own are marked as theirs.
let seen = fb.list(ann).items;
assert.deepEqual(seen.map((i) => i.id), [b1.id, a1.id]);
assert.deepEqual(seen.map((i) => [i.mine, i.canDelete]), [[false, false], [true, true]]);
assert.ok(!JSON.stringify(fb.list(ann)).includes("bob"), "authors' IDs are never returned");

// Deleting: your own, or anything as an admin.
fails(() => fb.remove(ann, b1.id), 403);
fails(() => fb.remove(ann, "nope"), 404);
fb.remove(ann, a1.id);
assert.deepEqual(fb.list(bob).items.map((i) => i.id), [b1.id]);
const d1 = fb.post(admin, "Thanks, zoom is coming.");
assert.equal(d1.admin, true, "an admin's posts are labeled");
assert.equal(fb.list(bob).items[0].admin, true);
assert.equal(fb.list(admin).items.find((i) => i.id === b1.id).canDelete, true);
assert.equal(fb.list(admin).isAdmin, true);

// Limits: 3 per account a day, deleted posts included; 7 from everyone a day (admins count, but aren't limited);
// a day later it resets.
fb.post(ann, "two"); fb.post(ann, "three");
fails(() => fb.post(ann, "four"), 429, /3 times a day/);
fb.post(bob, "b2"); fb.post({ user: "cat" }, "c1");
fails(() => fb.post({ user: "dan" }, "d1"), 429, /lot of feedback/);
fb.post(admin, "admins aren't limited");
clock += 24 * 3600 * 1000;
fb.post(ann, "a new day");

// Threads: everyone who can see one replies (replies count toward the limits); only admins close or reopen.
clock += 1000;
const t1 = fb.post({ user: "eve" }, "Dark mode, please.");
fails(() => fb.reply({ user: "eve" }, "nope", "hi"), 404);
let th = fb.reply(admin, t1.id, "Which screens?");
assert.deepEqual([th.canReply, th.canClose, th.messages.length, th.messages[0].admin, th.messages[0].mine], [true, true, 1, true, true]);
clock += 1000;
th = fb.reply({ user: "eve" }, t1.id, "  All of them.  ");
assert.deepEqual(th.messages.map((m) => [m.body, m.admin, m.mine, m.op]), [["Which screens?", true, false, false], ["All of them.", false, true, true]]);
assert.deepEqual([th.canReply, th.canClose, th.replies], [true, false, 2]);
assert.ok(!JSON.stringify(th).includes('"eve"') && !JSON.stringify(th).includes('"dev"'), "no user IDs in a thread");
assert.equal(th.author, undefined, "anonymous without authorKey");
clock += 1000;
th = fb.reply({ user: "fay" }, t1.id, "+1, and the map too.");
assert.deepEqual([th.messages[2].op, th.messages[2].mine, th.canClose], [false, true, false], "anyone can reply");
assert.equal(fb.thread(bob, t1.id).messages.length, 3, "and everyone can read it");
assert.equal(fb.list(bob).items[0].id, t1.id, "the most recently active thread comes first");
fails(() => fb.setStatus({ user: "eve" }, t1.id, "done"), 403, /Only the developers/);
fails(() => fb.setStatus(admin, t1.id, "maybe"), 400);
assert.equal(fb.doneCount("eve"), 0);
assert.equal(fb.setStatus(admin, t1.id, "done").status, "done");
assert.equal(fb.doneCount("eve"), 1);
fb.setStatus(admin, t1.id, "wontdo"); assert.equal(fb.doneCount("eve"), 0);
fb.setStatus(admin, t1.id, "open"); fb.setStatus(admin, t1.id, "done");
assert.equal(fb.authorOf(t1.id), "eve");
assert.equal(fb.authorOf("nope"), null);
fb.reply({ user: "eve" }, t1.id, "Thanks!");
fails(() => fb.reply({ user: "eve" }, t1.id, "x".repeat(2049)), 400);
// eve's post and two replies count toward her limit of 3.
fails(() => fb.post({ user: "eve" }, "more"), 429);
fails(() => fb.reply({ user: "eve" }, t1.id, "more"), 429);
const thread1 = fb.thread(admin, t1.id);

// The file: one JSON object per line, posts and deletions.
const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.ok(lines.some((l) => l.delete === a1.id), "a deletion is appended");
assert.ok(lines.some((l) => l.id === a1.id), "and the post is still in the file until the next start");
const before = fb.list(admin).items;

// Restart: the same posts, and the deleted one's text is gone from the disk.
fb = open();
assert.deepEqual(fb.list(admin).items, before, "everything is still there after a restart");
assert.deepEqual(fb.thread(admin, t1.id), thread1, "replies and status too");
assert.equal(fb.doneCount("eve"), 1);
const text = fs.readFileSync(file, "utf8");
assert.ok(!text.includes("Could it zoom"), "deleted text is compacted away");
assert.ok(!text.includes('"delete"'));

// A line cut short by a crash: skipped, the original kept, and the next post starts on its own line.
fs.appendFileSync(file, '{"id":"half","user":"ann","crea');
fb = open();
assert.deepEqual(fb.list(admin).items, before);
assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".unreadable-")).length, 1, "the original is kept");
fb.post(bob, "after the crash");
assert.equal(open().list(admin).items[0].body, "after the crash");

// Deleting a thread deletes its replies, from the disk too at the next start.
fb.remove(admin, t1.id);
fails(() => fb.thread(admin, t1.id), 404);
assert.equal(fb.doneCount("eve"), 0);
fb = open();
assert.ok(!fs.readFileSync(file, "utf8").includes("All of them."), "a deleted thread's replies are compacted away");

// The daily limit counts posts from before a restart ("a new day" above).
fb = open();
fb.post(ann, "two today"); fb.post(ann, "three today");
fails(() => fb.post(ann, "four today"), 429);

// authorKey: each post and reply says what the app chose to show of its author.
fb = open({ file: path.join(dir, "authors.jsonl"), authorKey: (u) => (u === "ann" ? "icon-ann" : null) });
const k1 = fb.post(ann, "hello");
assert.equal(k1.author, "icon-ann");
const k2 = fb.reply(bob, k1.id, "hi");
assert.deepEqual([k2.author, k2.messages[0].author], ["icon-ann", null]);
assert.equal(fb.list(bob).items[0].author, "icon-ann");

// "own": people see only their own posts (the demo); admins see all.
fb = open({ scope: "own", file: path.join(dir, "own.jsonl") });
const o1 = fb.post(ann, "mine"); fb.post(bob, "his");
assert.deepEqual(fb.list(ann).items.map((i) => i.body), ["mine"]);
fails(() => fb.remove(bob, o1.id), 404, /wasn't found/);
fails(() => fb.reply(bob, o1.id, "hi"), 404, /wasn't found/);
assert.equal(fb.list(admin).items.length, 2);

fs.rmSync(dir, { recursive: true, force: true });
console.log("feedback: ok");
