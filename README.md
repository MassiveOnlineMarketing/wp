# authentic-golf-wp-tools

Small TypeScript/pnpm utilities for working with exported WordPress data from authentic.golf.

## Setup

```zsh
pnpm install
```

## Scripts

### Full workflow (recommended order)

```zsh
pnpm run extract:pages
pnpm run scrape:images
pnpm run backup:media
pnpm run merge:product-media
pnpm run copy:product-images
```

### Extract page id + link

Reads `wp-data/pages.json` and writes `wp-data/pages.id-link.json`.

```zsh
pnpm run extract:pages
```

### Scrape images + Google Maps iframe per page

Reads `wp-data/pages.id-link.json` and writes `wp-data/pages.images.json`.

- Requests are **sequential** with a **1s delay** (`--delayMs 1000`) to be polite.
- Image URLs are normalized to the **original upload filename** by stripping WordPress variants like `-300x200` (and `-scaled`).
- If a page contains a Google Maps iframe, `mapIframe` is included as:
  `<iframe loading='lazy' src='…' width='1200' height='480'></iframe>`

```zsh
pnpm run scrape:images
```

Optional flags (run directly):

```zsh
node --enable-source-maps --loader ts-node/esm src/scrape-images.ts \
  --in wp-data/pages.id-link.json \
  --out wp-data/pages.images.json \
  --delayMs 1000 \
  --timeoutMs 20000 \
  --limit 10
```

### Backup all WordPress media

Downloads the WordPress media library via the REST API and saves files to `backup/<media_details.file>`.

```zsh
pnpm run backup:media
```

Optional flags (run directly):

```zsh
node --enable-source-maps --loader ts-node/esm src/backup-media.ts \
  --baseUrl https://authentic.golf \
  --outDir backup \
  --perPage 100 \
  --pages 5
```

Notes:
- If `--pages` is omitted, the script uses `x-wp-totalpages` when available, otherwise it stops when a page returns fewer than `--perPage` items.
- Existing files are skipped.

### Merge scraped media into products

Reads `product-data.json` + `wp-data/pages.images.json` and writes `product-data.with-media.json`.
Adds:
- `images: string[]`
- `mapIframe?: string`

```zsh
pnpm run merge:product-media
```

Optional flags:

```zsh
pnpm run merge:product-media -- --out product-data.with-media.json --limit 10
```

### Copy backed-up images into per-product folders

Reads `product-data.with-media.json` and copies files from `backup/` into a per-product folder under `product-media/`.

- Product folder name is the product `slug` (without leading `/`).
- Image URLs are mapped to `backup/<uploads path>` via `/wp-content/uploads/...`.

```zsh
pnpm run copy:product-images
```

Optional flags:

```zsh
pnpm run copy:product-images -- --outRoot product-media --backupDir backup --productsIn product-data.with-media.json --limit 10
```

## Reports

### Report: backup images not used in product-media

Compares `backup/` with what actually exists in `product-media/` and outputs a list of backup files that were not copied into any product.

Outputs:
- `reports/unused-backup-media.json`
- `reports/unused-backup-media.csv`

```zsh
pnpm run report:unused-backup
```

## SEO renaming strategy (safe, reversible)

Recommended approach:
- Don’t rename the canonical `backup/`.
- Generate an SEO-ready copy of `product-media/` into a new folder (default: `product-media-seo/`).
- Keep a mapping file so you can always trace `old → new`.

Why this works:
- Your source-of-truth stays intact (`backup/` + `product-media/`).
- You can regenerate SEO filenames deterministically per product.
- The mapping file is your audit trail for redirects/rollbacks.

### Filename scheme

Current scheme per product:
- Base name = last segment of the product folder (derived from `slug`), slugified.
- Output names: `<base>-01.<ext>`, `<base>-02.<ext>`, …

Example:
- Product slug: `/golfreizen/engeland/cornwall-golf`
- SEO filenames: `cornwall-golf-01.jpg`, `cornwall-golf-02.jpg`, …

Notes:
- We keep the original file extension.
- We don’t try to “understand” image content; it’s consistent and safe.
- If you later want richer names (course/hotel keywords), extend the script to inject those tokens; keep the mapping.

The script copies files and renames them per product like:
`<slug-last-segment>-01.<ext>`, `<slug-last-segment>-02.<ext>`, …

Outputs:
- `product-media-seo/` (renamed copy)
- `reports/seo-rename-map.json`
- `reports/seo-rename-map.csv`

```zsh
pnpm run seo:rename-product-media
```

Optional flags:

```zsh
pnpm run seo:rename-product-media -- --inRoot product-media --outRoot product-media-seo --reportDir reports --limitProducts 5
```

### Using the mapping (lookup / traceability)

`reports/seo-rename-map.json` contains rows like:
- `from`: original path under `product-media/...`
- `to`: renamed path under `product-media-seo/...`

Common tasks:

Find the new name for an old file:
```zsh
node -e "const m=require('./reports/seo-rename-map.json'); const old=process.argv[1]; const hit=m.find(x=>x.from===old); console.log(hit?hit.to:'NOT_FOUND');" "product-media/golfreizen/engeland/cornwall-golf/2017/11/IMG_4399_opt.jpg"
```

Find the old name for a new file:
```zsh
node -e "const m=require('./reports/seo-rename-map.json'); const neu=process.argv[1]; const hit=m.find(x=>x.to===neu); console.log(hit?hit.from:'NOT_FOUND');" "product-media-seo/golfreizen/engeland/cornwall-golf/2017/11/cornwall-golf-01.jpg"
```

### Rollback strategy

Because `seo:rename-product-media` creates a copy, rollback is simply:
- Stop using `product-media-seo/` and switch back to `product-media/`.
- Or delete `product-media-seo/` and regenerate later.

## SEO rename from scraped URLs (v2)

If you want filenames tied to the original scraped image URL, use:

```zsh
pnpm run seo:rename-from-scrape
```

Defaults:
- Reads products from `product-data.with-media.json` (must contain `slug` + `images[]` URLs).
- Reads source files from `product-media/`.
- Writes a renamed copy to `product-media-seo-v2/`.

Filename scheme:
- `{land}-{product_slug}-{original_filename}{ext}`

Outputs:
- `reports/seo-rename-scrape-map.json`
- `reports/seo-rename-scrape-map.csv`

The mapping is keyed on `originalImageUrl` (scraped URL) and points to `newUrlPath` (path under the new SEO folder).

Options:

```zsh
pnpm run seo:rename-from-scrape -- --inRoot product-media --outRoot product-media-seo-v2 --reportDir reports --limitProducts 5 --dedupe copy
```

`--dedupe hardlink` will hardlink identical source files when possible (saves disk, still creates per-product paths).

## Interpreting the unused-backup report

`pnpm run report:unused-backup` lists backup files that were not found under any product folder in `product-media/`.

Typical reasons:
- The image URL exists on a page but wasn’t in your WordPress media API backup yet.
- The image comes from a different location (not `/wp-content/uploads/...`).
- The page scrape was interrupted or incomplete.
