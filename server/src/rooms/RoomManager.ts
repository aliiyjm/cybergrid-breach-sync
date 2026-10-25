import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { GAME } from '../../../shared/constants';
import {
  DEFAULT_SCORE_TARGET,
  SCORE_TARGETS,
  SCORE_TARGET_ERROR,
  calculateMatchDuration,
  isScoreTarget,
  type ScoreTarget,
} from '../../../shared/matchConfig';
import type {
  CreateRoomRequest,
  GameEvent,
  GameSnapshot,
  JoinRoomRequest,
  MatchResult,
  MemberState,
  PlayerUpgradeView,
  PublicUser,
  RoomListPayload,
  RoomState,
  RoomStatus,
  RoomSummary,
} from '../../../shared/protocol';
import { GameServer } from '../game/GameServer';
import { UpgradeError } from '../game/UpgradeSystem';
import type { UpgradeId } from '../../../shared/upgrades';
import { logger } from '../lib/logger';

/** Error de dominio de salas: se devuelve al cliente en el acuse del evento. */
export class RoomError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

interface Member {
  userId: string;
  username: string;
  state: MemberState;
  avatarUrl: string | null;
  joinedAt: number;
  graceTimer: NodeJS.Timeout | null;
}

export interface Room {
  id: string;
  name: string;
  ownerId: string;
  maxPlayers: number;
  isPrivate: boolean;
  accessCodeHash: Buffer | null;
  /** Puntuación para ganar y duración máxima: fijadas por el servidor al crear la sala. */
  scoreToWin: ScoreTarget;
  durationMs: number;
  status: RoomStatus;
  members: Map<string, Member>;
  countdownEndsAt: number | null;
  countdownTimer: NodeJS.Timeout | null;
  game: GameServer | null;
  createdAt: number;
}

/** Canal de salida hacia los clientes (implementado con Socket.IO). */
export interface RoomNotifier {
  roomState(room: RoomState): void;
  roomsChanged(payload: RoomListPayload): void;
  roomClosed(userIds: string[], roomId: string, reason: string): void;
  gameStart(room: Room, game: GameServer): void;
  snapshot(roomId: string, snapshot: GameSnapshot): void;
  event(roomId: string, event: GameEvent): void;
  gameEnd(roomId: string, result: MatchResult): void;
  appearance(roomId: string, playerId: string, avatarUrl: string | null): void;
  /** Estado privado de mejoras: solo al jugador indicado. */
  upgrades(userId: string, view: PlayerUpgradeView): void;
}

export interface RoomManagerOptions {
  notifier: RoomNotifier;
  /** Duración de referencia (MATCH_DURATION_S): la de cada modo sale de calculateMatchDuration. */
  matchDurationMs: number;
  /** Persiste el resultado de una partida. Se espera antes de anunciar el resultado. */
  persistMatch: (result: MatchResult, meta: { seed: number; startedAt: Date; endedAt: Date }) => Promise<void>;
  graceMs?: number;
  countdownMs?: number;
  /** Fuente aleatoria de las opciones de mejora (solo pruebas; por defecto criptográfica). */
  upgradeRandom?: () => number;
}

function hashCode(code: string): Buffer {
  return createHash('sha256').update(code.toUpperCase()).digest();
}

/**
 * Gestor autoritativo de salas. Toda la lógica (capacidad, permisos, estado
 * de listo, cuenta atrás, inicio de partida, desconexiones y reconexiones)
 * vive aquí, independiente del transporte, para poder probarla.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly userRoom = new Map<string, string>();
  private readonly graceMs: number;
  private readonly countdownMs: number;
  /** Último estado difundido por sala y de la lista: evita emitir dos veces lo mismo. */
  private readonly lastStateJson = new Map<string, string>();
  private lastListJson = '';
  private listVersion = 0;

  constructor(private readonly options: RoomManagerOptions) {
    this.graceMs = options.graceMs ?? GAME.RECONNECT_GRACE_MS;
    this.countdownMs = options.countdownMs ?? GAME.START_COUNTDOWN_MS;
  }

  /* ------------------------------ Consultas ------------------------------ */

  list(): RoomSummary[] {
    return [...this.rooms.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => ({
        id: room.id,
        name: room.name,
        ownerName: room.members.get(room.ownerId)?.username ?? '—',
        isPrivate: room.isPrivate,
        players: room.members.size,
        maxPlayers: room.maxPlayers,
        status: room.status,
        scoreToWin: room.scoreToWin,
        durationMs: room.durationMs,
      }));
  }

  /** Modos de puntuación disponibles con su duración calculada por el servidor. */
  matchOptions(): Array<{ scoreToWin: ScoreTarget; durationMs: number }> {
    return SCORE_TARGETS.map((target) => ({
      scoreToWin: target,
      durationMs: calculateMatchDuration(this.options.matchDurationMs, target),
    }));
  }

  /** Lista con número de versión (aumenta solo cuando la lista cambia). */
  listPayload(): RoomListPayload {
    return { version: this.listVersion, rooms: this.list() };
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  roomOf(userId: string): Room | undefined {
    const id = this.userRoom.get(userId);
    return id ? this.rooms.get(id) : undefined;
  }

  isMember(roomId: string, userId: string): boolean {
    return this.rooms.get(roomId)?.members.has(userId) ?? false;
  }

  state(room: Room): RoomState {
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      maxPlayers: room.maxPlayers,
      isPrivate: room.isPrivate,
      status: room.status,
      scoreToWin: room.scoreToWin,
      durationMs: room.durationMs,
      countdownEndsAt: room.countdownEndsAt,
      members: [...room.members.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((m) => ({
          userId: m.userId,
          username: m.username,
          state: m.state,
          isOwner: m.userId === room.ownerId,
          avatarUrl: m.avatarUrl,
        })),
    };
  }

  /* ------------------------------ Operaciones ------------------------------ */

  create(user: PublicUser, request: CreateRoomRequest): Room {
    const scoreToWin = request.scoreToWin ?? DEFAULT_SCORE_TARGET;
    // Zod ya lo valida; se comprueba de nuevo porque la sala es la fuente de verdad.
    if (!isScoreTarget(scoreToWin)) {
      throw new RoomError('VALIDACION', SCORE_TARGET_ERROR);
    }
    this.leaveCurrentIfIdle(user.id);
    const room: Room = {
      id: randomBytes(6).toString('base64url'),
      name: request.name,
      ownerId: user.id,
      maxPlayers: request.maxPlayers,
      isPrivate: request.isPrivate,
      accessCodeHash: request.isPrivate && request.accessCode ? hashCode(request.accessCode) : null,
      scoreToWin,
      durationMs: calculateMatchDuration(this.options.matchDurationMs, scoreToWin),
      status: 'lobby',
      members: new Map(),
      countdownEndsAt: null,
      countdownTimer: null,
      game: null,
      createdAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    this.addMember(room, user);
    logger.info('Sala creada', {
      roomId: room.id,
      owner: user.username,
      private: room.isPrivate,
      scoreToWin,
      durationMs: room.durationMs,
    });
    this.broadcast(room);
    return room;
  }

  join(user: PublicUser, request: JoinRoomRequest): Room {
    const room = this.rooms.get(request.roomId);
    if (!room) throw new RoomError('SALA_NO_EXISTE', 'La sala no existe o ya se cerró');

    // Reingreso de un miembro (p. ej. tras recargar la página).
    if (room.members.has(user.id)) {
      this.syncAppearance(room, user);
      this.reconnect(user.id);
      return room;
    }
    if (room.isPrivate) {
      const provided = request.accessCode ? hashCode(request.accessCode) : null;
      if (!provided || !room.accessCodeHash || !timingSafeEqual(provided, room.accessCodeHash)) {
        throw new RoomError('ACCESO_DENEGADO', 'Código de acceso incorrecto para esta sala privada');
      }
    }
    if (room.status !== 'lobby') throw new RoomError('PARTIDA_EN_CURSO', 'La partida de esta sala ya está en curso');
    if (room.members.size >= room.maxPlayers) throw new RoomError('SALA_LLENA', 'La sala está llena');

    this.leaveCurrentIfIdle(user.id);
    this.addMember(room, user);
    this.broadcast(room);
    return room;
  }

  /**
   * Regreso a la sala original tras una partida (botón «Volver al lobby»).
   *
   * Idempotente: no crea salas, no vuelve a añadir al jugador (los miembros se
   * guardan en un Map por userId) y, si el estado no cambia, no emite nada.
   * Si la sala ya no existe o el jugador dejó de pertenecer a ella responde
   * con un error explícito para que el cliente vuelva al lobby general.
   */
  returnToRoom(user: PublicUser, roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('SALA_NO_EXISTE', 'La sala ya no existe. Puedes crear o elegir otra en el lobby.');
    }
    const member = room.members.get(user.id);
    if (!member || this.userRoom.get(user.id) !== room.id) {
      throw new RoomError('NO_ERES_MIEMBRO', 'Ya no formas parte de esta sala. Elige otra en el lobby.');
    }
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = null;
    if (member.state === 'desconectado') member.state = 'conectado';
    room.game?.setConnected(user.id, true);
    this.syncAppearance(room, user);
    this.broadcast(room); // sin cambios ⇒ no se emite nada (ver broadcast)
    return room;
  }

  /** Copia la apariencia actual del usuario al miembro y a la partida, si cambió. */
  private syncAppearance(room: Room, user: PublicUser): void {
    if (user.avatarUrl === undefined) return;
    const member = room.members.get(user.id);
    if (!member || member.avatarUrl === user.avatarUrl) return;
    member.avatarUrl = user.avatarUrl;
    if (room.game?.setAppearance(user.id, user.avatarUrl)) {
      this.options.notifier.appearance(room.id, user.id, user.avatarUrl);
    }
  }

  /** Sala a la que pertenece el usuario según el servidor (única fuente de verdad). */
  current(userId: string): Room | undefined {
    return this.roomOf(userId);
  }

  /** Actualiza la apariencia de un miembro en su sala y en la partida en curso. */
  updateAppearance(userId: string, avatarUrl: string | null): void {
    const room = this.roomOf(userId);
    if (!room) return;
    const member = room.members.get(userId);
    if (!member || member.avatarUrl === avatarUrl) return;
    member.avatarUrl = avatarUrl;
    if (room.game?.setAppearance(userId, avatarUrl)) this.options.notifier.appearance(room.id, userId, avatarUrl);
    this.broadcast(room);
  }

  leave(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) return;
    const member = room.members.get(userId);
    if (member?.graceTimer) clearTimeout(member.graceTimer);
    room.members.delete(userId);
    this.userRoom.delete(userId);
    room.game?.removePlayer(userId);
    this.afterMembershipChange(room);
  }

  setReady(userId: string, ready: boolean): Room {
    const room = this.roomOf(userId);
    if (!room) throw new RoomError('SIN_SALA', 'No perteneces a ninguna sala');
    if (room.status === 'en_partida') throw new RoomError('PARTIDA_EN_CURSO', 'La partida ya ha comenzado');
    const member = room.members.get(userId) as Member;
    member.state = ready ? 'listo' : 'conectado';
    this.evaluateStart(room);
    this.broadcast(room);
    return room;
  }

  handleInput(userId: string, input: Parameters<GameServer['handleInput']>[1]): boolean {
    const room = this.roomOf(userId);
    if (!room?.game || room.status !== 'en_partida') return false;
    return room.game.handleInput(userId, input);
  }

  /** Elección de mejora del jugador en su partida en curso (validada por GameServer). */
  chooseUpgrade(userId: string, req: { milestone: number; upgradeId: UpgradeId }): PlayerUpgradeView {
    const room = this.roomOf(userId);
    if (!room?.game || room.status !== 'en_partida') {
      throw new RoomError('SIN_PARTIDA', 'No estás en una partida en curso');
    }
    try {
      return room.game.chooseUpgrade(userId, req.milestone, req.upgradeId);
    } catch (error) {
      if (error instanceof UpgradeError) throw new RoomError(error.code, error.message);
      throw error;
    }
  }

  /* ------------------------- Conexión y desconexión ------------------------- */

  disconnect(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) return;
    const member = room.members.get(userId);
    if (!member) return;
    member.state = 'desconectado';
    room.game?.setConnected(userId, false);
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = setTimeout(() => {
      member.graceTimer = null;
      if (member.state === 'desconectado') {
        logger.info('Jugador expulsado por desconexión prolongada', { roomId: room.id, userId });
        this.leave(userId);
      }
    }, this.graceMs);
    member.graceTimer.unref?.();
    this.cancelCountdown(room);
    this.broadcast(room);
  }

  /**
   * Partida EN CURSO de la sala, o null. Una partida que ya terminó (aunque
   * su resultado se esté guardando todavía) nunca se reenvía a un cliente que
   * se reconecta, vuelve o se une: así no puede recuperar mejoras de ella.
   */
  activeGame(room: Room): GameServer | null {
    const game = room.game;
    return game && room.status === 'en_partida' && !game.isEnded && !game.isDisposed ? game : null;
  }

  /** Devuelve la sala si el usuario tenía una (para resincronizar su cliente). */
  reconnect(userId: string): Room | undefined {
    const room = this.roomOf(userId);
    if (!room) return undefined;
    const member = room.members.get(userId);
    if (!member) return undefined;
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = null;
    if (member.state === 'desconectado') member.state = 'conectado';
    room.game?.setConnected(userId, true);
    this.broadcast(room);
    return room;
  }

  /* ------------------------------ Internos ------------------------------ */

  private addMember(room: Room, user: PublicUser): void {
    room.members.set(user.id, {
      userId: user.id,
      username: user.username,
      state: 'conectado',
      avatarUrl: user.avatarUrl ?? null,
      joinedAt: Date.now() + room.members.size * 1e-3,
      graceTimer: null,
    });
    this.userRoom.set(user.id, room.id);
  }

  private leaveCurrentIfIdle(userId: string): void {
    const current = this.roomOf(userId);
    if (!current) return;
    if (current.status === 'en_partida') {
      throw new RoomError('PARTIDA_EN_CURSO', 'Abandona tu partida actual antes de unirte a otra sala');
    }
    this.leave(userId);
  }

  private afterMembershipChange(room: Room): void {
    if (room.members.size === 0) {
      this.closeRoom(room, 'La sala quedó vacía');
      return;
    }
    if (!room.members.has(room.ownerId)) {
      // El creador se fue: hereda la sala el miembro más antiguo.
      const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0] as Member;
      room.ownerId = next.userId;
    }
    this.evaluateStart(room);
    this.broadcast(room);
  }

  private closeRoom(room: Room, reason: string): void {
    this.cancelCountdown(room);
    room.game?.dispose();
    room.game = null;
    for (const m of room.members.values()) {
      if (m.graceTimer) clearTimeout(m.graceTimer);
      this.userRoom.delete(m.userId);
    }
    this.options.notifier.roomClosed([...room.members.keys()], room.id, reason);
    this.rooms.delete(room.id);
    this.lastStateJson.delete(room.id);
    this.broadcastList();
  }

  /**
   * Condición de inicio: al menos 2 miembros y TODOS en estado «listo».
   * Se inicia una cuenta atrás; cualquier cambio la cancela.
   */
  private evaluateStart(room: Room): void {
    if (room.status === 'en_partida') return;
    const members = [...room.members.values()];
    const allReady =
      members.length >= GAME.MIN_PLAYERS_TO_START && members.every((m) => m.state === 'listo');
    if (allReady && room.status === 'lobby') {
      room.status = 'cuenta_atras';
      room.countdownEndsAt = Date.now() + this.countdownMs;
      room.countdownTimer = setTimeout(() => this.startMatch(room), this.countdownMs);
      room.countdownTimer.unref?.();
    } else if (!allReady && room.status === 'cuenta_atras') {
      this.cancelCountdown(room);
    }
  }

  private cancelCountdown(room: Room): void {
    if (room.countdownTimer) clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
    room.countdownEndsAt = null;
    if (room.status === 'cuenta_atras') room.status = 'lobby';
  }

  private startMatch(room: Room): void {
    room.countdownTimer = null;
    room.countdownEndsAt = null;
    if (!this.rooms.has(room.id) || room.status !== 'cuenta_atras') return;
    const players = [...room.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => ({ id: m.userId, username: m.username, avatarUrl: m.avatarUrl }));
    if (players.length < GAME.MIN_PLAYERS_TO_START) {
      room.status = 'lobby';
      this.broadcast(room);
      return;
    }
    const seed = randomInt(0, 2 ** 32 - 1);
    const startedAt = new Date();
    const game = new GameServer({
      matchId: randomUUID(),
      roomId: room.id,
      seed,
      players,
      durationMs: room.durationMs,
      scoreToWin: room.scoreToWin,
      // Solo la partida ACTUAL de la sala puede emitir: un callback de una
      // partida anterior (o de otra sala) se descarta sin tocar a nadie.
      onSnapshot: (snapshot) => {
        if (isCurrent()) this.options.notifier.snapshot(room.id, snapshot);
      },
      onEvent: (event) => {
        if (isCurrent()) this.options.notifier.event(room.id, event);
      },
      onEnd: (result) => void this.handleGameEnd(room, game, result, seed, startedAt),
      onUpgrades: (userId, view) => {
        if (isCurrent()) this.options.notifier.upgrades(userId, view);
      },
      upgradeRandom: this.options.upgradeRandom,
    });
    const isCurrent = (): boolean => room.game === game && !game.isDisposed && this.rooms.get(room.id) === room;
    // Nunca dos partidas a la vez en una sala: la anterior (si quedara) se libera.
    if (room.game && room.game !== game) room.game.dispose();
    room.game = game;
    room.status = 'en_partida';
    for (const m of room.members.values()) m.state = m.state === 'desconectado' ? 'desconectado' : 'conectado';
    game.start();
    logger.info('Partida iniciada', {
      roomId: room.id,
      matchId: game.matchId,
      players: players.length,
      seed,
      scoreToWin: room.scoreToWin,
      durationMs: room.durationMs,
    });
    this.options.notifier.gameStart(room, game);
    this.broadcast(room);
  }

  private async handleGameEnd(
    room: Room,
    game: GameServer,
    result: MatchResult,
    seed: number,
    startedAt: Date,
  ): Promise<void> {
    try {
      await this.options.persistMatch(result, { seed, startedAt, endedAt: new Date() });
      result.persisted = true;
    } catch (error) {
      logger.error('No se pudo guardar la partida', {
        matchId: result.matchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.info('Partida finalizada', { roomId: room.id, matchId: result.matchId, reason: result.reason });
    if (room.game !== game) {
      // La sala ya no tiene esta partida (se cerró o empezó otra): no se anuncia en ella.
      game.dispose();
      return;
    }
    this.options.notifier.gameEnd(room.id, result);
    room.game = null;
    // Libera proyectiles, efectos y estado temporal: nada pasa a la siguiente partida.
    game.dispose();
    if (!this.rooms.has(room.id)) return;
    room.status = 'lobby';
    for (const m of room.members.values()) if (m.state !== 'desconectado') m.state = 'conectado';
    this.broadcast(room);
  }

  /**
   * Difunde el estado de la sala y la lista de salas SOLO si cambiaron desde
   * la última difusión: una operación repetida (doble clic, reintento) no
   * produce eventos duplicados.
   */
  private broadcast(room: Room): void {
    if (this.rooms.has(room.id)) {
      const state = this.state(room);
      const json = JSON.stringify(state);
      if (this.lastStateJson.get(room.id) !== json) {
        this.lastStateJson.set(room.id, json);
        this.options.notifier.roomState(state);
      }
    }
    this.broadcastList();
  }

  private broadcastList(): void {
    const rooms = this.list();
    const json = JSON.stringify(rooms);
    if (json === this.lastListJson) return;
    this.lastListJson = json;
    this.listVersion++;
    this.options.notifier.roomsChanged({ version: this.listVersion, rooms });
  }

  /** Detiene temporizadores y partidas (cierre ordenado del servidor y pruebas). */
  dispose(): void {
    for (const room of this.rooms.values()) {
      this.cancelCountdown(room);
      room.game?.dispose();
      room.game = null;
      for (const m of room.members.values()) if (m.graceTimer) clearTimeout(m.graceTimer);
    }
    this.rooms.clear();
    this.userRoom.clear();
    this.lastStateJson.clear();
  }
}
