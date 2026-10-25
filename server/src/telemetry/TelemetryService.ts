import type { Queryable } from '../database/pool';
import { computeKdr, computeWinRate, round2 } from '../../../shared/stats';

/**
 * Agregados de telemetría calculados íntegramente en PostgreSQL
 * (COUNT, SUM, AVG, percentile_cont…): nunca se cargan las filas en memoria.
 *
 * Definiciones (idénticas a `shared/stats.ts`):
 *  - participación: un jugador en una partida (fila de match_players)
 *  - winRatePct  = 100 × victorias / participaciones
 *  - kdr         = eliminaciones / max(muertes, 1)   (global)
 *  - avgParticipationKdr = media del KDR de cada participación
 *  - survival.*  = tiempo vivo por participación, en milisegundos
 *  - survival.avgRatePct = media de (tiempo vivo / duración de la partida) × 100
 */

export interface TelemetryReport {
  generatedAt: string;
  queryTimeMs: number;
  units: Record<string, string>;
  formulas: Record<string, string>;
  totals: {
    matches: number;
    liveMatches: number;
    seededMatches: number;
    participations: number;
    distinctPlayers: number;
    wins: number;
    losses: number;
    kills: number;
    deaths: number;
    shards: number;
  };
  metrics: {
    winRatePct: number;
    kdr: number;
    avgParticipationKdr: number;
    avgKillsPerParticipation: number;
    avgMatchDurationMs: number;
    survival: {
      avgMs: number;
      medianMs: number;
      p95Ms: number;
      maxMs: number;
      avgLongestLifeMs: number;
      avgRatePct: number;
    };
  };
  bySource: Array<{
    source: 'live' | 'seed';
    matches: number;
    participations: number;
    winRatePct: number;
    kdr: number;
    avgSurvivalMs: number;
  }>;
  /** Partidas por puntuación objetivo (15, 25, 30). */
  byScoreTarget: Array<{
    scoreToWin: number;
    matches: number;
    avgDurationMs: number;
    endedByScorePct: number;
  }>;
  consistency: {
    /** Cada eliminación produce exactamente una muerte: debe ser 0. */
    killsMinusDeaths: number;
    /** Partidas cuyo número de ganadores no es exactamente 1 (abandonos sin ganador incluidos). */
    matchesWithoutSingleWinner: number;
    /** Participaciones con tiempo vivo mayor que la duración de su partida: debe ser 0. */
    survivalExceedsDuration: number;
  };
}

interface MainRow {
  total_matches: number;
  live_matches: number;
  seeded_matches: number;
  avg_duration_ms: number;
  participations: number;
  distinct_players: number;
  wins: number;
  kills: number;
  deaths: number;
  shards: number;
  avg_survival_ms: number;
  median_survival_ms: number;
  p95_survival_ms: number;
  max_survival_ms: number;
  avg_longest_life_ms: number;
  avg_participation_kdr: number;
  avg_survival_ratio: number;
  survival_exceeds: number;
  bad_winner_matches: number;
}

interface SourceRow {
  source: 'live' | 'seed';
  matches: number;
  participations: number;
  wins: number;
  kills: number;
  deaths: number;
  avg_survival_ms: number;
}

const MAIN_QUERY = `
  WITH m AS (
    SELECT count(*)::int                                   AS total_matches,
           count(*) FILTER (WHERE source = 'live')::int    AS live_matches,
           count(*) FILTER (WHERE source = 'seed')::int    AS seeded_matches,
           coalesce(avg(duration_ms), 0)::float8           AS avg_duration_ms
      FROM matches
  ),
  p AS (
    SELECT count(*)::int                                                     AS participations,
           count(DISTINCT coalesce(mp.user_id::text, mp.player_key))::int    AS distinct_players,
           count(*) FILTER (WHERE mp.won)::int                               AS wins,
           coalesce(sum(mp.kills), 0)::bigint                                AS kills,
           coalesce(sum(mp.deaths), 0)::bigint                               AS deaths,
           coalesce(sum(mp.shards), 0)::bigint                               AS shards,
           coalesce(avg(mp.survival_ms), 0)::float8                          AS avg_survival_ms,
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY mp.survival_ms), 0)::float8  AS median_survival_ms,
           coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY mp.survival_ms), 0)::float8 AS p95_survival_ms,
           coalesce(max(mp.survival_ms), 0)::int                             AS max_survival_ms,
           coalesce(avg(mp.longest_life_ms), 0)::float8                      AS avg_longest_life_ms,
           coalesce(avg(mp.kills::float8 / greatest(mp.deaths, 1)), 0)::float8 AS avg_participation_kdr,
           coalesce(avg(LEAST(mp.survival_ms::float8 / NULLIF(mt.duration_ms, 0), 1)), 0)::float8 AS avg_survival_ratio,
           count(*) FILTER (WHERE mp.survival_ms > mt.duration_ms)::int      AS survival_exceeds
      FROM match_players mp
      JOIN matches mt ON mt.id = mp.match_id
  ),
  w AS (
    SELECT count(*)::int AS bad_winner_matches
      FROM (SELECT mp.match_id
              FROM match_players mp
             GROUP BY mp.match_id
            HAVING count(*) FILTER (WHERE mp.won) <> 1) x
  )
  SELECT * FROM m, p, w
`;

const SCORE_TARGET_QUERY = `
  SELECT score_to_win,
         count(*)::int                                             AS matches,
         coalesce(avg(duration_ms), 0)::float8                     AS avg_duration_ms,
         count(*) FILTER (WHERE end_reason = 'puntuacion')::int    AS by_score
    FROM matches
   GROUP BY score_to_win
   ORDER BY score_to_win
`;

const SOURCE_QUERY = `
  SELECT mt.source,
         count(DISTINCT mt.id)::int             AS matches,
         count(*)::int                          AS participations,
         count(*) FILTER (WHERE mp.won)::int    AS wins,
         coalesce(sum(mp.kills), 0)::bigint     AS kills,
         coalesce(sum(mp.deaths), 0)::bigint    AS deaths,
         coalesce(avg(mp.survival_ms), 0)::float8 AS avg_survival_ms
    FROM matches mt
    JOIN match_players mp ON mp.match_id = mt.id
   GROUP BY mt.source
   ORDER BY mt.source
`;

export class TelemetryService {
  constructor(private readonly db: Queryable) {}

  async report(): Promise<TelemetryReport> {
    const started = performance.now();
    const [main, bySource, byTarget] = await Promise.all([
      this.db.query<MainRow>(MAIN_QUERY),
      this.db.query<SourceRow>(SOURCE_QUERY),
      this.db.query<{ score_to_win: number; matches: number; avg_duration_ms: number; by_score: number }>(
        SCORE_TARGET_QUERY,
      ),
    ]);
    const queryTimeMs = round2(performance.now() - started);
    const r = main.rows[0] as MainRow;

    return {
      generatedAt: new Date().toISOString(),
      queryTimeMs,
      units: {
        winRatePct: 'porcentaje (0-100)',
        kdr: 'razón adimensional',
        'survival.*Ms': 'milisegundos',
        'survival.avgRatePct': 'porcentaje (0-100) del tiempo de partida',
        avgMatchDurationMs: 'milisegundos',
        queryTimeMs: 'milisegundos',
      },
      formulas: {
        winRatePct: '100 × victorias / participaciones (0 si no hay participaciones)',
        kdr: 'eliminaciones / max(muertes, 1); sin muertes, KDR = eliminaciones. En agregado global tiende a 1 porque cada eliminación es la muerte de otro jugador',
        avgParticipationKdr: 'media de [eliminaciones / max(muertes, 1)] de cada jugador en cada partida',
        'survival.avgMs': 'media del tiempo vivo de cada jugador en cada partida',
        'survival.avgRatePct': 'media de min(tiempo vivo / duración de la partida, 1) × 100',
        participation: 'un jugador en una partida (fila de match_players)',
      },
      totals: {
        matches: r.total_matches,
        liveMatches: r.live_matches,
        seededMatches: r.seeded_matches,
        participations: r.participations,
        distinctPlayers: r.distinct_players,
        wins: r.wins,
        losses: r.participations - r.wins,
        kills: Number(r.kills),
        deaths: Number(r.deaths),
        shards: Number(r.shards),
      },
      metrics: {
        winRatePct: computeWinRate(r.wins, r.participations),
        kdr: computeKdr(Number(r.kills), Number(r.deaths)),
        avgParticipationKdr: round2(r.avg_participation_kdr),
        avgKillsPerParticipation: r.participations > 0 ? round2(Number(r.kills) / r.participations) : 0,
        avgMatchDurationMs: Math.round(r.avg_duration_ms),
        survival: {
          avgMs: Math.round(r.avg_survival_ms),
          medianMs: Math.round(r.median_survival_ms),
          p95Ms: Math.round(r.p95_survival_ms),
          maxMs: r.max_survival_ms,
          avgLongestLifeMs: Math.round(r.avg_longest_life_ms),
          avgRatePct: round2(r.avg_survival_ratio * 100),
        },
      },
      bySource: bySource.rows.map((s) => ({
        source: s.source,
        matches: s.matches,
        participations: s.participations,
        winRatePct: computeWinRate(s.wins, s.participations),
        kdr: computeKdr(Number(s.kills), Number(s.deaths)),
        avgSurvivalMs: Math.round(s.avg_survival_ms),
      })),
      byScoreTarget: byTarget.rows.map((t) => ({
        scoreToWin: t.score_to_win,
        matches: t.matches,
        avgDurationMs: Math.round(t.avg_duration_ms),
        endedByScorePct: t.matches > 0 ? round2((t.by_score / t.matches) * 100) : 0,
      })),
      consistency: {
        killsMinusDeaths: Number(r.kills) - Number(r.deaths),
        matchesWithoutSingleWinner: r.bad_winner_matches,
        survivalExceedsDuration: r.survival_exceeds,
      },
    };
  }
}
