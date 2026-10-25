import { randomUUID } from 'node:crypto';
import { DEFAULT_SCORE_TARGET } from '../../../shared/matchConfig';
import { GAME } from '../../../shared/constants';
import { SeededRandom } from '../../../shared/random';
import { compareRanking } from '../../../shared/stats';
import type { MatchPlayerRecord, MatchRecord } from '../database/repositories';

export interface SeedGenerationOptions {
  matches: number;
  playersPerMatch: number;
  maxDurationS: number;
  batchId: string;
  rngSeed: number;
  /** Momento de referencia para fechar las partidas (inyectable en pruebas). */
  now?: number;
}

/**
 * Genera partidas sintéticas COHERENTES con las reglas del juego:
 *  - cada eliminación se simula como un evento asesino → víctima (≠ asesino),
 *    por lo que en cada partida Σ eliminaciones = Σ muertes;
 *  - puntuación = eliminaciones × SCORE_PER_KILL + fragmentos × SCORE_PER_SHARD;
 *  - tiempo vivo ≤ duración − muertes × tiempo de reaparición;
 *  - vida más larga ≤ tiempo vivo;
 *  - exactamente un ganador por partida, según la misma regla de clasificación
 *    que usa el servidor de juego.
 * Misma `rngSeed` ⇒ mismos datos (salvo los UUID).
 */
export function generateSeedMatches(options: SeedGenerationOptions): MatchRecord[] {
  const rng = new SeededRandom(options.rngSeed);
  const now = options.now ?? Date.now();
  const maxDurationMs = options.maxDurationS * 1000;
  const minDurationMs = Math.min(30_000, maxDurationMs);
  const out: MatchRecord[] = [];

  for (let i = 0; i < options.matches; i++) {
    const n = options.playersPerMatch;
    const durationMs = rng.int(minDurationMs, maxDurationMs);
    const endedAt = new Date(now - (options.matches - i) * 7 * 60_000);
    const startedAt = new Date(endedAt.getTime() - durationMs);

    const kills = new Array<number>(n).fill(0);
    const deaths = new Array<number>(n).fill(0);
    // Número de muertes posibles limitado por la duración y la reaparición.
    const maxDeathsPerPlayer = Math.max(0, Math.floor(durationMs / (GAME.RESPAWN_MS * 4)));
    const events = rng.int(0, n * 4);
    for (let e = 0; e < events; e++) {
      const killer = rng.int(0, n - 1);
      let victim = rng.int(0, n - 2);
      if (victim >= killer) victim++;
      if ((deaths[victim] as number) >= maxDeathsPerPlayer) continue;
      kills[killer] = (kills[killer] as number) + 1;
      deaths[victim] = (deaths[victim] as number) + 1;
    }

    const stats = Array.from({ length: n }, (_, j) => {
      const shards = rng.int(0, 6);
      const k = kills[j] as number;
      const d = deaths[j] as number;
      const maxAlive = Math.max(0, durationMs - d * GAME.RESPAWN_MS);
      const survivalMs = Math.max(0, maxAlive - rng.int(0, Math.min(2000, maxAlive)));
      const longestLifeMs = Math.min(survivalMs, Math.round((survivalMs / (d + 1)) * (1 + rng.next() * 0.5)));
      return {
        joinOrder: j,
        kills: k,
        deaths: d,
        shards,
        score: k * GAME.SCORE_PER_KILL + shards * GAME.SCORE_PER_SHARD,
        survivalMs,
        longestLifeMs,
      };
    });

    const ranked = [...stats].sort(compareRanking);
    const players: MatchPlayerRecord[] = ranked.map((s, index) => ({
      playerKey: `seed:${options.batchId}:${i}:${s.joinOrder}`,
      userId: null,
      username: `Sintético-${s.joinOrder + 1}`,
      kills: s.kills,
      deaths: s.deaths,
      shards: s.shards,
      score: s.score,
      survivalMs: s.survivalMs,
      longestLifeMs: s.longestLifeMs,
      won: index === 0,
      rank: index + 1,
    }));

    out.push({
      id: randomUUID(),
      roomId: null,
      mapSeed: rng.int(0, 2 ** 31 - 1),
      source: 'seed',
      seedBatchId: options.batchId,
      startedAt,
      endedAt,
      durationMs,
      endReason: rng.chance(0.3) ? 'puntuacion' : 'tiempo',
      winnerKey: (players[0] as MatchPlayerRecord).playerKey,
      // Los datos sintéticos usan el modo estándar (DEFAULT_SCORE_TARGET) con el límite de tiempo indicado.
      scoreToWin: DEFAULT_SCORE_TARGET,
      timeLimitMs: maxDurationMs,
      players,
    });
  }
  return out;
}
