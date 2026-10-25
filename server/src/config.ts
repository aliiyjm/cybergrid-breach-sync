import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GAME } from '../../shared/constants';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL es obligatoria (cadena de conexión de PostgreSQL)' })
    .min(1, 'DATABASE_URL es obligatoria (cadena de conexión de PostgreSQL)'),
  DATABASE_SSL: booleanString.default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),
  /** Orígenes permitidos para CORS separados por comas. Vacío = mismo origen. */
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),
  ENABLE_TEST_ENDPOINTS: booleanString.optional(),
  TEST_API_KEY: z.string().min(16, 'TEST_API_KEY debe tener al menos 16 caracteres').optional(),
  MATCH_DURATION_S: z.coerce.number().int().min(10).max(1800).default(GAME.DEFAULT_MATCH_DURATION_S),
  SERVE_CLIENT: booleanString.default('true'),
  CLIENT_DIST: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  /** Tamaño máximo de la imagen de apariencia (bytes). 2 MB por defecto. */
  AVATAR_MAX_BYTES: z.coerce.number().int().min(10 * 1024).max(10 * 1024 * 1024).default(2 * 1024 * 1024),
  /** Ancho y alto máximos de la imagen original (px). */
  AVATAR_MAX_DIMENSION: z.coerce.number().int().min(256).max(8192).default(4096),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolMax: number;
  sessionTtlMs: number;
  corsOrigins: string[];
  trustProxy: number;
  testEndpointsEnabled: boolean;
  testApiKey: string | undefined;
  matchDurationMs: number;
  serveClient: boolean;
  clientDist: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  cookieSecure: boolean;
  avatarMaxBytes: number;
  avatarMaxDimension: number;
}

function defaultClientDist(): string {
  // En el código empaquetado (server/dist/index.js) y en desarrollo
  // (server/src/config.ts) la carpeta del cliente está en ../../client/dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../client/dist');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${details}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  // Los endpoints de prueba están activos fuera de producción. En producción
  // solo se activan explícitamente y siempre exigen TEST_API_KEY.
  const testEndpointsEnabled = e.ENABLE_TEST_ENDPOINTS ?? !isProduction;
  if (isProduction && testEndpointsEnabled && !e.TEST_API_KEY) {
    throw new Error('ENABLE_TEST_ENDPOINTS=true en producción requiere definir TEST_API_KEY');
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3600 * 1000,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: e.TRUST_PROXY ?? (isProduction ? 1 : 0),
    testEndpointsEnabled,
    testApiKey: e.TEST_API_KEY,
    matchDurationMs: e.MATCH_DURATION_S * 1000,
    serveClient: e.SERVE_CLIENT,
    clientDist: e.CLIENT_DIST ? path.resolve(e.CLIENT_DIST) : defaultClientDist(),
    logLevel: e.NODE_ENV === 'test' && !env.LOG_LEVEL ? 'warn' : e.LOG_LEVEL,
    cookieSecure: isProduction,
    avatarMaxBytes: e.AVATAR_MAX_BYTES,
    avatarMaxDimension: e.AVATAR_MAX_DIMENSION,
  };
}
