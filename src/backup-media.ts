import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

async function download(url: string, target: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText}: ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
}

type MediaItem = {
  source_url?: unknown;
  media_details?: {
    file?: unknown;
  };
};

async function fetchMediaPage(baseUrl: string, perPage: number, page: number) {
  const url = `${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/media?per_page=${perPage}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'authentic-golf-wp-tools/1.0 (+local script)',
      accept: 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`Media fetch failed ${res.status} ${res.statusText}: ${url}`);
  }

  const totalPagesHeader = res.headers.get('x-wp-totalpages');
  const totalPages = totalPagesHeader ? Number(totalPagesHeader) : undefined;

  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error(`Expected array response from ${url}`);

  return { items: json as MediaItem[], totalPages };
}

async function backupMedia() {
  const args = process.argv.slice(2);

  const baseUrl = getArgValue(args, '--baseUrl') ?? 'https://authentic.golf';
  const outDir = getArgValue(args, '--outDir') ?? 'backup';
  const perPage = getArgInt(args, '--perPage') ?? 100;
  const maxPagesArg = getArgInt(args, '--pages');

  let totalPages = maxPagesArg;

  for (let page = 1; ; page++) {
    const { items, totalPages: discoveredTotal } = await fetchMediaPage(baseUrl, perPage, page);
    if (!totalPages && discoveredTotal && Number.isFinite(discoveredTotal)) {
      totalPages = discoveredTotal;
    }

    for (const item of items) {
      const relativePath = item.media_details?.file;
      const sourceUrl = item.source_url;

      if (typeof relativePath !== 'string') continue;
      if (typeof sourceUrl !== 'string') continue;

      const target = path.join(outDir, relativePath);
      if (await exists(target)) {
        process.stdout.write(`Skipped (exists): ${target}\n`);
        continue;
      }

      await download(sourceUrl, target);
      process.stdout.write(`Downloaded: ${target}\n`);
    }

    if (totalPages && page >= totalPages) break;
    if (!totalPages) {
      // If the API didn't provide x-wp-totalpages, stop when a page returns < perPage
      if (items.length < perPage) break;
    }
  }
}

await backupMedia();
