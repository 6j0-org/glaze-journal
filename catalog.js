// Browses manufacturers' real product lines so whole lines can be imported.
//   Mayco     – WooCommerce Store API (public JSON): lines = "Color > Fired" categories.
//   Amaco     – line names from the amaco.com menu; glazes from the shop's product sitemap by code prefix.
//   Free Form – the store's public glaze list pages. Codes that exist in the Mayco or Amaco
//               catalogs are filed under that manufacturer, with its line and product data.
import { safeFetch, readLimited, text, importProduct, ImportError } from "./importer.js";

const DAY = 24 * 3600 * 1000;
const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttl)) return hit.value;
  const value = fn().then(
    (v) => { cache.set(key, { at: Date.now(), value: Promise.resolve(v) }); return v; },
    (e) => { cache.delete(key); throw e; },
  );
  cache.set(key, { pending: true, value });
  return value;
}
async function getBody(url, accept, limit = 25 * 1024 * 1024) {
  const { res } = await safeFetch(url, accept);
  return { body: (await readLimited(res, limit, "The manufacturer's response was too large.")).toString("utf8"), headers: res.headers };
}
async function getJson(url) {
  const { body, headers } = await getBody(url, "application/json");
  try { return { data: JSON.parse(body), headers }; } catch { throw new ImportError("The manufacturer's catalog returned something unexpected."); }
}

export const normCode = (s) => {
  const m = /^([A-Za-z]{1,5})[-\s]?(\d{1,5}[A-Za-z]?)$/.exec(String(s || "").trim());
  return m ? `${m[1].toUpperCase()}-${m[2].toUpperCase()}` : "";
};
// Matching key: "SC-001", "SC-1" and "sc1" are the same product.
export const codeKey = (s) => normCode(s).replace(/-0+(?=\d)/, "-");
const words = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// Names agree when one's words are all in the other ("Black Designer Liner" ~ "Designer Liner Black").
const namesAgree = (a, b) => { const x = words(a), y = words(b); if (!x.length || !y.length) return true; const [s1, l1] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)]; return s1.every((w) => l1.has(w)); };
const cleanName = (s) => text(s).replace(/[™®©]/g, "").replace(/\s+-\s+NEW!?$/i, "").replace(/\s+/g, " ").trim();
const titleCase = (slug) => slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// ---------------- Mayco ----------------
const MAYCO_API = "https://www.maycocolors.com/wp-json/wc/store/v1";
const MAYCO_FIRED = 98;
const MAYCO_SKIP = /kit|accessor|discontinued|new colors/i;

async function maycoCategories() {
  return cached("mayco:cats", DAY, async () => (await getJson(`${MAYCO_API}/products/categories?per_page=100`)).data);
}
async function maycoProducts() {
  return cached("mayco:products", DAY / 2, async () => {
    // Page 1 says how many pages there are; fetch the rest in parallel. Sequentially, ~9 pages at
    // ~2 s each outran the gateway's 15 s request timeout on a cold cache.
    const page = (n) => getJson(`${MAYCO_API}/products?per_page=100&page=${n}`);
    const first = await page(1);
    const total = Math.min(30, Number(first.headers.get("x-wp-totalpages") || 1));
    const rest = await Promise.all(Array.from({ length: total - 1 }, (_, i) => page(i + 2)));
    return [first, ...rest].flatMap((r) => r.data);
  });
}
async function maycoLineMap() {
  const cats = await maycoCategories();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const underFired = (c) => { for (let p = c; p; p = byId.get(p.parent)) { if (MAYCO_SKIP.test(text(p.name))) return false; if (p.parent === MAYCO_FIRED) return true; } return false; };
  const lines = new Map();
  for (const c of cats) {
    if (!underFired(c)) continue;
    const parent = byId.get(c.parent);
    const label = parent && parent.id !== MAYCO_FIRED ? `${cleanName(parent.name)}: ${cleanName(c.name)}` : cleanName(c.name);
    lines.set(c.id, { id: String(c.id), name: label, line: label, count: c.count, parentId: c.parent });
  }
  return lines;
}
function maycoItem(p, lines) {
  // Most specific line: one whose id isn't the parent of another of the product's lines.
  const own = p.categories.map((c) => lines.get(c.id)).filter(Boolean);
  const leaf = own.find((l) => !own.some((o) => String(o.parentId) === l.id)) || own[0];
  const slugCode = normCode((/^([a-z]{1,5}-?\d{1,5}[a-z]?)-/i.exec(p.slug) || [])[1]);
  const img = p.images?.[0];
  return {
    key: p.permalink, brand: "Mayco", line: leaf?.line || "", code: normCode(p.sku) || slugCode, name: cleanName(p.name),
    url: p.permalink, thumb: img?.thumbnail || img?.src || "", image: img?.src || "",
    description: text(p.short_description || p.description || "").slice(0, 2000),
  };
}
async function maycoIndex() {
  return cached("mayco:index", DAY / 2, async () => {
    const [products, lines] = await Promise.all([maycoProducts(), maycoLineMap()]);
    const byCode = new Map();
    for (const p of products) {
      if (!p.categories.some((c) => lines.has(c.id))) continue;
      const item = maycoItem(p, lines);
      const k = codeKey(item.code);
      if (k && !byCode.has(k)) byCode.set(k, item);
    }
    return byCode;
  });
}
const mayco = {
  id: "mayco", name: "Mayco", brands: ["Mayco"],
  async lines() {
    const lines = [...(await maycoLineMap()).values()].filter((l) => l.count > 0);
    return lines.sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name, line, count }) => ({ id, name, line, count }));
  },
  async items(lineId) {
    const [products, lines] = await Promise.all([maycoProducts(), maycoLineMap()]);
    const line = lines.get(Number(lineId));
    if (!line) throw new ImportError("That Mayco product line wasn't found.", 404);
    return products.filter((p) => p.categories.some((c) => c.id === line.id * 1)).map((p) => ({ ...maycoItem(p, lines), line: line.line }));
  },
};

// ---------------- Amaco ----------------
const AMACO_SHOP = "https://shop.amaco.com";
const AMACO_SKIP = /crayon|pencil|ink|additive|aids/i;
async function amacoMenuLines() {
  return cached("amaco:menu", DAY, async () => {
    const { body } = await getBody("https://amaco.com/", "text/html");
    const lines = new Map();
    for (const m of body.matchAll(/<a\b[^>]*href="https:\/\/shop\.amaco\.com\/glazes-underglazes\/([a-z0-9-]+)\/([a-z0-9-]+)\/?(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const [, group, slug, inner] = m;
      const name = cleanName(inner);
      if (!name || /^(learn|shop)\b/i.test(name) || AMACO_SKIP.test(slug) || lines.has(slug)) continue;
      lines.set(slug, { id: slug, name, line: name, group, prefix: slug.split("-")[0] });
    }
    return lines;
  });
}
async function amacoProductUrls() {
  return cached("amaco:sitemap", DAY, async () => {
    const { body: index } = await getBody(`${AMACO_SHOP}/xmlsitemap.php`, "application/xml,text/xml");
    const pages = [...index.matchAll(/<loc>([^<]*type=products[^<]*)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    const urls = [];
    for (const p of pages.slice(0, 20)) {
      const { body } = await getBody(p, "application/xml,text/xml");
      urls.push(...[...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
    }
    return urls;
  });
}
// One entry per product code, from slugs like "pc-20-blue-rutile".
async function amacoIndex() {
  return cached("amaco:index", DAY, async () => {
    const [urls, menu] = await Promise.all([amacoProductUrls(), amacoMenuLines()]);
    const lineByPrefix = new Map([...menu.values()].map((l) => [l.prefix, l]));
    const byCode = new Map();
    for (const u of urls) {
      let slug;
      try { slug = new URL(u).pathname.replace(/^\/|\/$/g, ""); } catch { continue; }
      const m = /^([a-z]{1,5})-(\d{1,5}[a-z]?)-([a-z0-9-]+)$/.exec(slug);
      if (!m || slug.includes("/")) continue;
      const code = normCode(`${m[1]}-${m[2]}`);
      const line = lineByPrefix.get(m[1]);
      const name = titleCase(m[3].replace(/-(pint|gallon|pt|gal|oz|\d+-?oz|dry|\d+-?lbs?)$/i, ""));
      const prev = byCode.get(codeKey(code));
      if (prev && prev.url.length <= u.length) continue;
      byCode.set(codeKey(code), {
        key: u, brand: m[1] === "v" ? "Velvet Underglaze" : "Amaco", line: line?.line || "", prefix: m[1],
        code, name: m[1] === "v" ? name.replace(/\s+Underglaze$/i, "") : name, url: u, thumb: "", image: "", description: "",
      });
    }
    return byCode;
  });
}
const amaco = {
  id: "amaco", name: "Amaco (including Velvet)", brands: ["Amaco", "Velvet Underglaze"],
  async lines() {
    const [menu, index] = await Promise.all([amacoMenuLines(), amacoIndex()]);
    const counts = new Map();
    for (const it of index.values()) counts.set(it.prefix, (counts.get(it.prefix) || 0) + 1);
    return [...menu.values()].map((l) => ({ id: l.id, name: l.name, line: l.line, count: counts.get(l.prefix) || 0 }))
      .filter((l) => l.count > 0).sort((a, b) => a.name.localeCompare(b.name));
  },
  async items(lineId) {
    const [menu, index] = await Promise.all([amacoMenuLines(), amacoIndex()]);
    const line = menu.get(lineId);
    if (!line) throw new ImportError("That Amaco product line wasn't found.", 404);
    return [...index.values()].filter((it) => it.prefix === line.prefix)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  },
};

// ---------------- Free Form Clay & Supply ----------------
const FREEFORM = "https://www.freeformclay.com";
const FREEFORM_LINES = [
  { id: "midfireglaze", name: "Mid Fire Glaze" },
  { id: "lowfireglaze", name: "Low Fire Glaze" },
  { id: "underglaze", name: "Underglaze" },
  { id: "strokecoat", name: "Stroke & Coat" },
];
async function freeformList(id) {
  return cached(`freeform:${id}`, DAY / 2, async () => {
    const { body } = await getBody(`${FREEFORM}/${id}`, "text/html");
    const html = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
    const counts = new Map();
    for (const m of html.matchAll(/href="https:\/\/www\.freeformclay\.com\/([a-z0-9-]+)\/[a-z0-9-]+"/g)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    const prefix = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!prefix) return [];
    const re = new RegExp(`<a\\b[^>]*href="https://www\\.freeformclay\\.com/${prefix}/([a-z0-9-]+)"[^>]*>`, "g");
    const hits = [...html.matchAll(re)];
    const seen = new Map();
    hits.forEach((m, i) => {
      if (seen.has(m[1])) return;
      const end = hits[i + 1] ? hits[i + 1].index : m.index + 4000;
      const parts = html.slice(m.index + m[0].length, end).replace(/<[^>]+>/g, "\n").split("\n").map((t) => text(t)).filter(Boolean);
      let title = parts[0] || "";
      if (normCode(title) && parts[1] && !/^\$|price|n\/a/i.test(parts[1]) && parts[1].length < 60) title = `${title} ${parts[1]}`;
      seen.set(m[1], { slug: m[1], title, url: `${FREEFORM}/${prefix}/${m[1]}` });
    });
    return [...seen.values()];
  });
}
const freeform = {
  id: "freeform", name: "Free Form Clay & Supply", brands: ["Freeform"],
  async lines() { return FREEFORM_LINES.map((l) => ({ ...l, line: l.name, count: null })); },
  async items(lineId) {
    const line = FREEFORM_LINES.find((l) => l.id === lineId);
    if (!line) throw new ImportError("That Free Form list wasn't found.", 404);
    const [list, mIndex, aIndex] = await Promise.all([
      freeformList(line.id),
      maycoIndex().catch(() => new Map()),
      amacoIndex().catch(() => new Map()),
    ]);
    return list.map((it) => {
      const cm = /^([A-Za-z]{1,5}-?\d{1,5}[A-Za-z]?)\b\s*(.*)$/.exec(it.title);
      const code = cm ? normCode(cm[1]) : "";
      const listedName = cm ? cm[2] : it.title;
      // Same code AND names that agree (or no name listed): codes alone can collide between companies.
      const match = code && [mIndex.get(codeKey(code)), aIndex.get(codeKey(code))].find((m) => m && namesAgree(m.name, listedName));
      if (match) return { ...match, key: it.url, soldBy: "Free Form" };
      return { key: it.url, brand: "Freeform", line: line.name, code, name: cm ? cm[2] || code : it.title, url: it.url, thumb: "", image: "", description: "" };
    });
  },
};

export const SOURCES = [mayco, amaco, freeform];
export const sourceById = (id) => SOURCES.find((s) => s.id === id);

// Brand -> product line names, for the glaze form's suggestions.
export async function linesByBrand() {
  const out = {};
  await Promise.all(SOURCES.map(async (s) => {
    let lines = [];
    try { lines = await s.lines(); } catch { return; }
    for (const brand of s.brands) {
      const names = lines.map((l) => l.line).filter((n) => (brand === "Velvet Underglaze" ? /velvet/i.test(n) : brand === "Amaco" ? !/velvet/i.test(n) : true));
      out[brand] = [...new Set([...(out[brand] || []), ...names])].sort();
    }
  }));
  return out;
}

// Complete one catalog item with the product page's details when the listing didn't include them.
export async function completeItem(item) {
  if (!item || typeof item.url !== "string") throw new ImportError("Missing product link.", 400);
  if (item.image) return { ...item };
  const page = await importProduct(item.url);
  return {
    ...item,
    name: item.brand === page.brand || !item.name ? page.name || item.name : item.name,
    code: item.code || page.code,
    description: item.description || page.description,
    image: page.imageUrl,
    url: page.sourceUrl,
  };
}
