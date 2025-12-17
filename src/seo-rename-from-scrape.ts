import { copyFile, link as hardlink, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Product = {
  slug?: unknown;
  images?: unknown;
};

type MapRow = {
  land: string;
  productSlug: string;
  productSlugPath: string;

  originalImageUrl: string;
  uploadsRel: string;

  expectedSourcePath: string;
  sourcePath: string;
  resolvedFromOtherProduct: boolean;

  targetPath: string;
  newUrlPath: string;

  status: 'copied' | 'linked' | 'missing';
  error?: string;
};

function getArgValue(args: string[], name: string): string | undefined {
  const idx = args.lastIndexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function getArgInt(args: string[], name: string): number | undefined {
  const v = getArgValue(args, name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeRel(p: string): string {
  return p.replaceAll('\\', '/');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function safeSlugToken(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function parseProductSlug(slug: string): { land: string; productSlug: string; productSlugPath: string } {
  // Expected: /golfreizen/<land>/<product>
  const cleaned = slug.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  const golfreizenIdx = parts.indexOf('golfreizen');
  const landRaw = golfreizenIdx >= 0 ? parts[golfreizenIdx + 1] : parts[1];
  const productRaw = parts[parts.length - 1] ?? '';

  if (!landRaw || !productRaw) {
    throw new Error(`Unexpected product slug: ${slug}`);
  }

  const land = safeSlugToken(landRaw);
  const productSlug = safeSlugToken(productRaw);

  return {
    land,
    productSlug,
    productSlugPath: normalizeRel(path.posix.join('golfreizen', land, productSlug))
  };
}

function uploadsRelFromImageUrl(urlStr: string): string {
  const marker = '/wp-content/uploads/';
  const u = new URL(urlStr);
  const idx = u.pathname.indexOf(marker);
  if (idx === -1) throw new Error(`Not an uploads URL: ${urlStr}`);
  return u.pathname.slice(idx + marker.length).replace(/^\/+/, '');
}

function basenameTokenFromImageUrl(urlStr: string): { base: string; ext: string } {
  const u = new URL(urlStr);
  const file = path.posix.basename(u.pathname);
  const ext = path.extname(file).toLowerCase();
  const baseRaw = ext ? file.slice(0, -ext.length) : file;
  return { base: safeSlugToken(baseRaw), ext };
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

async function buildUploadsIndex(absInRoot: string): Promise<Map<string, string>> {
  const idx = new Map<string, string>();

  const golfreizenRoot = path.join(absInRoot, 'golfreizen');
  if (!(await exists(golfreizenRoot))) return idx;

  const files = await walkFiles(golfreizenRoot);

  for (const absFile of files) {
    const rel = normalizeRel(path.relative(absInRoot, absFile));
    const parts = rel.split('/');
    // rel: golfreizen/<land>/<product>/<uploadsRel...>
    if (parts.length < 5) continue;
    if (parts[0] !== 'golfreizen') continue;

    const uploadsRel = parts.slice(3).join('/');
    if (!idx.has(uploadsRel)) idx.set(uploadsRel, absFile);
  }

  return idx;
}

async function main() {
  const args = process.argv.slice(2);
  const productsIn = getArgValue(args, '--productsIn') ?? 'product-data.with-media.json';
  const inRoot = getArgValue(args, '--inRoot') ?? 'product-media';
  const outRoot = getArgValue(args, '--outRoot') ?? 'product-media-seo-v2';
  const reportDir = getArgValue(args, '--reportDir') ?? 'reports';
  const limitProducts = getArgInt(args, '--limitProducts');
  const dedupe = (getArgValue(args, '--dedupe') ?? 'copy').toLowerCase(); // copy | hardlink
  const fallbackSearch = (getArgValue(args, '--fallbackSearch') ?? '1') !== '0';

  const absProductsIn = path.resolve(process.cwd(), productsIn);
  const absInRoot = path.resolve(process.cwd(), inRoot);
  const absOutRoot = path.resolve(process.cwd(), outRoot);
  const absReportDir = path.resolve(process.cwd(), reportDir);

  const products = JSON.parse(await readFile(absProductsIn, 'utf8')) as unknown;
  if (!Array.isArray(products)) throw new Error(`Expected array in ${productsIn}`);

  const outUrlRoot = '/' + normalizeRel(outRoot).replace(/^\/+/, '').replace(/\/+$/, '');

  const selected =
    typeof limitProducts === 'number'
      ? (products as Product[]).slice(0, Math.max(0, limitProducts))
      : (products as Product[]);

  const uploadsIndex = fallbackSearch ? await buildUploadsIndex(absInRoot) : new Map<string, string>();

  const map: MapRow[] = [];

  // For hardlink dedupe: remember first created target per uploadsRel (same WordPress file reused across products).
  const linkCache = new Map<string, string>();

  let copied = 0;
  let linked = 0;
  let missing = 0;

  for (const p of selected) {
    const slug = typeof p.slug === 'string' ? p.slug : undefined;
    const images = Array.isArray(p.images) ? (p.images as unknown[]).filter((x) => typeof x === 'string') : [];
    if (!slug) continue;

    const { land, productSlug, productSlugPath } = parseProductSlug(slug);

    for (const img of images as string[]) {
      let uploadsRel: string;
      let base: string;
      let ext: string;

      try {
        uploadsRel = uploadsRelFromImageUrl(img);
        ({ base, ext } = basenameTokenFromImageUrl(img));
      } catch {
        // Skip non-uploads URLs
        continue;
      }

      const expectedSrcAbs = path.join(absInRoot, productSlugPath, uploadsRel);
      let srcAbs = expectedSrcAbs;
      let resolvedFromOtherProduct = false;

      if (!(await exists(srcAbs)) && fallbackSearch) {
        const alt = uploadsIndex.get(uploadsRel);
        if (alt && (await exists(alt))) {
          srcAbs = alt;
          resolvedFromOtherProduct = true;
        }
      }

      const newFileName = `${land}-${productSlug}-${base}${ext}`;
      const destAbs = path.join(absOutRoot, productSlugPath, path.dirname(uploadsRel), newFileName);
      const newUrlPath = normalizeRel(path.posix.join(outUrlRoot, productSlugPath, path.posix.dirname(uploadsRel), newFileName));

      const rowBase = {
        land,
        productSlug,
        productSlugPath,
        originalImageUrl: img,
        uploadsRel,
        expectedSourcePath: normalizeRel(path.relative(process.cwd(), expectedSrcAbs)),
        sourcePath: normalizeRel(path.relative(process.cwd(), srcAbs)),
        resolvedFromOtherProduct,
        targetPath: normalizeRel(path.relative(process.cwd(), destAbs)),
        newUrlPath
      };

      if (!(await exists(srcAbs))) {
        missing++;
        map.push({ ...rowBase, status: 'missing', error: 'source_missing' });
        continue;
      }

      await mkdir(path.dirname(destAbs), { recursive: true });

      if (await exists(destAbs)) {
        map.push({ ...rowBase, status: dedupe === 'hardlink' ? 'linked' : 'copied' });
        continue;
      }

      try {
        if (dedupe === 'hardlink') {
          const already = linkCache.get(uploadsRel);
          if (already && (await exists(already))) {
            await hardlink(already, destAbs);
            linked++;
            map.push({ ...rowBase, status: 'linked' });
          } else {
            await copyFile(srcAbs, destAbs);
            linkCache.set(uploadsRel, destAbs);
            copied++;
            map.push({ ...rowBase, status: 'copied' });
          }
        } else {
          await copyFile(srcAbs, destAbs);
          copied++;
          map.push({ ...rowBase, status: 'copied' });
        }
      } catch (e) {
        missing++;
        map.push({ ...rowBase, status: 'missing', error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  await mkdir(absReportDir, { recursive: true });
  const jsonPath = path.join(absReportDir, 'seo-rename-scrape-map.json');
  const csvPath = path.join(absReportDir, 'seo-rename-scrape-map.csv');

  await writeFile(jsonPath, JSON.stringify(map, null, 2) + '\n', 'utf8');

  const header = [
    'land',
    'productSlug',
    'productSlugPath',
    'originalImageUrl',
    'uploadsRel',
    'expectedSourcePath',
    'sourcePath',
    'resolvedFromOtherProduct',
    'targetPath',
    'newUrlPath',
    'status',
    'error'
  ].join(',');

  const csvLines = map.map((r) =>
    [
      r.land,
      r.productSlug,
      r.productSlugPath,
      r.originalImageUrl,
      r.uploadsRel,
      r.expectedSourcePath,
      r.sourcePath,
      String(r.resolvedFromOtherProduct),
      r.targetPath,
      r.newUrlPath,
      r.status,
      r.error ?? ''
    ]
      .map((v) => `"${String(v).replaceAll('"', '""')}"`)
      .join(',')
  );

  await writeFile(csvPath, [header, ...csvLines].join('\n') + '\n', 'utf8');

  process.stdout.write(
    `Done. copied=${copied} linked=${linked} missing=${missing}. Mapping: ${path.relative(process.cwd(), jsonPath)}\n`
  );
}

await main();
