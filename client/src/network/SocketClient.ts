import { io, type Socket } from 'socket.io-client';
import type {
  ChooseUpgradeRequest,
  PlayerUpgradeView,
  AckResponse,
  ClientToServerEvents,
  CreateRoomRequest,
  InputIntent,
  JoinRoomRequest,
  RoomListPayload,
  RoomState,
  ServerToClientEvents,
} from '../../../shared/protocol';
import { SERVER_URL } from './api';
import { LatencyMonitor } from './LatencyMonitor';

export type ConnectionState = 'offline' | 'connecting' | 'online';
type GameClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export class SocketActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SocketActionError';
  }
}

/**
 * Conexión en tiempo real con el servidor. La sesión viaja en la cookie
 * HttpOnly del handshake; el servidor rechaza el socket si no es válida.
 */
export class SocketClient {
  readonly socket: GameClientSocket;
  readonly latency: LatencyMonitor;
  private state: ConnectionState = 'offline';
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private authFailureHandler: (() => void) | null = null;

  constructor() {
    this.socket = io(SERVER_URL || undefined, {
      path: '/socket.io',
      autoConnect: false,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });
    this.latency = new LatencyMonitor((t) => this.socket.timeout(5000).emitWithAck('net:ping', { t }));

    this.socket.on('connect', () => {
      this.setState('online');
      this.latency.start();
    });
    this.socket.on('disconnect', (reason) => {
      this.latency.stop();
      // Si el servidor cerró la conexión a propósito no se reintenta solo.
      this.setState(reason === 'io server disconnect' ? 'offline' : 'connecting');
    });
    this.socket.on('connect_error', (err) => {
      if (err.message === 'NO_AUTENTICADO') {
        this.socket.disconnect();
        this.setState('offline');
        this.authFailureHandler?.();
        return;
      }
      this.setState('connecting');
    });
    this.socket.io.on('reconnect_attempt', () => this.setState('connecting'));
  }

  connect(): void {
    if (this.socket.connected || this.socket.active) return;
    this.setState('connecting');
    this.socket.connect();
  }

  disconnect(): void {
    this.latency.stop();
    this.socket.disconnect();
    this.setState('offline');
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Transporte activo: "websocket" una vez establecida la conexión. */
  get transport(): string | null {
    return this.socket.connected ? this.socket.io.engine.transport.name : null;
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  onAuthFailure(fn: () => void): void {
    this.authFailureHandler = fn;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const fn of this.stateListeners) fn(next);
  }

  private async call<T>(promise: Promise<AckResponse<T>>): Promise<T> {
    let res: AckResponse<T>;
    try {
      res = await promise;
    } catch {
      throw new SocketActionError('SIN_RESPUESTA', 'El servidor no respondió a tiempo. Inténtalo de nuevo.');
    }
    if (!res.ok) throw new SocketActionError(res.error?.code ?? 'ERROR', res.error?.message ?? 'Operación rechazada');
    return res.data as T;
  }

  listRooms(): Promise<RoomListPayload> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:list'));
  }

  /** Sala a la que pertenece el usuario según el servidor (o null). */
  currentRoom(): Promise<RoomState | null> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:current'));
  }

  /** Regreso idempotente a la sala original tras una partida. */
  returnToRoom(roomId: string): Promise<RoomState> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:return', { roomId }));
  }

  createRoom(req: CreateRoomRequest): Promise<RoomState> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:create', req));
  }

  joinRoom(req: JoinRoomRequest): Promise<RoomState> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:join', req));
  }

  leaveRoom(): Promise<undefined> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:leave'));
  }

  setReady(ready: boolean): Promise<RoomState> {
    return this.call(this.socket.timeout(5000).emitWithAck('room:ready', { ready }));
  }

  /**
   * Solicita una mejora para el hito pendiente. El servidor valida el hito y que
   * la mejora estuviera entre las ofrecidas; repetirla no la aplica dos veces.
   */
  chooseUpgrade(req: ChooseUpgradeRequest): Promise<PlayerUpgradeView> {
    return this.call(this.socket.timeout(5000).emitWithAck('game:upgrade:choose', req));
  }

  sendInput(input: InputIntent): void {
    if (this.socket.connected) this.socket.volatile.emit('game:input', input);
  }

  /** Envía un evento crudo (solo para pruebas de rechazo en el servidor). */
  rawEmit(event: string, payload: unknown): void {
    (this.socket as unknown as Socket).emit(event, payload);
  }
}
