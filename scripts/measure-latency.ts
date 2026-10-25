/**
 * Mide la latencia ping/pong real de Socket.IO (transporte WebSocket) con
 * varios clientes simultáneos y guarda el resultado.
 *
 * Uso:
 *   npm run bench:latency -- --url http://localhost:3000 [--clients 4] [--pings 200] [--out reports/latency.json]
 * Crea usuarios temporales mediante /api/auth/register.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { io } from 'socket.io-client';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const baseUrl = arg('url', process.env.BENCH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const clients = Number(arg('clients', '4'));
const pings = Number(arg('pings', '200'));
const out = arg('out', 'reports/latency.json');
const TARGET_MS = 100;

const r2 = (v: number) => Math.round(v * 100) / 100;

async function register(): Promise<string> {
  const username = `lat_${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`.slice(0, 20);
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username, password: 'medicion-latencia-1' }),
  });
  if (res.status !== 201) throw new Error(`No se pudo registrar el usuario de medición (${res.status})`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function measureClient(): Promise<number[]> {
  const cookie = await register();
  const socket = io(baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  if (socket.io.engine.transport.name !== 'websocket') throw new Error('No se estableció transporte WebSocket');
  const samples: number[] = [];
  for (let i = 0; i < pings; i++) {
    const t = performance.now();
    await socket.timeout(3000).emitWithAck('net:ping', { t });
    samples.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 30)); // respeta el límite de frecuencia del servidor
  }
  socket.close();
  return samples;
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
  return {
    samples: s.length,
    minMs: r2(s[0] ?? 0),
    avgMs: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
    p50Ms: r2(pick(50)),
    p95Ms: r2(pick(95)),
    p99Ms: r2(pick(99)),
    maxMs: r2(s[s.length - 1] ?? 0),
    under100Pct: r2((s.filter((v) => v < TARGET_MS).length / Math.max(1, s.length)) * 100),
  };
}

async function main(): Promise<void> {
  const results = await Promise.all(Array.from({ length: clients }, () => measureClient()));
  const all = results.flat();
  const aggregate = stats(all);
  const report = {
    measuredAt: new Date().toISOString(),
    baseUrl,
    transport: 'websocket',
    clients,
    pingsPerClient: pings,
    summary: { target: `< ${TARGET_MS} ms`, ...aggregate, meetsTarget: aggregate.p95Ms < TARGET_MS },
    perClient: results.map(stats),
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nInforme guardado en ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
