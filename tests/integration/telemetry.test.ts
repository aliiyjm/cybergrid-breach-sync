import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/testServer';

interface Telemetry {
  queryTimeMs: number;
  totals: { matches: number; seededMatches: number; participations: number; wins: number; kills: number; deaths: number };
  metrics: { winRatePct: number; kdr: number; survival: { avgMs: number; medianMs: number; avgRatePct: number } };
  consistency: { killsMinusDeaths: number; matchesWithoutSingleWinner: number; survivalExceedsDuration: number };
  formulas: Record<string, string>;
}

let ctx: TestServer;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  ctx = await startTestServer();
  await ctx.db.query('TRUNCATE match_players, matches, seed_batches CASCADE');
});

afterAll(async () => {
  await ctx?.close();
});

describe('GET /api/test/telemetry', () => {
  it('sin partidas devuelve 200 con valores válidos (ceros, sin NaN)', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/test/telemetry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Telemetry;
    expect(body.totals.matches).toBe(0);
    expect(body.metrics.winRatePct).toBe(0);
    expect(body.metrics.kdr).toBe(0);
    expect(body.metrics.survival.avgMs).toBe(0);
    expect(JSON.stringify(body)).not.toContain('null');
    expect(body.formulas.kdr).toContain('max(muertes, 1)');
  });
});

describe('POST /api/test/seed', () => {
  it('rechaza payloads inválidos con 400 y detalle', async () => {
    for (const bad of [{ matches: 99 }, { matches: 1001 }, { matches: '200' }, { matches: 200, extra: 1 }, {}]) {
      const res = await post('/api/test/seed', bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: unknown[] } };
      expect(body.error.code).toBe('VALIDACION');
      expect(body.error.details.length).toBeGreaterThan(0);
    }
    expect((await post('/api/test/seed', '{malformado')).status).toBe(400);
  });

  it('inserta 1000 partidas por lotes y devuelve el resumen con tiempos', async () => {
    const res = await post('/api/test/seed', { matches: 1000, playersPerMatch: 4, seed: 2026, batchId: 'ci-1000', reset: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      batchId: string;
      inserted: { matches: number; playerRows: number };
      totals: { kills: number; deaths: number; wins: number };
      timing: { processingMs: number };
    };
    expect(body.ok).toBe(true);
    expect(body.batchId).toBe('ci-1000');
    expect(body.inserted).toMatchObject({ matches: 1000, playerRows: 4000 });
    expect(body.totals.kills).toBe(body.totals.deaths);
    expect(body.timing.processingMs).toBeGreaterThan(0);

    const count = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM matches WHERE seed_batch_id = 'ci-1000'");
    expect(count.rows[0]?.n).toBe(1000);
  });

  it('evita duplicados accidentales: el mismo batchId devuelve 409', async () => {
    const res = await post('/api/test/seed', { matches: 100, batchId: 'ci-1000' });
    expect(res.status).toBe(409);
    const count = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM matches');
    expect(count.rows[0]?.n).toBe(1000);
  });

  it('acepta el mínimo de 100 partidas', async () => {
    const res = await post('/api/test/seed', { matches: 100, playersPerMatch: 2, seed: 7, batchId: 'ci-100' });
    expect(res.status).toBe(200);
  });
});

describe('Telemetría coherente con los datos insertados', () => {
  it('agrega 1100 partidas con fórmulas correctas en menos de 200 ms', async () => {
    const durations: number[] = [];
    let body: Telemetry | null = null;
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const res = await fetch(`${ctx.baseUrl}/api/test/telemetry`);
      body = (await res.json()) as Telemetry;
      durations.push(performance.now() - started);
      expect(res.status).toBe(200);
    }
    const t = body as Telemetry;
    expect(t.totals.matches).toBe(1100);
    expect(t.totals.seededMatches).toBe(1100);
    expect(t.totals.participations).toBe(1000 * 4 + 100 * 2);
    expect(t.totals.wins).toBe(1100);
    expect(t.metrics.winRatePct).toBeCloseTo((1100 / 4200) * 100, 1);
    expect(t.metrics.kdr).toBeCloseTo(t.totals.kills / Math.max(t.totals.deaths, 1), 2);
    expect(t.consistency).toEqual({ killsMinusDeaths: 0, matchesWithoutSingleWinner: 0, survivalExceedsDuration: 0 });
    expect(t.metrics.survival.avgRatePct).toBeGreaterThan(0);
    expect(t.metrics.survival.avgRatePct).toBeLessThanOrEqual(100);

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95) - 1] ?? Infinity;
    console.log(`[telemetría] p50=${durations[10]?.toFixed(1)} ms p95=${p95.toFixed(1)} ms (20 peticiones)`);
    expect(p95).toBeLessThan(200);
  });

  it('reset: true borra solo los lotes sembrados', async () => {
    await ctx.db.query(
      `INSERT INTO matches (id, room_id, map_seed, source, started_at, ended_at, duration_ms, end_reason)
       VALUES (gen_random_uuid(), 'sala', 1, 'live', now() - interval '1 minute', now(), 60000, 'tiempo')`,
    );
    const res = await post('/api/test/seed', { matches: 100, reset: true, batchId: 'ci-reset' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedMatches: number };
    expect(body.deletedMatches).toBe(1100);
    const live = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM matches WHERE source = 'live'");
    expect(live.rows[0]?.n).toBe(1);
  });
});

describe('Protección del endpoint de seed', () => {
  it('exige X-Test-Api-Key cuando está configurada y responde 404 si está desactivado', async () => {
    const secured = await startTestServer({ TEST_API_KEY: 'clave-secreta-de-pruebas-123' });
    try {
      const url = `${secured.baseUrl}/api/test/seed`;
      const body = JSON.stringify({ matches: 100 });
      const headers = { 'Content-Type': 'application/json' };
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);
      expect((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Test-Api-Key': 'incorrecta' }, body })).status).toBe(403);
    } finally {
      await secured.close();
    }
    const disabled = await startTestServer({ ENABLE_TEST_ENDPOINTS: 'false' });
    try {
      expect((await fetch(`${disabled.baseUrl}/api/test/telemetry`)).status).toBe(404);
    } finally {
      await disabled.close();
    }
  });
});
