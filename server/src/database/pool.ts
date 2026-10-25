import pg from 'pg';
import type { AppConfig } from '../config';
import { logger } from '../lib/logger';

export type Database = pg.Pool;

/** Interfaz mínima que comparten Pool y PoolClient (útil en transacciones). */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

// BIGINT/COUNT → number (los valores de este proyecto caben de sobra en 2^53).
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));
// NUMERIC → number (resultados de AVG, percentiles, etc.)
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value));

export function createPool(config: Pick<AppConfig, 'databaseUrl' | 'databaseSsl' | 'databasePoolMax'>): Database {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => logger.error('Error inesperado en el pool de PostgreSQL', { error: err.message }));
  return pool;
}

/** Ejecuta `fn` dentro de una transacción; revierte si lanza una excepción. */
export async function withTransaction<T>(db: Database, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
