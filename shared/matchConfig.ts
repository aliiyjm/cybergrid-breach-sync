import { GAME } from './constants';

/**
 * Configuración centralizada de los modos de puntuación.
 *
 * ── PARA CAMBIAR LAS PUNTUACIONES ──────────────────────────────────────────
 * Edita SOLO `SCORE_TARGETS`, `DEFAULT_SCORE_TARGET` y `SCORE_TARGET_LABELS`.
 * La validación (servidor y cliente), el selector de «Crear sala», los
 * mensajes, los tiempos y los textos de la portada se generan a partir de aquí.
 * Lo único que necesita un paso aparte es la base de datos: añade una
 * migración que permita los valores nuevos (ver `server/src/database/migrations.ts`).
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Duración máxima: se conserva el RITMO de puntos por minuto del juego
 * original, en el que `MATCH_DURATION_S` (180 s por defecto) era el tiempo
 * para PACE_REFERENCE_SCORE puntos:
 *
 *   duración(objetivo) = round( MATCH_DURATION_S × objetivo / PACE_REFERENCE_SCORE )
 *
 * Con 180 s y referencia 15: 30 → 360 s (6:00), 40 → 480 s (8:00), 50 → 600 s (10:00).
 */
export const SCORE_TARGETS = [30, 40, 50] as const;
export type ScoreTarget = (typeof SCORE_TARGETS)[number];

export const DEFAULT_SCORE_TARGET: ScoreTarget = 30;

export const SCORE_TARGET_LABELS: Record<ScoreTarget, string> = {
  30: 'Partida estándar',
  40: 'Partida extendida',
  50: 'Partida larga',
};

/**
 * Puntos que corresponden a `MATCH_DURATION_S` (ritmo de referencia).
 * Súbelo para partidas más cortas o bájalo para partidas más largas.
 */
export const PACE_REFERENCE_SCORE = 15;

export function isScoreTarget(value: unknown): value is ScoreTarget {
  return typeof value === 'number' && (SCORE_TARGETS as readonly number[]).includes(value);
}

/** Lista legible para textos y mensajes: «30, 40 o 50». */
export function formatScoreTargets(targets: readonly number[] = SCORE_TARGETS): string {
  if (targets.length <= 1) return targets.join('');
  return `${targets.slice(0, -1).join(', ')} o ${targets[targets.length - 1]}`;
}

/** Mensaje de error único para cualquier valor no permitido. */
export const SCORE_TARGET_ERROR = `La puntuación para ganar debe ser ${formatScoreTargets()}`;

/** Duración máxima (ms) para un objetivo, a partir de la duración base del servidor. */
export function calculateMatchDuration(baseDurationMs: number, target: ScoreTarget): number {
  return Math.round((baseDurationMs * target) / PACE_REFERENCE_SCORE);
}

export interface MatchConfig {
  targetScore: ScoreTarget;
  durationMs: number;
}

/** Tabla completa de modos para una duración base dada. */
export function buildMatchConfig(
  baseDurationMs: number = GAME.DEFAULT_MATCH_DURATION_S * 1000,
): Record<ScoreTarget, MatchConfig> {
  return Object.fromEntries(
    SCORE_TARGETS.map((target) => [target, { targetScore: target, durationMs: calculateMatchDuration(baseDurationMs, target) }]),
  ) as Record<ScoreTarget, MatchConfig>;
}
