import {
  loadKey, clearKey, encryptRecord, decryptRecord, encryptPhoto, decryptPhoto, startIdSignIn, finishIdSignIn, hasIdCallback,
} from "/secure.js";

(() => {
  const DEFAULTS = {
    brands: ["Mayco", "Amaco", "Freeform", "Velvet Underglaze"],
    types: ["Stable", "Float", "Fluid"],
    clays: ["Laguna Speckled Buff", "Laguna Dover White"],
  };
  const LIST_LABELS = { brands: "brand", types: "glaze type", clays: "clay body" };
  const state = {
    view: "log",
    glazes: [], logs: [], lists: clone(DEFAULTS),
    loaded: { glazes: false, logs: false },
    filter: { kind: "all", glaze: "", clay: "" },
    glazeFilter: "",
    canUpload: true,
    auth: "unknown", // "unknown" | "in" | "out" | "locked" (signed in, but this device doesn't have the journal key)
    authError: "",
  };
  let store = null;

  // ---------- helpers ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s + "T12:00:00"); return isNaN(d) ? s : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
  const glazeById = (id) => state.glazes.find((g) => g.id === id);
  const glazeLabel = (g) => g ? `${g.brand} · ${g.code ? g.code + " " : ""}${g.name}` : "Deleted glaze";
  const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  // ---------- photos (encrypted on the server; decrypted here into blob: URLs) ----------
  // photoImg() draws a placeholder right away and fills in every <img data-pid> for that photo once it's decrypted.
  const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const photoCache = new Map(); // id -> { url, promise }
  function loadPhoto(id) {
    const entry = { url: "" };
    entry.promise = (async () => {
      const r = await fetch("/photos/" + encodeURIComponent(id));
      if (!r.ok) throw new Error("photo " + r.status);
      const type = r.headers.get("content-type") || "";
      const buf = await r.arrayBuffer();
      // Photos from before encryption come back as plain images until their owner's browser re-encrypts them.
      const blob = type.startsWith("application/octet-stream") ? await decryptPhoto(buf) : new Blob([buf], { type });
      entry.url = URL.createObjectURL(blob);
      document.querySelectorAll(`img[data-pid="${CSS.escape(id)}"]`).forEach((img) => { img.src = entry.url; });
      return entry.url;
    })().catch(() => ""); // a failed photo stays a placeholder until the next page load
    photoCache.set(id, entry);
    return entry.promise;
  }
  // A glaze's product image is { product: id }: an unencrypted file in the server's shared cache, used as is.
  // Everything else ({ id }) is the account's own encrypted photo.
  const productSrc = (p) => "/products/" + encodeURIComponent(p.product);
  const hasPhoto = (p) => Boolean(p?.id || p?.product);
  function photoSrc(p) {
    if (p?.product) return productSrc(p);
    if (!p?.id) return "";
    const c = photoCache.get(p.id);
    if (!c) loadPhoto(p.id);
    return c?.url || BLANK;
  }
  const photoUrl = async (p) => (p?.product ? productSrc(p) : !p?.id ? "" : photoCache.get(p.id)?.url || (await (photoCache.get(p.id)?.promise || loadPhoto(p.id))));
  const photoImg = (p, attrs = "") => p.product ? `<img src="${esc(photoSrc(p))}" loading="lazy" ${attrs}>` : `<img data-pid="${esc(p.id)}" src="${esc(photoSrc(p))}" ${attrs}>`;
  function seedPhoto(id, blob) { const url = URL.createObjectURL(blob); photoCache.set(id, { url, promise: Promise.resolve(url) }); }
  function clearPhotos() { for (const c of photoCache.values()) if (c.url) URL.revokeObjectURL(c.url); photoCache.clear(); }
  function resolveGlaze(item) {
    const g = glazeById(item.glazeId);
    return g ? { ...g, live: true } : { name: item.name || "Deleted glaze", brand: item.brand || "", type: item.type || "", color: item.color || "#999999", live: false };
  }

  // Test-tile swatch: raw clay below, glaze dipped on top, drips for fluid glazes.
  function tileSvg(color, type) {
    const t = (type || "").toLowerCase();
    const y = t === "fluid" ? 44 : t === "float" ? 48 : 50;
    let glaze = `M0 0H60V${y}Q52.5 ${y + 3} 45 ${y}T30 ${y}T15 ${y}T0 ${y}Z`;
    let drips = "";
    if (t === "fluid") drips = `<path d="M11 ${y}q2 14 4 14q2 0 3-14z M38 ${y}q1 20 4 20q3 0 3-20z" fill="${esc(color)}"/>`;
    if (t === "float") drips = `<path d="M22 ${y}q1 6 3 6q2 0 2-6z" fill="${esc(color)}"/>`;
    const specks = [[8, 62], [20, 70], [33, 64], [47, 72], [52, 60], [14, 76], [40, 58]].map(([x, yy]) => `<circle cx="${x}" cy="${yy}" r="0.9" fill="#6b5640"/>`).join("");
    return `<rect x="0" y="0" width="60" height="80" rx="6" fill="#d3bd98"/>${specks}<g style="clip-path:inset(0 round 6px)"><path d="${glaze}" fill="${esc(color)}"/>${drips}<rect x="5" y="4" width="7" height="${y - 10}" rx="3.5" fill="#fff" opacity=".18"/></g><circle cx="30" cy="11" r="4.2" style="fill:var(--surface)" stroke="rgb(0 0 0 / .18)"/><rect x=".5" y=".5" width="59" height="79" rx="5.5" fill="none" stroke="rgb(0 0 0 / .15)"/>`;
  }
  $("#logoTile").innerHTML = tileSvg("#2f6f60", "Fluid");

  // ---------- storage ----------
  // JSON (or raw bytes with a type) to the API. Errors carry .status. A 401 means the session ended.
  async function api(method, url, body, type) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = type || "application/json"; opts.body = type ? body : JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opts); } catch { throw new Error("can't reach the server. Check your connection."); }
    if (!r.ok) {
      let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch {}
      if (r.status === 401 && !url.startsWith("/api/id/")) signedOut();
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return r.status === 204 ? null : r.json();
  }

  // Everything in the journal is encrypted in this browser before it's sent (see secure.js). The server keeps the
  // ciphertext, plus which photos each record uses so it can delete photos nothing uses any more.
  function apiStore() {
    const subs = { glazes: [], logs: [], config: [] };
    let snap = null, upgrading = false;
    function emit() {
      subs.config.forEach((f) => f(snap.lists));
      subs.glazes.forEach((f) => f(snap.glazes));
      subs.logs.forEach((f) => f(snap.logs));
    }
    const photoIds = (c, doc) => (c === "logs" ? [doc.pre?.id, doc.post?.id] : c === "glazes" ? [doc.image?.id] : []).filter(Boolean);
    async function putRecord(c, id, doc) {
      if (c === "config") return api("PUT", "/api/lists", { enc: await encryptRecord("config", "lists", doc) });
      return api("PUT", `/api/${c}/${encodeURIComponent(id)}`, { enc: await encryptRecord(c, id, doc), photos: photoIds(c, doc) });
    }
    async function upload(blob) {
      const r = await api("POST", "/api/photos", await encryptPhoto(blob), "application/octet-stream");
      seedPhoto(r.id, blob);
      return { id: r.id };
    }
    // Product images stay in the server's shared cache; the glaze record (encrypted) just points at one.
    function withImage(r) {
      const { productImage, ...rest } = r;
      return { ...rest, image: productImage ? { product: productImage } : null };
    }
    async function decryptState(raw) {
      const legacy = []; let bad = 0;
      const one = async (c, r) => {
        if (r.legacy) { legacy.push({ c, id: r.id, doc: r.legacy }); return { id: r.id, ...r.legacy }; }
        try { return { id: r.id, ...(await decryptRecord(c, r.id, r.enc)) }; } catch { bad++; return null; }
      };
      const lists = raw.lists ? await one("config", raw.lists) : null;
      if (lists) delete lists.id;
      const glazes = (await Promise.all(raw.glazes.map((r) => one("glazes", r)))).filter(Boolean);
      const logs = (await Promise.all(raw.logs.map((r) => one("logs", r)))).filter(Boolean);
      return { lists, glazes, logs, legacy, bad };
    }
    // Records (and their photos) from before encryption: encrypt them once, then drop the plain copies.
    async function upgradeLegacy(items) {
      upgrading = true;
      try {
        for (const { c, id, doc } of items) {
          const next = { ...doc };
          for (const k of ["pre", "post", "image"]) {
            if (!next[k]?.id) continue;
            const r = await fetch("/photos/" + encodeURIComponent(next[k].id));
            next[k] = r.ok ? await upload(await r.blob()) : null;
          }
          await putRecord(c, id, next);
        }
      } finally { upgrading = false; }
    }
    return {
      async refresh() {
        try {
          const raw = await api("GET", "/api/state");
          if (!raw.wrappedKey || !(await loadKey(raw.guid))) { locked(); return; }
          snap = await decryptState(raw);
          state.auth = "in"; showAuthUi();
          showBanner(snap.bad ? `${snap.bad} record${snap.bad === 1 ? "" : "s"} couldn't be decrypted with this account's key and ${snap.bad === 1 ? "is" : "are"} hidden.` : "");
          emit();
          if (snap.legacy.length && !upgrading) {
            showBanner("Encrypting your existing journal…");
            try { await upgradeLegacy(snap.legacy); await this.refresh(); }
            catch (e) { showBanner("Couldn't finish encrypting your existing journal: " + (e?.message || "try again later.")); }
          }
        } catch (e) { if (e.status !== 401) showBanner("Can't reach the Glaze Journal server. Check your connection; the page will retry."); }
      },
      watch(c, cb) { subs[c].push(cb); if (snap) cb(c === "config" ? snap.lists : snap[c]); },
      // The browser picks record IDs: each ID is bound into its record's encryption.
      async save(c, id, d, opts = {}) {
        id = id || crypto.randomUUID();
        const prev = snap?.[c]?.find((x) => x.id === id);
        const { id: _, ...doc } = { ...d, createdAt: prev?.createdAt || d.createdAt || Date.now(), ...(c === "logs" ? { updatedAt: Date.now() } : {}) };
        await putRecord(c, id, doc);
        if (opts.refresh !== false) await this.refresh();
        return id;
      },
      get: (url) => api("GET", url),
      async catalogItem(item) { return withImage(await api("POST", "/api/catalog/item", { item })); },
      async remove(c, id) { await api("DELETE", `/api/${c}/` + encodeURIComponent(id)); await this.refresh(); },
      async saveConfig(d) { await putRecord("config", "lists", d); await this.refresh(); },
      upload,
      async importPage(url) { return withImage(await api("POST", "/api/import", { url })); },
      async deleteAsset() {}, // the server removes photos no entry uses any more
    };
  }

  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", 0.85));
    } catch { return file; }
  }

  // ---------- sign-in with a 6j0.org identity (the handoff and keys are in secure.js) ----------
  async function startSignIn() {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error("Can't reach the Glaze Journal server.");
    await startIdSignIn(await r.json());
  }

  async function signOut() {
    try { await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch {}
    signedOut();
  }

  function forget() {
    state.glazes = []; state.logs = []; state.lists = clone(DEFAULTS);
    clearPhotos(); clearKey();
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    showBanner(""); showAuthUi(); render();
  }
  function signedOut() { if (state.auth !== "out") { state.auth = "out"; forget(); } }
  // Signed in, but this device has no journal key (e.g. the browser cleared site storage): sign in again for it.
  function locked() { if (state.auth !== "locked") { state.auth = "locked"; forget(); } }

  function showAuthUi() {
    $("nav.tabs").hidden = state.auth !== "in";
    $("#signOut").hidden = state.auth !== "in" && state.auth !== "locked";
  }

  function renderSignIn() {
    const intro = state.auth === "locked"
      ? `<h3>Unlock your journal</h3><p>This device doesn't have your journal's key any more. Sign in again to unlock it.</p>`
      : `<h3>Sign in to your journal</h3><p>Glaze Journal uses your 6j0.org identity: one passkey (or username and password) for every 6j0.org app. Your glazes, firing log, and photos are encrypted in your browser, so only you can read them.</p>`;
    return `<div class="empty signin">${intro}
      <button class="btn primary" data-act="sign-in">Sign in with 6j0.org</button>
      <p class="meta err" id="signInErr"${state.authError ? "" : " hidden"}>${esc(state.authError)}</p></div>`;
  }

  function showBanner(text) { const b = $("#banner"); b.textContent = text; b.hidden = !text; }

  async function saveLists(next) {
    state.lists = next;
    render(); refreshListSelects();
    try { await store.saveConfig(next); } catch (e) { showBanner("Couldn't save the list change. " + (e?.message || "")); }
  }

  // ---------- routing ----------
  const VIEWS = ["log", "glazes", "lists"];
  function route() {
    const h = location.hash.replace("#", "");
    state.view = VIEWS.includes(h) ? h : "log";
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === state.view ? "page" : "false"));
    render();
  }
  window.addEventListener("hashchange", route);

  // ---------- rendering ----------
  function render() {
    const v = $("#view");
    if (state.auth === "out" || state.auth === "locked") { v.innerHTML = renderSignIn(); return; }
    if (!store || state.auth !== "in") { v.innerHTML = `<p class="loading">Opening the studio…</p>`; return; }
    const active = document.activeElement, focusId = v.contains(active) ? active.id : "";
    const caret = focusId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
    if (state.view === "log") v.innerHTML = renderLog();
    else if (state.view === "glazes") v.innerHTML = renderGlazes();
    else v.innerHTML = renderLists();
    const again = focusId && document.getElementById(focusId);
    if (again) { again.focus(); if (caret) try { again.setSelectionRange(...caret); } catch {} }
  }

  function usageCount(field, value) {
    if (field === "glaze") return state.logs.filter((l) => (l.glazes || []).some((x) => x.glazeId === value)).length;
    if (field === "clay") return state.logs.filter((l) => l.clay === value).length;
    if (field === "brand") return state.glazes.filter((g) => g.brand === value).length;
    if (field === "type") return state.glazes.filter((g) => g.type === value).length;
    return 0;
  }

  function sortedLogs() {
    return [...state.logs].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function renderLog() {
    const f = state.filter;
    const all = sortedLogs();
    const list = all.filter((l) => (f.kind === "all" || l.kind === f.kind) && (!f.clay || l.clay === f.clay) && (!f.glaze || (l.glazes || []).some((x) => x.glazeId === f.glaze)));
    const head = `<div class="view-head"><div><h2>Firing log</h2><p>Test tiles and finished pieces, before and after the kiln.</p></div><button class="btn primary" data-act="new-log">+ New entry</button></div>`;
    if (!state.loaded.logs) return head + `<p class="loading">Loading entries…</p>`;
    if (!all.length) {
      return head + `<div class="empty"><h3>No firings logged yet</h3><p>Add a test tile or a piece: pick the clay body and glazes, describe how you applied each one, and attach photos from before and after the firing.</p>${state.glazes.length ? "" : `<p>Tip: add a few glazes to your catalog first so you can pick them here.</p>`}<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn primary" data-act="new-log">+ New entry</button>${state.glazes.length ? "" : `<a class="btn" href="#glazes">Go to glazes</a>`}</div></div>`;
    }
    const usedGlazes = state.glazes.filter((g) => usageCount("glaze", g.id)).sort((a, b) => byText(glazeLabel(a), glazeLabel(b)));
    const usedClays = [...new Set(all.map((l) => l.clay).filter(Boolean))].sort(byText);
    const chip = (k, label) => `<button class="chip" data-kind="${k}" aria-pressed="${f.kind === k}">${label}</button>`;
    const filters = `<div class="filters">${chip("all", "All")}${chip("tile", "Test tiles")}${chip("piece", "Pieces")}
      <select id="fGlaze" aria-label="Filter by glaze"><option value="">Any glaze</option>${usedGlazes.map((g) => `<option value="${esc(g.id)}" ${f.glaze === g.id ? "selected" : ""}>${esc(glazeLabel(g))}</option>`).join("")}</select>
      <select id="fClay" aria-label="Filter by clay body"><option value="">Any clay</option>${usedClays.map((c) => `<option ${f.clay === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <span class="count">${list.length} of ${all.length}</span></div>`;
    if (!list.length) return head + filters + `<div class="empty"><p>No entries match these filters.</p><button class="btn" data-act="clear-filters">Clear filters</button></div>`;
    return head + filters + `<div class="grid">${list.map(logCard).join("")}</div>`;
  }

  function logCard(l) {
    const img = l.post?.id ? l.post : l.pre?.id ? l.pre : null;
    const glazes = (l.glazes || []).map(resolveGlaze);
    return `<button class="card" data-log="${esc(l.id)}">
      <div class="photo">${img ? photoImg(img, 'alt=""') : "No photo yet"}
        <span class="kind">${l.kind === "piece" ? "Piece" : "Test tile"}</span>
        ${img ? `<span class="stage">${img === l.post ? "After firing" : "Before firing"}</span>` : ""}</div>
      <div class="card-body">
        <h3>${esc(l.title || (l.kind === "piece" ? "Untitled piece" : "Untitled tile"))}</h3>
        <div class="meta">${esc([fmtDate(l.date), l.clay].filter(Boolean).join(" · "))}</div>
        ${glazes.length ? `<div class="glaze-dots">${glazes.map((g) => `<span><i class="dot" style="background:${esc(g.color)}"></i>${esc(g.name)}</span>`).join("")}</div>` : ""}
      </div></button>`;
  }

  function renderGlazes() {
    const head = `<div class="view-head"><div><h2>Glaze catalog</h2><p>${state.glazes.length} glaze${state.glazes.length === 1 ? "" : "s"} across ${new Set(state.glazes.map((g) => g.brand)).size} brands.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="browse-catalogs">Browse manufacturer catalogs</button><button class="btn" data-act="import-glazes">Import from links</button><button class="btn primary" data-act="new-glaze">+ Add glaze</button></div></div>`;
    if (!state.loaded.glazes) return head + `<p class="loading">Loading glazes…</p>`;
    if (!state.glazes.length) return head + `<div class="empty"><h3>Your catalog is empty</h3><p>Add the glazes on your shelf with their brand, type (stable, float, fluid…) and a color, or paste links to their product pages on the manufacturer's site to fill them in automatically.</p><div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn primary" data-act="browse-catalogs">Browse manufacturer catalogs</button><button class="btn" data-act="import-glazes">Import from links</button><button class="btn" data-act="new-glaze">+ Add glaze</button></div></div>`;
    const types = [...new Set(state.glazes.map((g) => g.type).filter(Boolean))].sort(byText);
    const tf = state.glazeFilter, qs = (state.glazeSearch || "").trim().toLowerCase();
    const filters = `<div class="filters"><input type="search" class="search" id="glazeSearch" placeholder="Search name, code or line" aria-label="Search glazes" value="${esc(state.glazeSearch || "")}"><button class="chip" data-gtype="" aria-pressed="${!tf}">All types</button>${types.map((t) => `<button class="chip" data-gtype="${esc(t)}" aria-pressed="${tf === t}">${esc(t)}</button>`).join("")}${state.glazes.some((g) => !g.type) ? `<button class="chip" data-gtype="__none" aria-pressed="${tf === "__none"}">No type yet</button>` : ""}</div>`;
    const shown = state.glazes.filter((g) => (!tf || (tf === "__none" ? !g.type : g.type === tf)) &&
      (!qs || [g.name, g.code, g.line, g.brand].some((x) => (x || "").toLowerCase().includes(qs))));
    if (!shown.length) return head + filters + `<div class="empty"><p>No glazes match.</p></div>`;
    const byCode = (x, y) => (x.code || "~").localeCompare(y.code || "~", undefined, { numeric: true }) || byText(x.name, y.name);
    const card = (g) => {
      const n = usageCount("glaze", g.id);
      const thumb = hasPhoto(g.image) ? `<div class="thumbwrap">${photoImg(g.image, 'class="gthumb" alt=""')}<i class="dot" style="background:${esc(g.color)}"></i></div>` : `<svg viewBox="0 0 60 80" aria-hidden="true">${tileSvg(g.color, g.type)}</svg>`;
      return `<button class="glaze-card" data-glaze="${esc(g.id)}">${thumb}<div>${g.code ? `<div class="gcode">${esc(g.code)}</div>` : ""}<div class="gname">${esc(g.name)}</div><div class="gsub"><span class="pill">${esc(g.type || "No type yet")}</span></div><div class="gsub" style="margin-top:4px">${n ? `${n} entr${n === 1 ? "y" : "ies"}` : "Not used yet"}</div></div></button>`;
    };
    const brands = [...new Set(shown.map((g) => g.brand))].sort(byText);
    return head + filters + brands.map((b) => {
      const inBrand = shown.filter((g) => g.brand === b);
      const lines = [...new Set(inBrand.map((g) => g.line || ""))].sort((x, y) => (x ? 0 : 1) - (y ? 0 : 1) || byText(x, y));
      const body = lines.length === 1 && !lines[0]
        ? `<div class="glaze-grid">${inBrand.sort(byCode).map(card).join("")}</div>`
        : lines.map((l) => { const gs = inBrand.filter((g) => (g.line || "") === l).sort(byCode); return `<div class="line-group"><h4>${esc(l || "Other")}<small>${gs.length}</small></h4><div class="glaze-grid">${gs.map(card).join("")}</div></div>`; }).join("");
      return `<section class="brand-group"><h3>${esc(b || "No brand")} · ${inBrand.length}</h3>${body}</section>`;
    }).join("");
  }

  function renderLists() {
    const box = (key, title, field) => `<div class="list-box"><h3>${title}</h3><ul>${state.lists[key].map((item, i) => {
      const n = usageCount(field, item);
      return `<li><span>${esc(item)}</span><span style="display:flex;align-items:center;gap:6px">${n ? `<small>${n} used</small>` : ""}<button class="x" data-remove="${key}" data-i="${i}" aria-label="Remove ${esc(item)}">×</button></span></li>`;
    }).join("") || `<li class="meta">Nothing here yet.</li>`}</ul>
      <form class="inline-add" data-addlist="${key}"><input type="text" id="add-${key}" placeholder="Add a ${LIST_LABELS[key]}" aria-label="Add a ${LIST_LABELS[key]}"><button class="btn small" type="submit">Add</button></form></div>`;
    return `<div class="view-head"><div><h2>Lists</h2><p>The choices offered in the glaze and log forms. Removing one keeps it on records that already use it.</p></div></div>
      <div class="lists">${box("brands", "Brands", "brand")}${box("types", "Glaze types", "type")}${box("clays", "Clay bodies", "clay")}</div>`;
  }

  // ---------- view events ----------
  $("#view").addEventListener("click", (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.dataset.act === "sign-in") {
      t.disabled = true;
      startSignIn().catch((err) => { t.disabled = false; state.authError = err.message || "Couldn't start sign-in."; render(); });
    }
    else if (t.dataset.act === "new-log") openLogForm(null);
    else if (t.dataset.act === "new-glaze") openGlazeForm(null);
    else if (t.dataset.act === "import-glazes") openImport();
    else if (t.dataset.act === "browse-catalogs") openCatalog();
    else if (t.dataset.act === "clear-filters") { state.filter = { kind: "all", glaze: "", clay: "" }; render(); }
    else if (t.dataset.kind) { state.filter.kind = t.dataset.kind; render(); }
    else if ("gtype" in t.dataset) { state.glazeFilter = t.dataset.gtype; render(); }
    else if (t.dataset.log) openDetail(t.dataset.log);
    else if (t.dataset.glaze) openGlazeForm(t.dataset.glaze);
    else if (t.dataset.remove) {
      const key = t.dataset.remove, next = clone(state.lists);
      next[key].splice(+t.dataset.i, 1);
      saveLists(next);
    }
  });
  $("#view").addEventListener("input", (e) => {
    if (e.target.id === "glazeSearch") { state.glazeSearch = e.target.value; render(); }
  });
  $("#view").addEventListener("change", (e) => {
    if (e.target.id === "fGlaze") { state.filter.glaze = e.target.value; render(); }
    if (e.target.id === "fClay") { state.filter.clay = e.target.value; render(); }
  });
  $("#view").addEventListener("submit", (e) => {
    const f = e.target.closest("[data-addlist]");
    if (!f) return;
    e.preventDefault();
    const key = f.dataset.addlist, input = f.querySelector("input"), val = input.value.trim();
    if (!val) return;
    if (!state.lists[key].some((x) => x.toLowerCase() === val.toLowerCase())) {
      const next = clone(state.lists); next[key].push(val); saveLists(next);
    }
    input.value = "";
  });

  // ---------- dialogs ----------
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });

  // Select with "+ Add new…" option backed by a list.
  function fillListSelect(sel, value) {
    const key = sel.dataset.list, items = [...state.lists[key]];
    if (value && !items.includes(value)) items.push(value);
    sel.innerHTML = `<option value="" disabled ${value ? "" : "selected"}>Choose…</option>` + items.map((i) => `<option ${i === value ? "selected" : ""}>${esc(i)}</option>`).join("") + `<option value="__new">+ Add new ${LIST_LABELS[key]}…</option>`;
    sel.dataset.prev = value || "";
  }
  function refreshListSelects() { document.querySelectorAll("select[data-list]").forEach((s) => { if (s.value !== "__new") fillListSelect(s, s.value); }); }
  document.querySelectorAll("select[data-list]").forEach((sel) => {
    const row = document.createElement("div");
    row.className = "add-row"; row.hidden = true;
    row.innerHTML = `<input type="text" id="${sel.id}-new" aria-label="New ${LIST_LABELS[sel.dataset.list]}" placeholder="New ${LIST_LABELS[sel.dataset.list]}"><button type="button" class="btn small">Add</button>`;
    sel.after(row);
    const input = row.querySelector("input");
    const commit = () => {
      const val = input.value.trim();
      if (!val) return;
      const key = sel.dataset.list;
      const existing = state.lists[key].find((x) => x.toLowerCase() === val.toLowerCase());
      if (!existing) { const next = clone(state.lists); next[key].push(val); saveLists(next); }
      fillListSelect(sel, existing || val);
      sel.dispatchEvent(new Event("input"));
      row.hidden = true; input.value = "";
    };
    row.querySelector("button").addEventListener("click", commit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
    sel.addEventListener("change", () => {
      if (sel.value === "__new") { sel.value = sel.dataset.prev; row.hidden = false; input.focus(); }
      else { sel.dataset.prev = sel.value; row.hidden = true; }
    });
  });

  // ----- glaze form -----
  let editingGlaze = null;
  function updateGlazePreview() {
    const c = $("#gfColor").value;
    $("#gfPreview").innerHTML = tileSvg(c, $("#gfType").value);
    $("#gfHex").textContent = c.toUpperCase();
  }
  function openGlazeForm(id) {
    const g = id ? glazeById(id) : null;
    editingGlaze = g;
    $("#glazeDlgTitle").textContent = g ? "Edit glaze" : "New glaze";
    fillListSelect($("#gfBrand"), g?.brand || "");
    fillListSelect($("#gfType"), g?.type || "");
    $("#gfName").value = g?.name || "";
    $("#gfCode").value = g?.code || "";
    $("#gfLine").value = g?.line || "";
    refreshLineSuggestions();
    $("#gfDesc").value = g?.description || "";
    $("#gfUrl").value = g?.sourceUrl || "";
    $("#gfColor").value = g?.color || "#5f8f86";
    glazeDraft = { image: g?.image || null, sourceUrl: g?.sourceUrl || "" };
    showFetchStatus("");
    renderGlazeImage();
    const n = g ? usageCount("glaze", g.id) : 0;
    $("#gfUsage").hidden = !g; $("#gfUsage").textContent = n ? `Used in ${n} log entr${n === 1 ? "y" : "ies"}.` : "Not used in any log entries yet.";
    $("#gfDelete").hidden = !g; disarm($("#gfDelete"));
    $("#gfShow").hidden = !n;
    setStatus("#glazeStatus", "");
    document.querySelectorAll("#glazeDlg .add-row").forEach((r) => (r.hidden = true));
    updateGlazePreview();
    $("#glazeDlg").showModal();
    if (!g) $("#gfName").focus();
  }
  $("#gfColor").addEventListener("input", updateGlazePreview);
  $("#gfType").addEventListener("change", updateGlazePreview);
  $("#gfBrand").addEventListener("change", refreshLineSuggestions);
  $("#gfBrand").addEventListener("input", refreshLineSuggestions);
  $("#gfType").addEventListener("input", updateGlazePreview);
  $("#glazeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { brand: $("#gfBrand").value, type: $("#gfType").value, name: $("#gfName").value.trim(), code: $("#gfCode").value.trim(), line: $("#gfLine").value.trim(), color: $("#gfColor").value, description: $("#gfDesc").value.trim(), image: glazeDraft.image, sourceUrl: glazeDraft.sourceUrl };
    if (!data.brand || data.brand === "__new") return setStatus("#glazeStatus", "Choose a brand.", true);
    if (!data.name) return setStatus("#glazeStatus", "Give the glaze a name.", true);
    if (!data.type || data.type === "__new") return setStatus("#glazeStatus", "Choose a type.", true);
    data.createdAt = editingGlaze?.createdAt || Date.now();
    setStatus("#glazeStatus", "Saving…");
    try { await store.save("glazes", editingGlaze?.id || null, data); ensureInList("brands", data.brand); $("#glazeDlg").close(); }
    catch (err) { setStatus("#glazeStatus", "Couldn't save: " + (err?.message || "try again."), true); }
  });
  $("#gfDelete").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains("armed")) {
      const n = usageCount("glaze", editingGlaze.id);
      arm(b, n ? `Delete (used in ${n})` : "Confirm delete");
      return;
    }
    try { await store.remove("glazes", editingGlaze.id); $("#glazeDlg").close(); }
    catch (err) { setStatus("#glazeStatus", "Couldn't delete: " + (err?.message || "try again."), true); }
  });
  $("#gfShow").addEventListener("click", () => {
    state.filter = { kind: "all", glaze: editingGlaze.id, clay: "" };
    $("#glazeDlg").close();
    location.hash = "log"; route();
  });

  // ----- importing from product pages -----
  let glazeDraft = { image: null, sourceUrl: "" };
  function ensureInList(key, value) {
    if (value && !state.lists[key].some((x) => x.toLowerCase() === value.toLowerCase())) {
      const next = clone(state.lists); next[key].push(value); saveLists(next);
    }
  }
  function showFetchStatus(text, err) {
    const s = $("#gfFetchStatus"); s.textContent = text; s.hidden = !text; s.classList.toggle("err", !!err);
  }
  function renderGlazeImage() {
    const has = hasPhoto(glazeDraft.image);
    $("#gfImageField").hidden = !has;
    $("#gfPick").hidden = !has;
    if (has) { $("#gfImage").dataset.pid = glazeDraft.image.id || ""; $("#gfImage").src = photoSrc(glazeDraft.image); }
    const src = $("#gfSource");
    src.hidden = !glazeDraft.sourceUrl;
    if (glazeDraft.sourceUrl) {
      let host = glazeDraft.sourceUrl;
      try { host = new URL(glazeDraft.sourceUrl).hostname.replace(/^www\./, ""); } catch {}
      src.innerHTML = `From <a href="${esc(glazeDraft.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a>`;
    }
  }
  // Most common color in the middle of the image, ignoring a white backdrop.
  function colorFromImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.onload = () => {
        try {
          const N = 64, c = document.createElement("canvas"); c.width = c.height = N;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, N, N);
          const d = ctx.getImageData(0, 0, N, N).data;
          const glaze = new Map(), every = new Map();
          const add = (m, k, r, g, b) => { const e = m.get(k) || { n: 0, r: 0, g: 0, b: 0 }; e.n++; e.r += r; e.g += g; e.b += b; m.set(k, e); };
          for (let y = Math.floor(N * 0.2); y < N * 0.8; y++) for (let x = Math.floor(N * 0.2); x < N * 0.8; x++) {
            const i = (y * N + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
            if (d[i + 3] < 128) continue;
            const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
            add(every, k, r, g, b);
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (!(max > 232 && max - min < 20)) add(glaze, k, r, g, b);
          }
          const total = (m) => [...m.values()].reduce((s, e) => s + e.n, 0);
          const pool = total(glaze) > total(every) * 0.15 ? glaze : every;
          const best = [...pool.values()].sort((p, q) => q.n - p.n)[0];
          if (!best) return resolve(null);
          resolve("#" + [best.r, best.g, best.b].map((v) => Math.round(v / best.n).toString(16).padStart(2, "0")).join(""));
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  $("#gfFetch").addEventListener("click", async () => {
    const url = $("#gfUrl").value.trim();
    if (!url) { showFetchStatus("Paste a product page link first.", true); return; }
    const btn = $("#gfFetch"); btn.disabled = true;
    showFetchStatus("Reading the product page…");
    try {
      const r = await store.importPage(url);
      if (r.brand) fillListSelect($("#gfBrand"), r.brand);
      $("#gfName").value = r.name || $("#gfName").value;
      $("#gfCode").value = r.code || "";
      if (r.description) $("#gfDesc").value = r.description;
      glazeDraft = { image: r.image || glazeDraft.image, sourceUrl: r.sourceUrl || url };
      renderGlazeImage();
      const color = await colorFromImage(await photoUrl(r.image));
      if (color) $("#gfColor").value = color;
      updateGlazePreview();
      const missing = [];
      if (!$("#gfType").value) missing.push("pick a type");
      if (color) missing.push("check the color");
      showFetchStatus(`Filled in ${[r.code, r.name].filter(Boolean).join(" ")}${r.imageNote ? ". " + r.imageNote : ""}${missing.length ? ". Please " + missing.join(" and ") + "." : "."}`);
    } catch (err) {
      showFetchStatus("Couldn't fill in from that link: " + (err?.message || "try again."), true);
    } finally { btn.disabled = false; }
  });
  $("#gfUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#gfFetch").click(); } });
  $("#gfPick").addEventListener("click", async () => {
    const color = await colorFromImage(await photoUrl(glazeDraft.image));
    if (color) { $("#gfColor").value = color; updateGlazePreview(); }
  });
  $("#gfImageRemove").addEventListener("click", () => { glazeDraft.image = null; renderGlazeImage(); });

  // ----- product line suggestions -----
  let linesByBrandCache = null;
  async function refreshLineSuggestions() {
    const brand = $("#gfBrand").value;
    const fill = (remote) => {
      const own = state.glazes.filter((g) => g.brand === brand && g.line).map((g) => g.line);
      const all = [...new Set([...(remote?.[brand] || []), ...own])].sort(byText);
      $("#gfLineList").innerHTML = all.map((l) => `<option value="${esc(l)}"></option>`).join("");
    };
    fill(linesByBrandCache);
    if (!linesByBrandCache) {
      try { linesByBrandCache = await store.get("/api/catalog/lines-by-brand"); fill(linesByBrandCache); } catch {}
    }
  }

  // ----- manufacturer catalogs -----
  const catalog = { sources: null, items: [], line: null, busy: false };
  const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  function inCatalog(item) {
    const url = (item.url || "").replace(/\/$/, "");
    return state.glazes.find((g) =>
      (g.sourceUrl && g.sourceUrl.replace(/\/$/, "") === url) ||
      (item.code && g.code && g.code.toUpperCase() === item.code.toUpperCase() && flat(g.brand) === flat(item.brand)) ||
      (!item.code && flat(g.brand) === flat(item.brand) && flat(g.name) === flat(item.name)));
  }
  function ctMsg(t, err) { const m = $("#ctMsg"); m.textContent = t; m.style.color = err ? "var(--danger)" : ""; }
  async function openCatalog() {
    $("#ctType").innerHTML = `<option value="">Set later</option>` + state.lists.types.map((t) => `<option>${esc(t)}</option>`).join("");
    setStatus("#ctStatus", "");
    $("#catalogDlg").showModal();
    if (!catalog.sources) {
      ctMsg("Loading manufacturers…");
      try { catalog.sources = await store.get("/api/catalog"); }
      catch (e) { ctMsg("Couldn't load the catalogs: " + e.message, true); return; }
      $("#ctSource").innerHTML = `<option value="" selected disabled>Choose…</option>` + catalog.sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
      ctMsg("Pick a manufacturer, then a product line to see its glazes.");
    }
  }
  $("#ctSource").addEventListener("change", async () => {
    const id = $("#ctSource").value, sel = $("#ctLine");
    sel.disabled = true; sel.innerHTML = `<option>Loading lines…</option>`;
    catalog.items = []; renderCatalogItems();
    ctMsg(`Reading ${$("#ctSource").selectedOptions[0].text} product lines…`);
    try {
      const lines = await store.get(`/api/catalog/${id}/lines`);
      sel.innerHTML = `<option value="" selected disabled>Choose a line…</option>` + lines.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}${l.count != null ? ` (${l.count})` : ""}</option>`).join("");
      sel.disabled = false;
      ctMsg(id === "freeform" ? "Free Form is a store: glazes it sells from Mayco or Amaco are filed under that manufacturer when the code and name match." : "");
    } catch (e) { sel.innerHTML = `<option>Unavailable</option>`; ctMsg("Couldn't read the product lines: " + e.message, true); }
  });
  $("#ctLine").addEventListener("change", async () => {
    const src = $("#ctSource").value, line = $("#ctLine").value;
    catalog.items = []; renderCatalogItems();
    ctMsg("Loading glazes… the first look at a catalog can take a few seconds.");
    try {
      catalog.items = (await store.get(`/api/catalog/${src}/lines/${encodeURIComponent(line)}`)).map((it) => ({ ...it, selected: false, status: "" }));
      $("#ctSearch").value = "";
      ctMsg(catalog.items.length ? "" : "No glazes found in this line.");
      renderCatalogItems();
    } catch (e) { ctMsg("Couldn't load this line: " + e.message, true); }
  });
  function visibleItems() {
    const q = $("#ctSearch").value.trim().toLowerCase();
    return catalog.items.filter((it) => !q || `${it.code} ${it.name} ${it.line} ${it.brand}`.toLowerCase().includes(q));
  }
  function renderCatalogItems() {
    const shown = visibleItems();
    $("#ctTools").hidden = !catalog.items.length;
    $("#ctTypeField").hidden = !catalog.items.length;
    const lineName = $("#ctLine").selectedOptions[0]?.text.replace(/\s\(\d+\)$/, "") || "";
    $("#ctItems").innerHTML = shown.map((it, i) => {
      const have = inCatalog(it);
      const idx = catalog.items.indexOf(it);
      const other = (it.line && it.line !== lineName) || it.brand !== ($("#ctSource").value === "freeform" ? "Freeform" : it.brand) ? `<div class="b">${esc([it.brand, it.line].filter(Boolean).join(" · "))}</div>` : "";
      const st = it.status === "ok" ? `<span class="st ok">Added</span>` : it.status === "busy" ? `<span class="st">…</span>` : it.status ? `<span class="st bad" title="${esc(it.status)}">Failed</span>` : have ? `<span class="st">In catalog</span>` : "";
      return `<label class="ct-item${have ? " have" : ""}"><input type="checkbox" data-i="${idx}" ${it.selected && !have ? "checked" : ""} ${have || catalog.busy ? "disabled" : ""} aria-label="${esc([it.code, it.name].filter(Boolean).join(" "))}">${st}
        <div class="ph">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(it.code || it.name.slice(0, 2))}</div>
        ${it.code ? `<div class="c">${esc(it.code)}</div>` : ""}<div class="n">${esc(it.name)}</div>${other}</label>`;
    }).join("");
    const selectable = shown.filter((it) => !inCatalog(it));
    const nSel = catalog.items.filter((it) => it.selected && !inCatalog(it)).length;
    $("#ctAll").checked = selectable.length > 0 && selectable.every((it) => it.selected);
    $("#ctCount").textContent = `${shown.length} shown · ${catalog.items.filter((it) => inCatalog(it)).length} already in catalog`;
    $("#ctGo").disabled = catalog.busy || !nSel;
    $("#ctGo").textContent = nSel ? `Import ${nSel} glaze${nSel === 1 ? "" : "s"}` : "Import selected";
  }
  $("#ctItems").addEventListener("change", (e) => {
    const i = e.target.dataset.i; if (i == null) return;
    catalog.items[+i].selected = e.target.checked; renderCatalogItems();
  });
  $("#ctSearch").addEventListener("input", renderCatalogItems);
  $("#ctAll").addEventListener("change", (e) => {
    visibleItems().forEach((it) => { if (!inCatalog(it)) it.selected = e.target.checked; });
    renderCatalogItems();
  });
  $("#catalogForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const queue = catalog.items.filter((it) => it.selected && !inCatalog(it));
    if (!queue.length) return;
    const type = $("#ctType").value;
    catalog.busy = true; renderCatalogItems();
    let done = 0, added = 0, failed = 0;
    const newBrands = new Set();
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        it.status = "busy"; renderCatalogItems();
        try {
          const r = await store.catalogItem(it);
          const color = (await colorFromImage(await photoUrl(r.image))) || "#888888";
          await store.save("glazes", null, { brand: r.brand || it.brand, line: r.line, code: r.code, name: r.name || it.name, type, color, description: r.description, image: r.image, sourceUrl: r.sourceUrl, createdAt: Date.now() }, { refresh: false });
          newBrands.add(r.brand || it.brand);
          it.status = "ok"; it.selected = false; added++;
        } catch (err) { it.status = err?.message || "Couldn't import"; failed++; }
        done++;
        setStatus("#ctStatus", `Imported ${done} of ${done + queue.length}…`);
        renderCatalogItems();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await store.refresh();
    const missing = [...newBrands].filter((b) => b && !state.lists.brands.some((x) => x.toLowerCase() === b.toLowerCase()));
    if (missing.length) { const next = clone(state.lists); next.brands.push(...missing); await saveLists(next); }
    catalog.busy = false;
    setStatus("#ctStatus", `Added ${added} glaze${added === 1 ? "" : "s"}${failed ? `, ${failed} failed (hover “Failed” for the reason)` : ""}.`, failed > 0);
    renderCatalogItems();
  });

  function openImport() {
    $("#imType").innerHTML = `<option value="">Set later</option>` + state.lists.types.map((t) => `<option>${esc(t)}</option>`).join("");
    $("#imResults").innerHTML = ""; $("#imResults").hidden = true;
    setStatus("#importStatus", "");
    $("#imGo").disabled = false;
    $("#importDlg").showModal();
    $("#imUrls").focus();
  }
  $("#importForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const urls = [...new Set($("#imUrls").value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
    if (!urls.length) { setStatus("#importStatus", "Paste at least one link that starts with https://", true); return; }
    const type = $("#imType").value;
    const list = $("#imResults"); list.hidden = false; list.innerHTML = "";
    $("#imGo").disabled = true;
    let added = 0, skipped = 0, failed = 0;
    for (const [i, url] of urls.entries()) {
      setStatus("#importStatus", `Importing ${i + 1} of ${urls.length}…`);
      const li = document.createElement("li");
      li.innerHTML = `<span>…</span><div><div class="t">Reading page</div><div class="u">${esc(url)}</div></div>`;
      list.append(li);
      const done = (mark, html) => { li.firstElementChild.textContent = mark; li.querySelector(".t").innerHTML = html; };
      try {
        const dupBySource = state.glazes.find((g) => g.sourceUrl && g.sourceUrl.replace(/\/$/, "") === url.replace(/\/$/, ""));
        if (dupBySource) { skipped++; done("–", `Already in catalog: ${esc(glazeLabel(dupBySource))}`); continue; }
        const r = await store.importPage(url);
        const dup = state.glazes.find((g) => g.brand.toLowerCase() === (r.brand || "").toLowerCase() &&
          (r.code ? (g.code || "").toUpperCase() === r.code : g.name.toLowerCase() === r.name.toLowerCase()));
        if (dup) { skipped++; done("–", `Already in catalog: ${esc(glazeLabel(dup))}`); continue; }
        const color = (await colorFromImage(await photoUrl(r.image))) || "#888888";
        await store.save("glazes", null, { brand: r.brand || "Unknown", name: r.name, code: r.code, type, color, description: r.description, image: r.image, sourceUrl: r.sourceUrl, createdAt: Date.now() });
        ensureInList("brands", r.brand);
        added++;
        done("✓", `<i class="dot" style="display:inline-block;vertical-align:-1px;background:${esc(color)}"></i> ${esc([r.brand, r.code, r.name].filter(Boolean).join(" · "))}${r.imageNote ? ` <span class="meta">(${esc(r.imageNote)})</span>` : ""}`);
      } catch (err) {
        failed++;
        done("✕", `<span class="err">${esc(err?.message || "Couldn't import this link.")}</span>`);
      }
    }
    setStatus("#importStatus", `Added ${added}${skipped ? `, skipped ${skipped} already in catalog` : ""}${failed ? `, ${failed} failed` : ""}.`, failed > 0);
    $("#imGo").disabled = false;
    if (!failed) $("#imUrls").value = "";
  });

  function arm(b, label) { b.classList.add("armed"); b.dataset.label = b.dataset.label || b.textContent; b.textContent = label; }
  function disarm(b) { b.classList.remove("armed"); if (b.dataset.label) b.textContent = b.dataset.label; }
  function setStatus(sel, text, err) { const s = $(sel); s.textContent = text; s.classList.toggle("err", !!err); }

  // ----- log form -----
  let editingLog = null;
  const pendingPhotos = { pre: undefined, post: undefined }; // undefined = unchanged, null = removed, File = new

  // Every whitespace-separated term must appear somewhere in the glaze's brand, line, code, name, or type.
  function glazeMatches(g, query) {
    const hay = [g.brand, g.line, g.code, g.name, g.type].filter(Boolean).join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }
  function glazeOptions(selected, query = "") {
    const sorted = [...state.glazes].filter((g) => glazeMatches(g, query)).sort((a, b) => byText(glazeLabel(a), glazeLabel(b)));
    let opts = `<option value="" disabled ${selected ? "" : "selected"}>${query && !sorted.length ? "No glazes match" : "Choose a glaze…"}</option>`;
    if (selected && !glazeById(selected)) opts += `<option value="${esc(selected)}" selected>Deleted glaze</option>`;
    const brands = [...new Set(sorted.map((g) => g.brand))].sort(byText);
    return opts + brands.map((b) => `<optgroup label="${esc(b)}">${sorted.filter((g) => g.brand === b).sort((x, y) => byText(x.line || "", y.line || "") || (x.code || "").localeCompare(y.code || "", undefined, { numeric: true }) || byText(x.name, y.name)).map((g) => `<option value="${esc(g.id)}" ${g.id === selected ? "selected" : ""}>${esc([g.code, g.name].filter(Boolean).join(" "))}${g.line ? ` · ${esc(g.line)}` : ""}${g.type ? ` (${esc(g.type)})` : ""}</option>`).join("")}</optgroup>`).join("");
  }
  let rowSeq = 0;
  function addGlazeRow(item = {}) {
    const i = rowSeq++;
    const row = document.createElement("div");
    row.className = "glaze-row";
    row.dataset.snapshot = JSON.stringify(item);
    const color = item.glazeId ? resolveGlaze(item).color : "transparent";
    row.innerHTML = `<div class="top"><i class="dot" style="width:18px;height:18px;background:${esc(color)}"></i>
      <input type="search" id="gr-search-${i}" class="glaze-search" aria-label="Search glazes" aria-controls="gr-glaze-${i}" placeholder="Search glazes by name, code, brand, or line" autocomplete="off">
      <button type="button" class="x" aria-label="Remove this glaze">×</button></div>
      <select id="gr-glaze-${i}" aria-label="Glaze">${glazeOptions(item.glazeId)}</select>
      <textarea id="gr-app-${i}" rows="2" aria-label="How it was applied" placeholder="How it was applied: e.g. 3 brushed coats, dipped 2 s, sprayed over rim, wax resist foot…">${esc(item.application || "")}</textarea>`;
    const sel = row.querySelector("select"), search = row.querySelector(".glaze-search");
    const syncDot = () => { const g = glazeById(sel.value); row.querySelector(".dot").style.background = g ? g.color : "transparent"; };
    sel.addEventListener("change", syncDot);
    // Narrow the dropdown as you type; if the current pick is filtered out, take the first match so Tab moves on with it.
    search.addEventListener("input", () => {
      const keep = sel.value;
      sel.innerHTML = glazeOptions(keep, search.value);
      const opts = [...sel.options].filter((o) => o.value && !o.disabled);
      if (opts.some((o) => o.value === keep)) sel.value = keep;
      else if (opts.length) sel.value = opts[0].value;
      syncDot();
    });
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sel.focus(); } });
    row.querySelector(".x").addEventListener("click", () => row.remove());
    $("#glazeRows").append(row);
    return row;
  }
  $("#addGlazeRow").addEventListener("click", () => {
    if (!state.glazes.length) { setStatus("#logStatus", "Your glaze catalog is empty. Add glazes on the Glazes tab first.", true); return; }
    addGlazeRow().querySelector(".glaze-search").focus();
  });

  function photoField(key, label, existing) {
    const url = Boolean(existing?.id);
    return `<div class="field"><span class="label">${label}</span>
      <label class="drop" id="drop-${key}">${url ? photoImg(existing, 'alt=""') : ""}
        <span>${url ? "" : "Add photo<br><small>Tap to choose or take one</small>"}</span>
        <input type="file" accept="image/*" id="file-${key}" data-photo="${key}">
        ${url ? `<button type="button" class="btn small clear" data-clear="${key}">Remove</button>` : ""}
      </label></div>`;
  }
  function renderPhotoFields(l) {
    if (!state.canUpload) { $("#photoFields").innerHTML = `<p class="meta">Only editors of this page can add photos.</p>`; return; }
    $("#photoFields").innerHTML = photoField("pre", "Before firing", l?.pre) + photoField("post", "After firing", l?.post);
  }
  $("#photoFields").addEventListener("change", (e) => {
    const key = e.target.dataset.photo, file = e.target.files?.[0];
    if (!key || !file) return;
    pendingPhotos[key] = file;
    const drop = $("#drop-" + key);
    drop.querySelector("img")?.remove();
    drop.querySelector("span").innerHTML = "";
    const img = document.createElement("img"); img.alt = ""; img.src = URL.createObjectURL(file);
    drop.prepend(img);
    if (!drop.querySelector(".clear")) drop.insertAdjacentHTML("beforeend", `<button type="button" class="btn small clear" data-clear="${key}">Remove</button>`);
  });
  $("#photoFields").addEventListener("click", (e) => {
    const key = e.target.dataset?.clear;
    if (!key) return;
    e.preventDefault();
    pendingPhotos[key] = null;
    const drop = $("#drop-" + key);
    drop.querySelector("img")?.remove();
    e.target.remove();
    drop.querySelector("input").value = "";
    drop.querySelector("span").innerHTML = "Add photo<br><small>Tap to choose or take one</small>";
  });

  function openLogForm(id) {
    const l = id ? state.logs.find((x) => x.id === id) : null;
    editingLog = l;
    pendingPhotos.pre = undefined; pendingPhotos.post = undefined;
    $("#logDlgTitle").textContent = l ? "Edit log entry" : "New log entry";
    (l?.kind === "tile" ? $("#kindTile") : $("#kindPiece")).checked = true;
    $("#lfTitle").value = l?.title || "";
    $("#lfDate").value = l?.date || today();
    fillListSelect($("#lfClay"), l?.clay || state.lists.clays[0] || "");
    $("#lfFiring").value = l?.firing ?? (state.logs.length ? sortedLogs()[0].firing || "" : "");
    $("#lfNotes").value = l?.notes || "";
    $("#glazeRows").innerHTML = "";
    (l?.glazes || []).forEach((g) => addGlazeRow(g));
    if (!l && state.glazes.length) addGlazeRow();
    renderPhotoFields(l);
    setStatus("#logStatus", state.glazes.length ? "" : "Tip: add glazes on the Glazes tab to pick them here.");
    $("#logSave").disabled = false;
    document.querySelectorAll("#logDlg .add-row").forEach((r) => (r.hidden = true));
    $("#logDlg").showModal();
  }

  $("#logForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const glazes = [...$("#glazeRows").children].map((row) => {
      const glazeId = row.querySelector("select").value;
      if (!glazeId) return null;
      const g = glazeById(glazeId);
      const prev = JSON.parse(row.dataset.snapshot || "{}");
      const snap = g ? { name: g.name, brand: g.brand, type: g.type, color: g.color } : { name: prev.name || "", brand: prev.brand || "", type: prev.type || "", color: prev.color || "" };
      return { glazeId, application: row.querySelector("textarea").value.trim(), ...snap };
    }).filter(Boolean);
    const clay = $("#lfClay").value === "__new" ? "" : $("#lfClay").value;
    const data = {
      kind: $("#kindPiece").checked ? "piece" : "tile",
      title: $("#lfTitle").value.trim(),
      date: $("#lfDate").value || today(),
      clay,
      firing: $("#lfFiring").value.trim(),
      glazes,
      notes: $("#lfNotes").value.trim(),
      pre: editingLog?.pre || null,
      post: editingLog?.post || null,
      createdAt: editingLog?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    $("#logSave").disabled = true;
    const toDelete = [];
    try {
      for (const key of ["pre", "post"]) {
        const p = pendingPhotos[key];
        if (p === undefined) continue;
        if (data[key]?.id) toDelete.push(data[key].id);
        if (p === null) { data[key] = null; continue; }
        setStatus("#logStatus", `Uploading ${key === "pre" ? "before" : "after"}-firing photo…`);
        data[key] = await store.upload(await shrink(p));
      }
      setStatus("#logStatus", "Saving…");
      await store.save("logs", editingLog?.id || null, data);
      toDelete.forEach((id) => store.deleteAsset(id));
      $("#logDlg").close();
    } catch (err) {
      setStatus("#logStatus", "Couldn't save: " + (err?.message || "try again."), true);
      $("#logSave").disabled = false;
    }
  });

  // ----- detail -----
  let viewingId = null;
  function openDetail(id) {
    const l = state.logs.find((x) => x.id === id);
    if (!l) return;
    viewingId = id;
    $("#vTitle").textContent = l.title || (l.kind === "piece" ? "Untitled piece" : "Untitled tile");
    const fig = (p, cap) => `<figure><figcaption>${cap}</figcaption><div class="photo">${p?.id ? photoImg(p, `alt="${cap} photo"`) : "No photo"}</div></figure>`;
    const glazes = (l.glazes || []).map((x) => ({ ...resolveGlaze(x), application: x.application }));
    $("#vBody").innerHTML = `
      <div class="detail-photos">${fig(l.pre, "Before firing")}${fig(l.post, "After firing")}</div>
      <dl class="dl">
        <dt>Type</dt><dd>${l.kind === "piece" ? "Piece" : "Test tile"}</dd>
        <dt>Date</dt><dd>${esc(fmtDate(l.date))}</dd>
        <dt>Clay body</dt><dd>${esc(l.clay || "—")}</dd>
        ${l.firing ? `<dt>Firing</dt><dd>${esc(l.firing)}</dd>` : ""}
      </dl>
      <div class="field"><span class="label">Glazes</span>${glazes.length ? `<ol class="applied">${glazes.map((g) => `<li><svg viewBox="0 0 60 80" aria-hidden="true">${tileSvg(g.color, g.type)}</svg><div><div><strong>${esc(g.name)}</strong> <span class="meta">${esc(g.brand)}${g.type ? " · " + esc(g.type) : ""}${g.live ? "" : " · removed from catalog"}</span></div>${g.application ? `<div class="how">${esc(g.application)}</div>` : ""}</div></li>`).join("")}</ol>` : `<p class="meta" style="margin:0">No glazes recorded.</p>`}</div>
      ${l.notes ? `<div class="field"><span class="label">Notes</span><p class="notes">${esc(l.notes)}</p></div>` : ""}`;
    disarm($("#vDelete"));
    $("#viewDlg").showModal();
  }
  $("#vEdit").addEventListener("click", () => { $("#viewDlg").close(); openLogForm(viewingId); });
  $("#vDelete").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains("armed")) { arm(b, "Confirm delete"); return; }
    const l = state.logs.find((x) => x.id === viewingId);
    try {
      await store.remove("logs", viewingId);
      [l?.pre?.id, l?.post?.id].forEach((id) => id && store.deleteAsset(id));
      $("#viewDlg").close();
    } catch (err) { b.textContent = "Couldn't delete"; }
  });

  // ---------- boot ----------
  async function boot() {
    if (hasIdCallback()) try { await finishIdSignIn(api); } catch (e) { state.authError = e.message || "Sign-in failed."; }
    $("#signOut").addEventListener("click", signOut);
    store = apiStore();
    store.watch("config", (cfg) => {
      state.lists = cfg ? { brands: cfg.brands || [], types: cfg.types || [], clays: cfg.clays || [] } : clone(DEFAULTS);
      render(); refreshListSelects();
    });
    store.watch("glazes", (g) => { state.glazes = g; state.loaded.glazes = true; render(); });
    store.watch("logs", (l) => { state.logs = l; state.loaded.logs = true; render(); });
    render();
    await store.refresh();
    // Pick up changes made on another device.
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.auth === "in") store.refresh(); });
    setInterval(() => { if (!document.hidden && state.auth === "in" && !document.querySelector("dialog[open]")) store.refresh(); }, 60000);
  }
  route();
  boot();
})();
