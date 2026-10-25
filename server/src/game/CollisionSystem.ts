import { isSolidTile, tileAt, type GameMap } from '../../../shared/MapGenerator';

type MapLike = Pick<GameMap, 'cols' | 'rows' | 'tiles' | 'tileSize'>;

export interface Body {
  x: number;
  y: number;
}

/**
 * Sistema de colisiones autoritativo.
 *
 * - Jugador contra mapa: el cuerpo se trata como un cuadrado de lado 2·radio
 *   y se resuelve eje por eje (primero X, luego Y). Esto permite deslizarse a
 *   lo largo de las paredes y solo consulta las celdas que toca el cuerpo
 *   (coste O(1) por jugador gracias a la rejilla del mapa).
 * - Desplazamientos grandes se subdividen para evitar atravesar muros.
 * - Proyectil contra mapa: recorrido de la rejilla con DDA (Amanatides-Woo).
 */

/** ¿El cuadrado centrado en (x, y) con semilado `r` toca alguna celda sólida? */
export function overlapsSolid(map: MapLike, x: number, y: number, r: number): boolean {
  const ts = map.tileSize;
  const minCol = Math.floor((x - r) / ts);
  const maxCol = Math.floor((x + r - 1e-6) / ts);
  const minRow = Math.floor((y - r) / ts);
  const maxRow = Math.floor((y + r - 1e-6) / ts);
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (isSolidTile(tileAt(map, col, row))) return true;
    }
  }
  return false;
}

function resolveAxisX(map: MapLike, body: Body, r: number, dx: number): void {
  if (dx === 0) return;
  body.x += dx;
  if (!overlapsSolid(map, body.x, body.y, r)) return;
  const ts = map.tileSize;
  if (dx > 0) {
    // Se ajusta el borde derecho al borde izquierdo de la celda bloqueante.
    const col = Math.floor((body.x + r) / ts);
    body.x = col * ts - r - 1e-4;
  } else {
    const col = Math.floor((body.x - r) / ts);
    body.x = (col + 1) * ts + r + 1e-4;
  }
}

function resolveAxisY(map: MapLike, body: Body, r: number, dy: number): void {
  if (dy === 0) return;
  body.y += dy;
  if (!overlapsSolid(map, body.x, body.y, r)) return;
  const ts = map.tileSize;
  if (dy > 0) {
    const row = Math.floor((body.y + r) / ts);
    body.y = row * ts - r - 1e-4;
  } else {
    const row = Math.floor((body.y - r) / ts);
    body.y = (row + 1) * ts + r + 1e-4;
  }
}

/** Mueve un cuerpo con colisión contra el mapa. Modifica `body` in situ. */
export function moveWithCollision(map: MapLike, body: Body, dx: number, dy: number, r: number): void {
  const maxStep = map.tileSize / 2 - 1;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxStep));
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    resolveAxisX(map, body, r, sx);
    resolveAxisY(map, body, r, sy);
  }
}

/**
 * Separa jugadores solapados (círculo contra círculo) repartiendo el empuje
 * entre ambos y respetando las paredes.
 */
export function separateBodies(map: MapLike, bodies: Body[], r: number): void {
  const minDist = r * 2;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i] as Body;
      const b = bodies[j] as Body;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= minDist) continue;
      if (dist === 0) {
        // Coincidencia exacta: se separan en un eje determinista.
        dx = 1;
        dy = 0;
        dist = 1;
      }
      const push = (minDist - dist) / 2;
      const nx = dx / dist;
      const ny = dy / dist;
      moveWithCollision(map, a, -nx * push, -ny * push, r);
      moveWithCollision(map, b, nx * push, ny * push, r);
    }
  }
}

/** Impacto contra el mapa: fracción del segmento y normal de la cara de la celda (eje alineado). */
export interface WallHit {
  t: number;
  /** Normal de la pared (−1, 0 o 1 en cada eje). (0, 0) si el origen ya estaba dentro de un sólido. */
  nx: number;
  ny: number;
}

/**
 * Recorre la rejilla desde (x0, y0) hacia (x1, y1) con DDA y devuelve el
 * primer contacto con una celda sólida (fracción t ∈ [0, 1] y normal de la
 * cara atravesada), o `null` si el segmento está libre.
 */
export function raycastSolidHit(map: MapLike, x0: number, y0: number, x1: number, y1: number): WallHit | null {
  const ts = map.tileSize;
  let col = Math.floor(x0 / ts);
  let row = Math.floor(y0 / ts);
  if (isSolidTile(tileAt(map, col, row))) return { t: 0, nx: 0, ny: 0 };

  const dx = x1 - x0;
  const dy = y1 - y0;
  const endCol = Math.floor(x1 / ts);
  const endRow = Math.floor(y1 / ts);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(ts / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(ts / dy) : Infinity;
  let tMaxX = stepX > 0 ? ((col + 1) * ts - x0) / dx : stepX < 0 ? (col * ts - x0) / dx : Infinity;
  let tMaxY = stepY > 0 ? ((row + 1) * ts - y0) / dy : stepY < 0 ? (row * ts - y0) / dy : Infinity;

  let guard = map.cols + map.rows + 4;
  while ((col !== endCol || row !== endRow) && guard-- > 0) {
    let t: number;
    let nx = 0;
    let ny = 0;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      col += stepX;
      tMaxX += tDeltaX;
      nx = -stepX;
    } else {
      t = tMaxY;
      row += stepY;
      tMaxY += tDeltaY;
      ny = -stepY;
    }
    if (t > 1) return null;
    if (isSolidTile(tileAt(map, col, row))) return { t: Math.max(0, t), nx, ny };
  }
  return null;
}

/**
 * Como `raycastSolidHit`, pero solo devuelve la fracción t ∈ [0, 1] del
 * primer contacto, o `null` si el segmento está libre.
 */
export function raycastSolid(map: MapLike, x0: number, y0: number, x1: number, y1: number): number | null {
  return raycastSolidHit(map, x0, y0, x1, y1)?.t ?? null;
}

/**
 * Intersección de un segmento con un círculo. Devuelve la fracción t ∈ [0,1]
 * del primer contacto, o `null`.
 */
export function segmentCircleHit(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0; // el origen ya está dentro del círculo
  if (a === 0) return null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}
