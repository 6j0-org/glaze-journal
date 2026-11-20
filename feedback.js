// Feedback: a page where signed-in people read everyone's feedback and post their own. Self-contained and
// app-agnostic (no dependencies, no knowledge of the app's accounts, routing, or database), so the same file can be
// copied into other apps. Pair it with public/feedback.js, which draws the page.
//
// Storage is one JSON Lines file: one JSON object per line, appended to and never edited in place, so a crash can't
// damage earlier entries and the file reads fine with tail, grep, or jq.
//   {"id":"…","user":"…","created":1763600000000,"body":"…"}          a post ("admin":true if an admin wrote it)
//   {"delete":"…","by":"…","at":1763600500000}                           a deletion
// The whole file is read at startup and kept in memory. At startup the file is also compacted (rewritten without
// deleted posts, then renamed into place) when anything was deleted, so deleted text doesn't stay on disk past the
// next restart. Only one process may write to the file.
//
// Who's asking is passed to each call as { user, admin }: user is any stable, opaque ID for the account (never shown
// to anyone), and admin says whether this account may delete anyone's posts (and gets its posts labeled).
//
// Usage:
//   const feedback = createFeedback({ file: "data/feedback.jsonl" });
//   feedback.list(who)        → { items: [{ id, body, created, admin, mine, canDelete }], maxLength, isAdmin }
//   feedback.post(who, body)  → the new item
//   feedback.remove(who, id)
// Bad input and limits throw FeedbackError with an HTTP status and a message fit to show people.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class FeedbackError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DAY = 24 * 3600 * 1000;

export function createFeedback({
  file,
  maxLength = 2048,     // characters per post (UTF-16 code units, as the browser's maxlength counts them)
  perUserPerDay = 5,    // posts per account in any 24 hours, deleted ones included
  perDay = 500,         // posts from everyone together in any 24 hours, so many accounts can't fill the disk
  listLimit = 200,      // newest posts returned by list()
  scope = "all",        // "all": everyone sees every post; "own": people see only their own (admins see all)
  now = Date.now,
} = {}) {
  if (!file) throw new Error("createFeedback: file is required");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const posts = new Map(); // id → post, in the order posted
  const recent = [];       // { user, created } of posts in the last day, deleted ones included, for the limits

  // Load, and compact if anything was deleted.
  let deletions = 0, skipped = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { skipped++; continue; } // e.g. a line cut short by a crash
      if (typeof r.delete === "string") { posts.delete(r.delete); deletions++; }
      else if (typeof r.id === "string" && typeof r.body === "string") {
        posts.set(r.id, r);
        if (now() - r.created < DAY) recent.push({ user: r.user, created: r.created });
      } else skipped++;
    }
    // Unreadable lines are left out of the compacted file (which also ends a line cut short, so the next append
    // starts on a line of its own), with the original kept next to it.
    if (skipped) {
      const keep = `${file}.unreadable-${now()}`;
      fs.copyFileSync(file, keep);
      console.warn(`feedback: skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"} in ${file}; the original is in ${keep}`);
    }
    if (deletions || skipped) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, [...posts.values()].map((p) => JSON.stringify(p) + "\n").join(""), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  }
  const append = (record) => fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });

  const visible = (p, who) => who.admin || scope === "all" || p.user === who.user;
  const view = (p, who) => ({
    id: p.id, body: p.body, created: p.created, admin: Boolean(p.admin),
    mine: p.user === who.user, canDelete: who.admin || p.user === who.user,
  });
  function check(who) {
    if (!who || typeof who.user !== "string" || !who.user) throw new FeedbackError(401, "Please sign in.");
  }
  function clean(body) {
    if (typeof body !== "string") throw new FeedbackError(400, "Feedback must be text.");
    // Keep line breaks and tabs; drop other control characters.
    const text = body.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (!text) throw new FeedbackError(400, "Write something first.");
    if (text.length > maxLength) throw new FeedbackError(400, `Feedback can be up to ${maxLength} characters; this is ${text.length}.`);
    return text;
  }

  return {
    maxLength,
    list(who) {
      check(who);
      const items = [];
      for (const p of [...posts.values()].reverse()) {
        if (!visible(p, who)) continue;
        items.push(view(p, who));
        if (items.length >= listLimit) break;
      }
      return { items, maxLength, isAdmin: Boolean(who.admin) };
    },
    post(who, body) {
      check(who);
      const text = clean(body), t = now();
      while (recent.length && t - recent[0].created >= DAY) recent.shift();
      if (!who.admin) {
        if (recent.filter((r) => r.user === who.user).length >= perUserPerDay) throw new FeedbackError(429, `You can post up to ${perUserPerDay} times a day. Please try again tomorrow.`);
        if (recent.length >= perDay) throw new FeedbackError(429, "There's been a lot of feedback today. Please try again tomorrow.");
      }
      const p = { id: crypto.randomBytes(9).toString("base64url"), user: who.user, created: t, body: text, ...(who.admin ? { admin: true } : {}) };
      append(p);
      posts.set(p.id, p);
      recent.push({ user: p.user, created: t });
      return view(p, who);
    },
    remove(who, id) {
      check(who);
      const p = typeof id === "string" ? posts.get(id) : null;
      if (!p || !visible(p, who)) throw new FeedbackError(404, "That feedback wasn't found.");
      if (!who.admin && p.user !== who.user) throw new FeedbackError(403, "You can only delete your own feedback.");
      append({ delete: id, by: who.user, at: now() });
      posts.delete(id);
    },
  };
}
