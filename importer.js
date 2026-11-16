// Reads a glaze's name, code, brand, description and product image from a manufacturer's product page.
// Uses JSON-LD product data first, then Open Graph / page metadata, with small per-site adjustments.
import dns from "node:dns/promises";
import net from "node:net";

const UA = "Mozilla/5.0 (compatible; GlazeJournal/1.0; personal glaze catalog)";
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 15000;

export class ImportError extends Error { constructor(message, status = 422) { super(message); this.status = status; } }

// ---------- safe fetching (public hosts only, redirects re-checked) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}
async function assertPublicUrl(u) {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ImportError("Use a link that starts with http:// or https://.", 400);
  if (u.username || u.password) throw new ImportError("Links with a username or password aren't supported.", 400);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); }
  catch { throw new ImportError(`Couldn't find the site ${u.hostname}. Check the link.`); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ImportError("That link points to a private network address.", 400);
}
export async function safeFetch(rawUrl, accept) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new ImportError("That doesn't look like a web address.", 400); }
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(u);
    let res;
    try {
      res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": UA, Accept: accept } });
    } catch (e) {
      throw new ImportError(e?.name === "TimeoutError" ? `${u.hostname} took too long to respond.` : `Couldn't connect to ${u.hostname}.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location"), u);
      continue;
    }
    if (res.status === 404) throw new ImportError("That page wasn't found on the manufacturer's site (404). Check the link.");
    if (!res.ok) throw new ImportError(`${u.hostname} answered with an error (${res.status}).`);
    return { res, url: u };
  }
  throw new ImportError("That link redirects too many times.");
}
export async function readLimited(res, limit, tooBig) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > limit) throw new ImportError(tooBig);
  const chunks = []; let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > limit) throw new ImportError(tooBig);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---------- HTML parsing ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", reg: "®", trade: "™", deg: "°" };
function decode(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export const text = (html) => decode(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}
function metaTags(html) {
  const list = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || "").toLowerCase();
    if (key && a.content) list.push([key, a.content.trim()]);
  }
  return list;
}
function jsonLdItems(html) {
  const items = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (v["@graph"]) walk(v["@graph"]);
    if (v["@type"]) items.push(v);
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch {}
  }
  return items;
}
const hasType = (it, t) => [].concat(it["@type"]).includes(t);
const firstImage = (img) => (Array.isArray(img) ? firstImage(img[0]) : typeof img === "object" && img ? img.url || img.contentUrl || "" : img || "");

// "PC-20", "SW-104", "V-360", "WC-110", "C-41", "FN-001", "S2101"
const CODE_RE = /^([A-Z]{1,4}-?\d{1,5}[A-Z]?)\b[\s:–—-]*(.*)$/i;
function splitCode(s) {
  const m = CODE_RE.exec(s.trim());
  return m && /\d/.test(m[1]) ? { code: m[1].toUpperCase(), name: m[2].trim() } : { code: "", name: s.trim() };
}
function stripSiteSuffix(title, siteNames) {
  let t = title;
  for (const sn of siteNames.filter(Boolean)) {
    const esc = sn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*[|–—-]\\s*${esc}\\s*$`, "i"), "");
  }
  return t.replace(/\s*\|\s*[^|]{2,60}$/, "").trim();
}

const SITES = [
  { match: /(^|\.)maycocolors\.com$/, brand: () => "Mayco", codeFromPath: /\/product\/([a-z]{1,4}-\d{1,5}[a-z]?)-/i },
  { match: /(^|\.)amaco\.com$/, brand: (code) => (/^V-\d/.test(code) ? "Velvet Underglaze" : "Amaco"), cleanName: (n, code) => (/^V-\d/.test(code) ? n.replace(/\s+underglaze$/i, "") : n) },
  { match: /(^|\.)freeformclay\.com$/, brand: () => "Freeform", preferH1: true },
];

// Stand-in images sites show before a real photo exists.
const PLACEHOLDER_IMAGE = /coming[\s%20_-]*soon|empty[-_]?state|placeholder|no[-_]?image|image[-_]?not[-_]?available/i;
// Ask image CDNs for a reasonable size instead of multi-megapixel originals.
function sizedImage(u) {
  return u.replace(/(static\.wixstatic\.com\/media\/[^/]+\/v1\/fill\/)w_(\d+),h_(\d+)/, (m, pre, w, h) => {
    const s = Math.min(1, 1200 / Math.max(+w, +h));
    return `${pre}w_${Math.round(w * s)},h_${Math.round(h * s)}`;
  });
}
export { PLACEHOLDER_IMAGE };

export async function importProduct(rawUrl) {
  const { res, url } = await safeFetch(String(rawUrl || "").trim(), "text/html,application/xhtml+xml");
  const type = res.headers.get("content-type") || "";
  if (!/html/i.test(type)) throw new ImportError("That link isn't a web page. Paste the glaze's product page link.");
  const html = (await readLimited(res, MAX_HTML_BYTES, "That page is too large to read.")).toString("utf8");

  const site = SITES.find((s) => s.match.test(url.hostname)) || {};
  const metas = metaTags(html);
  const metaAll = (k) => metas.filter(([key]) => key === k).map(([, v]) => v);
  const metaLast = (k) => metaAll(k).at(-1) || "";
  const ld = jsonLdItems(html);
  const product = ld.find((it) => hasType(it, "Product")) || {};
  const page = ld.find((it) => hasType(it, "WebPage")) || {};
  const siteName = metaLast("og:site_name") || ld.find((it) => hasType(it, "WebSite"))?.name || "";
  const h1 = text((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || "");
  const title = text((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");

  // Name: structured data, then og:title, then heading, then <title>. A bare code ("WC-110") defers to a fuller candidate.
  const candidates = [product.name, metaLast("og:title"), h1, title].map((c) => stripSiteSuffix(text(c || ""), [siteName, url.hostname.replace(/^www\./, "")])).filter(Boolean);
  if (site.preferH1 && h1) candidates.unshift(h1);
  let picked = candidates[0] || "";
  if (splitCode(picked).code && !splitCode(picked).name) picked = candidates.find((c) => c.toUpperCase().startsWith(splitCode(picked).code) && splitCode(c).name) || picked;
  let { code, name } = splitCode(picked);
  if (!code && site.codeFromPath) { const m = site.codeFromPath.exec(url.pathname); if (m) code = m[1].toUpperCase(); }
  if (!code && product.sku && /\d/.test(product.sku) && String(product.sku).length <= 12) code = String(product.sku).toUpperCase();
  if (site.cleanName) name = site.cleanName(name, code);
  if (!name) throw new ImportError("Couldn't find a glaze name on that page. Is it a single product page?");

  const brandName = typeof product.brand === "object" ? product.brand?.name : product.brand;
  const brand = site.brand ? site.brand(code) : text(brandName || siteName || "");

  // Image: product data, then the page's primary image, then og/twitter images (skipping site logos).
  const ogImages = metaAll("og:image").filter((u) => !/logo|favicon|icon/i.test(u));
  let image = [firstImage(product.image), page.thumbnailUrl, ogImages.at(-1), metaLast("twitter:image")].find((u) => u && !PLACEHOLDER_IMAGE.test(u)) || "";
  if (image) { try { image = sizedImage(new URL(image, url).href); } catch { image = ""; } }

  const generic = /since \d{4}|official site|shop now/i;
  const description = [product.description, metaLast("og:description"), metaLast("description")].map((d) => text(d || "")).find((d) => d && d.length > 20 && !generic.test(d)) || "";

  return { name, code, brand, description: description.slice(0, 2000), imageUrl: image, sourceUrl: url.href };
}

export async function fetchImage(imageUrl) {
  const { res } = await safeFetch(imageUrl, "image/avif,image/webp,image/png,image/jpeg,image/*");
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const buf = await readLimited(res, MAX_IMAGE_BYTES, "The product image is too large.");
  return { type, buf };
}
