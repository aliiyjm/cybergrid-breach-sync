/**
 * Mide los endpoints de evaluación contra un servidor en marcha:
 *   1. POST /api/test/seed con 1000 partidas (tiempo de procesamiento).
 *   2. 50 × GET /api/test/telemetry (p50, p95, máximo).
 *
 * Uso:
 *   npm run bench:api -- --url http://localhost:3000 [--matches 1000] [--runs 50] [--out reports/api-benchmark.json]
 * Si el servidor exige clave, defina TEST_API_KEY en el entorno.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const baseUrl = arg('url', process.env.BENCH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const matches = Number(arg('matches', '1000'));
const runs = Number(arg('runs', '50'));
const out = arg('out', 'reports/api-benchmark.json');
const TARGET_MS = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}
const r1 = (v: number) => Math.round(v * 10) / 10;

async function main(): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.TEST_API_KEY) headers['X-Test-Api-Key'] = process.env.TEST_API_KEY;

  const seedStart = performance.now();
  const seedRes = await fetch(`${baseUrl}/api/test/seed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ matches, playersPerMatch: 4, reset: true, batchId: `bench_${Date.now()}` }),
  });
  const seedWall = performance.now() - seedStart;
  const seedBody = (await seedRes.json()) as { timing?: { processingMs: number }; error?: unknown };
  if (seedRes.status !== 200) throw new Error(`seed respondió ${seedRes.status}: ${JSON.stringify(seedBody)}`);

  // Calentamiento (primera conexión del pool, planes de consulta).
  await fetch(`${baseUrl}/api/test/telemetry`);

  const wall: number[] = [];
  const server: number[] = [];
  const query: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const res = await fetch(`${baseUrl}/api/test/telemetry`);
    const body = (await res.json()) as { queryTimeMs: number };
    wall.push(performance.now() - t);
    if (res.status !== 200) throw new Error(`telemetry respondió ${res.status}`);
    server.push(Number.parseFloat(res.headers.get('x-response-time') ?? 'NaN'));
    query.push(body.queryTimeMs);
  }
  for (const list of [wall, server, query]) list.sort((a, b) => a - b);

  const summary = {
    target: `< ${TARGET_MS} ms`,
    seed: {
      matches,
      status: seedRes.status,
      serverProcessingMs: seedBody.timing?.processingMs ?? null,
      clientWallMs: r1(seedWall),
    },
    telemetry: {
      runs,
      clientWallMs: { p50: r1(percentile(wall, 50)), p95: r1(percentile(wall, 95)), max: r1(wall[wall.length - 1] ?? 0) },
      serverResponseMs: { p50: r1(percentile(server, 50)), p95: r1(percentile(server, 95)), max: r1(server[server.length - 1] ?? 0) },
      sqlQueryMs: { p50: r1(percentile(query, 50)), p95: r1(percentile(query, 95)) },
      meetsTarget: percentile(wall, 95) < TARGET_MS,
    },
  };
  const report = { measuredAt: new Date().toISOString(), baseUrl, node: process.version, summary };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nInforme guardado en ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
