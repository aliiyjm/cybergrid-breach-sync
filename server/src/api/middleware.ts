import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Mide el tiempo de cada petición y lo expone en `X-Response-Time` y
 * `Server-Timing`, además de registrarlo. Sirve como evidencia del objetivo
 * de respuesta < 200 ms de los endpoints de evaluación.
 */
export function responseTiming(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const elapsedMs = (): number => Number(process.hrtime.bigint() - start) / 1e6;
  const originalWriteHead = res.writeHead;
  res.writeHead = function patchedWriteHead(this: Response, ...args: unknown[]) {
    const ms = elapsedMs().toFixed(2);
    if (!this.headersSent) {
      this.setHeader('X-Response-Time', `${ms}ms`);
      this.setHeader('Server-Timing', `app;dur=${ms}`);
    }
    return (originalWriteHead as (...a: unknown[]) => Response).apply(this, args);
  } as typeof res.writeHead;
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api/')) return;
    const ms = Number(elapsedMs().toFixed(2));
    const meta = { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms };
    if (res.statusCode >= 500) logger.error('Petición HTTP', meta);
    else logger.info('Petición HTTP', meta);
  });
  next();
}

export function securityHeaders(options: { production: boolean; extraConnect: string[] }) {
  const connectSrc = ["'self'", 'ws:', 'wss:', ...options.extraConnect].join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // blob: permite la vista previa local de la imagen elegida antes de subirla.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (options.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** CORS para despliegues con frontend y backend en dominios distintos. */
export function cors(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Api-Key, X-File-Name, Authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

export function apiNotFound(req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'NO_ENCONTRADO', `No existe la ruta ${req.method} ${req.path}`));
}

/** Manejador centralizado de errores: respuesta JSON uniforme. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    });
    return;
  }
  const bodyError = err as { type?: string; status?: number };
  if (bodyError?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'JSON_INVALIDO', message: 'El cuerpo no es un JSON válido' } });
    return;
  }
  if (bodyError?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'CUERPO_DEMASIADO_GRANDE', message: 'El cuerpo de la petición es demasiado grande' } });
    return;
  }
  logger.error('Error no controlado', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  res.status(500).json({ error: { code: 'ERROR_INTERNO', message: 'Error interno del servidor' } });
}
