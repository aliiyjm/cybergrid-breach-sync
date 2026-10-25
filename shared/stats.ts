/**
 * Fórmulas de estadísticas. Son las mismas que usa la consulta SQL de
 * `GET /api/test/telemetry` (ver `server/src/telemetry/TelemetryService.ts`),
 * de modo que los resultados de una partida y los agregados coinciden.
 *
 *  - KDR = eliminaciones / max(muertes, 1)
 *        → si no hay muertes, el KDR es igual al número de eliminaciones.
 *  - Win Rate (%) = 100 × victorias / participaciones   (0 si no hay participaciones)
 *  - Tasa de supervivencia (%) = 100 × tiempo vivo / duración de la partida
 */

export function computeKdr(kills: number, deaths: number): number {
  return round2(kills / Math.max(deaths, 1));
}

export function computeWinRate(wins: number, played: number): number {
  if (played <= 0) return 0;
  return round2((wins / played) * 100);
}

export function computeSurvivalRate(survivalMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return round2(Math.min(1, survivalMs / durationMs) * 100);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface RankableStats {
  score: number;
  kills: number;
  deaths: number;
  survivalMs: number;
  joinOrder: number;
}

/**
 * Orden de clasificación: mayor puntuación, más eliminaciones,
 * menos muertes, más supervivencia y, por último, orden de ingreso.
 */
export function compareRanking(a: RankableStats, b: RankableStats): number {
  return (
    b.score - a.score ||
    b.kills - a.kills ||
    a.deaths - b.deaths ||
    b.survivalMs - a.survivalMs ||
    a.joinOrder - b.joinOrder
  );
}

export type TiebreakCriterion = 'eliminaciones' | 'muertes' | 'supervivencia' | 'orden_de_ingreso';

/**
 * Si `first` y `second` empatan a puntos, devuelve el criterio de
 * `compareRanking` que deshizo el empate; si no hay empate a puntos, null.
 */
export function tiebreakCriterion(first: RankableStats, second: RankableStats | undefined): TiebreakCriterion | null {
  if (!second || first.score !== second.score) return null;
  if (first.kills !== second.kills) return 'eliminaciones';
  if (first.deaths !== second.deaths) return 'muertes';
  if (first.survivalMs !== second.survivalMs) return 'supervivencia';
  return 'orden_de_ingreso';
}
