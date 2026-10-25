import type { GameMap } from '../../../shared/MapGenerator';
import { overlapsSolid, raycastSolid } from './CollisionSystem';

/**
 * Lógica pura de las habilidades de la expansión 1.3 (sin estado de partida),
 * usada por `GameServer` y probada de forma aislada.
 */

type MapLike = Pick<GameMap, 'cols' | 'rows' | 'tiles' | 'tileSize'>;

/* ------------------------------ Teletransporte ------------------------------ */

/** Paso de muestreo del recorrido del teletransporte (px). */
const TELEPORT_STEP = 4;
/** Por debajo de esta distancia útil el teletransporte se cancela (sin gastar la recarga). */
export const MIN_TELEPORT_DISTANCE = 24;

/**
 * Destino seguro de un teletransporte: el punto más lejano en la dirección
 * `angle`, hasta `maxDist`, tal que el recorrido no cruza ningún sólido y la
 * nave (radio `radius`) cabe sin solaparse con obstáculos ni salir del mapa.
 * Si una pared corta el camino, se usa la posición segura justo antes de ella.
 * Devuelve `null` (cancelar) si no se puede avanzar al menos MIN_TELEPORT_DISTANCE.
 */
export function findTeleportDestination(
  map: MapLike,
  x: number,
  y: number,
  angle: number,
  maxDist: number,
  radius: number,
): { x: number; y: number; distance: number } | null {
  if (!Number.isFinite(angle) || !Number.isFinite(maxDist) || maxDist <= 0) return null;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const worldW = map.cols * map.tileSize;
  const worldH = map.rows * map.tileSize;
  let best: { x: number; y: number; distance: number } | null = null;
  for (let d = TELEPORT_STEP; d <= maxDist + 1e-9; d += TELEPORT_STEP) {
    const px = x + dirX * d;
    const py = y + dirY * d;
    const inside = px - radius >= 0 && py - radius >= 0 && px + radius <= worldW && py + radius <= worldH;
    // Sin atravesar paredes (línea central) ni terminar dentro de un obstáculo.
    if (!inside || raycastSolid(map, x, y, px, py) !== null || overlapsSolid(map, px, py, radius)) break;
    best = { x: px, y: py, distance: d };
  }
  return best && best.distance >= MIN_TELEPORT_DISTANCE ? best : null;
}

/* ------------------------------ Cadena eléctrica ------------------------------ */

export interface ChainCandidate {
  id: string;
  x: number;
  y: number;
}

/**
 * Siguiente objetivo de una cadena: el candidato más cercano a `from` dentro de
 * `radius`, que no esté en `excluded` y con línea de visión. Desempate por id
 * (determinista).
 */
export function pickChainTarget<T extends ChainCandidate>(
  from: { x: number; y: number },
  candidates: Iterable<T>,
  radius: number,
  excluded: ReadonlySet<string>,
  lineOfSight: (x0: number, y0: number, x1: number, y1: number) => boolean,
): T | null {
  let best: T | null = null;
  let bestD = radius * radius;
  for (const c of candidates) {
    if (excluded.has(c.id)) continue;
    const d = (c.x - from.x) ** 2 + (c.y - from.y) ** 2;
    if (d > bestD || (d === bestD && best && c.id > best.id)) continue;
    if (!lineOfSight(from.x, from.y, c.x, c.y)) continue;
    best = c;
    bestD = d;
  }
  return best;
}

/* ------------------------------ Satélites ------------------------------ */

/** Posiciones de los satélites: reparto uniforme en una órbita circular. */
export function satellitePositions(
  x: number,
  y: number,
  count: number,
  baseAngle: number,
  orbitRadius: number,
): { x: number; y: number; angle: number }[] {
  const out: { x: number; y: number; angle: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + (i * Math.PI * 2) / count;
    out.push({ x: x + Math.cos(angle) * orbitRadius, y: y + Math.sin(angle) * orbitRadius, angle });
  }
  return out;
}

/* ------------------------------ Corrosión ------------------------------ */

export interface CorrosionState {
  sourceId: string;
  /** Fin del efecto (ms de simulación). */
  until: number;
  nextTickAt: number;
  tickDamage: number;
  tickMs: number;
  /** false en la corrosión contagiada por Reacción corrosiva: no se vuelve a contagiar. */
  spreadable: boolean;
}

/**
 * Regla de combinación: un nuevo impacto RENUEVA la duración (nunca la suma),
 * conserva el ritmo de pulsos y usa el mayor daño por pulso, sin sumarlos.
 * Una corrosión primaria no se degrada por una secundaria.
 */
export function renewCorrosion(current: CorrosionState | null, incoming: CorrosionState): CorrosionState {
  if (!current) return { ...incoming };
  return {
    sourceId: incoming.sourceId,
    until: Math.max(current.until, incoming.until),
    nextTickAt: current.nextTickAt,
    tickDamage: Math.max(current.tickDamage, incoming.tickDamage),
    tickMs: current.tickMs,
    spreadable: current.spreadable || incoming.spreadable,
  };
}
