import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

type Product = {
  slug?: unknown;
  images?: unknown;
  [k: string]: unknown;
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeSlugPath(slug: string): string {
  // Use slug as folder name; keep nested structure, strip leading slashes.
  const cleaned = slug.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  // Prevent path traversal
  const parts = cleaned.split('/').filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/');
}

function uploadsRelativePathFromUrl(urlStr: string): string | undefined {
  try {
    const u = new URL(urlStr);
    const marker = '/wp-content/uploads/';
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return undefined;
    return u.pathname.slice(idx + marker.length).replace(/^\/+/, '');
  } catch {
    return undefined;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const productsIn = getArgValue(args, '--productsIn') ?? 'product-data.with-media.json';
  const backupDir = getArgValue(args, '--backupDir') ?? 'backup';
  const outRoot = getArgValue(args, '--outRoot') ?? 'product-media';
  const limit = getArgInt(args, '--limit');

  const productsRaw = await readFile(path.resolve(process.cwd(), productsIn), 'utf8');
  const productsJson = JSON.parse(productsRaw) as unknown;
  if (!Array.isArray(productsJson)) throw new Error(`Expected array in ${productsIn}`);

  const products = productsJson as Product[];
  const toProcess = typeof limit === 'number' ? products.slice(0, Math.max(0, limit)) : products;

  let copied = 0;
  let missing = 0;
  let skipped = 0;

  for (const product of toProcess) {
    const slug = typeof product.slug === 'string' ? product.slug : undefined;
    const images = Array.isArray(product.images) ? (product.images as unknown[]) : [];
    if (!slug) {
      skipped++;
      continue;
    }

    const productDir = path.resolve(process.cwd(), outRoot, safeSlugPath(slug));
    await mkdir(productDir, { recursive: true });

    for (const img of images) {
      if (typeof img !== 'string') continue;
      const rel = uploadsRelativePathFromUrl(img);
      if (!rel) {
        skipped++;
        continue;
      }

      const src = path.resolve(process.cwd(), backupDir, rel);
      if (!(await exists(src))) {
        missing++;
        process.stderr.write(`Missing in backup: ${src}\n`);
        continue;
      }

      const dest = path.join(productDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });

      if (await exists(dest)) {
        continue;
      }

      await copyFile(src, dest);
      copied++;
    }
  }

  process.stdout.write(`Done. copied=${copied} missing=${missing} skipped=${skipped}\n`);
}

await main();
