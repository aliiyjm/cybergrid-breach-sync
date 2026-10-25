import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { AppConfig } from './config';
import type { Database } from './database/pool';
import { saveMatch } from './database/repositories';
import { toMatchRecord } from './game/matchRecord';
import { createAuthRouter } from './auth/routes';
import { csrfGuard } from './auth/middleware';
import { SessionService } from './auth/SessionService';
import { apiNotFound, cors, errorHandler, responseTiming, securityHeaders } from './api/middleware';
import { createHealthRouter, createRoomsRouter, createStatsRouter } from './api/routes';
import { createTestRouter } from './telemetry/routes';
import { createAvatarFilesRouter, createProfileRouter } from './profile/routes';
import { createSocketServer, type GameIo } from './sockets/socketServer';
import { RoomManager } from './rooms/RoomManager';
import { logger } from './lib/logger';

export interface ServerApp {
  app: Express;
  httpServer: HttpServer;
  io: GameIo;
  rooms: RoomManager;
  close: () => Promise<void>;
}

/** Construye Express + HTTP + Socket.IO sin empezar a escuchar (útil en pruebas). */
export function createServerApp(config: AppConfig, db: Database): ServerApp {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const sessions = new SessionService(db, config.sessionTtlMs);
  const httpServer = createServer(app);

  let rooms: RoomManager | null = null;
  const getRooms = (): RoomManager | null => rooms;

  const sockets = createSocketServer({
    httpServer,
    sessions,
    corsOrigins: config.corsOrigins,
    createRoomManager: (notifier) =>
      new RoomManager({
        notifier,
        matchDurationMs: config.matchDurationMs,
        persistMatch: (result, meta) => saveMatch(db, toMatchRecord(result, meta)),
      }),
  });
  rooms = sockets.rooms;

  app.use(responseTiming);
  app.use(securityHeaders({ production: config.isProduction, extraConnect: config.corsOrigins }));
  app.use(cors(config.corsOrigins));
  app.use(express.json({ limit: '32kb' }));

  app.use('/api/health', createHealthRouter(db, getRooms));
  app.use('/api', csrfGuard(config.corsOrigins));
  app.use(
    '/api/auth',
    createAuthRouter({
      db,
      sessions,
      sessionTtlMs: config.sessionTtlMs,
      cookieSecure: config.cookieSecure,
      onLogout: sockets.disconnectUser,
      relaxedRateLimits: config.env === 'test',
    }),
  );
  app.use('/api/rooms', createRoomsRouter(sessions, getRooms));
  app.use('/api/stats', createStatsRouter(db, sessions));
  app.use(
    '/api/profile',
    createProfileRouter({
      db,
      sessions,
      limits: { maxBytes: config.avatarMaxBytes, maxDimension: config.avatarMaxDimension, minDimension: 32 },
      onAvatarChanged: sockets.updateUserAppearance,
      relaxedRateLimits: config.env === 'test',
    }),
  );
  app.use('/api/avatars', createAvatarFilesRouter(db, sessions));
  app.use('/api/test', createTestRouter({ db, enabled: config.testEndpointsEnabled, apiKey: config.testApiKey }));
  app.use('/api', apiNotFound);

  if (config.serveClient) {
    const indexFile = path.join(config.clientDist, 'index.html');
    if (existsSync(indexFile)) {
      app.use(
        express.static(config.clientDist, {
          index: 'index.html',
          maxAge: config.isProduction ? '1h' : 0,
          setHeaders: (res, filePath) => {
            if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
          },
        }),
      );
      // La navegación usa rutas con hash, pero cualquier GET de HTML devuelve la aplicación.
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' || !req.accepts('html')) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexFile);
      });
    } else {
      logger.warn(`No se encontró el cliente compilado en ${config.clientDist}. Ejecuta "npm run build:client".`);
    }
  }

  app.use(errorHandler);

  const close = async (): Promise<void> => {
    sockets.rooms.dispose();
    await new Promise<void>((resolve) => {
      void sockets.io.close(() => resolve());
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };

  return { app, httpServer, io: sockets.io, rooms: sockets.rooms, close };
}
