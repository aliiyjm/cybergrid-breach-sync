/**
 * CLI de migraciones: `npm run db:migrate` (desarrollo) o
 * `node server/dist/migrate.js` (producción, lo ejecuta `npm run start:prod`).
 */
import { loadConfig } from '../config';
import { configureLogger, logger } from '../lib/logger';
import { createPool } from './pool';
import { runMigrations } from './migrations';

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger(config.logLevel === 'silent' ? 'info' : config.logLevel, config.isProduction);
  const pool = createPool(config);
  try {
    const applied = await runMigrations(pool);
    logger.info(
      applied.length > 0 ? `Migraciones aplicadas: ${applied.join(', ')}` : 'La base de datos ya está actualizada',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logger.error('No se pudieron aplicar las migraciones', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
