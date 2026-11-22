# Glaze Journal

A pottery glaze catalog and firing log. Catalog your glazes (brand, name, type, color), then log
test tiles and pieces with the clay body, the glazes used and how each was applied, any number of
before- and after-firing photos (tap one to see it full size), and notes. Brands, glaze types and clay bodies are editable lists.

**Manufacturer catalogs:** "Browse manufacturer catalogs" on the Glazes tab lists real product
lines and their glazes, with photos where the manufacturer provides them. Tick glazes (or "Select all"),
choose a type for them, and import: each gets its brand, product line, code, name, description,
product photo and an estimated color. Glazes already in your catalog are marked and skipped.

| Catalog | Lines from | Notes |
| ------- | ---------- | ----- |
| Mayco | Mayco's public store API ("Color > Fired" categories) | Photos and descriptions come with the listing, so imports are fast. |
| Amaco (incl. Velvet) | amaco.com's menu + the shop's product sitemap, matched by code prefix (PC-, C-, V-…) | Each import reads the product page for its photo and description. |
| Free Form Clay & Supply | The store's Mid Fire, Low Fire, Underglaze and Stroke & Coat lists | Free Form resells other brands: when a code *and* name match a Mayco or Amaco glaze, it is filed under that manufacturer and line. Everything else stays under "Freeform". |

Catalog responses are cached in memory for 12–24 hours. The glaze form's "Product line" field
suggests the real lines for the selected brand.

**Importing from manufacturer sites:** paste a product page link into the glaze form ("Fill in"),
or paste many links at once with "Import from links" on the Glazes tab. The server reads the
page's name, code, brand, description and product image, and the browser estimates the glaze color
from the image. Product images go into a shared cache on the server (see [Encryption](#encryption)). Mayco, Amaco (including Velvet underglazes) and Free Form Clay pages
are handled specifically; other manufacturers work when their pages carry standard product
metadata (JSON-LD or Open Graph). Only public internet addresses are fetched.

**Accounts:** people sign in with an anonymous identity from a [6j0.org identity server](https://gitlab.com/6j0-org/id)
(`id.6j0.org`), so one passkey (or username and password) covers every 6j0.org app. Each account has its own
journal, **end-to-end encrypted**: glazes, firing log, lists, and your photos are encrypted in the browser, and the
server only stores ciphertext (see [Encryption](#encryption)).

No dependencies: a single Node server (`node:sqlite` for encrypted records, encrypted photos and the product image
cache on disk) serves the app and its JSON API. On a phone, use "Add to Home Screen" to install it like an app.

## Run

```sh
ID_ORIGIN=https://id.6j0.org npm start   # http://localhost:3000
```

Requires Node 24 or newer. To try it without an identity server, see [Demo mode](#demo-mode). The identity server must list this app in its `APPS`, with the origin people open it at
(e.g. `APPS=glaze-journal=https://glaze.6j0.org`), since it only sends sign-ins back to that origin.

| Variable       | Default  | Purpose                                             |
| -------------- | -------- | --------------------------------------------------- |
| `PORT`         | `3000`   | Listen port                                         |
| `HOST`         | `0.0.0.0`| Listen address                                      |
| `DATA_DIR`     | `./data` | SQLite database (`glaze-journal.db`) and `photos/`  |
| `DEMO`         | unset    | `1` for [demo mode](#demo-mode): no sign-in, nothing kept. Ignores `DATA_DIR` and the `ID_*` variables. |
| `ID_ORIGIN`    | required | The 6j0.org identity server, e.g. `https://id.6j0.org` |
| `ID_APP`       | `glaze-journal` | This app's name in the identity server's `APPS` |
| `ID_JWKS_URL`  | `ID_ORIGIN/.well-known/jwks.json` | Where to fetch the identity server's public keys (e.g. an in-cluster Service URL) |
| `ID_OWNER_SUB` | unset    | The identity that gets journal data from before sign-in existed. Unset: the first account to sign in gets it. |
| `ADMIN_SUB`    | unset    | The 6j0.org identity (its `sub`) that can close and delete anyone's [feedback](#feedback), and whose posts and replies are labeled "Developer". |
| `ORIGIN`       | unset    | This app's public origin, e.g. `https://glaze.6j0.org`. `https:` turns on `Secure` cookies. |

### Feedback

The Feedback button in the header opens a page where signed-in people read everyone's feedback and post their own:
plain text, up to 2048 characters. Each post is a chat: tapping it opens its thread, where anyone can reply. Posts
and replies show no author (the post's author is "Tester" in its thread); the server files each one under the
account's random public ID so people can delete their own. Each account can post or reply 100 times a day, and
everyone together 500 times a day. Set `ADMIN_SUB` to your identity's `sub` to close threads as Done or Won't do (or
reopen them), delete anyone's posts, and have yours labeled "Developer". In the demo, each visitor sees only their
own posts.

Feedback is shared, so unlike the journal it isn't encrypted, and the page says so. It's kept in
`DATA_DIR/feedback.jsonl`, one JSON object per line, appended to and never edited in place: posts, replies
(`{"reply": post id, …}`), status changes (`{"status": post id, "value": "done"}`), and deletions (`{"delete": id}`).
Read it with `tail -f`, `grep`, or `jq`. The server loads it at startup and, if anything was deleted, rewrites it
without the deleted posts and their replies, so deleted text is gone from the disk after the next restart.

It's built to be copied into other apps: `feedback.js` (the server side: no dependencies, and nothing about this
app's accounts, routes, or database) and `public/feedback.js` (draws the page; style it with the `fb-*` classes).
The app wires up its routes and says who's asking (see the comments at the top of each file and the
`/api/feedback` routes in `server.js`). An app that has avatars or names can show them: pass `authorKey` on the
server and `author` to the page (this app doesn't, so feedback stays anonymous). `test/unit/feedback.mjs` tests the
server side on its own.

### Demo mode

`npm run demo` (or `DEMO=1 npm start`) runs a throwaway demo with no sign-in, on http://localhost:3000. Each
browser automatically gets its own account, already filled in with glazes and firing log entries, including
entries with several before- and after-firing photos in different shapes (portrait, landscape, square, and wide)
and one saved the way entries were before they could hold more than one photo per stage. "Start over" (in place of
"Sign out") replaces it with a fresh one.

The browser fills the journal in itself (`public/demo.js`), since only it has the journal key: it encrypts and
saves everything through the same code as real use, and draws the photos on a canvas, each labeled
("After 2/4 · tall") so you can tell them apart. The journal key is wrapped under a random key that's thrown away,
so the account only works in the browser that made it.

The database is in memory and photos go to a temporary folder that's deleted when the server stops; visitor
accounts are also deleted after a day. It's for trying the app out and for the tests, never for real use.

### Tests

```sh
npm test               # all of them
npm run test:unit      # modules on their own, with no server: feedback.js
npm run test:server    # the API in Node: demo accounts, keys, photo uploads and limits, accounts kept apart
npm run test:browser   # the real UI in headless Chromium: several photos per firing, the full-size viewer, and more
```

The runner (`test/run.mjs`) starts its own demo-mode server on a free port, so nothing touches `data/`. There are no
dependencies: the browser tests drive Chrome or Chromium over the DevTools protocol with Node's built-in WebSocket.
Set `CHROME_BIN` if it isn't found; without one they're skipped, unless `TEST_BROWSER=1`, which makes that a
failure. `TEST_VERBOSE=1` prints every test's output, not just the failures'. CI runs them (with a browser required)
before building the image, and skips the build if they fail.

### Sign-in

1. "Sign in with 6j0.org" makes a random nonce and an ephemeral ECDH key pair, and goes to
   `ID_ORIGIN/authorize?app=glaze-journal&nonce=…&epk=…`.
2. The identity server signs the person in and sends the browser back to `/` with a signed token (an Ed25519 JWT)
   in the URL fragment, which never reaches a server.
3. The page checks the nonce and posts the token to `/api/id/login`. `idtoken.js` verifies
   the signature against the identity server's JWKS, plus `iss`, `aud`, `exp`, `nonce`, and one-time use
   (`jti`). The server then finds or creates the account for the token's `sub` and sets a session cookie
   (`HttpOnly`, `SameSite=Lax`, 30 days; the database stores only its SHA-256).
4. The page decrypts the app key that came with the token (below) and unlocks the journal.

### Encryption

The code is in `public/secure.js`.

- Alongside the token, the identity server hands the page Glaze Journal's own 32-byte **app key**, encrypted to
  the one-time ECDH key the page made, in the URL fragment. It's derived from the identity's root secret (which
  only the person's passkey or password unlocks), so every device signed in to the same identity gets the same
  key. Other 6j0.org apps get different keys and can't read journals.
- HKDF turns the app key into a key-encryption key that wraps the account's random 256-bit **journal key**. The
  browser makes the journal key on the first sign-in and stores only the wrapped copy on the server
  (`PUT /api/key`).
- The journal key encrypts every record (AES-256-GCM, with the collection and record ID as additional data, so
  the server can't swap records around) and every photo you add, including the MIME type. The server stores, per
  record, the ciphertext plus the IDs of the photos it uses, so it can delete photos nothing uses any more.
- **Product images are the exception.** They're public, so the server keeps one unencrypted copy of each in a
  cache every account shares (`DATA_DIR/products/`, the `product_images` table), keyed by the SHA-256 of the
  manufacturer's image URL. A glaze points at its product image (`image: {product: id}`) from inside its encrypted
  record, so the database doesn't show which accounts use which images. The cache keeps each image's URL and
  downloads it again if the file goes missing. Glazes saved before the cache existed keep their encrypted copies.
- After sign-in the journal key stays in IndexedDB as a non-extractable `CryptoKey`, so reloads don't need to sign
  in again. Signing out deletes it. If the browser clears it while the session cookie is still valid, the app
  asks to sign in again to unlock.
- **What the server still knows:** how many glazes, entries, and photos each account has, their sizes, when they
  change, which photos belong to which record, and IP addresses. Manufacturer pages, catalog lookups, and product
  images go through the server (they're public, but it sees which ones each session looks up or loads).
- **Lose every way into your 6j0.org identity and the journal is gone for good.** Nobody, including the server
  operator, can recover it. Add a second passkey or a password at `id.6j0.org`.

**Upgrading from an older version:** journals made before sign-in existed are unencrypted and belong to nobody
until someone claims them. Set `ID_OWNER_SUB` to your identity's `sub` to choose who, or the first account to sign
in gets them, so sign in right after deploying. That browser then encrypts the old records and photos and the
server deletes the plain copies (SQLite's `secure_delete` and a WAL checkpoint keep old copies from lingering in
the database files). The schema migration runs on startup (`MIGRATIONS` in `server.js`, tracked in
`PRAGMA user_version`); back up `DATA_DIR` first.

To try it locally, run the identity server on `localhost` and this app on `127.0.0.1` (cookies ignore the port, so
two apps on one hostname would overwrite each other's session cookie):

```sh
# in the id repo
APPS=glaze-journal=http://127.0.0.1:3000 ORIGIN=http://localhost:4000 npm start
# here
ID_ORIGIN=http://localhost:4000 ORIGIN=http://127.0.0.1:3000 npm start   # open http://127.0.0.1:3000
```

## Docker

CI runs the [tests](#tests), then builds multi-arch (amd64, arm64) images: `.gitlab-ci.yml` publishes to this project's GitLab Container Registry
(`:latest`, `:<short sha>`, and a sortable `:dev-<short sha>-<unix time>` for Flux image automation on the default
branch, `:<tag>` for tags), and `.github/workflows/image.yml` publishes to `ghcr.io`. Merge and pull requests only
build.

```sh
docker build -t glaze-journal .
docker run -d -p 3000:3000 -v glaze-data:/data \
  -e ID_ORIGIN=https://id.6j0.org -e ORIGIN=https://glaze.6j0.org glaze-journal
```

Put it behind HTTPS (Caddy, Traefik, a tunnel, etc.) when exposing it: session cookies are only marked `Secure`
when `ORIGIN` is `https:`, and phones only offer "install" for HTTPS sites.

## Backups

Everything lives in `DATA_DIR`. Copy the folder while the server is stopped, or use
`sqlite3 data/glaze-journal.db ".backup backup.db"` plus a copy of `data/photos/` and `data/feedback.jsonl` while it runs.

## API

Everything except `/api/config`, `/api/id/login`, `/api/demo/register`, `/api/logout`, and `/healthz` needs a session and only sees the
signed-in account's journal. Without one it answers 401. Requests marked `Sec-Fetch-Site: cross-site` that change
data are refused.

| Method | Path                 | Body / result                                        |
| ------ | -------------------- | ---------------------------------------------------- |
| GET    | `/api/config`        | `{idOrigin, idApp}`, or `{demo: true}` in demo mode   |
| POST   | `/api/demo/register` | demo mode only: a new account → `{guid}` and sets the session cookie |
| POST   | `/api/id/login`      | `{token, nonce}` → `{guid, wrappedKey}` and sets the session cookie |
| POST   | `/api/logout`        | ends the session                                     |
| PUT    | `/api/key`           | `{wrappedKey}`, once per account (409 if already set) |
| GET    | `/api/state`         | `{guid, wrappedKey, lists, glazes, logs}`; each record is `{id, enc}` (or `{id, legacy}` from before encryption) |
| PUT    | `/api/lists`         | `{enc}`                                              |
| PUT    | `/api/glazes/:id`    | `{enc, photos: [photo ids]}`; creates or replaces (the browser picks the ID) |
| DELETE | `/api/glazes/:id`    | also deletes photos nothing else uses                |
| PUT    | `/api/logs/:id`      | `{enc, photos: [photo ids]}`, up to 60 photos        |
| DELETE | `/api/logs/:id`      | also deletes its photos                              |
| GET    | `/api/catalog`       | catalog sources                                      |
| GET    | `/api/catalog/:source/lines` | product lines                                |
| GET    | `/api/catalog/:source/lines/:line` | glazes in a line                       |
| GET    | `/api/catalog/lines-by-brand` | `{brand: [line names]}`                     |
| POST   | `/api/catalog/item`  | `{item}` → glaze fields plus `{productImage, imageNote}` (the image is cached on the server) |
| POST   | `/api/import`        | `{url}` → `{name, code, brand, description, sourceUrl, productImage, imageNote}` |
| GET    | `/api/feedback`      | `{items: [{id, body, created, updated, admin, mine, canDelete, status, replies}], maxLength, isAdmin, demo}`, most recently active first |
| POST   | `/api/feedback`      | `{body}` → the new item (400 if empty or over 2048 characters, 429 over the daily limits) |
| GET    | `/api/feedback/:id`  | the item plus `{messages: [{id, body, created, admin, mine, op}], canReply, canClose}` |
| POST   | `/api/feedback/:id/replies` | `{body}` → the thread                         |
| POST   | `/api/feedback/:id/status`  | `{status}` (`open`, `done`, or `wontdo`) → the thread; `ADMIN_SUB` only |
| DELETE | `/api/feedback/:id`  | your own, or anyone's for `ADMIN_SUB`                |
| POST   | `/api/photos`        | encrypted photo bytes as `application/octet-stream` → `{id}` |
| GET    | `/photos/:id`        | the encrypted photo                                  |
| GET    | `/products/:id`      | a cached product image (unencrypted, shared by all accounts) |
