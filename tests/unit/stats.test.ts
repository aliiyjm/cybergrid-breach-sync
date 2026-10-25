import { describe, expect, it } from 'vitest';
import { GAME } from '../../shared/constants';
import { compareRanking, computeKdr, computeSurvivalRate, computeWinRate } from '../../shared/stats';
import { generateSeedMatches } from '../../server/src/telemetry/seedGenerator';

describe('Fórmulas de estadísticas', () => {
  it('KDR evita la división entre cero', () => {
    expect(computeKdr(10, 4)).toBe(2.5);
    expect(computeKdr(7, 0)).toBe(7); // sin muertes: KDR = eliminaciones
    expect(computeKdr(0, 0)).toBe(0);
    expect(computeKdr(1, 3)).toBe(0.33);
  });

  it('Win Rate y tasa de supervivencia en porcentaje', () => {
    expect(computeWinRate(1, 4)).toBe(25);
    expect(computeWinRate(0, 0)).toBe(0);
    expect(computeSurvivalRate(90_000, 180_000)).toBe(50);
    expect(computeSurvivalRate(200_000, 180_000)).toBe(100);
    expect(computeSurvivalRate(5, 0)).toBe(0);
  });

  it('clasifica por puntuación, eliminaciones, muertes y supervivencia', () => {
    const base = { score: 5, kills: 1, deaths: 1, survivalMs: 1000, joinOrder: 0 };
    const sorted = [
      { ...base, joinOrder: 3 },
      { ...base, score: 9, joinOrder: 1 },
      { ...base, deaths: 0, joinOrder: 2 },
    ].sort(compareRanking);
    expect(sorted.map((s) => s.joinOrder)).toEqual([1, 2, 3]);
  });
});

describe('Generador de datos de prueba (seed)', () => {
  const matches = generateSeedMatches({
    matches: 200,
    playersPerMatch: 4,
    maxDurationS: 180,
    batchId: 'test',
    rngSeed: 99,
    now: Date.UTC(2026, 0, 1),
  });

  it('produce datos coherentes con las reglas del juego', () => {
    expect(matches).toHaveLength(200);
    for (const m of matches) {
      const kills = m.players.reduce((a, p) => a + p.kills, 0);
      const deaths = m.players.reduce((a, p) => a + p.deaths, 0);
      expect(kills).toBe(deaths); // cada eliminación produce una muerte
      expect(m.players.filter((p) => p.won)).toHaveLength(1);
      expect(m.winnerKey).toBe(m.players.find((p) => p.won)?.playerKey);
      expect(m.endedAt.getTime() - m.startedAt.getTime()).toBe(m.durationMs);
      for (const p of m.players) {
        expect(p.survivalMs).toBeLessThanOrEqual(m.durationMs);
        expect(p.longestLifeMs).toBeLessThanOrEqual(p.survivalMs);
        expect(p.score).toBe(p.kills * GAME.SCORE_PER_KILL + p.shards * GAME.SCORE_PER_SHARD);
      }
      expect(new Set(m.players.map((p) => p.playerKey)).size).toBe(4);
    }
  });

  it('es determinista con la misma semilla', () => {
    const again = generateSeedMatches({
      matches: 200,
      playersPerMatch: 4,
      maxDurationS: 180,
      batchId: 'test',
      rngSeed: 99,
      now: Date.UTC(2026, 0, 1),
    });
    const strip = (list: typeof matches) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(again)).toEqual(strip(matches));
  });
});
