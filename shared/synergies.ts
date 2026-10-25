import type { UpgradeId, UpgradeLevels } from './upgrades';

/**
 * Catálogo centralizado de sinergias entre mejoras.
 *
 * Una sinergia se activa AUTOMÁTICAMENTE cuando el jugador posee todas las
 * mejoras requeridas (no añade ninguna elección ni otorga puntos). Las que
 * dependen de un estado temporal (`condition`) solo producen efecto mientras
 * ese estado está activo, y el servidor es quien lo decide.
 *
 * Los efectos reales se aplican en `computeLoadout()` (shared/upgrades.ts) y en
 * la simulación del servidor; aquí están sus datos y parámetros.
 */

export const SYNERGY_IDS = [
  'tormenta_rebotes',
  'rayo_sobrecargado',
  'defensa_orbital',
  'canon_corrosivo',
  'cadena_fragmentos',
  'cadena_perforante',
  'cazador_energia',
  'fragmentacion_electrica',
  'escudo_reactivo',
  'reaccion_corrosiva',
] as const;

export type SynergyId = (typeof SYNERGY_IDS)[number];

/** Cuándo produce efecto una sinergia que ya se posee. */
export type SynergyCondition =
  | 'siempre'
  | 'sobrecarga_activa'
  | 'tras_teletransporte'
  | 'escudo_activo'
  | 'objetivo_corroido';

export interface SynergyDefinition {
  id: SynergyId;
  name: string;
  description: string;
  requires: readonly [UpgradeId, UpgradeId];
  condition: SynergyCondition;
  /** Resumen del efecto aplicado (para la documentación y la interfaz). */
  effect: string;
  params: Readonly<Record<string, number>>;
  /** Efecto visual asociado en el cliente. */
  visual: string;
}

export const SYNERGY_CATALOG: Record<SynergyId, SynergyDefinition> = {
  tormenta_rebotes: {
    id: 'tormenta_rebotes',
    name: 'Tormenta de rebotes',
    description: 'Los tres proyectiles del triple disparo rebotan en las paredes.',
    requires: ['bala_rebotadora', 'triple_disparo'],
    condition: 'siempre',
    effect: 'Sin la sinergia solo rebota la bala central; con ella, las tres, cada una con su propio contador.',
    params: {},
    visual: 'chispa en cada rebote',
  },
  rayo_sobrecargado: {
    id: 'rayo_sobrecargado',
    name: 'Rayo sobrecargado',
    description: 'Con Sobrecarga activa el rayo hace más daño y brilla con más intensidad.',
    requires: ['rayo_perforante', 'sobrecarga'],
    condition: 'sobrecarga_activa',
    effect: 'Multiplicador del rayo ×1,4 en lugar de ×1,3, sin superar el daño máximo del rayo.',
    params: { beamMultiplier: 1.4 },
    visual: 'rayo más ancho y dorado',
  },
  defensa_orbital: {
    id: 'defensa_orbital',
    name: 'Defensa orbital',
    description: 'Mientras el escudo tiene carga, cada satélite bloquea 6 de daño más.',
    requires: ['satelites', 'escudo_energia'],
    condition: 'escudo_activo',
    effect: 'Capacidad de bloqueo +6 por satélite. Lo que bloquea un satélite no llega al escudo (no se absorbe dos veces).',
    params: { capacityBonus: 6 },
    visual: 'contorno de satélite reforzado',
  },
  canon_corrosivo: {
    id: 'canon_corrosivo',
    name: 'Cañón corrosivo',
    description: 'Los proyectiles pesados también corroen, con más daño por pulso.',
    requires: ['municion_corrosiva', 'municion_pesada'],
    condition: 'siempre',
    effect: 'La munición pesada aplica corrosión de 4 por pulso (normal: 3). Conserva su cadencia reducida.',
    params: { tickDamage: 4 },
    visual: 'proyectil pesado verde',
  },
  cadena_fragmentos: {
    id: 'cadena_fragmentos',
    name: 'Cadena de fragmentos',
    description: 'Los fragmentos pueden lanzar cadenas eléctricas cortas.',
    requires: ['bala_fragmentada', 'cadena_electrica'],
    condition: 'siempre',
    effect: 'Cada fragmento encadena 1 salto como máximo y los fragmentos de una misma bala comparten un límite de 2 saltos.',
    params: { jumpsPerFragment: 1, budgetPerBullet: 2 },
    visual: 'arcos desde los fragmentos',
  },
  cadena_perforante: {
    id: 'cadena_perforante',
    name: 'Cadena perforante',
    description: 'Cada disparo del rayo lanza UNA cadena eléctrica desde el primer enemigo alcanzado.',
    requires: ['rayo_perforante', 'cadena_electrica'],
    condition: 'siempre',
    effect: 'Una activación por disparo, nunca por cada enemigo atravesado, y sin volver a dañar a los alcanzados por el rayo.',
    params: { activationsPerShot: 1 },
    visual: 'arco desde el rayo',
  },
  cazador_energia: {
    id: 'cazador_energia',
    name: 'Cazador de energía',
    description: 'Tras teletransportarte, +10 % de daño durante 1,5 s si la Sobrecarga está lista.',
    requires: ['teletransporte', 'sobrecarga'],
    condition: 'tras_teletransporte',
    effect: 'Solo si la Sobrecarga no está activa ni en recarga; no toca su duración ni su recarga y respeta el daño máximo.',
    params: { damageMultiplier: 1.1, durationMs: 1500 },
    visual: 'resplandor breve',
  },
  fragmentacion_electrica: {
    id: 'fragmentacion_electrica',
    name: 'Fragmentación eléctrica',
    description: 'Con Sobrecarga activa los fragmentos se electrifican y conservan el daño extra.',
    requires: ['bala_fragmentada', 'sobrecarga'],
    condition: 'sobrecarga_activa',
    effect: 'Sin la sinergia los fragmentos se calculan sin la Sobrecarga; con ella la heredan UNA vez de su bala, sin volver a multiplicarla.',
    params: {},
    visual: 'fragmentos eléctricos',
  },
  escudo_reactivo: {
    id: 'escudo_reactivo',
    name: 'Escudo reactivo',
    description: 'Tras teletransportarte, los satélites amplían su órbita durante 1,2 s.',
    requires: ['satelites', 'teletransporte'],
    condition: 'tras_teletransporte',
    effect: 'Órbita de 36 a 50 px (cubren más espacio para interceptar). No crea satélites ni da invulnerabilidad.',
    params: { orbitRadius: 50, durationMs: 1200 },
    visual: 'expansión de la órbita',
  },
  reaccion_corrosiva: {
    id: 'reaccion_corrosiva',
    name: 'Reacción corrosiva',
    description: 'Una cadena que salta desde un enemigo corroído contagia una corrosión débil.',
    requires: ['municion_corrosiva', 'cadena_electrica'],
    condition: 'objetivo_corroido',
    effect: 'Corrosión secundaria de 2 por pulso durante 1,5 s, a 2 objetivos por cadena como máximo; la secundaria no se vuelve a contagiar.',
    params: { tickDamage: 2, durationMs: 1500, maxTargets: 2 },
    visual: 'arco verde',
  },
};

/** Sinergias que el jugador POSEE (tiene todas las mejoras requeridas). */
export function computeSynergies(levels: UpgradeLevels): SynergyId[] {
  return SYNERGY_IDS.filter((id) => SYNERGY_CATALOG[id].requires.every((req) => (levels[req] ?? 0) > 0));
}

/** Sinergias que una mejora nueva completaría con el equipamiento actual (para la interfaz). */
export function synergiesCompletedBy(levels: UpgradeLevels, candidate: UpgradeId): SynergyId[] {
  if ((levels[candidate] ?? 0) > 0) return [];
  const before = new Set(computeSynergies(levels));
  return computeSynergies({ ...levels, [candidate]: 1 }).filter((id) => !before.has(id));
}
