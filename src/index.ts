import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type PageLike = {
	id?: unknown;
	link?: unknown;
};

function getArgValue(args: string[], name: string): string | undefined {
	const idx = args.lastIndexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function normalizeLink(link: string): string {
	// JSON parsing already converts `https:\/\/` -> `https://`, but keep this
	// as a safeguard in case input is a raw string.
	return link.replaceAll('\\/', '/');
}

async function main() {
	const args = process.argv.slice(2);
	const inPath = getArgValue(args, '--in') ?? 'wp-data/pages.json';
	const outPath = getArgValue(args, '--out') ?? 'wp-data/pages.id-link.json';

	const absIn = path.resolve(process.cwd(), inPath);
	const absOut = path.resolve(process.cwd(), outPath);

	const raw = await readFile(absIn, 'utf8');
	const data = JSON.parse(raw) as unknown;

	if (!Array.isArray(data)) {
		throw new Error(`Expected an array in ${inPath}`);
	}

	const extracted = (data as PageLike[])
		.map((p) => {
			const id = typeof p?.id === 'number' ? p.id : undefined;
			const link = typeof p?.link === 'string' ? normalizeLink(p.link) : undefined;
			return id && link ? { id, link } : undefined;
		})
		.filter((x): x is { id: number; link: string } => Boolean(x));

	await writeFile(absOut, JSON.stringify(extracted, null, 2) + '\n', 'utf8');
	process.stdout.write(`Wrote ${extracted.length} records to ${outPath}\n`);
}

await main();
