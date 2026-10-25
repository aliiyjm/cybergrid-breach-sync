import { defineConfig } from 'vitest/config';

/**
 * Dos proyectos:
 *  - unit:        lógica pura (mapas, combate, colisiones, interpolación, Zod…)
 *  - integration: API HTTP + Socket.IO + PostgreSQL reales. Requiere
 *                 TEST_DATABASE_URL (o DATABASE_URL); si no existe, la suite
 *                 FALLA en lugar de omitirse, para que CI no quede en verde
 *                 sin haberla ejecutado.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/globalSetup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
