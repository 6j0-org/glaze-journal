// The feedback page, drawn into an element. Pairs with the server's feedback.js and its routes:
//   GET <endpoint> → { items, maxLength, isAdmin }        POST <endpoint> { body } → item
//   GET <endpoint>/:id → thread                           DELETE <endpoint>/:id
//   POST <endpoint>/:id/replies { body } → thread         POST <endpoint>/:id/status { status } → thread
// Each post opens as a chat that everyone who can see it can reply to; the developers (the admins) close it as done
// or won't do. App-agnostic, so it can be copied into other apps: style it with the fb-* classes, and pass
// buttonClass and primaryClass to reuse the app's own button styles.
//
// Posts are anonymous unless the server sends each post's and reply's "author" (see authorKey in feedback.js) and the
// app passes author(key): it returns { icon, name, hidden } or null, where icon is HTML the app trusts (an avatar),
// name is plain text (e.g. what this person calls them), and hidden hides what they wrote (e.g. someone blocked).
//
//   const page = mountFeedback(document.getElementById("view"), { buttonClass: "btn small", primaryClass: "btn primary" });
//   page.refresh();   // reload what's shown; drafts in the text boxes are kept
//
// Everything people write is shown as plain text (no links or formatting), so there's nothing to sanitize and
// nothing for spammers to gain.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (t) => new Date(t).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const time = (t) => `<time datetime="${new Date(t).toISOString()}">${esc(when(t))}</time>`;
const STATUS_LABELS = { open: "Open", done: "Done", wontdo: "Won't do" };

export function mountFeedback(el, {
  endpoint = "/api/feedback",
  title = "Feedback",
  intro = "Ideas, problems, or questions? Everyone signed in can read what's posted here, and it isn't encrypted, so please don't include anything personal. Tap a post to open its chat, where anyone can reply.",
  adminLabel = "Developer",
  authorLabel = "Tester", // the post's author, in its thread
  author = null,          // (key) → { icon, name, hidden } or null, for posts with an "author"; see above
  buttonClass = "",
  primaryClass = "",
  maxLength = 2048,
  pollMs = 10000,       // how often an open thread checks for new replies
} = {}) {
  el.innerHTML = `<div class="fb">
    <div class="fb-home">
      <h2 class="fb-title">${esc(title)}</h2>
      <p class="fb-intro">${esc(intro)}</p>
      <form class="fb-form" novalidate>
        <label class="fb-label" for="fbBody">Your feedback</label>
        <textarea id="fbBody" class="fb-body" rows="5" maxlength="${maxLength}" required></textarea>
        <div class="fb-actions"><span class="fb-count" aria-live="polite"></span><span class="fb-status" role="status"></span>
          <button type="submit" class="fb-send ${esc(primaryClass)}">Post feedback</button></div>
      </form>
      <div class="fb-list" aria-live="polite"><p class="fb-empty">Loading…</p></div>
    </div>
    <div class="fb-thread" hidden></div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  const home = $(".fb-home"), threadEl = $(".fb-thread");
  const box = $(".fb-body"), count = $(".fb-count"), status = $(".fb-status"), send = $(".fb-send"), list = $(".fb-list");
  const setStatus = (text, err) => { status.textContent = text; status.classList.toggle("fb-err", Boolean(err)); };
  const showCount = () => { count.textContent = `${box.value.length} / ${box.maxLength}`; };
  showCount();
  let openId = null, poll = null;

  // Changes are always sent as JSON (an empty object if there's nothing to say), since some apps only accept JSON for
  // anything but GET, as a guard against cross-site form posts.
  async function call(method, url, body) {
    let r;
    try {
      r = await fetch(url, method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    } catch { throw new Error("Can't reach the server. Check your connection."); }
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || r.statusText);
    return data;
  }
  const itemUrl = (id) => `${endpoint}/${encodeURIComponent(id)}`;
  const statusTag = (s) => `<span class="fb-state fb-state-${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;
  // Who wrote a post or reply: the app's avatar and name for them (if any), then labels for developers and, in a
  // thread, the post's author.
  const whoIs = (m) => (author && m.author ? author(m.author) : null) || {};
  const byline = (m, op) => {
    const w = whoIs(m), name = m.mine ? "You" : w.name;
    return `${w.icon ? `<span class="fb-avatar">${w.icon}</span>` : ""}${name ? `<span class="fb-name">${esc(name)}</span>` : ""}` +
      `${m.admin ? `<strong class="fb-admin">${esc(adminLabel)}</strong>` : ""}${op && !m.admin ? `<strong class="fb-author">${esc(authorLabel)}</strong>` : ""}`;
  };
  const text = (m) => (whoIs(m).hidden && !m.mine ? `<p class="fb-text fb-hidden">Hidden</p>` : `<p class="fb-text">${esc(m.body)}</p>`);

  // ---- the list ----
  function drawList({ items, maxLength: max }) {
    if (max && box.maxLength !== max) { box.maxLength = max; showCount(); }
    list.innerHTML = items.length
      ? items.map((it) => `<article class="fb-item${it.mine ? " fb-mine" : ""}" data-open="${esc(it.id)}" role="button" tabindex="0" aria-label="Open this feedback's chat">
          <div class="fb-meta">${statusTag(it.status)}${byline(it, false)}${time(it.created)}
            ${it.replies ? `<span class="fb-replies">${it.replies === 1 ? "1 reply" : `${it.replies} replies`}</span>` : ""}
            ${it.canDelete ? `<button type="button" class="fb-delete ${esc(buttonClass)}" data-delete="${esc(it.id)}">Delete</button>` : ""}</div>
          ${text(it)}</article>`).join("")
      : `<p class="fb-empty">No feedback yet. Be the first.</p>`;
  }
  async function refreshList() {
    try { drawList(await call("GET", endpoint)); }
    catch (e) { list.innerHTML = `<p class="fb-empty fb-err">Couldn't load feedback: ${esc(e.message)}</p>`; }
  }

  // ---- a thread ----
  const shape = (t) => `${t.status}|${t.canReply}|${t.canClose}`;
  let shown = null; // the thread as last drawn
  function messagesHtml(t) {
    const bubble = (m, op) => `<div class="fb-msg${m.mine ? " fb-msg-mine" : ""}${m.admin ? " fb-msg-admin" : ""}">
        <div class="fb-meta">${byline(m, op)}${time(m.created)}</div>${text(m)}</div>`;
    const closed = t.status === "done" ? `A developer marked this as done.${t.mine ? " Thank you!" : ""}`
      : t.status === "wontdo" ? "A developer closed this as won't do." : "";
    return bubble(t, true) + t.messages.map((m) => bubble(m, m.op)).join("") + (closed ? `<p class="fb-sys">${esc(closed)}</p>` : "");
  }
  function drawThread(t) {
    const draft = threadEl.querySelector(".fb-reply-body")?.value || "";
    shown = t;
    const closeBtn = (s, label) => `<button type="button" class="${esc(buttonClass)}" data-set-status="${s}">${esc(label)}</button>`;
    threadEl.innerHTML = `
      <div class="fb-thread-head">
        <button type="button" class="fb-back" aria-label="Back to all feedback">←</button>
        ${statusTag(t.status)}
        <span class="fb-thread-actions">${t.canClose ? (t.status === "open"
          ? closeBtn("done", "Done") + closeBtn("wontdo", "Won't do") : closeBtn("open", "Reopen")) : ""}</span>
      </div>
      <div class="fb-msgs" aria-live="polite">${messagesHtml(t)}</div>
      ${t.canReply ? `<form class="fb-reply" novalidate>
        <label class="fb-label" for="fbReply">Reply</label>
        <textarea id="fbReply" class="fb-reply-body" rows="2" maxlength="${box.maxLength}" required></textarea>
        <div class="fb-actions"><span class="fb-reply-status" role="status"></span>
          <button type="submit" class="fb-reply-send ${esc(primaryClass)}">Send</button></div>
      </form>` : ""}`;
    const reply = threadEl.querySelector(".fb-reply-body");
    if (reply) reply.value = draft;
  }
  function redrawMessages(t) {
    if (shape(t) !== shape(shown)) return drawThread(t);
    shown = t;
    const msgs = threadEl.querySelector(".fb-msgs"), html = messagesHtml(t);
    if (msgs.dataset.drawn !== html) { msgs.innerHTML = html; msgs.dataset.drawn = html; }
  }
  async function openThread(id) {
    openId = id;
    home.hidden = true; threadEl.hidden = false;
    threadEl.innerHTML = `<p class="fb-empty">Loading…</p>`;
    shown = null;
    try { drawThread(await call("GET", itemUrl(id))); }
    catch (e) { threadEl.innerHTML = `<button type="button" class="fb-back" aria-label="Back to all feedback">←</button><p class="fb-empty fb-err">Couldn't load this feedback: ${esc(e.message)}</p>`; }
    clearInterval(poll);
    poll = setInterval(async () => {
      if (openId !== id || !el.isConnected) return clearInterval(poll);
      try { const t = await call("GET", itemUrl(id)); if (openId === id) redrawMessages(t); } catch {}
    }, pollMs);
  }
  function closeThread() {
    openId = null; shown = null; clearInterval(poll);
    threadEl.hidden = true; threadEl.innerHTML = ""; home.hidden = false;
    refreshList();
  }

  async function refresh() {
    if (openId) {
      try { const t = await call("GET", itemUrl(openId)); shown ? redrawMessages(t) : drawThread(t); }
      catch { closeThread(); }
    } else await refreshList();
  }

  // ---- events ----
  box.addEventListener("input", () => { showCount(); setStatus(""); });
  $(".fb-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = box.value.trim();
    if (!body) { setStatus("Write something first.", true); box.focus(); return; }
    send.disabled = true; setStatus("Posting…");
    try {
      await call("POST", endpoint, { body });
      box.value = ""; showCount(); setStatus("Posted. Thank you!");
      await refreshList();
    } catch (err) { setStatus(err.message, true); }
    finally { send.disabled = false; }
  });
  // Delete takes two clicks: the first asks to confirm. Anywhere else on an item opens its chat.
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete]");
    if (!b) {
      const item = e.target.closest("[data-open]");
      if (item && !e.target.closest("a, button")) openThread(item.dataset.open);
      return;
    }
    if (!b.classList.contains("fb-armed")) { b.classList.add("fb-armed"); b.textContent = "Confirm delete"; return; }
    b.disabled = true;
    try { await call("DELETE", itemUrl(b.dataset.delete)); await refreshList(); }
    catch (err) { b.disabled = false; b.textContent = "Couldn't delete"; setStatus(err.message, true); }
  });
  list.addEventListener("keydown", (e) => {
    const item = e.target.closest?.("[data-open]");
    if (item && e.target === item && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openThread(item.dataset.open); }
  });
  threadEl.addEventListener("click", async (e) => {
    if (e.target.closest(".fb-back")) return closeThread();
    const b = e.target.closest("[data-set-status]");
    if (!b || !openId) return;
    b.disabled = true;
    try { drawThread(await call("POST", `${itemUrl(openId)}/status`, { status: b.dataset.setStatus })); }
    catch (err) { b.disabled = false; alert(err.message); }
  });
  threadEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = threadEl.querySelector(".fb-reply-body"), note = threadEl.querySelector(".fb-reply-status");
    const sendBtn = threadEl.querySelector(".fb-reply-send"), body = input.value.trim();
    if (!body) { note.textContent = "Write something first."; input.focus(); return; }
    sendBtn.disabled = true; note.textContent = "Sending…";
    try {
      const t = await call("POST", `${itemUrl(openId)}/replies`, { body });
      input.value = ""; note.textContent = "";
      redrawMessages(t);
      const msgs = threadEl.querySelector(".fb-msgs");
      msgs.lastElementChild?.scrollIntoView({ block: "nearest" });
    } catch (err) { note.textContent = err.message; note.classList.add("fb-err"); }
    finally { sendBtn.disabled = false; }
  });
  threadEl.addEventListener("input", (e) => {
    if (e.target.matches(".fb-reply-body")) { const n = threadEl.querySelector(".fb-reply-status"); n.textContent = ""; n.classList.remove("fb-err"); }
  });

  refreshList();
  return { refresh };
}
