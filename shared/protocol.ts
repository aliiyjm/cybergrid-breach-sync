/**
 * Contrato de mensajes entre cliente y servidor (Socket.IO).
 * Los tipos son compartidos; la validación en tiempo de ejecución de todo lo
 * que envía el cliente se hace en el servidor con Zod
 * (`server/src/validation/schemas.ts`).
 */

import type { SynergyId } from './synergies';
import type { UpgradeId } from './upgrades';

export type MemberState = 'conectado' | 'listo' | 'desconectado';
export type RoomStatus = 'lobby' | 'cuenta_atras' | 'en_partida';

export interface PublicUser {
  id: string;
  username: string;
  /** URL de la imagen personalizada (generada por el servidor) o null para el aspecto predeterminado. */
  avatarUrl?: string | null;
}

export interface RoomMember {
  userId: string;
  username: string;
  state: MemberState;
  isOwner: boolean;
  avatarUrl: string | null;
}

export interface RoomSummary {
  id: string;
  name: string;
  ownerName: string;
  isPrivate: boolean;
  players: number;
  maxPlayers: number;
  status: RoomStatus;
  scoreToWin: number;
  durationMs: number;
}

/** Lista de salas versionada: el cliente descarta versiones más antiguas que la que ya tiene. */
export interface RoomListPayload {
  version: number;
  rooms: RoomSummary[];
}

export interface RoomState {
  id: string;
  name: string;
  ownerId: string;
  maxPlayers: number;
  isPrivate: boolean;
  status: RoomStatus;
  /** Puntuación para ganar (15, 25 o 30) fijada al crear la sala. */
  scoreToWin: number;
  /** Duración máxima de la partida calculada por el servidor (ms). */
  durationMs: number;
  members: RoomMember[];
  /** Hora del servidor (ms epoch) en la que termina la cuenta atrás, si existe. */
  countdownEndsAt: number | null;
}

/* ---------- Entradas del cliente (solo intenciones) ---------- */

export interface InputIntent {
  seq: number;
  /** Intención de movimiento en [-1, 1]. El servidor decide la posición real. */
  moveX: number;
  moveY: number;
  /** Ángulo de apuntado en radianes [-π, π]. */
  aim: number;
  fire: boolean;
  dash: boolean;
  /** Habilidad activa Teletransporte (tecla E). Solo intención: el servidor valida propiedad y recarga. */
  tp?: boolean;
  /** Habilidad activa Sobrecarga (tecla Q). */
  ov?: boolean;
}

export interface CreateRoomRequest {
  name: string;
  maxPlayers: number;
  isPrivate: boolean;
  accessCode?: string;
  /** 15, 25 o 30. Si se omite, 15. */
  scoreToWin?: number;
}

export interface JoinRoomRequest {
  roomId: string;
  accessCode?: string;
}

export interface ReturnToRoomRequest {
  roomId: string;
}

/** Elección de mejora: solo el hito pendiente y una de las opciones que ofreció el servidor. */
export interface ChooseUpgradeRequest {
  milestone: number;
  upgradeId: UpgradeId;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/* ---------- Estado autoritativo emitido por el servidor ---------- */

export interface MapPayload {
  seed: number;
  cols: number;
  rows: number;
  tileSize: number;
  /** Celdas codificadas como dígitos (0 suelo, 1 muro, 2 cobertura). */
  tiles: string;
}

export interface GamePlayerInfo {
  id: string;
  username: string;
  color: string;
  avatarUrl: string | null;
}

export interface GameStartPayload {
  matchId: string;
  roomId: string;
  map: MapPayload;
  players: GamePlayerInfo[];
  durationMs: number;
  scoreToWin: number;
  startedAt: number;
  serverTime: number;
  tickRate: number;
  yourId: string;
  /** Estado PRIVADO de mejoras del destinatario (restaura la elección pendiente al reconectar). */
  upgrades?: PlayerUpgradeView;
}

/* ---------- Mejoras de nave (estado privado de cada jugador) ---------- */

export interface UpgradeOfferView {
  /** Hito al que corresponde la elección (10, 20, 30…). */
  milestone: number;
  /** Exactamente dos mejoras distintas generadas por el servidor. */
  options: UpgradeId[];
}

/** Valores efectivos calculados por el servidor (solo para mostrarlos). */
export interface UpgradeStatsView {
  fireCooldownMs: number;
  damageMultiplier: number;
  projectileSpeed: number;
  projectilesPerShot: number;
  moveSpeedMultiplier: number;
  pickupRadius: number;
  shieldCapacity: number;
  droneIntervalMs: number;
}

/** Estado de las habilidades con recarga (horas del servidor en ms epoch; null si no la tiene). */
export interface AbilityStateView {
  weapon: 'bala' | 'rayo';
  beamCooldownMs: number | null;
  teleportCooldownMs: number | null;
  teleportReadyAt: number | null;
  overloadCooldownMs: number | null;
  overloadDurationMs: number | null;
  overloadUntil: number | null;
  overloadReadyAt: number | null;
}

export interface PlayerUpgradeView {
  /** Partida a la que pertenece este estado (las mejoras nunca pasan de una partida a otra). */
  matchId?: string;
  /** Progreso de mejoras (independiente de la puntuación competitiva). */
  progress: number;
  milestoneStep: number;
  nextMilestone: number;
  levels: { id: UpgradeId; level: number }[];
  pending: UpgradeOfferView | null;
  /** Hitos alcanzados que esperan a que se resuelva la elección actual. */
  queued: number;
  stats: UpgradeStatsView;
  /** Sinergias que posee (el servidor decide cuándo actúan las condicionales). */
  synergies: SynergyId[];
  abilities: AbilityStateView;
}

export interface PlayerSnapshot {
  id: string;
  x: number;
  y: number;
  aim: number;
  hp: number;
  energy: number;
  alive: boolean;
  score: number;
  kills: number;
  deaths: number;
  shards: number;
  dashing: boolean;
  protected: boolean;
  connected: boolean;
  respawnInMs: number;
  /** Escudo de energía actual y capacidad (solo si lo tiene). */
  shield?: number;
  shieldMax?: number;
  /** Ángulo de órbita del dron de apoyo (solo si lo tiene). */
  drone?: number;
  /** Está eligiendo mejora bajo protección temporal. */
  choosing?: boolean;
  /* --- Expansión 1.3: solo lo necesario para dibujar --- */
  /** Arma de rayo equipada. */
  wpn?: 'r';
  /** Sobrecarga activa / bonificación de Cazador de energía. */
  ov?: boolean;
  hunt?: boolean;
  /** Afectado por corrosión. */
  cor?: boolean;
  /** Satélites: carga restante de cada uno (0 = roto, recuperándose), ángulo base y radio de órbita. */
  sats?: number[];
  satA?: number;
  satR?: number;
  /** Contador de teletransportes (el cliente no interpola entre posiciones de saltos distintos). */
  tp?: number;
}

export interface ProjectileSnapshot {
  id: number;
  x: number;
  y: number;
  ownerId: string;
  /** Tipo visual: pesado 'p', dron 'd', fragmento 'f', fragmento eléctrico 'e', corrosivo 'c', rebotador 'b'. Ausente = normal. */
  k?: 'p' | 'd' | 'f' | 'e' | 'c' | 'b';
}

export interface ShardSnapshot {
  id: number;
  x: number;
  y: number;
}

export interface GameSnapshot {
  /** Partida a la que pertenece (el cliente descarta instantáneas de otra partida). */
  matchId?: string;
  tick: number;
  serverTime: number;
  remainingMs: number;
  players: PlayerSnapshot[];
  projectiles: ProjectileSnapshot[];
  shards: ShardSnapshot[];
  /** Último número de secuencia de entrada procesado por jugador. */
  acks: Record<string, number>;
}

export type GameEvent =
  | { type: 'fire'; playerId: string; x: number; y: number; aim: number; source?: 'dron' }
  | {
      type: 'hit';
      targetId: string;
      attackerId: string;
      damage: number;
      x: number;
      y: number;
      absorbed?: number;
      /** Daño periódico (corrosión). */
      dot?: boolean;
    }
  /* --- Expansión 1.3 --- */
  | { type: 'beam'; playerId: string; x1: number; y1: number; x2: number; y2: number; hits: string[]; power: 0 | 1 | 2 }
  | { type: 'chain'; playerId: string; points: { x: number; y: number }[]; corrosive: boolean }
  | { type: 'bounce'; x: number; y: number }
  | { type: 'teleport'; playerId: string; fromX: number; fromY: number; x: number; y: number }
  | { type: 'overload'; playerId: string; active: boolean }
  | { type: 'block'; playerId: string; x: number; y: number }
  | { type: 'satellite'; playerId: string; index: number; state: 'roto' | 'restaurado'; x: number; y: number }
  | { type: 'fragment'; playerId: string; x: number; y: number; electric: boolean }
  | { type: 'kill'; killerId: string; victimId: string; x: number; y: number }
  | { type: 'pickup'; playerId: string; x: number; y: number }
  | { type: 'respawn'; playerId: string; x: number; y: number }
  | { type: 'impact'; x: number; y: number };

export interface PlayerResult {
  userId: string;
  username: string;
  rank: number;
  score: number;
  kills: number;
  deaths: number;
  shards: number;
  survivalMs: number;
  longestLifeMs: number;
  kdr: number;
  won: boolean;
}

export interface MatchResult {
  matchId: string;
  roomId: string;
  durationMs: number;
  /** Configuración con la que se jugó. */
  scoreToWin: number;
  timeLimitMs: number;
  reason: 'tiempo' | 'puntuacion' | 'abandono';
  winnerId: string | null;
  /** Criterio que decidió el primer puesto si hubo empate a puntos (null si no hubo empate). */
  tiebreak: 'eliminaciones' | 'muertes' | 'supervivencia' | 'orden_de_ingreso' | null;
  players: PlayerResult[];
  persisted: boolean;
}

export interface ServerError {
  code: string;
  message: string;
  event?: string;
}

/* ---------- Mapa de eventos para tipar Socket.IO ---------- */

export interface ClientToServerEvents {
  'room:list': (ack: (res: AckResponse<RoomListPayload>) => void) => void;
  'room:current': (ack: (res: AckResponse<RoomState | null>) => void) => void;
  'room:return': (req: ReturnToRoomRequest, ack: (res: AckResponse<RoomState>) => void) => void;
  'room:create': (req: CreateRoomRequest, ack: (res: AckResponse<RoomState>) => void) => void;
  'room:join': (req: JoinRoomRequest, ack: (res: AckResponse<RoomState>) => void) => void;
  'room:leave': (ack: (res: AckResponse) => void) => void;
  'room:ready': (req: { ready: boolean }, ack: (res: AckResponse<RoomState>) => void) => void;
  'game:input': (input: InputIntent) => void;
  'game:upgrade:choose': (req: ChooseUpgradeRequest, ack: (res: AckResponse<PlayerUpgradeView>) => void) => void;
  'net:ping': (req: { t: number }, ack: (res: { t: number; serverTime: number }) => void) => void;
}

export interface ServerToClientEvents {
  'session:ready': (data: { user: PublicUser; roomId: string | null; serverTime: number }) => void;
  'session:replaced': () => void;
  'rooms:changed': (payload: RoomListPayload) => void;
  'room:state': (state: RoomState) => void;
  'room:closed': (data: { roomId: string; reason: string }) => void;
  'game:start': (payload: GameStartPayload) => void;
  'game:snapshot': (snapshot: GameSnapshot) => void;
  'game:event': (event: GameEvent) => void;
  'game:end': (result: MatchResult) => void;
  'player:appearance': (data: { playerId: string; avatarUrl: string | null }) => void;
  /** Solo al jugador afectado: progreso, elección pendiente y mejoras activas. */
  'game:upgrades': (view: PlayerUpgradeView) => void;
  'error:event': (error: ServerError) => void;
}

export const PLAYER_COLORS = [
  '#2ee6ff',
  '#ff2fb3',
  '#9b6bff',
  '#3d8bff',
  '#3dffc4',
  '#ffb22e',
  '#ff5470',
  '#e2f0ff',
] as const;
