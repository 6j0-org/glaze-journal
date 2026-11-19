// Headless Chromium against the demo: several photos per firing (before and after), the full-size viewer showing
// whole, uncropped photos, adding and removing photos in the form, entries saved with one photo per stage (from
// before multiple photos), and "Start over".
import assert from "node:assert/strict";
import { join } from "node:path";
import { browser, finish, wait } from "../lib.mjs";

const ICONS = new URL("../../public/", import.meta.url).pathname;
const B = await browser("photos", { width: 1200, height: 900 });
const openEntry = async (title) => {
  const id = await B.ev(`[...document.querySelectorAll('.card[data-log]')].find((c) => c.querySelector('h3').textContent === ${JSON.stringify(title)}).dataset.log`);
  await B.click(`.card[data-log="${id}"]`);
  await B.until(`document.getElementById('viewDlg').open`);
};
const cardStage = (title) => B.ev(`[...document.querySelectorAll('.card[data-log]')].find((c) => c.querySelector('h3').textContent === ${JSON.stringify(title)}).querySelector('.stage')?.textContent || ''`);
// The viewer's photo: loaded, scaled down whole (not cropped), and inside the window.
const viewerPhoto = () => B.ev(`(async () => {
  const img = document.getElementById('lbImg');
  for (let i = 0; i < 50 && !(img.complete && img.naturalWidth > 1); i++) await new Promise((r) => setTimeout(r, 100));
  const r = img.getBoundingClientRect();
  return { caption: document.getElementById('lbCap').textContent, natural: img.naturalWidth / img.naturalHeight, shown: r.width / r.height,
    fit: getComputedStyle(img).objectFit, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, w: img.naturalWidth };
})()`);

// The card shows the first after-firing photo and the total.
assert.equal(await cardStage("Breakfast bowl #3"), "After firing · 6 photos");
assert.equal(await cardStage("Smokey Merlot mug"), "After firing · 2 photos");
assert.equal(await cardStage("Blue Rutile over Oatmeal"), "");

// The entry shows every photo: before (2) and after (4).
await openEntry("Breakfast bowl #3");
assert.equal(await B.ev(`document.querySelectorAll('#vBody [data-lb=pre]').length`), 2);
assert.equal(await B.ev(`document.querySelectorAll('#vBody [data-lb=post]').length`), 4);
assert.match(await B.ev(`document.querySelector('#vBody .detail-photos').textContent`), /After firing · 4 photos/);

// The viewer: the first after photo is the tall one (1:2), shown whole.
await B.click(`#vBody [data-lb=post][data-i="0"]`);
await B.until(`document.getElementById('lightbox').open`);
let p = await viewerPhoto();
assert.equal(p.caption, "After firing 1 of 4");
assert.ok(p.w > 1, "the photo loaded");
assert.equal(p.fit, "contain");
assert.ok(Math.abs(p.shown - p.natural) < 0.02, `shown at its own shape (${p.shown.toFixed(3)} vs ${p.natural.toFixed(3)}), so not cropped`);
assert.ok(p.inside, "and all of it is on screen");
// Next and previous wrap around all 6 photos of the entry: before photos first.
await B.click(`#lbNext`);
assert.equal((await viewerPhoto()).caption, "After firing 2 of 4");
await B.ev(`document.getElementById('lightbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
p = await viewerPhoto();
assert.equal(p.caption, "After firing 3 of 4");
assert.ok(Math.abs(p.shown - 1) < 0.02, "the square one is square");
for (let i = 0; i < 2; i++) await B.click(`#lbNext`);
assert.equal((await viewerPhoto()).caption, "Before firing 1 of 2", "wraps around to the first photo");
await B.click(`#lbPrev`);
assert.equal((await viewerPhoto()).caption, "After firing 4 of 4");
// Escape closes the viewer and leaves the entry open.
await B.key("Escape", "Escape", 27);
await B.until(`!document.getElementById('lightbox').open`);
assert.ok(await B.ev(`document.getElementById('viewDlg').open`), "the entry is still open");

// Edit: remove one after photo, add two, and look at a new one full size before saving.
await B.click(`#vEdit`);
await B.until(`document.getElementById('logDlg').open`);
assert.equal(await B.ev(`document.querySelectorAll('#stage-pre .thumb').length`), 2);
assert.equal(await B.ev(`document.querySelectorAll('#stage-post .thumb').length`), 4);
await B.click(`#stage-post [data-remove][data-i="1"]`);
assert.equal(await B.ev(`document.querySelectorAll('#stage-post .thumb').length`), 3);
await B.setFiles("#stage-post input[type=file]", [join(ICONS, "icon-192.png"), join(ICONS, "icon-512.png")]);
await B.until(`document.querySelectorAll('#stage-post .thumb').length === 5`);
assert.match(await B.ev(`document.querySelector('#stage-post .drop').innerText`), /Add more/);
await B.click(`#stage-post [data-view][data-i="4"]`);
await B.until(`document.getElementById('lightbox').open`);
p = await viewerPhoto();
assert.equal(p.caption, "After firing 5 of 5");
assert.equal(p.w, 512, "a photo picked in the form shows full size before it's saved");
await B.click(`#lightbox [data-close]`);
await B.until(`!document.getElementById('lightbox').open`);
assert.ok(await B.ev(`document.getElementById('logDlg').open`), "closing the viewer leaves the form open");
await B.click(`#logSave`);
await B.until(`!document.getElementById('logDlg').open`);
await B.until(`document.querySelector('.card[data-log] .stage') && [...document.querySelectorAll('.card[data-log]')].some((c) => c.querySelector('.stage')?.textContent === 'After firing · 7 photos')`);

// It's all still there after a reload (the journal key stays in this browser).
await B.reload();
assert.equal(await cardStage("Breakfast bowl #3"), "After firing · 7 photos");
await openEntry("Breakfast bowl #3");
assert.equal(await B.ev(`document.querySelectorAll('#vBody [data-lb=post]').length`), 5);
await B.click(`#vBody [data-lb=post][data-i="4"]`);
await B.until(`document.getElementById('lightbox').open`);
assert.equal((await viewerPhoto()).w, 512, "the uploaded photo decrypts at full size (it was under the 1800 px limit)");
await B.key("Escape", "Escape", 27);
await B.until(`!document.getElementById('lightbox').open`);
await B.key("Escape", "Escape", 27);
await B.until(`!document.getElementById('viewDlg').open`);

// An entry saved with one photo per stage (before lists): shown, editable, and saved as lists with nothing lost.
assert.equal(await cardStage("Oatmeal liner"), "After firing · 2 photos");
await openEntry("Oatmeal liner");
assert.equal(await B.ev(`document.querySelectorAll('#vBody [data-lb]').length`), 2);
await B.click(`#vEdit`);
await B.until(`document.getElementById('logDlg').open`);
assert.equal(await B.ev(`document.querySelectorAll('#photoFields .thumb').length`), 2);
await B.setFiles("#stage-pre input[type=file]", [join(ICONS, "icon-192.png")]);
await B.until(`document.querySelectorAll('#stage-pre .thumb').length === 2`);
await B.click(`#logSave`);
await B.until(`!document.getElementById('logDlg').open`);
await B.until(`[...document.querySelectorAll('.card[data-log]')].some((c) => c.querySelector('.stage')?.textContent === 'After firing · 3 photos')`);

// On a phone: the viewer still fits the whole photo on screen.
await B.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await wait(300);
await openEntry("Breakfast bowl #3");
await B.click(`#vBody [data-lb=post][data-i="0"]`);
await B.until(`document.getElementById('lightbox').open`);
p = await viewerPhoto();
assert.ok(p.inside && Math.abs(p.shown - p.natural) < 0.02, "whole photo on a phone screen");
// Tap the dark area above the photo.
for (const type of ["mousePressed", "mouseReleased"]) await B.send("Input.dispatchMouseEvent", { type, x: 195, y: 20, button: "left", clickCount: 1 });
await B.until(`!document.getElementById('lightbox').open`);
await B.key("Escape", "Escape", 27);
await B.until(`!document.getElementById('viewDlg').open`);
await B.send("Emulation.clearDeviceMetricsOverride");

// Start over: a fresh demo journal, without the photos added above.
await B.click(`#signOut`);
await wait(500);
await B.ready();
assert.equal(await cardStage("Breakfast bowl #3"), "After firing · 6 photos");

B.close();
finish("browser photos");
