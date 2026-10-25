/**
 * Constantes de juego compartidas por servidor y cliente.
 * El servidor es la única autoridad: el cliente solo las usa para dibujar
 * (radios, tamaños) y para mostrar información, nunca para decidir resultados.
 */
export const GAME = {
  /** Frecuencia de simulación del servidor (Hz). */
  TICK_RATE: 30,
  /** Tamaño de cada celda del mapa en unidades de mundo (px). */
  TILE_SIZE: 40,
  /** Dimensiones del mapa en celdas. */
  MAP_COLS: 40,
  MAP_ROWS: 28,

  PLAYER_RADIUS: 16,
  /** Velocidad máxima de desplazamiento (px/s). */
  PLAYER_SPEED: 220,
  MAX_HP: 100,
  MAX_ENERGY: 100,
  /** Regeneración de energía (unidades/s). */
  ENERGY_REGEN: 15,

  /** Impulso (acción secundaria). */
  DASH_COST: 35,
  DASH_MULTIPLIER: 2.6,
  DASH_DURATION_MS: 180,

  /** Proyectiles. */
  FIRE_COOLDOWN_MS: 250,
  PROJECTILE_SPEED: 700,
  PROJECTILE_RANGE: 650,
  PROJECTILE_RADIUS: 4,
  BASE_DAMAGE: 20,
  /** Distancia a partir de la cual empieza la caída de daño (px). */
  FALLOFF_START: 200,
  /** Multiplicador mínimo de daño en el alcance máximo. */
  FALLOFF_MIN: 0.5,
  /** Bonificación de daño por racha de eliminaciones (por eliminación). */
  STREAK_BONUS: 0.1,
  STREAK_BONUS_MAX: 0.3,

  RESPAWN_MS: 3000,
  SPAWN_PROTECTION_MS: 1000,

  /** Fragmentos de datos (recursos recolectables). */
  SHARD_MAX_ACTIVE: 6,
  SHARD_RESPAWN_MS: 4000,
  SHARD_RADIUS: 10,
  SHARD_ENERGY: 25,
  SHARD_HEAL: 10,

  /** Puntuación. */
  SCORE_PER_KILL: 3,
  SCORE_PER_SHARD: 1,
  /** Valor de reserva; debe coincidir con DEFAULT_SCORE_TARGET (shared/matchConfig.ts). */
  SCORE_TO_WIN: 30,
  DEFAULT_MATCH_DURATION_S: 180,

  /** Cuenta atrás antes de iniciar la partida (ms). */
  START_COUNTDOWN_MS: 3000,
  /** Tiempo de gracia para reconectar antes de expulsar al jugador (ms). */
  RECONNECT_GRACE_MS: 30000,

  MIN_PLAYERS_TO_START: 2,
  MAX_ROOM_CAPACITY: 8,
} as const;

export const NET = {
  /** Retardo de interpolación aplicado a los jugadores remotos (ms). */
  INTERPOLATION_DELAY_MS: 100,
  /** Frecuencia de envío de intenciones del cliente (Hz). */
  INPUT_SEND_RATE: 30,
  /** Intervalo de ping/pong (ms). */
  PING_INTERVAL_MS: 2000,
  /** Máximo de mensajes de entrada por segundo aceptados por socket. */
  INPUT_RATE_LIMIT_PER_S: 60,
  /** Máximo de otros eventos (salas, ping) por segundo. */
  EVENT_RATE_LIMIT_PER_S: 10,
} as const;

export const TILE = {
  FLOOR: 0,
  WALL: 1,
  COVER: 2,
} as const;
export type TileType = (typeof TILE)[keyof typeof TILE];
