// Feedback: a page where signed-in people read everyone's feedback and post their own. Each post is a thread, like a
// chat: everyone who can see it can reply, and admins (developers) close it as done or won't do (or reopen it).
// Self-contained and app-agnostic (no dependencies, no knowledge of the app's accounts, routing, or database), so the
// same file can be copied into other apps. Pair it with public/feedback.js, which draws the page.
//
// Storage is one JSON Lines file: one JSON object per line, appended to and never edited in place, so a crash can't
// damage earlier entries and the file reads fine with tail, grep, or jq.
//   {"id":"…","user":"…","created":1763600000000,"body":"…"}          a post ("admin":true if an admin wrote it)
//   {"reply":"<post id>","id":"…","user":"…","created":…,"body":"…"}   a reply in a post's thread (likewise "admin")
//   {"status":"<post id>","value":"done","by":"…","at":…}              closed as "done" or "wontdo", or reopened ("open")
//   {"delete":"<post id>","by":"…","at":1763600500000}                 a post deleted, with its thread
// The whole file is read at startup and kept in memory. At startup the file is also compacted (rewritten without
// deleted posts and their replies, then renamed into place) when anything was deleted, so deleted text doesn't stay
// on disk past the next restart. Compacted posts carry their status as "status" and "closed" fields. Only one process
// may write to the file.
//
// Who's asking is passed to each call as { user, admin }: user is any stable, opaque ID for the account (never shown
// to anyone), and admin says whether this account may close any thread and delete anyone's posts (and gets its posts
// labeled). Posts and replies are anonymous unless the app passes authorKey: a function from a user ID to what the
// page may show of the author (e.g. a hash the app's browsers can match to contacts and draw an avatar from), which
// is then returned as each post's and reply's "author".
//
// Usage:
//   const feedback = createFeedback({ file: "data/feedback.jsonl" });
//   feedback.list(who)              → { items: [item], maxLength, isAdmin }, the most recently active first, where
//                                     item is { id, body, created, updated, admin, mine, canDelete, status, replies }
//                                     (plus author, with authorKey)
//   feedback.post(who, body)        → the new item
//   feedback.thread(who, id)        → { ...item, messages: [{ id, body, created, admin, mine, op }], canReply, canClose }
//                                     (op: written by the post's author; plus author, with authorKey)
//   feedback.reply(who, id, body)   → the thread
//   feedback.setStatus(who, id, s)  → the thread ("open", "done", or "wontdo"; admins only)
//   feedback.remove(who, id)
//   feedback.doneCount(user)        → how many of this account's posts admins closed as done
//   feedback.authorOf(id)           → the post's author's user ID (for the app's own use, e.g. notifications)
// Bad input and limits throw FeedbackError with an HTTP status and a message fit to show people.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class FeedbackError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DAY = 24 * 3600 * 1000;
export const STATUSES = ["open", "done", "wontdo"];

export function createFeedback({
  file,
  maxLength = 2048,     // characters per post or reply (UTF-16 code units, as the browser's maxlength counts them)
  perUserPerDay = 100,  // posts and replies per account in any 24 hours, deleted ones included
  perDay = 500,         // posts and replies from everyone together in any 24 hours, so many accounts can't fill the disk
  listLimit = 200,      // most recently active posts returned by list()
  scope = "all",        // "all": everyone sees every post; "own": people see only their own (admins see all)
  authorKey = null,     // (user ID) → what to show of the author, as "author"; leave it out to keep posts anonymous
  now = Date.now,
} = {}) {
  if (!file) throw new Error("createFeedback: file is required");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // id → post, in the order posted. In memory, each post also has status, closed (when it was last closed or
  // reopened, or 0), updated (its last reply or status change), and replies.
  const posts = new Map();
  const recent = [];       // { user, created } of posts and replies in the last day, deleted ones included, for the limits
  const remember = (r) => { if (now() - r.created < DAY) recent.push({ user: r.user, created: r.created }); };

  // Load, and compact if anything was deleted.
  let deletions = 0, skipped = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { skipped++; continue; } // e.g. a line cut short by a crash
      if (typeof r.delete === "string") { posts.delete(r.delete); deletions++; }
      else if (typeof r.status === "string" && STATUSES.includes(r.value)) {
        const p = posts.get(r.status);
        if (p) { p.status = r.value; p.closed = r.at; p.updated = Math.max(p.updated, r.at); }
      } else if (typeof r.reply === "string" && typeof r.id === "string" && typeof r.body === "string") {
        const p = posts.get(r.reply);
        if (p) { const { reply, ...rest } = r; p.replies.push(rest); p.updated = Math.max(p.updated, r.created); }
        else deletions++; // its post was deleted, so leave it out of the compacted file
        remember(r);
      } else if (typeof r.id === "string" && typeof r.body === "string") {
        const status = STATUSES.includes(r.status) ? r.status : "open", closed = r.closed || 0;
        posts.set(r.id, { ...r, status, closed, updated: Math.max(r.created, closed), replies: [] });
        remember(r);
      } else skipped++;
    }
    recent.sort((a, b) => a.created - b.created);
    // Unreadable lines are left out of the compacted file (which also ends a line cut short, so the next append
    // starts on a line of its own), with the original kept next to it.
    if (skipped) {
      const keep = `${file}.unreadable-${now()}`;
      fs.copyFileSync(file, keep);
      console.warn(`feedback: skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"} in ${file}; the original is in ${keep}`);
    }
    if (deletions || skipped) {
      const tmp = `${file}.${process.pid}.tmp`;
      const lines = [];
      for (const { status, closed, updated, replies, ...p } of posts.values()) {
        lines.push(status === "open" && !closed ? p : { ...p, status, closed });
        for (const r of replies) lines.push({ reply: p.id, ...r });
      }
      fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l) + "\n").join(""), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  }
  const append = (record) => fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });

  const visible = (p, who) => who.admin || scope === "all" || p.user === who.user;
  const author = (user) => (authorKey ? { author: authorKey(user) ?? null } : {});
  const view = (p, who) => ({
    id: p.id, body: p.body, created: p.created, updated: p.updated, admin: Boolean(p.admin),
    mine: p.user === who.user, canDelete: Boolean(who.admin) || p.user === who.user,
    status: p.status, replies: p.replies.length, ...author(p.user),
  });
  const threadView = (p, who) => ({
    ...view(p, who),
    messages: p.replies.map((r) => ({
      id: r.id, body: r.body, created: r.created, admin: Boolean(r.admin), mine: r.user === who.user, op: r.user === p.user, ...author(r.user),
    })),
    canReply: true, // everyone who can see a thread can reply
    canClose: Boolean(who.admin),
  });
  function check(who) {
    if (!who || typeof who.user !== "string" || !who.user) throw new FeedbackError(401, "Please sign in.");
  }
  function find(who, id) {
    const p = typeof id === "string" ? posts.get(id) : null;
    if (!p || !visible(p, who)) throw new FeedbackError(404, "That feedback wasn't found.");
    return p;
  }
  function clean(body) {
    if (typeof body !== "string") throw new FeedbackError(400, "Feedback must be text.");
    // Keep line breaks and tabs; drop other control characters.
    const text = body.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (!text) throw new FeedbackError(400, "Write something first.");
    if (text.length > maxLength) throw new FeedbackError(400, `Feedback can be up to ${maxLength} characters; this is ${text.length}.`);
    return text;
  }
  // The daily limits, for posts and replies alike. Admins count toward everyone's total, but aren't limited.
  function limit(who, t) {
    while (recent.length && t - recent[0].created >= DAY) recent.shift();
    if (who.admin) return;
    if (recent.filter((r) => r.user === who.user).length >= perUserPerDay) throw new FeedbackError(429, `You can post up to ${perUserPerDay} times a day. Please try again tomorrow.`);
    if (recent.length >= perDay) throw new FeedbackError(429, "There's been a lot of feedback today. Please try again tomorrow.");
  }
  const newId = () => crypto.randomBytes(9).toString("base64url");

  return {
    maxLength,
    list(who) {
      check(who);
      const items = [...posts.values()].reverse().filter((p) => visible(p, who)) // ties: newest first
        .sort((a, b) => b.updated - a.updated).slice(0, listLimit).map((p) => view(p, who));
      return { items, maxLength, isAdmin: Boolean(who.admin) };
    },
    post(who, body) {
      check(who);
      const text = clean(body), t = now();
      limit(who, t);
      const p = { id: newId(), user: who.user, created: t, body: text, ...(who.admin ? { admin: true } : {}) };
      append(p);
      posts.set(p.id, { ...p, status: "open", closed: 0, updated: t, replies: [] });
      recent.push({ user: p.user, created: t });
      return view(posts.get(p.id), who);
    },
    thread(who, id) {
      check(who);
      return threadView(find(who, id), who);
    },
    reply(who, id, body) {
      check(who);
      const p = find(who, id);
      const text = clean(body), t = now();
      limit(who, t);
      const r = { id: newId(), user: who.user, created: t, body: text, ...(who.admin ? { admin: true } : {}) };
      append({ reply: p.id, ...r });
      p.replies.push(r);
      p.updated = t;
      recent.push({ user: r.user, created: t });
      return threadView(p, who);
    },
    setStatus(who, id, value) {
      check(who);
      const p = find(who, id);
      if (!who.admin) throw new FeedbackError(403, "Only the developers can close feedback.");
      if (!STATUSES.includes(value)) throw new FeedbackError(400, `Status must be one of: ${STATUSES.join(", ")}.`);
      if (p.status !== value) {
        const t = now();
        append({ status: p.id, value, by: who.user, at: t });
        p.status = value; p.closed = t; p.updated = t;
      }
      return threadView(p, who);
    },
    remove(who, id) {
      check(who);
      const p = find(who, id);
      if (!who.admin && p.user !== who.user) throw new FeedbackError(403, "You can only delete your own feedback.");
      append({ delete: id, by: who.user, at: now() });
      posts.delete(id);
    },
    doneCount(user) {
      let n = 0;
      for (const p of posts.values()) if (p.user === user && p.status === "done") n++;
      return n;
    },
    authorOf(id) {
      return posts.get(id)?.user ?? null;
    },
  };
}
