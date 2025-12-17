import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type PageLink = { id: number; link: string };

type OutputRow = {
  id: number;
  link: string;
  images: string[];
  mapIframe?: string;
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSlashes(url: string): string {
  // safeguard for any raw JSON escaped strings
  return url.replaceAll('\\/', '/');
}

function toAbsoluteUrl(candidate: string, baseUrl: string): string | undefined {
  const trimmed = candidate.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return undefined;
  if (trimmed.startsWith('data:')) return undefined;

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function toOriginalWpImageUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const segments = u.pathname.split('/');
    const last = segments[segments.length - 1] ?? '';

    let updated = last;
    updated = updated.replace(/-scaled(\.[^.\/]+)$/i, '$1');
    updated = updated.replace(/-(\d+)x(\d+)(\.[^.\/]+)$/i, '$3');

    if (updated !== last) {
      segments[segments.length - 1] = updated;
      u.pathname = segments.join('/');
    }

    return u.toString();
  } catch {
    return urlStr
      .replace(/-scaled(\.[a-z0-9]+)(\?.*)?$/i, '$1$2')
      .replace(/-(\d+)x(\d+)(\.[a-z0-9]+)(\?.*)?$/i, '$3$4');
  }
}

function extractAttr(tag: string, attrName: string): string[] {
  const re = new RegExp(`${attrName}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const m = tag.match(re);
  if (!m?.[1]) return [];
  return [m[1]];
}

function extractSrcset(tag: string): string[] {
  const raw = extractAttr(tag, 'srcset')[0];
  if (!raw) return [];
  const cleaned = raw.replace(/^['"]|['"]$/g, '');
  return cleaned
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractImageCandidatesFromHtml(html: string): string[] {
  const out: string[] = [];

  // <img ...>
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    out.push(...extractAttr(tag, 'src'));
    out.push(...extractAttr(tag, 'data-src'));
    out.push(...extractAttr(tag, 'data-lazy-src'));
    out.push(...extractAttr(tag, 'data-original'));
    out.push(...extractSrcset(tag));
  }

  // og:image
  const ogTags = html.match(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/gi) ?? [];
  for (const tag of ogTags) out.push(...extractAttr(tag, 'content'));

  // rel=preload as=image
  const preloadTags = html.match(/<link\b[^>]*rel\s*=\s*["']preload["'][^>]*>/gi) ?? [];
  for (const tag of preloadTags) {
    const as = extractAttr(tag, 'as')[0]?.replace(/^['"]|['"]$/g, '').toLowerCase();
    if (as === 'image') out.push(...extractAttr(tag, 'href'));
  }

  return out.map((s) => s.replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function extractIframeCandidatesFromHtml(html: string): string[] {
  const out: string[] = [];
  const iframeTags = html.match(/<iframe\b[^>]*>/gi) ?? [];
  for (const tag of iframeTags) {
    out.push(...extractAttr(tag, 'src'));
    out.push(...extractAttr(tag, 'data-src'));
  }
  return out.map((s) => s.replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function buildMapIframe(src: string): string {
  return `<iframe loading='lazy' src='${src}' width='1200' height='480'></iframe>`;
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'authentic-golf-wp-tools/1.0 (+local script)',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const inPath = getArgValue(args, '--in') ?? 'wp-data/pages.id-link.json';
  const outPath = getArgValue(args, '--out') ?? 'wp-data/pages.images.json';
  const delayMs = getArgInt(args, '--delayMs') ?? 1000;
  const timeoutMs = getArgInt(args, '--timeoutMs') ?? 20000;
  const limit = getArgInt(args, '--limit');

  const absIn = path.resolve(process.cwd(), inPath);
  const absOut = path.resolve(process.cwd(), outPath);

  const raw = await readFile(absIn, 'utf8');
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) throw new Error(`Expected an array in ${inPath}`);

  const pages: PageLink[] = (data as any[])
    .map((p) => ({ id: p?.id, link: p?.link }))
    .filter((p) => typeof p.id === 'number' && typeof p.link === 'string')
    .map((p) => ({ id: p.id, link: normalizeSlashes(p.link) }));

  const toProcess = typeof limit === 'number' ? pages.slice(0, Math.max(0, limit)) : pages;

  const results: OutputRow[] = [];
  for (let i = 0; i < toProcess.length; i++) {
    const { id, link } = toProcess[i];
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${id} ${link}\n`);

    try {
      const html = await fetchHtml(link, timeoutMs);
      const candidates = extractImageCandidatesFromHtml(html);
      const absolute = candidates
        .map((c) => toAbsoluteUrl(c, link))
        .filter((u): u is string => Boolean(u));

      const images = uniq(absolute.map((u) => toOriginalWpImageUrl(u)));

      const iframeCandidates = extractIframeCandidatesFromHtml(html);
      const iframeAbsolute = iframeCandidates
        .map((c) => toAbsoluteUrl(c, link))
        .filter((u): u is string => Boolean(u));

      const mapSrc = iframeAbsolute.find((u) => /(^https?:\/\/)(www\.)?google\.[^/]+\/maps\//i.test(u));
      const mapIframe = mapSrc ? buildMapIframe(mapSrc) : undefined;

      results.push({ id, link, images, mapIframe });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id, link, images: [], error: msg });
    }

    if (i < toProcess.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  await writeFile(absOut, JSON.stringify(results, null, 2) + '\n', 'utf8');
  process.stdout.write(`Wrote ${results.length} rows to ${outPath}\n`);
}

await main();
