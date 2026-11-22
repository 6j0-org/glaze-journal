// Headless Chromium against the demo: the Feedback button in the header, posting (with the character count and the
// 2048-character limit), a draft surviving the journal's refreshes and a trip to another tab, and deleting your own.
import assert from "node:assert/strict";
import { browser, finish, wait } from "../lib.mjs";

const B = await browser("feedback");
const items = () => B.ev(`[...document.querySelectorAll('.fb-item .fb-text')].map((e) => e.textContent)`);

// The header button opens the page, which starts empty.
assert.ok(await B.ev(`!document.getElementById('feedbackLink').hidden`), "the Feedback button is in the header");
await B.click("#feedbackLink");
await B.until(`location.hash === '#feedback' && document.querySelector('.fb-empty')?.textContent.includes('No feedback yet')`);
assert.equal(await B.ev(`document.getElementById('feedbackLink').getAttribute('aria-current')`), "page");
assert.match(await B.ev(`document.querySelector('.fb-intro').textContent`), /only you and the developer can see/, "the demo says posts are private to you");
assert.equal(await B.ev(`document.getElementById('fbBody').maxLength`), 2048);

// An empty post is refused in the page.
await B.click(".fb-send");
assert.match(await B.ev(`document.querySelector('.fb-status').textContent`), /Write something/);

// A draft survives the journal refreshing and going to another tab and back.
await B.click("#fbBody");
await B.send("Input.insertText", { text: "Could the viewer zoom?\nPinch to zoom would be great." });
assert.equal(await B.ev(`document.querySelector('.fb-count').textContent`), "52 / 2048");
await B.ev(`document.dispatchEvent(new Event('visibilitychange'))`); // makes the journal refresh from the server
await wait(1500);
assert.equal(await B.ev(`document.getElementById('fbBody').value.length`), 52, "a refresh keeps the draft");
await B.click(`nav.tabs a[data-view=glazes]`);
await B.until(`location.hash === '#glazes' && document.querySelector('.swatches, .glaze-grid, .view-head h2')?.textContent`);
await B.click("#feedbackLink");
await B.until(`location.hash === '#feedback' && document.getElementById('fbBody')`);
assert.equal(await B.ev(`document.getElementById('fbBody').value.length`), 52, "so does going to another tab and back");

// Post it: listed, as plain text with its line break, marked as yours.
await B.click(".fb-send");
await B.until(`document.querySelectorAll('.fb-item').length === 1`);
assert.deepEqual(await items(), ["Could the viewer zoom?\nPinch to zoom would be great."]);
assert.equal(await B.ev(`document.getElementById('fbBody').value`), "", "the box is cleared");
assert.match(await B.ev(`document.querySelector('.fb-item .fb-meta').textContent`), /You/);

// HTML is shown as text, and the box stops at 2048 characters.
await B.click("#fbBody");
await B.send("Input.insertText", { text: "<b>bold?</b> " + "x".repeat(2100) });
assert.equal(await B.ev(`document.getElementById('fbBody').value.length`), 2048, "typing stops at the limit");
assert.equal(await B.ev(`document.querySelector('.fb-count').textContent`), "2048 / 2048");
await B.click(".fb-send");
await B.until(`document.querySelectorAll('.fb-item').length === 2`);
assert.ok((await items())[0].startsWith("<b>bold?</b>"), "shown as text, not HTML");
assert.equal(await B.ev(`document.querySelectorAll('.fb-text b').length`), 0);

// A post opens as a chat, where anyone can reply; only the developer can close it. Back in the list, it shows the
// reply count, and the most recently active post comes first.
await B.ev(`document.querySelectorAll('.fb-item')[1].click()`);
await B.until(`document.querySelector('.fb-thread:not([hidden]) .fb-msg')`);
assert.equal(await B.ev(`document.querySelector('.fb-thread .fb-state').textContent`), "Open");
assert.equal(await B.ev(`document.querySelectorAll('[data-set-status]').length`), 0, "only the developer can close it");
assert.equal(await B.ev(`document.querySelector('.fb-msg .fb-author').textContent`), "Tester");
assert.equal(await B.ev(`document.querySelectorAll('.fb-avatar').length`), 0, "posts here are anonymous: no avatars");
await B.click("#fbReply");
await B.send("Input.insertText", { text: "Or double-tap." });
await B.click(".fb-reply-send");
await B.until(`document.querySelectorAll('.fb-msg').length === 2`);
// Editing my reply: Edit turns it into a text box; Save shows the new text, marked as edited.
await B.ev(`document.querySelectorAll('.fb-msg')[1].querySelector('.fb-edit').click()`);
await B.until(`document.getElementById('fbEditBox')`);
await B.ev(`document.getElementById('fbEditBox').value = 'Or a double-tap.'; document.querySelector('.fb-edit-form').requestSubmit()`);
await B.until(`document.querySelectorAll('.fb-msg')[1]?.querySelector('.fb-text')?.textContent === 'Or a double-tap.'`);
assert.equal(await B.ev(`document.querySelectorAll('.fb-msg')[1].querySelector('.fb-edited').textContent`), "edited");
await B.click(".fb-back");
await B.until(`document.querySelector('.fb-item .fb-replies')`);
assert.equal(await B.ev(`document.querySelector('.fb-item .fb-replies').textContent`), "1 reply");
assert.ok((await items())[0].startsWith("Could the viewer zoom?"), "the most recently active comes first");

// Delete takes two clicks (the bold one, now second).
await B.click(".fb-item:nth-child(2) .fb-delete");
assert.equal(await B.ev(`document.querySelector('.fb-item:nth-child(2) .fb-delete').textContent`), "Confirm delete");
assert.equal(await B.ev(`document.querySelectorAll('.fb-item').length`), 2, "nothing's deleted yet");
await B.click(".fb-item:nth-child(2) .fb-delete");
await B.until(`document.querySelectorAll('.fb-item').length === 1`);
assert.deepEqual(await items(), ["Could the viewer zoom?\nPinch to zoom would be great."]);

// Still there after a reload, and gone after "Start over" (a new demo account).
await B.send("Page.reload");
await B.until(`document.querySelectorAll('.fb-item').length === 1`);
await B.click("#signOut");
await B.until(`document.getElementById('banner').hidden && document.querySelector('.fb-empty')?.textContent.includes('No feedback yet')`, 60000);
assert.equal(await B.ev(`location.hash`), "#feedback");

B.close();
finish("browser feedback");
