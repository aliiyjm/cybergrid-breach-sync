import { GAME } from './constants';
import { SYNERGY_CATALOG, computeSynergies, type SynergyId } from './synergies';

/**
 * Catálogo centralizado de mejoras de nave y reglas de combinación.
 *
 * - El SERVIDOR usa `computeLoadout()` para obtener los parámetros reales de
 *   cada jugador (cadencia, proyectiles, daño, velocidad, escudo, dron, imán).
 * - El CLIENTE solo usa el catálogo para mostrar nombre, descripción, icono y
 *   categoría; nunca decide efectos.
 *
 * Para equilibrar el juego basta con cambiar los valores de `UPGRADE_CATALOG`,
 * `PROGRESSION` y `UPGRADE_LIMITS`: todo lo demás se deriva de aquí.
 */

export const UPGRADE_IDS = [
  'doble_canon',
  'triple_disparo',
  'municion_pesada',
  'disparo_acelerado',
  'proyectiles_veloces',
  'escudo_energia',
  'propulsores',
  'canones_laterales',
  'dron_apoyo',
  'iman_energia',
  // Expansión 1.3 (se añaden; las diez originales no cambian).
  'bala_rebotadora',
  'rayo_perforante',
  'satelites',
  'teletransporte',
  'municion_corrosiva',
  'sobrecarga',
  'cadena_electrica',
  'bala_fragmentada',
] as const;

export type UpgradeId = (typeof UPGRADE_IDS)[number];
export type UpgradeCategory = 'ataque' | 'defensa' | 'movilidad' | 'utilidad';
export type UpgradeRarity = 'comun' | 'rara' | 'epica';
/** pasiva: siempre activa · activa: se usa con una tecla (E / Q) · arma: sustituye el disparo normal. */
export type UpgradeType = 'pasiva' | 'activa' | 'arma';
/** Nivel adquirido de cada mejora (ausente = 0). */
export type UpgradeLevels = Partial<Record<UpgradeId, number>>;

export const UPGRADE_CATEGORY_LABEL: Record<UpgradeCategory, string> = {
  ataque: 'Ataque',
  defensa: 'Defensa',
  movilidad: 'Movilidad',
  utilidad: 'Utilidad',
};

export const UPGRADE_RARITY_LABEL: Record<UpgradeRarity, string> = {
  comun: 'Común',
  rara: 'Rara',
  epica: 'Épica',
};

/** Peso relativo de cada rareza al generar opciones. */
export const UPGRADE_TYPE_LABEL: Record<UpgradeType, string> = {
  pasiva: 'Pasiva',
  activa: 'Activa',
  arma: 'Arma',
};

export const RARITY_WEIGHT: Record<UpgradeRarity, number> = { comun: 3, rara: 2, epica: 1 };

/** Progresión de mejoras: independiente de la puntuación competitiva. */
export const PROGRESSION = {
  /** Cada cuántos puntos de progreso hay un hito (10, 20, 30…). */
  MILESTONE_STEP: 10,
  /** Progreso por fragmento recogido (la puntuación competitiva sigue siendo +1). */
  PROGRESS_PER_SHARD: 2,
  /** Progreso por eliminación (la puntuación competitiva sigue siendo +3). */
  PROGRESS_PER_KILL: 4,
  /** Opciones mostradas en cada elección. */
  OPTIONS_PER_CHOICE: 2,
  /** Protección mientras se elige: duración máxima (ms). Termina antes si elige o dispara. */
  CHOICE_PROTECTION_MS: 2000,
  /** Tiempo mínimo entre dos protecciones de elección (ms): evita encadenarlas. */
  CHOICE_PROTECTION_COOLDOWN_MS: 10_000,
} as const;

/** Límites explícitos tras combinar mejoras: ninguna combinación puede superarlos. */
export const UPGRADE_LIMITS = {
  MIN_FIRE_COOLDOWN_MS: 150,
  MAX_FIRE_COOLDOWN_MS: 600,
  MAX_DAMAGE_MULTIPLIER: 2,
  MAX_PROJECTILE_SPEED: 1000,
  /** Velocidad de movimiento máxima respecto a la base (×1,2 = +20 %). */
  MAX_MOVE_SPEED_MULTIPLIER: 1.2,
  MAX_PROJECTILES_PER_VOLLEY: 5,
  /** Suma máxima de los factores de daño de una ráfaga (1 = un disparo normal). */
  MAX_VOLLEY_DAMAGE_FACTOR: 2,
  MAX_PICKUP_RADIUS: 70,
  MAX_SHIELD_CAPACITY: 40,
  MIN_DRONE_INTERVAL_MS: 800,
  MAX_DRONE_DAMAGE: 12,
  /** Proyectiles vivos como máximo en toda la partida (protección contra bucles de disparo). */
  MAX_ACTIVE_PROJECTILES: 400,
  /* --- Expansión 1.3 --- */
  MAX_BOUNCES: 3,
  MAX_BEAM_DAMAGE: 48,
  MIN_BEAM_COOLDOWN_MS: 400,
  MAX_BEAM_RANGE: 650,
  MAX_BEAM_TARGETS: 4,
  MAX_SATELLITES: 3,
  MAX_SATELLITE_CAPACITY: 40,
  MAX_TELEPORT_DISTANCE: 220,
  MIN_TELEPORT_COOLDOWN_MS: 3000,
  MAX_CORROSION_TICK_DAMAGE: 5,
  MAX_CORROSION_DURATION_MS: 4000,
  MIN_CORROSION_TICK_MS: 250,
  MAX_OVERLOAD_MULTIPLIER: 1.5,
  MIN_OVERLOAD_COOLDOWN_MS: 8000,
  MAX_OVERLOAD_DURATION_MS: 6000,
  MAX_CHAIN_JUMPS: 3,
  /** Cadenas eléctricas resueltas como máximo por paso de simulación (toda la partida). */
  MAX_CHAINS_PER_TICK: 12,
  MAX_FRAGMENTS_PER_SPLIT: 5,
  MAX_ACTIVE_FRAGMENTS: 90,
} as const;

interface UpgradeBase<P> {
  id: UpgradeId;
  name: string;
  description: string;
  /** Trazado SVG (viewBox 0 0 24 24, solo trazo) para el icono. */
  icon: string;
  category: UpgradeCategory;
  rarity: UpgradeRarity;
  type: UpgradeType;
  /** 'bala': solo útil con el arma de balas (no se ofrece si el rayo está equipado). */
  requiresWeapon: 'bala' | null;
  maxLevel: number;
  /** Mejoras con las que no se puede combinar (no se ofrecen si ya tienes alguna). */
  incompatibleWith: readonly UpgradeId[];
  params: P;
}

export const UPGRADE_CATALOG = {
  doble_canon: {
    id: 'doble_canon',
    name: 'Doble cañón',
    description: 'Cada disparo lanza dos proyectiles en paralelo (60 % de daño cada uno).',
    icon: 'M8 21V4M16 21V4M6 7l2-3 2 3M14 7l2-3 2 3',
    category: 'ataque',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: ['triple_disparo'],
    params: { spacing: 7, damageFactor: 0.6 },
  },
  triple_disparo: {
    id: 'triple_disparo',
    name: 'Triple disparo',
    description: 'Tres proyectiles en abanico de ±12° (50 % de daño cada uno).',
    icon: 'M12 21V4M12 21 6 5M12 21l6-16',
    category: 'ataque',
    rarity: 'rara',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: ['doble_canon'],
    params: { spreadDeg: 12, damageFactor: 0.5 },
  },
  municion_pesada: {
    id: 'municion_pesada',
    name: 'Munición pesada',
    description: '+60 % de daño por proyectil, pero disparas un 50 % más lento.',
    icon: 'M12 4a8 8 0 1 0 0.01 0ZM12 9a3 3 0 1 0 0.01 0Z',
    category: 'ataque',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: [],
    params: { damageMultiplier: 1.6, cooldownMultiplier: 1.5 },
  },
  disparo_acelerado: {
    id: 'disparo_acelerado',
    name: 'Disparo acelerado',
    description: 'Reduce un 15 % el intervalo entre disparos (2 niveles).',
    icon: 'M4 6l6 6-6 6M12 6l6 6-6 6',
    category: 'ataque',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 2,
    incompatibleWith: [],
    params: { cooldownMultiplierPerLevel: 0.85 },
  },
  proyectiles_veloces: {
    id: 'proyectiles_veloces',
    name: 'Proyectiles veloces',
    description: 'Tus balas viajan un 20 % más rápido (2 niveles).',
    icon: 'M3 8h5M2 12h8M3 16h5M12 12h9M17 8l4 4-4 4',
    category: 'ataque',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 2,
    incompatibleWith: [],
    params: { speedMultiplierPerLevel: 1.2 },
  },
  escudo_energia: {
    id: 'escudo_energia',
    name: 'Escudo de energía',
    description: 'Absorbe 30 de daño. Se recarga tras 4 s sin recibir impactos.',
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z',
    category: 'defensa',
    rarity: 'rara',
    type: 'pasiva',
    requiresWeapon: null,
    maxLevel: 1,
    incompatibleWith: [],
    params: { capacity: 30, rechargeDelayMs: 4000, rechargePerSecond: 15 },
  },
  propulsores: {
    id: 'propulsores',
    name: 'Propulsores mejorados',
    description: '+10 % de velocidad de movimiento (2 niveles, máximo +20 %).',
    icon: 'M8 4h8l-1 8H9ZM9 15l3 6 3-6',
    category: 'movilidad',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: null,
    maxLevel: 2,
    incompatibleWith: [],
    params: { speedBonusPerLevel: 0.1 },
  },
  canones_laterales: {
    id: 'canones_laterales',
    name: 'Cañones laterales',
    description: 'Añade dos disparos diagonales a ±45° (40 % de daño cada uno).',
    icon: 'M12 21V9M12 15 5 8M12 15l7-7',
    category: 'ataque',
    rarity: 'rara',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: [],
    params: { angleDeg: 45, damageFactor: 0.4 },
  },
  dron_apoyo: {
    id: 'dron_apoyo',
    name: 'Dron de apoyo',
    description: 'Un dron orbita tu nave y dispara al rival visible más cercano cada 1,2 s (8 de daño).',
    icon: 'M12 9a3 3 0 1 0 0.01 0ZM6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5M3 5h6M15 5h6M3 19h6M15 19h6',
    category: 'utilidad',
    rarity: 'epica',
    type: 'pasiva',
    requiresWeapon: null,
    maxLevel: 1,
    incompatibleWith: [],
    params: { intervalMs: 1200, damage: 8, range: 380, projectileSpeed: 650, orbitRadius: 30, orbitSpeed: 2.2 },
  },
  iman_energia: {
    id: 'iman_energia',
    name: 'Imán de energía',
    description: 'Recoges fragmentos desde 20 px más lejos (2 niveles).',
    icon: 'M6 3v9a6 6 0 0 0 12 0V3M6 7h4M14 7h4',
    category: 'utilidad',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: null,
    maxLevel: 2,
    incompatibleWith: [],
    params: { radiusBonusPerLevel: 20 },
  },

  /* ------------------------------ Expansión 1.3 ------------------------------ */

  bala_rebotadora: {
    id: 'bala_rebotadora',
    name: 'Bala rebotadora',
    description: 'Tu bala central rebota hasta 2 veces en las paredes. No crea balas nuevas.',
    icon: 'M3 18 9 6l6 12 6-12',
    category: 'ataque',
    rarity: 'rara',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: [],
    params: { maxBounces: 2 },
  },
  rayo_perforante: {
    id: 'rayo_perforante',
    name: 'Rayo perforante',
    description: 'Sustituye tus balas por un rayo láser instantáneo que atraviesa hasta 4 enemigos (30 de daño, recarga 0,5 s, alcance 520 px).',
    icon: 'M3 12h13M16 8l5 4-5 4M7 8v8',
    category: 'ataque',
    rarity: 'epica',
    type: 'arma',
    requiresWeapon: null,
    maxLevel: 1,
    incompatibleWith: [],
    params: { damage: 30, cooldownMs: 500, range: 520, halfWidth: 5, maxTargets: 4 },
  },
  satelites: {
    id: 'satelites',
    name: 'Satélites protectores',
    description: 'Dos satélites blindados orbitan tu nave y bloquean balas enemigas (20 de daño cada uno; se recuperan en 8 s). Nivel 2: tres satélites.',
    icon: 'M12 10a2 2 0 1 0 0.01 0ZM3 4h6v4l-3 2.5L3 8ZM15 14h6v4l-3 2.5-3-2.5Z',
    category: 'defensa',
    rarity: 'rara',
    type: 'pasiva',
    requiresWeapon: null,
    maxLevel: 2,
    incompatibleWith: [],
    params: { count: 2, extraPerLevel: 1, capacity: 20, radius: 8, orbitRadius: 36, orbitSpeed: -1.6, recoverMs: 8000 },
  },
  teletransporte: {
    id: 'teletransporte',
    name: 'Teletransporte corto',
    description: 'Tecla E (o botón): saltas al instante hasta 160 px hacia donde apuntas, sin atravesar paredes. Recarga 5 s.',
    icon: 'M5 19 19 5M13 5h6v6M5 13v6h6',
    category: 'movilidad',
    rarity: 'rara',
    type: 'activa',
    requiresWeapon: null,
    maxLevel: 1,
    incompatibleWith: [],
    params: { distance: 160, cooldownMs: 5000 },
  },
  municion_corrosiva: {
    id: 'municion_corrosiva',
    name: 'Munición corrosiva',
    description: 'Tus balas corroen al enemigo: 3 de daño cada 0,5 s durante 3 s. Un nuevo impacto renueva la duración, no suma daño.',
    icon: 'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11Z',
    category: 'ataque',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: [],
    params: { tickDamage: 3, tickMs: 500, durationMs: 3000 },
  },
  sobrecarga: {
    id: 'sobrecarga',
    name: 'Sobrecarga',
    description: 'Tecla Q (o botón): +30 % de daño de tu arma durante 4 s. Recarga 15 s.',
    icon: 'M13 2 4 14h7l-1 8 9-12h-7Z',
    category: 'ataque',
    rarity: 'rara',
    type: 'activa',
    requiresWeapon: null,
    maxLevel: 1,
    incompatibleWith: [],
    params: { durationMs: 4000, cooldownMs: 15000, damageMultiplier: 1.3 },
  },
  cadena_electrica: {
    id: 'cadena_electrica',
    name: 'Cadena eléctrica',
    description: 'Al impactar, un arco salta a 2 enemigos cercanos más (50 % y 30 % del daño). Nunca repite objetivo.',
    icon: 'M5 4l4 6-3 3 5 7M14 4l4 6-3 3',
    category: 'ataque',
    rarity: 'rara',
    type: 'pasiva',
    requiresWeapon: null,
    maxLevel: 1,
    incompatibleWith: [],
    params: { jumps: 2, radius: 170, firstFactor: 0.5, decay: 0.6 },
  },
  bala_fragmentada: {
    id: 'bala_fragmentada',
    name: 'Bala fragmentada',
    description: 'Al impactar, la bala se divide en 3 fragmentos (35 % del daño, 160 px de alcance). Los fragmentos no se dividen.',
    icon: 'M12 13 6 7M12 13l6-6M12 13v8M12 3a2 2 0 1 0 0.01 0Z',
    category: 'ataque',
    rarity: 'comun',
    type: 'pasiva',
    requiresWeapon: 'bala',
    maxLevel: 1,
    incompatibleWith: [],
    params: { count: 3, spreadDeg: 30, damageFactor: 0.35, range: 160, speed: 560 },
  },
} as const satisfies { [K in UpgradeId]: UpgradeBase<Record<string, number>> & { id: K } };

export type UpgradeDefinition = (typeof UPGRADE_CATALOG)[UpgradeId];

export function isUpgradeId(value: unknown): value is UpgradeId {
  return typeof value === 'string' && (UPGRADE_IDS as readonly string[]).includes(value);
}

export function upgradeLevel(levels: UpgradeLevels, id: UpgradeId): number {
  const raw = levels[id] ?? 0;
  const def = UPGRADE_CATALOG[id];
  return Number.isFinite(raw) ? Math.max(0, Math.min(def.maxLevel, Math.floor(raw))) : 0;
}

/**
 * ¿Se puede ofrecer esta mejora con el equipamiento actual?
 * No si ya está al nivel máximo o es incompatible con alguna que ya tienes.
 */
export function canOfferUpgrade(levels: UpgradeLevels, id: UpgradeId): boolean {
  const def = UPGRADE_CATALOG[id];
  if (upgradeLevel(levels, id) >= def.maxLevel) return false;
  // Con el rayo equipado, las mejoras exclusivas de las balas serían opciones inútiles.
  if (def.requiresWeapon === 'bala' && upgradeLevel(levels, 'rayo_perforante') > 0) return false;
  return !(def.incompatibleWith as readonly UpgradeId[]).some((other) => upgradeLevel(levels, other) > 0);
}

/* ------------------------------ Efectos combinados ------------------------------ */

export interface VolleyShot {
  /** Desviación respecto al ángulo de apuntado (rad). */
  angle: number;
  /** Desplazamiento lateral del cañón (px, perpendicular al apuntado). */
  offset: number;
  /** Fracción del daño de un disparo normal. */
  damageFactor: number;
  /** Rebotes permitidos a ESTE proyectil (0 = no rebota). */
  bounces: number;
}

export interface BeamConfig {
  damage: number;
  cooldownMs: number;
  range: number;
  halfWidth: number;
  maxTargets: number;
}

export interface SatelliteConfig {
  count: number;
  capacity: number;
  /** Capacidad extra mientras el escudo tiene carga (Defensa orbital; 0 sin la sinergia). */
  shieldBonus: number;
  radius: number;
  orbitRadius: number;
  orbitSpeed: number;
  recoverMs: number;
  /** Escudo reactivo: órbita ampliada tras teletransportarse (null sin la sinergia). */
  reactive: { orbitRadius: number; durationMs: number } | null;
}

export interface TeleportConfig {
  distance: number;
  cooldownMs: number;
}

export interface CorrosionConfig {
  tickDamage: number;
  tickMs: number;
  durationMs: number;
  /** Cañón corrosivo: la munición pesada también corroe (con este daño por pulso). */
  heavyTickDamage: number | null;
  /** Reacción corrosiva: contagio débil por la cadena eléctrica. */
  spread: { tickDamage: number; durationMs: number; maxTargets: number } | null;
}

export interface OverloadConfig {
  durationMs: number;
  cooldownMs: number;
  damageMultiplier: number;
  /** Multiplicador del rayo (Rayo sobrecargado lo eleva). */
  beamMultiplier: number;
  /** Cazador de energía: bonificación tras teletransportarse (null sin la sinergia). */
  hunter: { damageMultiplier: number; durationMs: number } | null;
}

export interface ChainConfig {
  jumps: number;
  radius: number;
  firstFactor: number;
  decay: number;
  /** Cadena de fragmentos (null sin la sinergia). */
  fromFragments: { jumpsPerFragment: number; budgetPerBullet: number } | null;
  /** Cadena perforante (null sin la sinergia). */
  fromBeam: boolean;
}

export interface FragmentConfig {
  count: number;
  spreadDeg: number;
  damageFactor: number;
  range: number;
  speed: number;
  /** Fragmentación eléctrica: heredan la Sobrecarga de su bala (una vez). */
  inheritOverload: boolean;
}

export interface ShieldConfig {
  capacity: number;
  rechargeDelayMs: number;
  rechargePerSecond: number;
}

export interface DroneConfig {
  intervalMs: number;
  damage: number;
  range: number;
  projectileSpeed: number;
  orbitRadius: number;
  orbitSpeed: number;
}

/** Parámetros efectivos de una nave tras aplicar sus mejoras. */
export interface Loadout {
  fireCooldownMs: number;
  damageMultiplier: number;
  projectileSpeed: number;
  projectileKind: 'normal' | 'pesado';
  volley: VolleyShot[];
  moveSpeedMultiplier: number;
  pickupRadius: number;
  shield: ShieldConfig | null;
  drone: DroneConfig | null;
  /* --- Expansión 1.3 --- */
  /** Arma equipada: el rayo sustituye al disparo normal (la configuración de balas se conserva). */
  weapon: 'bala' | 'rayo';
  beam: BeamConfig | null;
  satellites: SatelliteConfig | null;
  teleport: TeleportConfig | null;
  corrosion: CorrosionConfig | null;
  overload: OverloadConfig | null;
  chain: ChainConfig | null;
  fragments: FragmentConfig | null;
  /** Sinergias que posee (las condicionales solo actúan cuando se cumple su condición). */
  synergies: SynergyId[];
}

const DEG = Math.PI / 180;
const BASE_PICKUP_RADIUS = GAME.PLAYER_RADIUS + GAME.SHARD_RADIUS;

const clampFinite = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/**
 * Combina las mejoras de un jugador con reglas deterministas:
 *  - Cadencia: base × pesada × acelerado^nivel, limitada a [150, 600] ms.
 *  - Daño: base × pesada (≤ ×2). La racha de eliminaciones se aplica aparte.
 *  - Velocidad de bala: base × veloces^nivel (≤ 1000 px/s).
 *  - Patrón: simple, doble (paralelo) o triple (abanico) — doble y triple son
 *    incompatibles — más dos diagonales si hay cañones laterales. Si la suma
 *    de factores supera MAX_VOLLEY_DAMAGE_FACTOR, se reescala para no superarla.
 *  - Movimiento: 1 + suma de bonificaciones (≤ ×1,2).
 *  - Imán: radio base + bonificación (≤ 70 px).
 * Sin mejoras devuelve exactamente los valores del juego original.
 */
export function computeLoadout(levels: UpgradeLevels): Loadout {
  const lv = (id: UpgradeId) => upgradeLevel(levels, id);
  const C = UPGRADE_CATALOG;
  const L = UPGRADE_LIMITS;

  let cooldown: number = GAME.FIRE_COOLDOWN_MS;
  let damage = 1;
  if (lv('municion_pesada') > 0) {
    cooldown *= C.municion_pesada.params.cooldownMultiplier;
    damage *= C.municion_pesada.params.damageMultiplier;
  }
  cooldown *= C.disparo_acelerado.params.cooldownMultiplierPerLevel ** lv('disparo_acelerado');

  const speed = GAME.PROJECTILE_SPEED * C.proyectiles_veloces.params.speedMultiplierPerLevel ** lv('proyectiles_veloces');

  // Patrón frontal (doble y triple son mutuamente excluyentes; si por error
  // llegaran ambos, gana el triple de forma determinista).
  let volley: VolleyShot[];
  if (lv('triple_disparo') > 0) {
    const s = C.triple_disparo.params.spreadDeg * DEG;
    const f = C.triple_disparo.params.damageFactor;
    volley = [-s, 0, s].map((angle) => ({ angle, offset: 0, damageFactor: f, bounces: 0 }));
  } else if (lv('doble_canon') > 0) {
    const o = C.doble_canon.params.spacing;
    const f = C.doble_canon.params.damageFactor;
    volley = [-o, o].map((offset) => ({ angle: 0, offset, damageFactor: f, bounces: 0 }));
  } else {
    volley = [{ angle: 0, offset: 0, damageFactor: 1, bounces: 0 }];
  }
  if (lv('canones_laterales') > 0) {
    const a = C.canones_laterales.params.angleDeg * DEG;
    const f = C.canones_laterales.params.damageFactor;
    volley.push({ angle: -a, offset: 0, damageFactor: f, bounces: 0 }, { angle: a, offset: 0, damageFactor: f, bounces: 0 });
  }
  // Bala rebotadora: solo las balas frontales centrales (ángulo 0). Con Tormenta
  // de rebotes (+ Triple disparo) rebotan las tres del abanico; las laterales nunca.
  const synergies = computeSynergies(levels);
  const has = (id: SynergyId) => synergies.includes(id);
  if (lv('bala_rebotadora') > 0) {
    const n = Math.min(L.MAX_BOUNCES, Math.max(0, Math.floor(C.bala_rebotadora.params.maxBounces)));
    const lateralAngle = C.canones_laterales.params.angleDeg * DEG;
    for (const shot of volley) {
      const isLateral = lv('canones_laterales') > 0 && Math.abs(Math.abs(shot.angle) - lateralAngle) < 1e-9;
      if (shot.angle === 0 || (has('tormenta_rebotes') && !isLateral)) shot.bounces = n;
    }
  }
  volley = volley.slice(0, L.MAX_PROJECTILES_PER_VOLLEY);
  const total = volley.reduce((sum, shot) => sum + shot.damageFactor, 0);
  if (total > L.MAX_VOLLEY_DAMAGE_FACTOR) {
    const k = L.MAX_VOLLEY_DAMAGE_FACTOR / total;
    volley = volley.map((shot) => ({ ...shot, damageFactor: shot.damageFactor * k }));
  }

  const moveMultiplier = 1 + C.propulsores.params.speedBonusPerLevel * lv('propulsores');
  const pickup = BASE_PICKUP_RADIUS + C.iman_energia.params.radiusBonusPerLevel * lv('iman_energia');

  const shieldP = C.escudo_energia.params;
  const droneP = C.dron_apoyo.params;

  return {
    fireCooldownMs: clampFinite(cooldown, L.MIN_FIRE_COOLDOWN_MS, L.MAX_FIRE_COOLDOWN_MS, GAME.FIRE_COOLDOWN_MS),
    damageMultiplier: clampFinite(damage, 0.1, L.MAX_DAMAGE_MULTIPLIER, 1),
    projectileSpeed: clampFinite(speed, 100, L.MAX_PROJECTILE_SPEED, GAME.PROJECTILE_SPEED),
    projectileKind: lv('municion_pesada') > 0 ? 'pesado' : 'normal',
    volley,
    moveSpeedMultiplier: clampFinite(moveMultiplier, 1, L.MAX_MOVE_SPEED_MULTIPLIER, 1),
    pickupRadius: clampFinite(pickup, BASE_PICKUP_RADIUS, L.MAX_PICKUP_RADIUS, BASE_PICKUP_RADIUS),
    shield:
      lv('escudo_energia') > 0
        ? {
            capacity: clampFinite(shieldP.capacity, 1, L.MAX_SHIELD_CAPACITY, 30),
            rechargeDelayMs: clampFinite(shieldP.rechargeDelayMs, 1000, 30_000, 4000),
            rechargePerSecond: clampFinite(shieldP.rechargePerSecond, 1, 100, 15),
          }
        : null,
    ...expansionLoadout(levels, synergies),
    drone:
      lv('dron_apoyo') > 0
        ? {
            intervalMs: clampFinite(droneP.intervalMs, L.MIN_DRONE_INTERVAL_MS, 10_000, 1200),
            damage: clampFinite(droneP.damage, 1, L.MAX_DRONE_DAMAGE, 8),
            range: clampFinite(droneP.range, 50, GAME.PROJECTILE_RANGE, 380),
            projectileSpeed: clampFinite(droneP.projectileSpeed, 100, L.MAX_PROJECTILE_SPEED, 650),
            orbitRadius: clampFinite(droneP.orbitRadius, GAME.PLAYER_RADIUS, 60, 30),
            orbitSpeed: clampFinite(droneP.orbitSpeed, 0, 10, 2.2),
          }
        : null,
  };
}

/* ------------------------------ Expansión 1.3 ------------------------------ */

/** Parámetro numérico de una sinergia, leído del catálogo central (shared/synergies.ts). */
const SYN = (id: SynergyId, key: string, fallback: number): number => {
  const value = SYNERGY_CATALOG[id].params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

function expansionLoadout(
  levels: UpgradeLevels,
  synergies: SynergyId[],
): Pick<Loadout, 'weapon' | 'beam' | 'satellites' | 'teleport' | 'corrosion' | 'overload' | 'chain' | 'fragments' | 'synergies'> {
  const lv = (id: UpgradeId) => upgradeLevel(levels, id);
  const has = (id: SynergyId) => synergies.includes(id);
  const C = UPGRADE_CATALOG;
  const L = UPGRADE_LIMITS;

  const b = C.rayo_perforante.params;
  const beam: BeamConfig | null =
    lv('rayo_perforante') > 0
      ? {
          damage: clampFinite(b.damage, 1, L.MAX_BEAM_DAMAGE, 30),
          cooldownMs: clampFinite(b.cooldownMs, L.MIN_BEAM_COOLDOWN_MS, 5000, 500),
          range: clampFinite(b.range, 50, L.MAX_BEAM_RANGE, 520),
          halfWidth: clampFinite(b.halfWidth, 1, 12, 5),
          maxTargets: Math.floor(clampFinite(b.maxTargets, 1, L.MAX_BEAM_TARGETS, 4)),
        }
      : null;

  const sp = C.satelites.params;
  const satellites: SatelliteConfig | null =
    lv('satelites') > 0
      ? {
          count: Math.floor(clampFinite(sp.count + sp.extraPerLevel * (lv('satelites') - 1), 1, L.MAX_SATELLITES, 2)),
          capacity: clampFinite(sp.capacity, 1, L.MAX_SATELLITE_CAPACITY, 20),
          shieldBonus: has('defensa_orbital') ? clampFinite(SYN('defensa_orbital', 'capacityBonus', 6), 0, 10, 6) : 0,
          radius: clampFinite(sp.radius, 4, 14, 8),
          orbitRadius: clampFinite(sp.orbitRadius, GAME.PLAYER_RADIUS + 8, 60, 36),
          orbitSpeed: clampFinite(sp.orbitSpeed, -6, 6, -1.6),
          recoverMs: clampFinite(sp.recoverMs, 1000, 60_000, 8000),
          reactive: has('escudo_reactivo')
            ? {
                orbitRadius: clampFinite(SYN('escudo_reactivo', 'orbitRadius', 50), GAME.PLAYER_RADIUS + 8, 70, 50),
                durationMs: clampFinite(SYN('escudo_reactivo', 'durationMs', 1200), 100, 3000, 1200),
              }
            : null,
        }
      : null;

  const tp = C.teletransporte.params;
  const teleport: TeleportConfig | null =
    lv('teletransporte') > 0
      ? {
          distance: clampFinite(tp.distance, 40, L.MAX_TELEPORT_DISTANCE, 160),
          cooldownMs: clampFinite(tp.cooldownMs, L.MIN_TELEPORT_COOLDOWN_MS, 60_000, 5000),
        }
      : null;

  const cp = C.municion_corrosiva.params;
  const tick = (v: number, d: number) => clampFinite(v, 1, L.MAX_CORROSION_TICK_DAMAGE, d);
  const corrosion: CorrosionConfig | null =
    lv('municion_corrosiva') > 0
      ? {
          tickDamage: tick(cp.tickDamage, 3),
          tickMs: clampFinite(cp.tickMs, L.MIN_CORROSION_TICK_MS, 2000, 500),
          durationMs: clampFinite(cp.durationMs, 500, L.MAX_CORROSION_DURATION_MS, 3000),
          heavyTickDamage: has('canon_corrosivo') ? tick(SYN('canon_corrosivo', 'tickDamage', 4), 4) : null,
          spread: has('reaccion_corrosiva')
            ? {
                tickDamage: tick(SYN('reaccion_corrosiva', 'tickDamage', 2), 2),
                durationMs: clampFinite(SYN('reaccion_corrosiva', 'durationMs', 1500), 250, L.MAX_CORROSION_DURATION_MS, 1500),
                maxTargets: Math.floor(clampFinite(SYN('reaccion_corrosiva', 'maxTargets', 2), 1, 3, 2)),
              }
            : null,
        }
      : null;

  const op = C.sobrecarga.params;
  const overMult = clampFinite(op.damageMultiplier, 1, L.MAX_OVERLOAD_MULTIPLIER, 1.3);
  const overload: OverloadConfig | null =
    lv('sobrecarga') > 0
      ? {
          durationMs: clampFinite(op.durationMs, 500, L.MAX_OVERLOAD_DURATION_MS, 4000),
          cooldownMs: clampFinite(op.cooldownMs, L.MIN_OVERLOAD_COOLDOWN_MS, 120_000, 15000),
          damageMultiplier: overMult,
          beamMultiplier: has('rayo_sobrecargado')
            ? clampFinite(SYN('rayo_sobrecargado', 'beamMultiplier', 1.4), 1, L.MAX_OVERLOAD_MULTIPLIER, 1.4)
            : overMult,
          hunter: has('cazador_energia')
            ? {
                damageMultiplier: clampFinite(SYN('cazador_energia', 'damageMultiplier', 1.1), 1, 1.2, 1.1),
                durationMs: clampFinite(SYN('cazador_energia', 'durationMs', 1500), 100, 3000, 1500),
              }
            : null,
        }
      : null;

  const ch = C.cadena_electrica.params;
  const chain: ChainConfig | null =
    lv('cadena_electrica') > 0
      ? {
          jumps: Math.floor(clampFinite(ch.jumps, 1, L.MAX_CHAIN_JUMPS, 2)),
          radius: clampFinite(ch.radius, 40, 300, 170),
          firstFactor: clampFinite(ch.firstFactor, 0.05, 0.8, 0.5),
          decay: clampFinite(ch.decay, 0.1, 0.9, 0.6),
          fromFragments: has('cadena_fragmentos')
            ? {
                jumpsPerFragment: Math.floor(clampFinite(SYN('cadena_fragmentos', 'jumpsPerFragment', 1), 1, 2, 1)),
                budgetPerBullet: Math.floor(clampFinite(SYN('cadena_fragmentos', 'budgetPerBullet', 2), 1, 4, 2)),
              }
            : null,
          fromBeam: has('cadena_perforante'),
        }
      : null;

  const fp = C.bala_fragmentada.params;
  const fragments: FragmentConfig | null =
    lv('bala_fragmentada') > 0
      ? {
          count: Math.floor(clampFinite(fp.count, 1, L.MAX_FRAGMENTS_PER_SPLIT, 3)),
          spreadDeg: clampFinite(fp.spreadDeg, 5, 80, 30),
          damageFactor: clampFinite(fp.damageFactor, 0.05, 0.6, 0.35),
          range: clampFinite(fp.range, 40, 300, 160),
          speed: clampFinite(fp.speed, 100, L.MAX_PROJECTILE_SPEED, 560),
          inheritOverload: has('fragmentacion_electrica'),
        }
      : null;

  return {
    weapon: beam ? 'rayo' : 'bala',
    beam,
    satellites,
    teleport,
    corrosion,
    overload,
    chain,
    fragments,
    synergies,
  };
}
