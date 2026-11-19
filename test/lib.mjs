// Shared helpers for the server and browser tests. test/run.mjs starts a demo-mode server and passes its address in
// TEST_BASE, and a scratch directory in TEST_TMP. No dependencies: Chromium is driven over the DevTools protocol
// with Node's built-in WebSocket.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE = process.env.TEST_BASE || "http://127.0.0.1:3000";
export const TMP = process.env.TEST_TMP || mkdtempSync(join(tmpdir(), "glaze-journal-test-"));
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A demo account in Node, with its own session cookie. api(method, path, body, type) → parsed JSON (or the Response
// for raw: true). Errors carry .status.
export async function demoAccount() {
  let cookie = "";
  async function api(method, path, body, { type, raw } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = type || "application/json";
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : type ? body : JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    if (raw) return r;
    const data = r.status === 204 ? null : await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data?.error || r.statusText), { status: r.status });
    return data;
  }
  const { guid } = await api("POST", "/api/demo/register", {});
  return { guid, api };
}

// ---------- headless Chromium over the DevTools protocol ----------
export function findChrome() {
  const names = [process.env.CHROME_BIN, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return names.find((p) => p && existsSync(p)) || null;
}

// Page errors and console errors or warnings from every browser opened, for the test to report at the end.
export const pageErrors = [];

// Opens `path` in a new headless browser with its own profile (so its own demo account), and waits for the app to
// finish setting up: the log tab showing `entries` cards and no setup progress banner.
export async function browser(name, { path = "/", width = 1200, height = 900, entries = 5 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("No Chrome or Chromium found; set CHROME_BIN");
  const profile = mkdtempSync(join(TMP, `chrome-${name}-`));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--disable-dev-shm-usage", `--window-size=${width},${height}`, "about:blank"]; // containers often have a tiny /dev/shm
  if (process.getuid?.() === 0) args.unshift("--no-sandbox"); // containers usually run as root, where Chromium won't sandbox
  const proc = spawn(chrome, args, { stdio: "ignore" });
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    await wait(100);
    if (existsSync(`${profile}/DevToolsActivePort`)) port = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n")[0];
  }
  if (!port) { proc.kill(); throw new Error(`${name}: Chromium didn't start`); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(`${name}: ` + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) pageErrors.push(`${name} console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  // Evaluate an expression in the page and return its value (awaiting promises).
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${name}: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}\n  in: ${expr}`);
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 30000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await wait(200); } throw new Error(`${name} timed out waiting for: ${expr}`); };
  const ready = () => until(`document.querySelectorAll('#view .card[data-log]').length === ${entries} && document.getElementById('banner').hidden`, 60000);
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: `${BASE}${path}` });
  await ready();
  // Attach files to an <input type=file> found by a CSS selector; Chromium fires its change event.
  const setFiles = async (selector, files) => {
    const r = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    const objectId = r.result?.result?.objectId;
    if (!objectId) throw new Error(`${name}: no element for ${selector}`);
    await send("DOM.setFileInputFiles", { files, objectId });
  };
  // A real key press, as the dialog's built-in Escape handling needs.
  const key = async (key, code = key, keyCode = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };
  // A real mouse click in the middle of the element a CSS selector finds. Unlike el.click() it counts as a user
  // action, which matters for dialogs: Chromium closes dialogs opened without one together, on a single Escape.
  const click = async (selector) => {
    const pt = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!pt) throw new Error(`${name}: no element for ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...pt, button: "left", clickCount: 1 });
  };
  const reload = async () => { await send("Page.reload"); await ready(); };
  const screenshot = async (file) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    (await import("node:fs")).writeFileSync(file, Buffer.from(result.data, "base64"));
  };
  return { name, send, ev, until, click, setFiles, key, reload, ready, screenshot, close: () => { ws.close(); proc.kill(); } };
}

// Prints the page errors and exits: 1 if there were any.
export function finish(label) {
  if (pageErrors.length) { console.log(`${label}: page errors:\n` + pageErrors.join("\n")); process.exit(1); }
  console.log(`${label}: ok`);
  process.exit(0);
}
