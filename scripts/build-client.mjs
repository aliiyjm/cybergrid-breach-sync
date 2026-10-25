// Compila el cliente con esbuild: TypeScript → client/dist/assets/main.js,
// CSS → client/dist/assets/main.css, y copia index.html y los estáticos.
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'client/dist');
const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: [
    { in: 'client/src/main.ts', out: 'main' },
    { in: 'client/src/styles/main.css', out: 'main' },
  ],
  outdir: path.join(outdir, 'assets'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: production,
  logLevel: 'info',
  define: {
    // URL del backend si el cliente se aloja en otro dominio; vacío = mismo origen.
    __SERVER_URL__: JSON.stringify(process.env.PUBLIC_SERVER_URL ?? ''),
  },
};

async function copyStatic() {
  await cp(path.join(root, 'client/index.html'), path.join(outdir, 'index.html'));
  await cp(path.join(root, 'client/public'), outdir, { recursive: true });
}

await rm(outdir, { recursive: true, force: true });
await mkdir(path.join(outdir, 'assets'), { recursive: true });
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[cliente] Compilación en modo vigilancia');
} else {
  await build(options);
  console.log(`[cliente] Compilado en ${path.relative(root, outdir)}`);
}
