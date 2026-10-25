import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Database } from '../database/pool';
import {
  avatarUrlFor,
  deleteAvatar,
  getAvatarIdForUser,
  getAvatarImage,
  replaceAvatar,
} from '../database/repositories';
import { requireAuth, type AuthLocals } from '../auth/middleware';
import type { SessionService } from '../auth/SessionService';
import { HttpError, validationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { FixedWindowLimiter } from '../lib/RateLimiter';
import { avatarCropSchema } from '../validation/schemas';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  AVATAR_OUTPUT_SIZE,
  AvatarError,
  processAvatar,
  type AvatarLimits,
} from './avatarProcessor';

export interface ProfileRouterOptions {
  db: Database;
  sessions: SessionService;
  limits: AvatarLimits;
  /** Notifica el cambio a la sala/partida del usuario (sin duplicarlo ni desconectarlo). */
  onAvatarChanged: (userId: string, avatarUrl: string | null) => void;
  relaxedRateLimits?: boolean;
}

/**
 * Perfil del jugador: apariencia personalizada.
 *   GET    /api/profile         → datos del perfil y límites de subida
 *   POST   /api/profile/avatar  → sube y guarda una imagen (cuerpo binario PNG/JPEG)
 *   DELETE /api/profile/avatar  → restablece la apariencia predeterminada
 *
 * Solo existe la variante «mi apariencia»: ningún endpoint recibe un id de
 * usuario, así que nadie puede cambiar la apariencia de otro jugador.
 */
export function createProfileRouter(options: ProfileRouterOptions): Router {
  const { db, sessions, limits } = options;
  const router = Router();
  const uploadLimiter = new FixedWindowLimiter(options.relaxedRateLimits ? 1000 : 10, 60_000);

  router.use(requireAuth(sessions));

  router.get('/', async (_req: Request, res: Response) => {
    const { user } = res.locals as AuthLocals;
    const avatarUrl = avatarUrlFor(await getAvatarIdForUser(db, user.id));
    res.json({
      user: { ...user, avatarUrl },
      limits: {
        maxBytes: limits.maxBytes,
        maxDimension: limits.maxDimension,
        minDimension: limits.minDimension,
        outputSize: AVATAR_OUTPUT_SIZE,
        extensions: ALLOWED_EXTENSIONS,
        mimeTypes: ALLOWED_MIME_TYPES,
      },
    });
  });

  // Cuerpo binario limitado; solo se lee si el Content-Type es PNG o JPEG.
  const rawParser = express.raw({ type: [...ALLOWED_MIME_TYPES], limit: limits.maxBytes });
  const parseImage = (req: Request, res: Response, next: NextFunction): void => {
    rawParser(req, res, (err?: unknown) => {
      if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
        const mb = (limits.maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
        next(new HttpError(413, 'ARCHIVO_DEMASIADO_GRANDE', `La imagen supera el tamaño máximo de ${mb} MB.`));
        return;
      }
      next(err as Error | undefined);
    });
  };

  router.post('/avatar', parseImage, async (req: Request, res: Response) => {
    const { user } = res.locals as AuthLocals;
    const retryMs = uploadLimiter.hit(user.id);
    if (retryMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
      throw new HttpError(429, 'DEMASIADOS_INTENTOS', 'Has subido demasiadas imágenes seguidas. Espera un minuto.');
    }

    const crop = avatarCropSchema.safeParse(req.query);
    if (!crop.success) throw validationError(crop.error);

    let fileName = '';
    try {
      fileName = decodeURIComponent(req.header('x-file-name') ?? '');
    } catch {
      fileName = '';
    }
    const mimeType = req.header('content-type') ?? '';
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!Buffer.isBuffer(req.body) && mimeType && !ALLOWED_MIME_TYPES.some((t) => mimeType.startsWith(t))) {
      throw new HttpError(415, 'FORMATO_NO_PERMITIDO', 'Formato no permitido. Solo se aceptan imágenes PNG o JPEG.');
    }

    try {
      const processed = await processAvatar({ buffer, fileName, mimeType, crop: crop.data }, limits);
      const avatarId = await replaceAvatar(db, user.id, processed);
      const avatarUrl = avatarUrlFor(avatarId);
      options.onAvatarChanged(user.id, avatarUrl);
      logger.info('Apariencia actualizada', { user: user.username, bytes: processed.bytes, source: processed.sourceType });
      res.json({ avatarUrl, width: processed.width, height: processed.height, bytes: processed.bytes });
    } catch (error) {
      if (error instanceof AvatarError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });

  router.delete('/avatar', async (_req: Request, res: Response) => {
    const { user } = res.locals as AuthLocals;
    const removed = await deleteAvatar(db, user.id);
    if (removed) options.onAvatarChanged(user.id, null);
    res.json({ avatarUrl: null, removed });
  });

  return router;
}

const AVATAR_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/;

/**
 * Entrega de imágenes: GET /api/avatars/<id>.png. El nombre lo generó el
 * servidor (UUID); cualquier otro formato de ruta responde 404, por lo que no
 * hay rutas manipulables. El contenido siempre es el PNG re-codificado.
 */
export function createAvatarFilesRouter(db: Database, sessions: SessionService): Router {
  const router = Router();
  router.use(requireAuth(sessions));
  router.get('/:file', async (req: Request, res: Response) => {
    const match = AVATAR_FILE_RE.exec(String(req.params.file ?? ''));
    if (!match) throw new HttpError(404, 'NO_ENCONTRADO', 'Imagen no encontrada');
    const avatar = await getAvatarImage(db, match[1] as string);
    if (!avatar) throw new HttpError(404, 'NO_ENCONTRADO', 'Imagen no encontrada');
    const etag = `"${avatar.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline; filename="avatar.png"');
    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.type('image/png').send(avatar.image);
  });
  return router;
}
