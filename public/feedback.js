// The feedback page, drawn into an element. Pairs with the server's feedback.js and its three routes:
//   GET <endpoint> → { items, maxLength, isAdmin }, POST <endpoint> { body } → item, DELETE <endpoint>/:id
// App-agnostic, so it can be copied into other apps: style it with the fb-* classes, and pass buttonClass and
// primaryClass to reuse the app's own button styles.
//
//   const page = mountFeedback(document.getElementById("view"), { buttonClass: "btn small", primaryClass: "btn primary" });
//   page.refresh();   // reload the list; a draft in the textbox is kept
//
// Everything people write is shown as plain text (no links or formatting), so there's nothing to sanitize and
// nothing for spammers to gain.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (t) => new Date(t).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function mountFeedback(el, {
  endpoint = "/api/feedback",
  title = "Feedback",
  intro = "Ideas, problems, or questions? Everyone signed in can read what's posted here, and it isn't encrypted, so please don't include anything personal.",
  adminLabel = "Developer",
  buttonClass = "",
  primaryClass = "",
  maxLength = 2048,
} = {}) {
  el.innerHTML = `<div class="fb">
    <h2 class="fb-title">${esc(title)}</h2>
    <p class="fb-intro">${esc(intro)}</p>
    <form class="fb-form" novalidate>
      <label class="fb-label" for="fbBody">Your feedback</label>
      <textarea id="fbBody" class="fb-body" rows="5" maxlength="${maxLength}" required></textarea>
      <div class="fb-actions"><span class="fb-count" aria-live="polite"></span><span class="fb-status" role="status"></span>
        <button type="submit" class="fb-send ${esc(primaryClass)}">Post feedback</button></div>
    </form>
    <div class="fb-list" aria-live="polite"><p class="fb-empty">Loading…</p></div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  const box = $(".fb-body"), count = $(".fb-count"), status = $(".fb-status"), send = $(".fb-send"), list = $(".fb-list");
  const setStatus = (text, err) => { status.textContent = text; status.classList.toggle("fb-err", Boolean(err)); };
  const showCount = () => { count.textContent = `${box.value.length} / ${box.maxLength}`; };
  showCount();

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

  function draw({ items, maxLength: max }) {
    if (max && box.maxLength !== max) { box.maxLength = max; showCount(); }
    list.innerHTML = items.length
      ? items.map((it) => `<article class="fb-item${it.mine ? " fb-mine" : ""}" data-id="${esc(it.id)}">
          <div class="fb-meta">${it.admin ? `<strong class="fb-admin">${esc(adminLabel)}</strong> · ` : ""}${it.mine ? "You · " : ""}<time datetime="${new Date(it.created).toISOString()}">${esc(when(it.created))}</time>
            ${it.canDelete ? `<button type="button" class="fb-delete ${esc(buttonClass)}" data-delete="${esc(it.id)}">Delete</button>` : ""}</div>
          <p class="fb-text">${esc(it.body)}</p></article>`).join("")
      : `<p class="fb-empty">No feedback yet. Be the first.</p>`;
  }

  async function refresh() {
    try { draw(await call("GET", endpoint)); }
    catch (e) { list.innerHTML = `<p class="fb-empty fb-err">Couldn't load feedback: ${esc(e.message)}</p>`; }
  }

  box.addEventListener("input", () => { showCount(); setStatus(""); });
  $(".fb-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = box.value.trim();
    if (!body) { setStatus("Write something first.", true); box.focus(); return; }
    send.disabled = true; setStatus("Posting…");
    try {
      await call("POST", endpoint, { body });
      box.value = ""; showCount(); setStatus("Posted. Thank you!");
      await refresh();
    } catch (err) { setStatus(err.message, true); }
    finally { send.disabled = false; }
  });
  // Delete takes two clicks: the first asks to confirm.
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete]");
    if (!b) return;
    if (!b.classList.contains("fb-armed")) { b.classList.add("fb-armed"); b.textContent = "Confirm delete"; return; }
    b.disabled = true;
    try { await call("DELETE", `${endpoint}/${encodeURIComponent(b.dataset.delete)}`); await refresh(); }
    catch (err) { b.disabled = false; b.textContent = "Couldn't delete"; setStatus(err.message, true); }
  });

  refresh();
  return { refresh };
}
