import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './pool';
import { withTransaction } from './pool';
import { computeKdr, computeWinRate } from '../../../shared/stats';

/* ------------------------------ Usuarios ------------------------------ */

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: Date;
}

export async function findUserByUsername(db: Queryable, username: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, username, password_hash, created_at FROM users WHERE lower(username) = lower($1)',
    [username],
  );
  return rows[0] ?? null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, username, password_hash, created_at FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Crea un usuario. Devuelve null si el nombre ya existe (sin distinguir mayúsculas). */
export async function createUser(db: Queryable, username: string, passwordHash: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id, username, password_hash, created_at`,
    [randomUUID(), username, passwordHash],
  );
  return rows[0] ?? null;
}

/* ------------------------------ Sesiones ------------------------------ */

export async function insertSession(db: Queryable, tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

export async function findSessionUser(
  db: Queryable,
  tokenHash: string,
): Promise<{ id: string; username: string; expires_at: Date; avatar_id: string | null } | null> {
  const { rows } = await db.query<{ id: string; username: string; expires_at: Date; avatar_id: string | null }>(
    `SELECT u.id, u.username, s.expires_at, a.id AS avatar_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_avatars a ON a.user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Queryable, tokenHash: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function deleteExpiredSessions(db: Queryable): Promise<number> {
  const result = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}

/* ------------------------------ Partidas ------------------------------ */

export interface MatchPlayerRecord {
  playerKey: string;
  userId: string | null;
  username: string;
  kills: number;
  deaths: number;
  shards: number;
  score: number;
  survivalMs: number;
  longestLifeMs: number;
  won: boolean;
  rank: number;
}

export interface MatchRecord {
  id: string;
  roomId: string | null;
  mapSeed: number;
  source: 'live' | 'seed';
  seedBatchId: string | null;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  endReason: string;
  winnerKey: string | null;
  /** Configuración usada en la partida. */
  scoreToWin: number;
  timeLimitMs: number | null;
  players: MatchPlayerRecord[];
}

/**
 * Inserta partidas y jugadores con dos sentencias `INSERT … SELECT unnest(...)`
 * por bloque, en lugar de una sentencia por fila.
 */
export async function insertMatchesBulk(db: Queryable, matches: MatchRecord[], chunkSize = 1000): Promise<number> {
  let playerRows = 0;
  for (let offset = 0; offset < matches.length; offset += chunkSize) {
    const chunk = matches.slice(offset, offset + chunkSize);
    await db.query(
      `INSERT INTO matches (id, room_id, map_seed, source, seed_batch_id, started_at, ended_at, duration_ms, end_reason,
                            winner_key, score_to_win, time_limit_ms)
       SELECT * FROM unnest($1::uuid[], $2::varchar[], $3::bigint[], $4::varchar[], $5::varchar[],
                            $6::timestamptz[], $7::timestamptz[], $8::int[], $9::varchar[], $10::varchar[],
                            $11::smallint[], $12::int[])`,
      [
        chunk.map((m) => m.id),
        chunk.map((m) => m.roomId),
        chunk.map((m) => m.mapSeed),
        chunk.map((m) => m.source),
        chunk.map((m) => m.seedBatchId),
        chunk.map((m) => m.startedAt.toISOString()),
        chunk.map((m) => m.endedAt.toISOString()),
        chunk.map((m) => m.durationMs),
        chunk.map((m) => m.endReason),
        chunk.map((m) => m.winnerKey),
        chunk.map((m) => m.scoreToWin),
        chunk.map((m) => m.timeLimitMs),
      ],
    );

    const cols = {
      matchId: [] as string[],
      key: [] as string[],
      userId: [] as Array<string | null>,
      username: [] as string[],
      kills: [] as number[],
      deaths: [] as number[],
      shards: [] as number[],
      score: [] as number[],
      survival: [] as number[],
      longest: [] as number[],
      won: [] as boolean[],
      rank: [] as number[],
    };
    for (const m of chunk) {
      for (const p of m.players) {
        cols.matchId.push(m.id);
        cols.key.push(p.playerKey);
        cols.userId.push(p.userId);
        cols.username.push(p.username);
        cols.kills.push(p.kills);
        cols.deaths.push(p.deaths);
        cols.shards.push(p.shards);
        cols.score.push(p.score);
        cols.survival.push(p.survivalMs);
        cols.longest.push(p.longestLifeMs);
        cols.won.push(p.won);
        cols.rank.push(p.rank);
      }
    }
    await db.query(
      `INSERT INTO match_players (match_id, player_key, user_id, username, kills, deaths, shards, score,
                                  survival_ms, longest_life_ms, won, rank)
       SELECT * FROM unnest($1::uuid[], $2::varchar[], $3::uuid[], $4::varchar[], $5::int[], $6::int[],
                            $7::int[], $8::int[], $9::int[], $10::int[], $11::boolean[], $12::smallint[])`,
      [
        cols.matchId,
        cols.key,
        cols.userId,
        cols.username,
        cols.kills,
        cols.deaths,
        cols.shards,
        cols.score,
        cols.survival,
        cols.longest,
        cols.won,
        cols.rank,
      ],
    );
    playerRows += cols.matchId.length;
  }
  return playerRows;
}

export async function saveMatch(db: Database, match: MatchRecord): Promise<void> {
  await withTransaction(db, (client) => insertMatchesBulk(client, [match]));
}

/* ---------------------------- Estadísticas ---------------------------- */

export interface UserStats {
  matchesPlayed: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  shards: number;
  totalSurvivalMs: number;
  avgSurvivalMs: number;
  bestLifeMs: number;
  kdr: number;
  winRate: number;
}

export async function getUserStats(db: Queryable, userId: string): Promise<UserStats> {
  const { rows } = await db.query<{
    played: number;
    wins: number;
    kills: number;
    deaths: number;
    shards: number;
    survival: number;
    avg_survival: number;
    best_life: number;
  }>(
    `SELECT count(*)::int AS played,
            count(*) FILTER (WHERE won)::int AS wins,
            coalesce(sum(kills), 0)::int AS kills,
            coalesce(sum(deaths), 0)::int AS deaths,
            coalesce(sum(shards), 0)::int AS shards,
            coalesce(sum(survival_ms), 0)::bigint AS survival,
            coalesce(round(avg(survival_ms)), 0)::bigint AS avg_survival,
            coalesce(max(longest_life_ms), 0)::int AS best_life
       FROM match_players WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0] ?? { played: 0, wins: 0, kills: 0, deaths: 0, shards: 0, survival: 0, avg_survival: 0, best_life: 0 };
  return {
    matchesPlayed: r.played,
    wins: r.wins,
    losses: r.played - r.wins,
    kills: r.kills,
    deaths: r.deaths,
    shards: r.shards,
    totalSurvivalMs: Number(r.survival),
    avgSurvivalMs: Number(r.avg_survival),
    bestLifeMs: r.best_life,
    kdr: computeKdr(r.kills, r.deaths),
    winRate: computeWinRate(r.wins, r.played),
  };
}

export interface LeaderboardEntry {
  username: string;
  matchesPlayed: number;
  wins: number;
  kills: number;
  deaths: number;
  kdr: number;
  winRate: number;
}

export async function getLeaderboard(db: Queryable, limit = 10): Promise<LeaderboardEntry[]> {
  const { rows } = await db.query<{
    username: string;
    played: number;
    wins: number;
    kills: number;
    deaths: number;
  }>(
    `SELECT u.username,
            count(*)::int AS played,
            count(*) FILTER (WHERE mp.won)::int AS wins,
            sum(mp.kills)::int AS kills,
            sum(mp.deaths)::int AS deaths
       FROM match_players mp JOIN users u ON u.id = mp.user_id
      GROUP BY u.id, u.username
      ORDER BY count(*) FILTER (WHERE mp.won) DESC, sum(mp.kills)::float / greatest(sum(mp.deaths), 1) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    username: r.username,
    matchesPlayed: r.played,
    wins: r.wins,
    kills: r.kills,
    deaths: r.deaths,
    kdr: computeKdr(r.kills, r.deaths),
    winRate: computeWinRate(r.wins, r.played),
  }));
}

/* ------------------------------ Apariencia ------------------------------ */

/** URL pública de una imagen de apariencia a partir de su id (generado por el servidor). */
export function avatarUrlFor(avatarId: string | null | undefined): string | null {
  return avatarId ? `/api/avatars/${avatarId}.png` : null;
}

export async function getAvatarIdForUser(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM user_avatars WHERE user_id = $1', [userId]);
  return rows[0]?.id ?? null;
}

export interface StoredAvatar {
  image: Buffer;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  sourceType: 'png' | 'jpeg';
}

/**
 * Guarda la nueva apariencia del usuario y elimina la anterior en la misma
 * transacción (no quedan imágenes huérfanas). Devuelve el id nuevo.
 */
export async function replaceAvatar(db: Database, userId: string, avatar: StoredAvatar): Promise<string> {
  const id = randomUUID();
  await withTransaction(db, async (client) => {
    await client.query('DELETE FROM user_avatars WHERE user_id = $1', [userId]);
    await client.query(
      `INSERT INTO user_avatars (id, user_id, image, mime, width, height, bytes, sha256, source_type)
       VALUES ($1, $2, $3, 'image/png', $4, $5, $6, $7, $8)`,
      [id, userId, avatar.image, avatar.width, avatar.height, avatar.bytes, avatar.sha256, avatar.sourceType],
    );
  });
  return id;
}

/** Elimina la apariencia del usuario. Devuelve true si había una. */
export async function deleteAvatar(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM user_avatars WHERE user_id = $1', [userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function getAvatarImage(db: Queryable, avatarId: string): Promise<{ image: Buffer; sha256: string } | null> {
  const { rows } = await db.query<{ image: Buffer; sha256: string }>(
    'SELECT image, sha256 FROM user_avatars WHERE id = $1',
    [avatarId],
  );
  return rows[0] ?? null;
}
