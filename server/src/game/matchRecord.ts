import type { MatchResult } from '../../../shared/protocol';
import type { MatchRecord } from '../database/repositories';

/** Convierte el resultado autoritativo de una partida en el registro persistente. */
export function toMatchRecord(
  result: MatchResult,
  meta: { seed: number; startedAt: Date; endedAt: Date },
): MatchRecord {
  return {
    id: result.matchId,
    roomId: result.roomId,
    mapSeed: meta.seed,
    source: 'live',
    seedBatchId: null,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationMs: result.durationMs,
    endReason: result.reason,
    winnerKey: result.winnerId,
    scoreToWin: result.scoreToWin,
    timeLimitMs: result.timeLimitMs,
    players: result.players.map((p) => ({
      playerKey: p.userId,
      userId: p.userId,
      username: p.username,
      kills: p.kills,
      deaths: p.deaths,
      shards: p.shards,
      score: p.score,
      survivalMs: Math.min(p.survivalMs, result.durationMs),
      longestLifeMs: Math.min(p.longestLifeMs, result.durationMs),
      won: p.won,
      rank: p.rank,
    })),
  };
}
