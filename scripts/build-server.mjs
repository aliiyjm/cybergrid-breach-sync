// Empaqueta el servidor con esbuild: server/dist/index.js y server/dist/migrate.js.
// Las dependencias de npm quedan como externas (se instalan con npm ci).
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'server/dist');

await rm(outdir, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: [
    { in: 'server/src/index.ts', out: 'index' },
    { in: 'server/src/database/migrate.ts', out: 'migrate' },
  ],
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
console.log(`[servidor] Compilado en ${path.relative(root, outdir)}`);
