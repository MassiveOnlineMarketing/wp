import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type PageMedia = {
  link: string;
  images: string[];
  mapIframe?: string;
};

type Product = {
  slug?: unknown;
  old_urls?: unknown;
  images?: unknown;
  mapIframe?: unknown;
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

function normalizeUrlish(input: string): string {
  const s = input.trim().replaceAll('\\/', '/');
  try {
    const u = new URL(s);
    u.hash = '';
    // Keep query (some map embeds have params), but for matching pages we mostly don't want it.
    // We'll build keys with and without query.
    return u.toString();
  } catch {
    return s;
  }
}

function normalizeForMatch(urlStr: string): { full: string; noQuery: string } {
  const normalized = normalizeUrlish(urlStr);
  try {
    const u = new URL(normalized);
    const full = u.toString();
    u.search = '';
    const noQuery = u.toString();
    return { full, noQuery };
  } catch {
    return { full: normalized, noQuery: normalized };
  }
}

function splitOldUrls(oldUrls: string): string[] {
  return oldUrls
    .split(/\s*[\n,;]+\s*|\s{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pathTail(urlStr: string): string | undefined {
  try {
    const u = new URL(urlStr);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1];
  } catch {
    const parts = urlStr.split('/').filter(Boolean);
    return parts[parts.length - 1];
  }
}

function tokenizeSlug(slug: string): string[] {
  const cleaned = slug.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const lastSeg = cleaned.split('/').filter(Boolean).slice(-1)[0] ?? '';
  const tokens = lastSeg
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean);

  const stop = new Set([
    'golf',
    'of',
    'the',
    'and',
    'tour',
    'tours',
    'short',
    'break',
    'links',
    'experience',
    'test'
  ]);

  return tokens.filter((t) => t.length >= 3 && !stop.has(t));
}

function scorePageForTokens(pageLink: string, tokens: string[], preferLang: 'nl' | 'en'): number {
  const linkLower = pageLink.toLowerCase();
  let score = 0;
  if (linkLower.includes(`/${preferLang}/`)) score += 3;
  for (const token of tokens) {
    if (linkLower.includes(token)) score += 2;
  }
  return score;
}

function bestTokenMatch(pages: PageMedia[], tokens: string[], preferLang: 'nl' | 'en'): PageMedia | undefined {
  if (!tokens.length) return undefined;
  let best: PageMedia | undefined;
  let bestScore = 0;
  for (const p of pages) {
    const score = scorePageForTokens(p.link, tokens, preferLang);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // Require at least one token hit (+2) to avoid random matches.
  return bestScore >= 2 ? best : undefined;
}

function preferBestMatch(candidates: PageMedia[], preferLang: 'nl' | 'en'): PageMedia {
  const byLang = candidates.filter((c) => c.link.includes(`/${preferLang}/`));
  const pool = byLang.length ? byLang : candidates;
  return pool
    .slice()
    .sort((a, b) => a.link.length - b.link.length)[0];
}

function deriveCandidatesFromOldUrl(oldUrl: string): string[] {
  const { full, noQuery } = normalizeForMatch(oldUrl);
  const out = new Set<string>([full, noQuery]);

  for (const u of [full, noQuery]) {
    out.add(u.replace('/nl/golfreis/', '/nl/'));
    out.add(u.replace('/en/golfreis/', '/en/'));
    out.add(u.replace('/golfreis/', '/'));
  }

  return [...out];
}

async function main() {
  const args = process.argv.slice(2);
  const productsIn = getArgValue(args, '--productsIn') ?? 'product-data.json';
  const pagesIn = getArgValue(args, '--pagesIn') ?? 'wp-data/pages.images.json';
  const outPath = getArgValue(args, '--out') ?? 'product-data.with-media.json';
  const limit = getArgInt(args, '--limit');

  const absProductsIn = path.resolve(process.cwd(), productsIn);
  const absPagesIn = path.resolve(process.cwd(), pagesIn);
  const absOut = path.resolve(process.cwd(), outPath);

  const productsRaw = await readFile(absProductsIn, 'utf8');
  const pagesRaw = await readFile(absPagesIn, 'utf8');

  const productsJson = JSON.parse(productsRaw) as unknown;
  const pagesJson = JSON.parse(pagesRaw) as unknown;

  if (!Array.isArray(productsJson)) throw new Error(`Expected array in ${productsIn}`);
  if (!Array.isArray(pagesJson)) throw new Error(`Expected array in ${pagesIn}`);

  const pages: PageMedia[] = (pagesJson as any[])
    .map((p) => ({ link: p?.link, images: p?.images, mapIframe: p?.mapIframe }))
    .filter((p) => typeof p.link === 'string' && Array.isArray(p.images))
    .map((p) => ({
      link: normalizeUrlish(p.link),
      images: (p.images as unknown[]).filter((x) => typeof x === 'string') as string[],
      mapIframe: typeof p.mapIframe === 'string' ? p.mapIframe : undefined
    }));

  const byExact = new Map<string, PageMedia>();
  for (const p of pages) {
    const { full, noQuery } = normalizeForMatch(p.link);
    byExact.set(full, p);
    byExact.set(noQuery, p);
  }

  const enriched: Product[] = [];
  const products = productsJson as Product[];
  const toProcess = typeof limit === 'number' ? products.slice(0, Math.max(0, limit)) : products;

  let matched = 0;
  let unmatched = 0;

  for (const product of toProcess) {
    const oldUrlsRaw = typeof product.old_urls === 'string' ? product.old_urls : '';
    const oldUrls = oldUrlsRaw ? splitOldUrls(oldUrlsRaw) : [];
    const slug = typeof product.slug === 'string' ? product.slug : '';

    let pageMatch: PageMedia | undefined;

    // 1) exact/derived candidates
    for (const oldUrl of oldUrls) {
      for (const cand of deriveCandidatesFromOldUrl(oldUrl)) {
        const hit = byExact.get(cand);
        if (hit) {
          pageMatch = hit;
          break;
        }
      }
      if (pageMatch) break;
    }

    // 2) fallback: contains tail segment
    if (!pageMatch) {
      const tails = oldUrls.map((u) => pathTail(u)).filter((x): x is string => Boolean(x));
      const uniqTails = [...new Set(tails)];
      const candidates: PageMedia[] = [];
      for (const t of uniqTails) {
        for (const p of pages) {
          if (p.link.includes(`/${t}/`) || p.link.endsWith(`/${t}`)) candidates.push(p);
        }
        if (candidates.length) break;
      }
      if (candidates.length) {
        pageMatch = preferBestMatch(candidates, 'nl');
      }
    }

    // 3) fallback: tokenize product slug and do a best-score match
    if (!pageMatch && slug) {
      const tokens = tokenizeSlug(slug);
      pageMatch = bestTokenMatch(pages, tokens, 'nl') ?? bestTokenMatch(pages, tokens, 'en');
    }

    const outProduct: Product = { ...product };
    if (pageMatch) {
      outProduct.images = pageMatch.images;
      if (pageMatch.mapIframe) outProduct.mapIframe = pageMatch.mapIframe;
      matched++;
    } else {
      outProduct.images = [];
      unmatched++;
      if (oldUrlsRaw) {
        process.stderr.write(`No media match for old_urls: ${oldUrlsRaw}\n`);
      }
    }

    enriched.push(outProduct);
  }

  // If limited, preserve the rest unchanged (but still add images/mapIframe to processed only)
  if (typeof limit === 'number' && limit < products.length) {
    enriched.push(...products.slice(limit));
  }

  await writeFile(absOut, JSON.stringify(enriched, null, 2) + '\n', 'utf8');
  process.stdout.write(`Wrote ${enriched.length} products to ${outPath} (matched: ${matched}, unmatched: ${unmatched})\n`);
}

await main();
