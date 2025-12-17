import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function getArgValue(args: string[], name: string): string | undefined {
  const idx = args.lastIndexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
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

function normalizeRel(p: string): string {
  return p.replaceAll('\\', '/');
}

function extractUploadsRelFromProductMediaPath(absFile: string): string | undefined {
  // We store copies as: product-media/<slug...>/<year>/<month>/<file>
  // So find first occurrence of /YYYY/MM/ and take the rest.
  const norm = normalizeRel(absFile);
  const m = norm.match(/\/(\d{4}\/\d{2}\/[^/].*)$/);
  return m?.[1];
}

async function main() {
  const args = process.argv.slice(2);
  const backupDir = getArgValue(args, '--backupDir') ?? 'backup';
  const productMediaDir = getArgValue(args, '--productMediaDir') ?? 'product-media';
  const outDir = getArgValue(args, '--outDir') ?? 'reports';

  const absBackup = path.resolve(process.cwd(), backupDir);
  const absProductMedia = path.resolve(process.cwd(), productMediaDir);
  const absOutDir = path.resolve(process.cwd(), outDir);

  // Ensure dirs exist (friendly error if missing)
  const b = await stat(absBackup).catch(() => null);
  if (!b?.isDirectory()) throw new Error(`Missing backup dir: ${backupDir}`);
  const p = await stat(absProductMedia).catch(() => null);
  if (!p?.isDirectory()) throw new Error(`Missing product-media dir: ${productMediaDir}`);

  const backupFilesAbs = await listFilesRecursive(absBackup);
  const backupRel = backupFilesAbs.map((f) => normalizeRel(path.relative(absBackup, f)));

  const productFilesAbs = await listFilesRecursive(absProductMedia);
  const usedRel = new Set<string>();
  for (const f of productFilesAbs) {
    const rel = extractUploadsRelFromProductMediaPath(f);
    if (rel) usedRel.add(rel);
  }

  const unused = backupRel.filter((rel) => !usedRel.has(rel));

  await mkdir(absOutDir, { recursive: true });
  const jsonPath = path.join(absOutDir, 'unused-backup-media.json');
  const csvPath = path.join(absOutDir, 'unused-backup-media.csv');

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        backupDir,
        productMediaDir,
        backupFileCount: backupRel.length,
        usedUniqueUploadPaths: usedRel.size,
        unusedCount: unused.length,
        unused
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  await writeFile(csvPath, ['relative_path', ...unused].join('\n') + '\n', 'utf8');

  process.stdout.write(
    `Wrote ${unused.length} unused backup files to ${path.relative(process.cwd(), jsonPath)} and .csv\n`
  );
}

await main();
