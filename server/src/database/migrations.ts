import type { Database } from './pool';
import { logger } from '../lib/logger';

/**
 * Migraciones versionadas. Cada una se aplica una sola vez dentro de una
 * transacción y queda registrada en `schema_migrations`.
 */
export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'esquema_inicial',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY,
        username      VARCHAR(20) NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash  CHAR(64) PRIMARY KEY,
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

      CREATE TABLE IF NOT EXISTS seed_batches (
        id          VARCHAR(64) PRIMARY KEY,
        rng_seed    BIGINT NOT NULL,
        matches     INTEGER NOT NULL,
        player_rows INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS matches (
        id              UUID PRIMARY KEY,
        room_id         VARCHAR(32),
        map_seed        BIGINT NOT NULL,
        source          VARCHAR(8) NOT NULL CHECK (source IN ('live', 'seed')),
        seed_batch_id   VARCHAR(64) REFERENCES seed_batches(id) ON DELETE CASCADE,
        started_at      TIMESTAMPTZ NOT NULL,
        ended_at        TIMESTAMPTZ NOT NULL,
        duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0),
        end_reason      VARCHAR(16) NOT NULL,
        winner_key      VARCHAR(80),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (ended_at >= started_at)
      );
      CREATE INDEX IF NOT EXISTS matches_source_idx ON matches (source);
      CREATE INDEX IF NOT EXISTS matches_batch_idx ON matches (seed_batch_id);

      CREATE TABLE IF NOT EXISTS match_players (
        match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_key      VARCHAR(80) NOT NULL,
        user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
        username        VARCHAR(40) NOT NULL,
        kills           INTEGER NOT NULL CHECK (kills >= 0),
        deaths          INTEGER NOT NULL CHECK (deaths >= 0),
        shards          INTEGER NOT NULL CHECK (shards >= 0),
        score           INTEGER NOT NULL CHECK (score >= 0),
        survival_ms     INTEGER NOT NULL CHECK (survival_ms >= 0),
        longest_life_ms INTEGER NOT NULL CHECK (longest_life_ms >= 0),
        won             BOOLEAN NOT NULL,
        rank            SMALLINT NOT NULL CHECK (rank >= 1),
        PRIMARY KEY (match_id, player_key)
      );
      CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id) WHERE user_id IS NOT NULL;
    `,
  },
  {
    id: 2,
    name: 'puntuacion_objetivo_y_avatares',
    sql: `
      -- Configuración con la que se jugó cada partida (15, 25 o 30 puntos) y su límite de tiempo.
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_to_win SMALLINT NOT NULL DEFAULT 15;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS time_limit_ms INTEGER;
      ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_score_to_win_check;
      ALTER TABLE matches ADD CONSTRAINT matches_score_to_win_check CHECK (score_to_win IN (15, 25, 30));
      CREATE INDEX IF NOT EXISTS matches_score_to_win_idx ON matches (score_to_win);

      -- Apariencia personalizada: una imagen por usuario, ya validada y
      -- re-codificada por el servidor (PNG 128×128 sin metadatos). El id lo
      -- genera el servidor y forma parte de la URL pública de la imagen.
      CREATE TABLE IF NOT EXISTS user_avatars (
        id          UUID PRIMARY KEY,
        user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        image       BYTEA NOT NULL,
        mime        VARCHAR(20) NOT NULL DEFAULT 'image/png' CHECK (mime = 'image/png'),
        width       SMALLINT NOT NULL,
        height      SMALLINT NOT NULL,
        bytes       INTEGER NOT NULL CHECK (bytes > 0),
        sha256      CHAR(64) NOT NULL,
        source_type VARCHAR(10) NOT NULL CHECK (source_type IN ('png', 'jpeg')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 3,
    name: 'puntuaciones_30_40_50',
    sql: `
      -- Nuevas puntuaciones para ganar (30, 40 o 50). Se mantienen 15, 25 y 30
      -- para que las partidas ya guardadas sigan siendo válidas.
      ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_score_to_win_check;
      ALTER TABLE matches ADD CONSTRAINT matches_score_to_win_check CHECK (score_to_win IN (15, 25, 30, 40, 50));
      ALTER TABLE matches ALTER COLUMN score_to_win SET DEFAULT 30;
    `,
  },
];

export async function runMigrations(db: Database): Promise<number[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const client = await db.connect();
  const applied: number[] = [];
  try {
    // Bloqueo consultivo: evita que dos instancias migren a la vez.
    await client.query('SELECT pg_advisory_lock(487123)');
    const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
          migration.id,
          migration.name,
        ]);
        await client.query('COMMIT');
        applied.push(migration.id);
        logger.info(`Migración aplicada: ${migration.id} ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(487123)').catch(() => undefined);
    client.release();
  }
  return applied;
}
