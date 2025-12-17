import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type RenameRow = {
  productSlugPath: string;
  uploadsRel: string;
  from: string;
  to: string;
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

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function findProductRoots(rootDir: string): Promise<string[]> {
  // A "product root" is any directory that contains a year folder (YYYY)
  // which itself contains a month folder (MM).
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const yyyy of subdirs) {
      if (!/^\d{4}$/.test(yyyy)) continue;
      const yyyyAbs = path.join(dir, yyyy);
      const yyyyEntries = await readdir(yyyyAbs, { withFileTypes: true });
      const hasMonth = yyyyEntries.some((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
      if (hasMonth) {
        out.push(dir);
        return; // don't recurse further under this product root
      }
    }

    for (const name of subdirs) {
      await walk(path.join(dir, name));
    }
  }

  await walk(rootDir);
  return out;
}

function normalizeRel(p: string): string {
  return p.replaceAll('\\', '/');
}

function slugBaseName(productSlugPath: string): string {
  const parts = productSlugPath.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? 'product';
  // keep as-is but ensure clean
  return last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function uploadsRelFromProductPath(absFile: string, productRootAbs: string): string | undefined {
  const rel = normalizeRel(path.relative(productRootAbs, absFile));
  const m = rel.match(/^(\d{4}\/\d{2}\/[^/].*)$/);
  return m?.[1];
}

function extnameLower(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function pad(num: number, width: number): string {
  const s = String(num);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

async function main() {
  const args = process.argv.slice(2);
  const inRoot = getArgValue(args, '--inRoot') ?? 'product-media';
  const outRoot = getArgValue(args, '--outRoot') ?? 'product-media-seo';
  const outReportDir = getArgValue(args, '--reportDir') ?? 'reports';
  const limitProducts = getArgInt(args, '--limitProducts');

  const absInRoot = path.resolve(process.cwd(), inRoot);
  const absOutRoot = path.resolve(process.cwd(), outRoot);
  const absReportDir = path.resolve(process.cwd(), outReportDir);

  const s = await stat(absInRoot).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`Missing input dir: ${inRoot}`);

  // Discover product folders nested under product-media.
  const productRootsAbs = (await findProductRoots(absInRoot)).sort();
  const productRootsRel = productRootsAbs.map((d) => normalizeRel(path.relative(absInRoot, d)));
  const selected =
    typeof limitProducts === 'number'
      ? productRootsRel.slice(0, Math.max(0, limitProducts))
      : productRootsRel;

  const mapping: RenameRow[] = [];

  for (const productSlugPath of selected) {
    const productAbs = path.join(absInRoot, productSlugPath);
    const base = slugBaseName(productSlugPath);
    const files = await listFilesRecursive(productAbs);

    // Group by uploadsRel (year/month) folder to preserve structure.
    // We copy to outRoot/<productSlug>/<year>/<month>/<base>-NN.<ext>
    const sorted = files.slice().sort();
    const usedNames = new Set<string>();

    let idx = 1;
    for (const absFile of sorted) {
      const uploadsRel = uploadsRelFromProductPath(absFile, productAbs);
      if (!uploadsRel) continue;

      const ext = extnameLower(absFile) || '';
      let name = `${base}-${pad(idx, 2)}${ext}`;
      while (usedNames.has(name)) {
        idx++;
        name = `${base}-${pad(idx, 2)}${ext}`;
      }
      usedNames.add(name);

      const dest = path.join(absOutRoot, productSlugPath, path.dirname(uploadsRel), name);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(absFile, dest);

      mapping.push({
        productSlugPath,
        uploadsRel,
        from: normalizeRel(path.relative(process.cwd(), absFile)),
        to: normalizeRel(path.relative(process.cwd(), dest))
      });

      idx++;
    }
  }

  await mkdir(absReportDir, { recursive: true });
  const jsonPath = path.join(absReportDir, 'seo-rename-map.json');
  const csvPath = path.join(absReportDir, 'seo-rename-map.csv');

  await writeFile(jsonPath, JSON.stringify(mapping, null, 2) + '\n', 'utf8');
  await writeFile(csvPath, ['productSlugPath,uploadsRel,from,to', ...mapping.map((r) => `${r.productSlugPath},${r.uploadsRel},${r.from},${r.to}`)].join('\n') + '\n', 'utf8');

  process.stdout.write(`Wrote ${mapping.length} rename mappings to ${path.relative(process.cwd(), jsonPath)} and .csv\n`);
}

await main();
