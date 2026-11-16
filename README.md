# Glaze Journal

A pottery glaze catalog and firing log. Catalog your glazes (brand, name, type, color), then log
test tiles and pieces with the clay body, the glazes used and how each was applied, before- and
after-firing photos, and notes. Brands, glaze types and clay bodies are editable lists.

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
page's name, code, brand, description and product image (saved locally), and the browser estimates
the glaze color from the image. Mayco, Amaco (including Velvet underglazes) and Free Form Clay pages
are handled specifically; other manufacturers work when their pages carry standard product
metadata (JSON-LD or Open Graph). Only public internet addresses are fetched.

No dependencies: a single Node server (`node:sqlite` for records, photos on disk) serves the app
and its JSON API. On a phone, use "Add to Home Screen" to install it like an app.

## Run

```sh
npm start                    # http://localhost:3000
APP_PASSWORD=secret npm start  # require a password (any username)
```

Requires Node 24 or newer.

| Variable       | Default  | Purpose                                             |
| -------------- | -------- | --------------------------------------------------- |
| `PORT`         | `3000`   | Listen port                                         |
| `HOST`         | `0.0.0.0`| Listen address                                      |
| `DATA_DIR`     | `./data` | SQLite database (`glaze-journal.db`) and `photos/`  |
| `APP_PASSWORD` | unset    | Enables HTTP Basic auth. Set it whenever the app is reachable from the internet. |

## Docker

```sh
docker build -t glaze-journal .
docker run -d -p 3000:3000 -v glaze-data:/data -e APP_PASSWORD=secret glaze-journal
```

Put it behind HTTPS (Caddy, Traefik, a tunnel, etc.) when exposing it: Basic auth sends the
password with every request, and phones only offer "install" for HTTPS sites.

## Backups

Everything lives in `DATA_DIR`. Copy the folder while the server is stopped, or use
`sqlite3 data/glaze-journal.db ".backup backup.db"` plus a copy of `data/photos/` while it runs.

## API

| Method | Path                 | Body / result                                        |
| ------ | -------------------- | ---------------------------------------------------- |
| GET    | `/api/state`         | `{lists, glazes, logs}`                              |
| PUT    | `/api/lists`         | `{brands, types, clays}`                             |
| POST   | `/api/glazes`        | `{brand, line, name, code, type, color, description, image, sourceUrl}` → created glaze |
| PUT    | `/api/glazes/:id`    | same                                                 |
| DELETE | `/api/glazes/:id`    |                                                      |
| POST   | `/api/logs`          | `{kind, title, date, clay, firing, glazes[], notes, pre, post}` |
| PUT    | `/api/logs/:id`      | same                                                 |
| DELETE | `/api/logs/:id`      | also deletes its photos                              |
| GET    | `/api/catalog`       | catalog sources                                      |
| GET    | `/api/catalog/:source/lines` | product lines                                |
| GET    | `/api/catalog/:source/lines/:line` | glazes in a line                       |
| GET    | `/api/catalog/lines-by-brand` | `{brand: [line names]}`                     |
| POST   | `/api/catalog/item`  | `{item}` → glaze fields with the image saved locally |
| POST   | `/api/import`        | `{url}` → `{name, code, brand, description, image, sourceUrl, imageNote}` |
| POST   | `/api/photos`        | raw image bytes with an image `Content-Type` → `{id}`|
| GET    | `/photos/:id`        | the image                                            |
