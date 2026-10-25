import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import type { PublicUser } from '../../../shared/protocol';
import { extractToken, type SessionService } from './SessionService';

export interface AuthLocals {
  user: PublicUser;
  token: string;
}

/** Exige una sesión válida; si no existe responde 401. */
export function requireAuth(sessions: SessionService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractToken(req.headers);
    const user = await sessions.resolve(token);
    if (!user || !token) {
      throw new HttpError(401, 'NO_AUTENTICADO', 'Debes iniciar sesión para acceder a este recurso');
    }
    (res.locals as AuthLocals).user = user;
    (res.locals as AuthLocals).token = token;
    next();
  };
}

/**
 * Protección CSRF para peticiones que modifican estado:
 *  - deben enviar JSON (un formulario de otro sitio no puede hacerlo sin CORS),
 *  - si llega cabecera Origin, debe ser el propio host o un origen permitido.
 * Junto con la cookie SameSite=Lax evita peticiones forjadas desde otros sitios.
 */
export function csrfGuard(allowedOrigins: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw new HttpError(403, 'ORIGEN_INVALIDO', 'Origen de la petición no permitido');
      }
      const sameHost = originHost === req.headers.host;
      if (!sameHost && !allowedOrigins.includes(origin)) {
        throw new HttpError(403, 'ORIGEN_INVALIDO', 'Origen de la petición no permitido');
      }
    }
    // Un formulario de otro sitio solo puede enviar urlencoded, multipart o
    // text/plain; se exige JSON o, para la subida de imágenes, PNG/JPEG binario.
    const hasBody =
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
      req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !req.is(['application/json', 'image/png', 'image/jpeg'])) {
      throw new HttpError(415, 'TIPO_NO_SOPORTADO', 'El cuerpo de la petición debe ser JSON o una imagen PNG/JPEG');
    }
    next();
  };
}
