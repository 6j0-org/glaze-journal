// Demo mode (server DEMO=1): fills a new visitor's journal with glazes and firing log entries. Only this browser has
// the journal key, so it encrypts and saves the demo content itself, through the same store as everything else.
//
// The photos are drawn here on a canvas (no image files to ship), in the shapes phones actually take: portrait,
// landscape, square, and wide, so cropped thumbnails and the full-size viewer both get exercised. Each photo has a
// small label ("After 2/4") so you can tell which one the viewer is showing.

const GLAZES = [
  { brand: "Amaco", line: "Potter's Choice", name: "Blue Rutile", type: "Fluid", color: "#3f5f86", description: "Variegated blue with rutile streaks; runs where it's thick." },
  { brand: "Amaco", line: "Potter's Choice", name: "Temmoku", type: "Stable", color: "#3b2418", description: "Glossy dark brown that breaks rust over edges." },
  { brand: "Amaco", line: "Potter's Choice", name: "Textured Turquoise", type: "Float", color: "#2f8f8a", description: "Turquoise with a textured, broken surface." },
  { brand: "Amaco", line: "Potter's Choice", name: "Smokey Merlot", type: "Stable", color: "#6b2c3a", description: "Deep red-purple, darker where it pools." },
  { brand: "Amaco", line: "Potter's Choice", name: "Oatmeal", type: "Stable", color: "#d9c9a8", description: "Speckled cream; good liner glaze." },
];

const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

// [width, height] of a phone photo in each orientation.
const SIZE = { portrait: [900, 1200], landscape: [1200, 900], square: [1000, 1000], wide: [1600, 900], tall: [700, 1400] };

// A pot or tile on a table, as a JPEG blob. Unfired glaze is drawn chalky and pale; fired glaze glossy.
function drawPhoto({ shape, colors, fired, size, label, seed = 1 }) {
  const [w, h] = SIZE[size];
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  let r = seed; const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  // Table and wall.
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, fired ? "#e8e2d8" : "#d9d4cc"); bg.addColorStop(0.62, fired ? "#cfc6b8" : "#c4bdb2"); bg.addColorStop(0.63, "#9c8c78"); bg.addColorStop(1, "#7d6e5c");
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const s = Math.min(w, h) * 0.62, cx = w / 2, cy = h * 0.55;
  const glaze = (x, y, ww, hh) => {
    const gr = g.createLinearGradient(x, y, x + ww, y);
    colors.forEach((col, i) => gr.addColorStop(i / Math.max(1, colors.length - 1), col));
    g.fillStyle = gr; g.fill();
    if (!fired) { g.fillStyle = "rgb(235 230 220 / .55)"; g.fill(); } // raw glaze is powdery and pale
  };
  g.save();
  g.shadowColor = "rgb(0 0 0 / .35)"; g.shadowBlur = s * 0.06; g.shadowOffsetY = s * 0.03;
  g.beginPath();
  if (shape === "bowl") { g.ellipse(cx, cy - s * 0.12, s * 0.5, s * 0.14, 0, Math.PI, 0); g.quadraticCurveTo(cx + s * 0.42, cy + s * 0.36, cx, cy + s * 0.36); g.quadraticCurveTo(cx - s * 0.42, cy + s * 0.36, cx - s * 0.5, cy - s * 0.12); }
  else if (shape === "mug") { g.roundRect(cx - s * 0.3, cy - s * 0.38, s * 0.6, s * 0.72, s * 0.05); g.moveTo(cx + s * 0.3, cy - s * 0.2); g.arc(cx + s * 0.3, cy - s * 0.02, s * 0.17, -Math.PI / 2, Math.PI / 2); }
  else g.roundRect(cx - s * 0.22, cy - s * 0.42, s * 0.44, s * 0.8, s * 0.04); // tile
  glaze(cx - s * 0.5, cy - s * 0.4, s, s);
  g.restore();
  // Bare clay foot, specks, drips and a highlight once fired.
  g.fillStyle = "#c9b38f";
  if (shape === "tile") g.fillRect(cx - s * 0.22, cy + s * 0.18, s * 0.44, s * 0.2);
  else if (shape === "mug") g.fillRect(cx - s * 0.3, cy + s * 0.28, s * 0.6, s * 0.06);
  else { g.beginPath(); g.ellipse(cx, cy + s * 0.34, s * 0.14, s * 0.03, 0, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = "rgb(60 40 25 / .55)";
  for (let i = 0; i < 70; i++) { g.beginPath(); g.arc(cx + (rand() - 0.5) * s * 0.7, cy + (rand() - 0.5) * s * 0.6, 1 + rand() * 2.5, 0, Math.PI * 2); g.fill(); }
  if (fired) {
    g.fillStyle = colors[0];
    for (let i = 0; i < 4; i++) { const x = cx + (rand() - 0.5) * s * 0.4, y = cy + s * (shape === "tile" ? 0.12 : 0.1); g.beginPath(); g.roundRect(x, y, s * 0.025, s * (0.06 + rand() * 0.1), s * 0.012); g.fill(); }
    const hl = g.createRadialGradient(cx - s * 0.15, cy - s * 0.15, 0, cx - s * 0.15, cy - s * 0.15, s * 0.3);
    hl.addColorStop(0, "rgb(255 255 255 / .45)"); hl.addColorStop(1, "rgb(255 255 255 / 0)");
    g.fillStyle = hl; g.fillRect(0, 0, w, h);
  }
  // A label in the corner, so the viewer test (and you) can tell the photos apart. Near the edge, where a cropped
  // thumbnail cuts it off but the full-size viewer shows it.
  g.font = `600 ${Math.round(Math.min(w, h) * 0.045)}px system-ui, sans-serif`;
  g.fillStyle = "rgb(0 0 0 / .55)"; g.fillText(label, Math.min(w, h) * 0.04, h - Math.min(w, h) * 0.04);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
}

// Log entries. photos: { pre: [...], post: [...] }, each [shape, size]. glazes: [name, how it was applied].
// The "Oatmeal liner" entry is stored the way entries were before multiple photos (one photo object per stage, not a
// list), so the demo keeps covering older journals.
const ENTRIES = [
  { kind: "piece", title: "Breakfast bowl #3", days: 3, clay: "Laguna Speckled Buff", firing: "Cone 6 oxidation, slow cool",
    glazes: [["Temmoku", "Dipped 3 s, whole bowl"], ["Blue Rutile", "Dipped 2 s over the top half, then 2 brushed coats on the rim"]],
    notes: "Rutile broke beautifully over the Temmoku. A little run near the foot: keep the second glaze 1 cm higher next time.",
    photos: { pre: [["bowl", "landscape"], ["bowl", "portrait"]], post: [["bowl", "tall"], ["bowl", "landscape"], ["bowl", "square"], ["bowl", "wide"]] } },
  { kind: "tile", title: "Textured Turquoise, 2 vs 3 coats", days: 10, clay: "Laguna Dover White", firing: "Cone 6 oxidation",
    glazes: [["Textured Turquoise", "Left half 2 brushed coats, right half 3"]],
    notes: "Three coats gives the broken texture; two is flat.",
    photos: { pre: [["tile", "portrait"]], post: [["tile", "portrait"]] } },
  { kind: "piece", title: "Smokey Merlot mug", days: 18, clay: "Laguna Speckled Buff", firing: "Cone 6 oxidation",
    glazes: [["Oatmeal", "Poured liner"], ["Smokey Merlot", "Dipped 3 s outside, wax resist foot"]],
    notes: "",
    photos: { pre: [], post: [["mug", "landscape"], ["mug", "portrait"]] } },
  { kind: "tile", title: "Oatmeal liner", days: 30, clay: "Laguna Dover White", firing: "Cone 6 oxidation", legacy: true,
    glazes: [["Oatmeal", "3 brushed coats"]],
    notes: "Saved before entries could hold more than one photo per stage.",
    photos: { pre: [["tile", "square"]], post: [["tile", "landscape"]] } },
  { kind: "tile", title: "Blue Rutile over Oatmeal", days: 1, clay: "Laguna Dover White", firing: "",
    glazes: [["Oatmeal", "2 brushed coats"], ["Blue Rutile", "1 coat over the top third"]],
    notes: "Waiting on the next firing.",
    photos: { pre: [], post: [] } },
];

// store: the app's store (save, saveConfig, upload). lists: the default lists, saved so the clay bodies are there.
export async function seedDemo(store, lists, onProgress = () => {}) {
  await store.saveConfig(lists);
  const ids = {};
  for (const g of GLAZES) ids[g.name] = await store.save("glazes", null, { ...g, code: "", image: null, sourceUrl: "", createdAt: Date.now() }, { refresh: false });
  const total = ENTRIES.reduce((n, e) => n + e.photos.pre.length + e.photos.post.length, 0);
  let done = 0, seed = 7;
  for (const e of ENTRIES) {
    const colors = e.glazes.map(([n]) => GLAZES.find((g) => g.name === n).color);
    const photos = {};
    for (const stage of ["pre", "post"]) {
      const list = e.photos[stage];
      photos[stage] = [];
      for (const [i, [shape, size]] of list.entries()) {
        onProgress(`Setting up the demo: photo ${++done} of ${total}…`);
        const blob = await drawPhoto({ shape, size, colors, fired: stage === "post", seed: seed++, label: `${stage === "pre" ? "Before" : "After"} ${i + 1}/${list.length} · ${size}` });
        photos[stage].push(await store.upload(blob));
      }
    }
    await store.save("logs", null, {
      kind: e.kind, title: e.title, date: daysAgo(e.days), clay: e.clay, firing: e.firing, notes: e.notes,
      glazes: e.glazes.map(([name, application]) => { const g = GLAZES.find((x) => x.name === name); return { glazeId: ids[name], application, name, brand: g.brand, type: g.type, color: g.color }; }),
      pre: e.legacy ? photos.pre[0] || null : photos.pre,
      post: e.legacy ? photos.post[0] || null : photos.post,
      createdAt: Date.now() - e.days * 86400000,
    }, { refresh: false });
  }
  await store.refresh();
}
