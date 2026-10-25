import { loadConfig } from '../../server/src/config';
import { createPool } from '../../server/src/database/pool';
import { runMigrations } from '../../server/src/database/migrations';
import { configureLogger } from '../../server/src/lib/logger';

/**
 * Prepara la base de datos de pruebas: aplica migraciones y vacía las tablas.
 * Usa TEST_DATABASE_URL (recomendado) o DATABASE_URL. Si no hay ninguna,
 * lanza un error: la suite de integración nunca se omite en silencio.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Las pruebas de integración necesitan PostgreSQL. Define TEST_DATABASE_URL, por ejemplo:\n' +
        '  TEST_DATABASE_URL=postgres://cybergrid:cybergrid@localhost:5432/cybergrid_test',
    );
  }
  configureLogger('warn', false);
  const config = loadConfig({ ...process.env, DATABASE_URL: url, NODE_ENV: 'test' });
  const pool = createPool(config);
  try {
    await runMigrations(pool);
    await pool.query('TRUNCATE match_players, matches, seed_batches, sessions, users RESTART IDENTITY CASCADE');
  } finally {
    await pool.end();
  }
}
