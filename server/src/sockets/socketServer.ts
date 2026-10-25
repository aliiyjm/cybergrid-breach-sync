import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { NET } from '../../../shared/constants';
import type {
  AckResponse,
  ClientToServerEvents,
  PublicUser,
  RoomListPayload,
  ServerToClientEvents,
} from '../../../shared/protocol';
import { extractToken, type SessionService } from '../auth/SessionService';
import { formatZodIssues } from '../lib/errors';
import { logger } from '../lib/logger';
import { TokenBucket } from '../lib/RateLimiter';
import { RoomError, RoomManager, type RoomNotifier } from '../rooms/RoomManager';
import {
  chooseUpgradeSchema,
  createRoomSchema,
  inputSchema,
  joinRoomSchema,
  pingSchema,
  readySchema,
  returnToRoomSchema,
} from '../validation/schemas';

interface SocketData {
  user: PublicUser;
  inputBucket: TokenBucket;
  eventBucket: TokenBucket;
  invalidCount: number;
  lastErrorAt: number;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type GameIo = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface SocketServerOptions {
  httpServer: HttpServer;
  sessions: SessionService;
  corsOrigins: string[];
  createRoomManager: (notifier: RoomNotifier) => RoomManager;
}

const MAX_INVALID_MESSAGES = 50;
const roomChannel = (roomId: string): string => `room:${roomId}`;

export function createSocketServer(options: SocketServerOptions): {
  io: GameIo;
  rooms: RoomManager;
  disconnectUser: (userId: string) => void;
  updateUserAppearance: (userId: string, avatarUrl: string | null) => void;
} {
  const io: GameIo = new Server(options.httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    cors: options.corsOrigins.length > 0 ? { origin: options.corsOrigins, credentials: true } : undefined,
  });

  /** Un socket activo por usuario: una segunda pestaña sustituye a la primera. */
  const userSockets = new Map<string, GameSocket>();

  const notifier: RoomNotifier = {
    roomState: (state) => io.to(roomChannel(state.id)).emit('room:state', state),
    // RoomManager ya descarta las listas repetidas y numera las versiones.
    roomsChanged: (payload: RoomListPayload) => io.to('lobby').emit('rooms:changed', payload),
    roomClosed: (userIds, roomId, reason) => {
      for (const id of userIds) {
        const s = userSockets.get(id);
        if (!s) continue;
        void s.leave(roomChannel(roomId));
        s.emit('room:closed', { roomId, reason });
      }
    },
    gameStart: (room, game) => {
      for (const member of room.members.values()) {
        userSockets.get(member.userId)?.emit('game:start', game.startPayload(member.userId));
      }
    },
    // `volatile`: si el búfer del cliente está lleno se descarta la instantánea
    // (la siguiente la sustituye), en lugar de acumular retraso.
    snapshot: (roomId, snapshot) => io.to(roomChannel(roomId)).volatile.emit('game:snapshot', snapshot),
    event: (roomId, event) => io.to(roomChannel(roomId)).emit('game:event', event),
    gameEnd: (roomId, result) => io.to(roomChannel(roomId)).emit('game:end', result),
    appearance: (roomId, playerId, avatarUrl) =>
      io.to(roomChannel(roomId)).emit('player:appearance', { playerId, avatarUrl }),
    // Privado: el progreso y las opciones de un jugador no se difunden a la sala.
    upgrades: (userId, view) => userSockets.get(userId)?.emit('game:upgrades', view),
  };
  const rooms = options.createRoomManager(notifier);

  /* --------------------- Autenticación del handshake --------------------- */
  io.use(async (socket, next) => {
    try {
      const authToken = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
      const token =
        authToken ??
        extractToken({
          cookie: socket.handshake.headers.cookie,
          authorization: socket.handshake.headers.authorization,
        });
      const user = await options.sessions.resolve(token);
      if (!user) {
        next(new Error('NO_AUTENTICADO'));
        return;
      }
      socket.data.user = user;
      socket.data.inputBucket = new TokenBucket(NET.INPUT_RATE_LIMIT_PER_S * 1.5, NET.INPUT_RATE_LIMIT_PER_S);
      socket.data.eventBucket = new TokenBucket(NET.EVENT_RATE_LIMIT_PER_S * 2, NET.EVENT_RATE_LIMIT_PER_S);
      socket.data.invalidCount = 0;
      socket.data.lastErrorAt = 0;
      next();
    } catch (error) {
      logger.error('Fallo al autenticar un socket', { error: error instanceof Error ? error.message : String(error) });
      next(new Error('ERROR_INTERNO'));
    }
  });

  io.on('connection', (socket: GameSocket) => {
    const user = socket.data.user;
    const previous = userSockets.get(user.id);
    if (previous && previous.id !== socket.id) {
      previous.emit('session:replaced');
      previous.disconnect(true);
    }
    userSockets.set(user.id, socket);
    void socket.join('lobby');
    logger.debug('Socket conectado', { user: user.username, socket: socket.id });

    // Reconexión: si el usuario tenía sala, se resincroniza su estado.
    const room = rooms.reconnect(user.id);
    if (room) void socket.join(roomChannel(room.id));
    socket.emit('session:ready', { user, roomId: room?.id ?? null, serverTime: Date.now() });
    if (room) {
      socket.emit('room:state', rooms.state(room));
      const active = rooms.activeGame(room);
      if (active) socket.emit('game:start', active.startPayload(user.id));
    }

    const reportInvalid = (event: string, message: string): void => {
      socket.data.invalidCount++;
      const now = Date.now();
      if (now - socket.data.lastErrorAt > 1000) {
        socket.data.lastErrorAt = now;
        socket.emit('error:event', { code: 'EVENTO_INVALIDO', message, event });
      }
      if (socket.data.invalidCount > MAX_INVALID_MESSAGES) {
        logger.warn('Socket desconectado por exceso de mensajes inválidos', { user: user.username });
        socket.disconnect(true);
      }
    };

    /**
     * Registra un manejador con: límite de frecuencia, validación Zod y
     * respuesta uniforme `{ ok, data?, error? }` en el acuse.
     */
    function handle<TReq, TRes>(
      event: string,
      schema: ZodType<TReq> | null,
      fn: (payload: TReq) => TRes,
    ): (...args: unknown[]) => void {
      return (...args: unknown[]) => {
        const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as (r: AckResponse<TRes>) => void) : null;
        const reply = (res: AckResponse<TRes>): void => ack?.(res);
        if (!socket.data.eventBucket.tryConsume()) {
          reply({ ok: false, error: { code: 'DEMASIADAS_PETICIONES', message: 'Vas demasiado rápido, espera un momento' } });
          return;
        }
        let payload: TReq = undefined as TReq;
        if (schema) {
          const parsed = schema.safeParse(args[0]);
          if (!parsed.success) {
            const issues = formatZodIssues(parsed.error);
            reportInvalid(event, issues[0]?.message ?? 'Datos inválidos');
            reply({ ok: false, error: { code: 'VALIDACION', message: issues.map((i) => `${i.path}: ${i.message}`).join('; ') } });
            return;
          }
          payload = parsed.data;
        }
        try {
          reply({ ok: true, data: fn(payload) });
        } catch (error) {
          if (error instanceof RoomError) {
            reply({ ok: false, error: { code: error.code, message: error.message } });
          } else {
            logger.error(`Error en el evento ${event}`, { error: error instanceof Error ? error.message : String(error) });
            reply({ ok: false, error: { code: 'ERROR_INTERNO', message: 'Error interno del servidor' } });
          }
        }
      };
    }

    socket.on('room:list', handle('room:list', null, () => rooms.listPayload()));

    socket.on(
      'room:current',
      handle('room:current', null, () => {
        const current = rooms.current(user.id);
        return current ? rooms.state(current) : null;
      }),
    );

    // Regreso a la sala original tras una partida: idempotente.
    // socket.join() no duplica la suscripción si el socket ya está en el canal.
    socket.on(
      'room:return',
      handle('room:return', returnToRoomSchema, (req) => {
        const room = rooms.returnToRoom(socket.data.user, req.roomId);
        void socket.join(roomChannel(room.id));
        const active = rooms.activeGame(room);
        if (active) socket.emit('game:start', active.startPayload(user.id));
        return rooms.state(room);
      }),
    );

    socket.on(
      'room:create',
      handle('room:create', createRoomSchema, (req) => {
        const previousRoom = rooms.roomOf(user.id);
        const created = rooms.create(socket.data.user, req);
        if (previousRoom) void socket.leave(roomChannel(previousRoom.id));
        void socket.join(roomChannel(created.id));
        return rooms.state(created);
      }),
    );

    socket.on(
      'room:join',
      handle('room:join', joinRoomSchema, (req) => {
        const previousRoom = rooms.roomOf(user.id);
        const joined = rooms.join(socket.data.user, req);
        if (previousRoom && previousRoom.id !== joined.id) void socket.leave(roomChannel(previousRoom.id));
        void socket.join(roomChannel(joined.id));
        const active = rooms.activeGame(joined);
        if (active) socket.emit('game:start', active.startPayload(user.id));
        return rooms.state(joined);
      }),
    );

    socket.on(
      'room:leave',
      handle('room:leave', null, () => {
        const current = rooms.roomOf(user.id);
        if (current) {
          rooms.leave(user.id);
          void socket.leave(roomChannel(current.id));
        }
        return undefined;
      }),
    );

    socket.on(
      'room:ready',
      handle('room:ready', readySchema, (req) => rooms.state(rooms.setReady(user.id, req.ready))),
    );

    socket.on('game:input', (raw: unknown) => {
      if (!socket.data.inputBucket.tryConsume()) return; // exceso de frecuencia: se descarta
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) {
        reportInvalid('game:input', formatZodIssues(parsed.error)[0]?.message ?? 'Entrada inválida');
        return;
      }
      rooms.handleInput(user.id, parsed.data);
    });

    // Elección de mejora: límite de frecuencia, Zod y validación de hito y
    // opción en el servidor. Repetir una elección confirmada no la reaplica.
    socket.on(
      'game:upgrade:choose',
      handle('game:upgrade:choose', chooseUpgradeSchema, (req) => rooms.chooseUpgrade(user.id, req)),
    );

    socket.on('net:ping', (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (!socket.data.eventBucket.tryConsume(0.25)) return;
      const parsed = pingSchema.safeParse(raw);
      if (!parsed.success) return;
      (ack as (r: { t: number; serverTime: number }) => void)({ t: parsed.data.t, serverTime: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      logger.debug('Socket desconectado', { user: user.username, reason });
      if (userSockets.get(user.id) === socket) {
        userSockets.delete(user.id);
        rooms.disconnect(user.id);
      }
    });
  });

  return {
    io,
    rooms,
    updateUserAppearance: (userId: string, avatarUrl: string | null) => {
      const s = userSockets.get(userId);
      // Se modifica el MISMO objeto de usuario del socket: los manejadores
      // (crear, unirse, volver a la sala) leen siempre la apariencia actual.
      if (s) s.data.user.avatarUrl = avatarUrl;
      rooms.updateAppearance(userId, avatarUrl);
    },
    disconnectUser: (userId: string) => {
      const s = userSockets.get(userId);
      if (s) {
        s.emit('session:replaced');
        s.disconnect(true);
      }
    },
  };
}
