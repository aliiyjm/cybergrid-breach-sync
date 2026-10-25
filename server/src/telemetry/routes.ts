import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Database } from '../database/pool';
import { withTransaction } from '../database/pool';
import { insertMatchesBulk } from '../database/repositories';
import { HttpError, validationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { round2 } from '../../../shared/stats';
import { seedPayloadSchema } from '../validation/schemas';
import { generateSeedMatches } from './seedGenerator';
import { TelemetryService } from './TelemetryService';

export interface TestRouterOptions {
  db: Database;
  enabled: boolean;
  apiKey: string | undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Endpoints obligatorios de evaluación:
 *   GET  /api/test/telemetry  → métricas agregadas (solo lectura)
 *   POST /api/test/seed       → inyección de 100-1000 partidas de prueba
 *
 * Protección:
 *  - Si los endpoints de prueba están desactivados, ambos responden 404.
 *  - Si existe TEST_API_KEY, `seed` exige la cabecera `X-Test-Api-Key`
 *    (401 si falta, 403 si no coincide). En producción la clave es obligatoria.
 *  - `seed` solo crea o borra datos con source = 'seed'; nunca toca partidas reales.
 */
export function createTestRouter(options: TestRouterOptions): Router {
  const router = Router();
  const telemetry = new TelemetryService(options.db);

  router.use((_req, _res, next) => {
    if (!options.enabled) throw new HttpError(404, 'NO_ENCONTRADO', 'Recurso no encontrado');
    next();
  });

  router.get('/telemetry', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await telemetry.report());
  });

  router.post('/seed', async (req: Request, res: Response) => {
    if (options.apiKey) {
      const provided = req.header('x-test-api-key');
      if (!provided) throw new HttpError(401, 'CLAVE_REQUERIDA', 'Falta la cabecera X-Test-Api-Key');
      if (!safeEqual(provided, options.apiKey)) throw new HttpError(403, 'CLAVE_INVALIDA', 'X-Test-Api-Key no es válida');
    }
    const parsed = seedPayloadSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);
    const payload = parsed.data;

    const started = performance.now();
    const batchId = payload.batchId ?? `lote_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const rngSeed = payload.seed ?? randomInt(0, 2 ** 32 - 1);

    const matches = generateSeedMatches({
      matches: payload.matches,
      playersPerMatch: payload.playersPerMatch,
      maxDurationS: payload.maxDurationS,
      batchId,
      rngSeed,
    });
    const generatedAt = performance.now();

    const result = await withTransaction(options.db, async (client) => {
      let deletedMatches = 0;
      if (payload.reset) {
        const del = await client.query("DELETE FROM matches WHERE source = 'seed'");
        deletedMatches = del.rowCount ?? 0;
        await client.query('DELETE FROM seed_batches');
      }
      const playerRowsExpected = matches.reduce((acc, m) => acc + m.players.length, 0);
      const insertedBatch = await client.query(
        `INSERT INTO seed_batches (id, rng_seed, matches, player_rows) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [batchId, rngSeed, matches.length, playerRowsExpected],
      );
      if (insertedBatch.rowCount === 0) {
        throw new HttpError(409, 'LOTE_DUPLICADO', `El lote "${batchId}" ya fue insertado; usa otro batchId o reset: true`);
      }
      const playerRows = await insertMatchesBulk(client, matches);
      return { deletedMatches, playerRows };
    });
    const finished = performance.now();

    let kills = 0;
    let deaths = 0;
    for (const m of matches) for (const p of m.players) {
      kills += p.kills;
      deaths += p.deaths;
    }

    logger.info('Datos de prueba insertados', { batchId, matches: matches.length, ms: round2(finished - started) });
    res.status(200).json({
      ok: true,
      batchId,
      rngSeed,
      reset: payload.reset,
      deletedMatches: result.deletedMatches,
      inserted: {
        matches: matches.length,
        playerRows: result.playerRows,
        playersPerMatch: payload.playersPerMatch,
      },
      totals: { kills, deaths, wins: matches.length },
      timing: {
        generationMs: round2(generatedAt - started),
        insertMs: round2(finished - generatedAt),
        processingMs: round2(finished - started),
      },
    });
  });

  return router;
}
