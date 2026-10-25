import { loadConfig } from './config';
import { createServerApp } from './app';
import { createPool } from './database/pool';
import { runMigrations } from './database/migrations';
import { deleteExpiredSessions } from './database/repositories';
import { configureLogger, logger } from './lib/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger(config.logLevel, config.isProduction);

  const db = createPool(config);
  // Aplicar migraciones al arrancar es idempotente y está protegido con un
  // bloqueo consultivo, así que es seguro con varias instancias.
  await runMigrations(db);

  const server = createServerApp(config, db);
  const cleanup = setInterval(() => {
    deleteExpiredSessions(db).catch((error: unknown) =>
      logger.warn('No se pudieron limpiar las sesiones caducadas', { error: String(error) }),
    );
  }, 60 * 60 * 1000);
  cleanup.unref();

  await new Promise<void>((resolve) => server.httpServer.listen(config.port, config.host, resolve));
  logger.info(`CyberGrid escuchando en http://${config.host}:${config.port}`, {
    env: config.env,
    testEndpoints: config.testEndpointsEnabled,
    matchDurationS: config.matchDurationMs / 1000,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Señal ${signal} recibida: cerrando de forma ordenada`);
    clearInterval(cleanup);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await server.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('No se pudo iniciar el servidor', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
