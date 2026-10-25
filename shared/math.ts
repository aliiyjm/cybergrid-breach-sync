/** Utilidades matemáticas puras sin asignaciones de memoria. */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpola ángulos por el camino más corto (radianes). */
export function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * Limita un vector de intención de movimiento a magnitud ≤ 1.
 * Evita que el movimiento diagonal sea más rápido que el recto.
 */
export function normalizeIntent(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len <= 1 || len === 0) return { x, y };
  return { x: x / len, y: y / len };
}

/**
 * Distancia al cuadrado desde el punto (px,py) al segmento (ax,ay)-(bx,by).
 */
export function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return distanceSq(px, py, cx, cy);
}
