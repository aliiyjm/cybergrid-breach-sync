import { randomInt } from 'node:crypto';
import type { AbilityStateView, PlayerUpgradeView, UpgradeOfferView } from '../../../shared/protocol';
import {
  PROGRESSION,
  RARITY_WEIGHT,
  UPGRADE_CATALOG,
  UPGRADE_IDS,
  canOfferUpgrade,
  isUpgradeId,
  upgradeLevel,
  type Loadout,
  type UpgradeId,
  type UpgradeLevels,
} from '../../../shared/upgrades';

/**
 * Progreso y elecciones de mejoras de UN jugador en UNA partida (servidor).
 *
 * - El progreso es independiente de la puntuación competitiva.
 * - Cada hito (10, 20, 30…) se alcanza una sola vez: `nextMilestone` solo avanza.
 * - Si se alcanzan varios hitos antes de elegir, se encolan y se ofrecen de uno en uno.
 * - Las opciones las genera el servidor; elegir valida hito y opción ofrecida.
 * - Repetir una elección ya confirmada (reintento tras perder el acuse,
 *   reconexión) es idempotente: no vuelve a aplicar el efecto.
 * - El estado vive dentro de la partida y desaparece con ella.
 */

/** Fuente aleatoria en [0, 1). Inyectable para pruebas deterministas. */
export type RandomSource = () => number;

/** Fuente por defecto: criptográfica (las opciones no se pueden predecir desde el cliente). */
export const cryptoRandom: RandomSource = () => randomInt(0, 2 ** 32) / 2 ** 32;

export interface UpgradeState {
  progress: number;
  nextMilestone: number;
  queued: number[];
  pending: UpgradeOfferView | null;
  levels: UpgradeLevels;
  history: { milestone: number; upgradeId: UpgradeId }[];
  /** Hitos sin elección porque no quedaban dos mejoras disponibles. */
  skipped: number[];
}

export class UpgradeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UpgradeError';
  }
}

export function createUpgradeState(): UpgradeState {
  return {
    progress: 0,
    nextMilestone: PROGRESSION.MILESTONE_STEP,
    queued: [],
    pending: null,
    levels: {},
    history: [],
    skipped: [],
  };
}

/** Suma progreso y encola los hitos cruzados. Devuelve los hitos nuevos. */
export function addProgress(state: UpgradeState, amount: number): number[] {
  if (!Number.isFinite(amount) || amount <= 0) return [];
  state.progress += Math.floor(amount);
  const reached: number[] = [];
  while (state.progress >= state.nextMilestone) {
    reached.push(state.nextMilestone);
    state.queued.push(state.nextMilestone);
    state.nextMilestone += PROGRESSION.MILESTONE_STEP;
  }
  return reached;
}

export function eligibleUpgrades(levels: UpgradeLevels): UpgradeId[] {
  return UPGRADE_IDS.filter((id) => canOfferUpgrade(levels, id));
}

/**
 * Elige `count` mejoras DISTINTAS entre las disponibles, ponderadas por rareza,
 * sin reemplazo. Con menos de `count` disponibles devuelve las que haya.
 */
export function rollUpgradeOptions(
  levels: UpgradeLevels,
  random: RandomSource,
  count: number = PROGRESSION.OPTIONS_PER_CHOICE,
): UpgradeId[] {
  const pool = eligibleUpgrades(levels);
  const picked: UpgradeId[] = [];
  while (picked.length < count && pool.length > 0) {
    const weights = pool.map((id) => RARITY_WEIGHT[UPGRADE_CATALOG[id].rarity]);
    const total = weights.reduce((a, b) => a + b, 0);
    const raw = random();
    const r = (Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0) * total;
    let acc = 0;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      acc += weights[i] as number;
      if (r < acc) {
        index = i;
        break;
      }
    }
    picked.push(pool[index] as UpgradeId);
    pool.splice(index, 1);
  }
  return picked;
}

/**
 * Abre la siguiente elección encolada si no hay ninguna pendiente.
 * Un hito sin dos opciones posibles se descarta (queda en `skipped`).
 */
export function openNextOffer(state: UpgradeState, random: RandomSource): UpgradeOfferView | null {
  if (state.pending) return null;
  while (state.queued.length > 0) {
    const milestone = state.queued.shift() as number;
    const options = rollUpgradeOptions(state.levels, random);
    if (options.length < PROGRESSION.OPTIONS_PER_CHOICE) {
      state.skipped.push(milestone);
      continue;
    }
    state.pending = { milestone, options };
    return state.pending;
  }
  return null;
}

/**
 * Valida y aplica una elección.
 * - 'aplicada': nivel incrementado (el llamador recalcula los efectos).
 * - 'repetida': ya estaba confirmada esa misma elección; no se aplica otra vez.
 */
export function chooseUpgrade(state: UpgradeState, milestone: number, upgradeId: unknown): 'aplicada' | 'repetida' {
  if (!isUpgradeId(upgradeId)) throw new UpgradeError('MEJORA_DESCONOCIDA', 'Esa mejora no existe');
  const previous = state.history.find((h) => h.milestone === milestone);
  if (previous) {
    if (previous.upgradeId === upgradeId) return 'repetida';
    throw new UpgradeError('YA_ELEGIDA', 'Ya elegiste una mejora para este hito');
  }
  const pending = state.pending;
  if (!pending) throw new UpgradeError('SIN_ELECCION_PENDIENTE', 'No tienes ninguna mejora pendiente de elegir');
  if (pending.milestone !== milestone) {
    throw new UpgradeError('HITO_INCORRECTO', `La elección pendiente es la del hito ${pending.milestone}`);
  }
  if (!pending.options.includes(upgradeId)) {
    throw new UpgradeError('MEJORA_NO_OFRECIDA', 'Esa mejora no estaba entre las opciones ofrecidas');
  }
  // Doble comprobación: el equipamiento pudo cambiar (defensivo; con una elección a la vez no ocurre).
  if (!canOfferUpgrade(state.levels, upgradeId)) {
    throw new UpgradeError('MEJORA_NO_DISPONIBLE', 'Esa mejora ya está al máximo o no es compatible');
  }
  state.levels[upgradeId] = upgradeLevel(state.levels, upgradeId) + 1;
  state.history.push({ milestone, upgradeId });
  state.pending = null;
  return 'aplicada';
}

const NO_ABILITIES: AbilityStateView = {
  weapon: 'bala',
  beamCooldownMs: null,
  teleportCooldownMs: null,
  teleportReadyAt: null,
  overloadCooldownMs: null,
  overloadDurationMs: null,
  overloadUntil: null,
  overloadReadyAt: null,
};

export function toUpgradeView(
  state: UpgradeState,
  loadout: Loadout,
  abilities: AbilityStateView = { ...NO_ABILITIES, weapon: loadout.weapon },
): PlayerUpgradeView {
  return {
    progress: state.progress,
    milestoneStep: PROGRESSION.MILESTONE_STEP,
    nextMilestone: state.nextMilestone,
    levels: UPGRADE_IDS.filter((id) => upgradeLevel(state.levels, id) > 0).map((id) => ({
      id,
      level: upgradeLevel(state.levels, id),
    })),
    pending: state.pending ? { milestone: state.pending.milestone, options: [...state.pending.options] } : null,
    queued: state.queued.length,
    stats: {
      fireCooldownMs: Math.round(loadout.fireCooldownMs),
      damageMultiplier: Math.round(loadout.damageMultiplier * 100) / 100,
      projectileSpeed: Math.round(loadout.projectileSpeed),
      projectilesPerShot: loadout.volley.length,
      moveSpeedMultiplier: Math.round(loadout.moveSpeedMultiplier * 100) / 100,
      pickupRadius: Math.round(loadout.pickupRadius),
      shieldCapacity: loadout.shield?.capacity ?? 0,
      droneIntervalMs: loadout.drone?.intervalMs ?? 0,
    },
    synergies: [...loadout.synergies],
    abilities,
  };
}
