import { Router, type Request, type Response } from 'express';
import type { Database } from '../database/pool';
import { getLeaderboard, getUserStats } from '../database/repositories';
import { requireAuth, type AuthLocals } from '../auth/middleware';
import type { SessionService } from '../auth/SessionService';
import { HttpError } from '../lib/errors';
import type { RoomManager } from '../rooms/RoomManager';
import { roomIdSchema } from '../validation/schemas';

const startedAt = Date.now();

/** Comprobación de disponibilidad para la plataforma de despliegue. */
export function createHealthRouter(db: Database, getRooms: () => RoomManager | null): Router {
  const router = Router();
  router.get('/', async (_req: Request, res: Response) => {
    let database = 'ok';
    try {
      await db.query('SELECT 1');
    } catch {
      database = 'error';
    }
    res.status(database === 'ok' ? 200 : 503).json({
      status: database === 'ok' ? 'ok' : 'degradado',
      database,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      activeRooms: getRooms()?.list().length ?? 0,
      serverTime: Date.now(),
    });
  });
  return router;
}

/** Consulta de salas por HTTP (las operaciones en tiempo real van por Socket.IO). */
export function createRoomsRouter(sessions: SessionService, getRooms: () => RoomManager | null): Router {
  const router = Router();
  router.use(requireAuth(sessions));

  router.get('/', (_req: Request, res: Response) => {
    const manager = getRooms();
    res.json({
      ...(manager?.listPayload() ?? { version: 0, rooms: [] }),
      matchOptions: manager?.matchOptions() ?? [],
    });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const parsed = roomIdSchema.safeParse(req.params.id);
    if (!parsed.success) throw new HttpError(400, 'VALIDACION', 'Identificador de sala inválido');
    const manager = getRooms();
    const room = manager?.get(parsed.data);
    if (!manager || !room) throw new HttpError(404, 'SALA_NO_EXISTE', 'La sala no existe');
    const { user } = res.locals as AuthLocals;
    if (room.isPrivate && !manager.isMember(room.id, user.id)) {
      throw new HttpError(403, 'SALA_PRIVADA', 'Esta sala es privada: necesitas su código de acceso para unirte');
    }
    res.json({ room: manager.state(room) });
  });
  return router;
}

export function createStatsRouter(db: Database, sessions: SessionService): Router {
  const router = Router();
  router.get('/me', requireAuth(sessions), async (_req: Request, res: Response) => {
    const { user } = res.locals as AuthLocals;
    res.json({ user, stats: await getUserStats(db, user.id) });
  });
  router.get('/leaderboard', async (_req: Request, res: Response) => {
    res.json({ leaderboard: await getLeaderboard(db, 10) });
  });
  return router;
}
