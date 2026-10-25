import { GAME, TILE, type TileType } from './constants';
import { SeededRandom } from './random';

/**
 * Generador procedural de arenas.
 *
 * Vive en `shared/` porque es código puro y determinista: el servidor lo usa
 * como fuente de verdad para colisiones y el cliente lo reutiliza para la
 * vista previa animada de la pantalla de inicio. En partida, el cliente
 * recibe el mapa ya generado desde el servidor.
 *
 * Garantías (comprobadas por `validateMap` y por las pruebas unitarias):
 *  - El borde exterior es muro.
 *  - Todas las celdas transitables forman una única región conectada.
 *  - Existen al menos `GAME.MAX_ROOM_CAPACITY` posiciones iniciales válidas,
 *    con una celda de margen libre alrededor y separadas entre sí.
 *  - La misma semilla produce exactamente el mismo mapa.
 */

export interface SpawnPoint {
  x: number;
  y: number;
}

export interface GameMap {
  seed: number;
  cols: number;
  rows: number;
  tileSize: number;
  tiles: Uint8Array;
  spawnPoints: SpawnPoint[];
  /** Intento en que se obtuvo un mapa válido (0 = primero). */
  attempt: number;
}

export interface MapValidation {
  valid: boolean;
  errors: string[];
  walkableRatio: number;
}

export interface MapOptions {
  cols?: number;
  rows?: number;
  tileSize?: number;
  spawnCount?: number;
}

const MIN_WALKABLE_RATIO = 0.55;
const MAX_ATTEMPTS = 20;

export function generateMap(seed: number, options: MapOptions = {}): GameMap {
  const cols = options.cols ?? GAME.MAP_COLS;
  const rows = options.rows ?? GAME.MAP_ROWS;
  const tileSize = options.tileSize ?? GAME.TILE_SIZE;
  const spawnCount = options.spawnCount ?? GAME.MAX_ROOM_CAPACITY;
  const normalizedSeed = seed >>> 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = new SeededRandom((normalizedSeed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
    const tiles = buildTiles(rng, cols, rows);
    sealUnreachable(tiles, cols, rows);
    const spawnPoints = pickSpawnPoints(tiles, cols, rows, tileSize, spawnCount);
    const map: GameMap = { seed: normalizedSeed, cols, rows, tileSize, tiles, spawnPoints, attempt };
    if (validateMap(map, spawnCount).valid) return map;
  }

  // Respaldo garantizado: arena abierta con cobertura mínima simétrica.
  const tiles = new Uint8Array(cols * rows);
  drawBorder(tiles, cols, rows);
  const cx = Math.floor(cols / 2);
  const cy = Math.floor(rows / 2);
  setTile(tiles, cols, cx - 1, cy, TILE.COVER);
  setTile(tiles, cols, cx, cy, TILE.COVER);
  const spawnPoints = pickSpawnPoints(tiles, cols, rows, tileSize, spawnCount);
  return { seed: normalizedSeed, cols, rows, tileSize, tiles, spawnPoints, attempt: MAX_ATTEMPTS };
}

function buildTiles(rng: SeededRandom, cols: number, rows: number): Uint8Array {
  const tiles = new Uint8Array(cols * rows);
  drawBorder(tiles, cols, rows);

  const structures = rng.int(12, 16);
  for (let i = 0; i < structures; i++) {
    const kind = rng.int(0, 3);
    let w: number;
    let h: number;
    let type: TileType;
    switch (kind) {
      case 0: // bloque de cobertura
        w = rng.int(1, 2);
        h = rng.int(1, 2);
        type = TILE.COVER;
        break;
      case 1: // muro horizontal
        w = rng.int(3, 7);
        h = 1;
        type = TILE.WALL;
        break;
      case 2: // muro vertical
        w = 1;
        h = rng.int(3, 6);
        type = TILE.WALL;
        break;
      default: // estructura grande
        w = rng.int(2, 3);
        h = rng.int(2, 3);
        type = TILE.WALL;
        break;
    }
    const x = rng.int(2, cols - 3 - w);
    const y = rng.int(2, rows - 3 - h);
    // Simetría central: cada estructura tiene su gemela rotada 180°.
    fillRect(tiles, cols, x, y, w, h, type);
    fillRect(tiles, cols, cols - x - w, rows - y - h, w, h, type);
  }

  // Coberturas sueltas en forma de L para crear zonas de cobertura.
  const lShapes = rng.int(2, 4);
  for (let i = 0; i < lShapes; i++) {
    const x = rng.int(3, cols - 6);
    const y = rng.int(3, rows - 6);
    const flip = rng.chance(0.5);
    fillRect(tiles, cols, x, y, 3, 1, TILE.COVER);
    fillRect(tiles, cols, flip ? x : x + 2, y + 1, 1, 2, TILE.COVER);
    const mx = cols - x - 3;
    const my = rows - y - 1;
    fillRect(tiles, cols, mx, my, 3, 1, TILE.COVER);
    fillRect(tiles, cols, flip ? mx + 2 : mx, my - 2, 1, 2, TILE.COVER);
  }

  // Zona central despejada para garantizar un punto de encuentro.
  const cx = Math.floor(cols / 2);
  const cy = Math.floor(rows / 2);
  fillRect(tiles, cols, cx - 2, cy - 2, 4, 4, TILE.FLOOR);
  return tiles;
}

function drawBorder(tiles: Uint8Array, cols: number, rows: number): void {
  for (let x = 0; x < cols; x++) {
    tiles[x] = TILE.WALL;
    tiles[(rows - 1) * cols + x] = TILE.WALL;
  }
  for (let y = 0; y < rows; y++) {
    tiles[y * cols] = TILE.WALL;
    tiles[y * cols + cols - 1] = TILE.WALL;
  }
}

function setTile(tiles: Uint8Array, cols: number, x: number, y: number, type: TileType): void {
  tiles[y * cols + x] = type;
}

function fillRect(
  tiles: Uint8Array,
  cols: number,
  x: number,
  y: number,
  w: number,
  h: number,
  type: TileType,
): void {
  const rows = tiles.length / cols;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      // Nunca se modifica el borde exterior.
      if (i <= 0 || j <= 0 || i >= cols - 1 || j >= rows - 1) continue;
      tiles[j * cols + i] = type;
    }
  }
}

/** Devuelve el índice de la celda transitable más cercana al centro, o -1. */
function centralFloorIndex(tiles: Uint8Array, cols: number, rows: number): number {
  const cx = Math.floor(cols / 2);
  const cy = Math.floor(rows / 2);
  let best = -1;
  let bestDist = Infinity;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (tiles[y * cols + x] !== TILE.FLOOR) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = y * cols + x;
      }
    }
  }
  return best;
}

/** Relleno por inundación (4 vecinos). Devuelve una máscara de alcanzables. */
export function floodFill(tiles: Uint8Array, cols: number, rows: number, start: number): Uint8Array {
  const visited = new Uint8Array(tiles.length);
  if (start < 0 || tiles[start] !== TILE.FLOOR) return visited;
  const stack: number[] = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const x = idx % cols;
    const y = (idx - x) / cols;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < cols - 1 ? idx + 1 : -1,
      y > 0 ? idx - cols : -1,
      y < rows - 1 ? idx + cols : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && visited[n] === 0 && tiles[n] === TILE.FLOOR) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
  return visited;
}

/** Convierte en muro cualquier bolsa transitable desconectada de la región central. */
function sealUnreachable(tiles: Uint8Array, cols: number, rows: number): void {
  const reachable = floodFill(tiles, cols, rows, centralFloorIndex(tiles, cols, rows));
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === TILE.FLOOR && reachable[i] === 0) tiles[i] = TILE.WALL;
  }
}

function hasClearance(tiles: Uint8Array, cols: number, rows: number, x: number, y: number): boolean {
  for (let j = y - 1; j <= y + 1; j++) {
    for (let i = x - 1; i <= x + 1; i++) {
      if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
      if (tiles[j * cols + i] !== TILE.FLOOR) return false;
    }
  }
  return true;
}

/**
 * Selecciona posiciones iniciales mediante muestreo del punto más lejano:
 * cada nueva posición maximiza su distancia mínima a las ya elegidas.
 */
function pickSpawnPoints(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  tileSize: number,
  count: number,
): SpawnPoint[] {
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      if (hasClearance(tiles, cols, rows, x, y)) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return [];

  const chosen: Array<{ x: number; y: number }> = [];
  // Primera posición: la candidata más cercana a la esquina superior izquierda.
  let first = candidates[0] as { x: number; y: number };
  for (const c of candidates) if (c.x + c.y < first.x + first.y) first = c;
  chosen.push(first);

  const minDist = new Float64Array(candidates.length).fill(Infinity);
  while (chosen.length < count && chosen.length < candidates.length) {
    const last = chosen[chosen.length - 1] as { x: number; y: number };
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i] as { x: number; y: number };
      const d = (c.x - last.x) ** 2 + (c.y - last.y) ** 2;
      if (d < (minDist[i] as number)) minDist[i] = d;
      if ((minDist[i] as number) > bestDist) {
        bestDist = minDist[i] as number;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestDist === 0) break;
    chosen.push(candidates[bestIdx] as { x: number; y: number });
  }

  return chosen.map((c) => ({ x: (c.x + 0.5) * tileSize, y: (c.y + 0.5) * tileSize }));
}

export function tileAt(map: Pick<GameMap, 'cols' | 'rows' | 'tiles'>, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return TILE.WALL;
  return map.tiles[row * map.cols + col] as number;
}

export function isSolidTile(type: number): boolean {
  return type === TILE.WALL || type === TILE.COVER;
}

/** ¿El punto de mundo (x, y) está dentro de una celda sólida? */
export function isSolidAt(map: Pick<GameMap, 'cols' | 'rows' | 'tiles' | 'tileSize'>, x: number, y: number): boolean {
  return isSolidTile(tileAt(map, Math.floor(x / map.tileSize), Math.floor(y / map.tileSize)));
}

/** Comprueba las garantías del generador. */
export function validateMap(map: GameMap, requiredSpawns: number = GAME.MAX_ROOM_CAPACITY): MapValidation {
  const errors: string[] = [];
  const { cols, rows, tiles, tileSize } = map;

  for (let x = 0; x < cols; x++) {
    if (tiles[x] !== TILE.WALL || tiles[(rows - 1) * cols + x] !== TILE.WALL) {
      errors.push('El borde horizontal no es completamente sólido');
      break;
    }
  }
  for (let y = 0; y < rows; y++) {
    if (tiles[y * cols] !== TILE.WALL || tiles[y * cols + cols - 1] !== TILE.WALL) {
      errors.push('El borde vertical no es completamente sólido');
      break;
    }
  }

  let floorCount = 0;
  let firstFloor = -1;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === TILE.FLOOR) {
      floorCount++;
      if (firstFloor < 0) firstFloor = i;
    }
  }
  const walkableRatio = floorCount / tiles.length;
  if (walkableRatio < MIN_WALKABLE_RATIO) {
    errors.push(`Superficie transitable insuficiente (${(walkableRatio * 100).toFixed(1)} %)`);
  }

  const reachable = floodFill(tiles, cols, rows, firstFloor);
  let reachableCount = 0;
  for (let i = 0; i < reachable.length; i++) reachableCount += reachable[i] as number;
  if (reachableCount !== floorCount) {
    errors.push(`Hay ${floorCount - reachableCount} celdas transitables aisladas`);
  }

  if (map.spawnPoints.length < requiredSpawns) {
    errors.push(`Solo hay ${map.spawnPoints.length} posiciones iniciales (se requieren ${requiredSpawns})`);
  }
  const minSpawnDistance = tileSize * 3;
  for (let i = 0; i < map.spawnPoints.length; i++) {
    const s = map.spawnPoints[i] as SpawnPoint;
    const col = Math.floor(s.x / tileSize);
    const row = Math.floor(s.y / tileSize);
    if (tileAt(map, col, row) !== TILE.FLOOR) errors.push(`La posición inicial ${i} está dentro de un obstáculo`);
    else if (reachable[row * cols + col] === 0) errors.push(`La posición inicial ${i} es inalcanzable`);
    for (let j = i + 1; j < map.spawnPoints.length; j++) {
      const o = map.spawnPoints[j] as SpawnPoint;
      if (Math.hypot(s.x - o.x, s.y - o.y) < minSpawnDistance) {
        errors.push(`Las posiciones iniciales ${i} y ${j} están demasiado cerca`);
      }
    }
  }

  return { valid: errors.length === 0, errors, walkableRatio };
}

/** Serializa las celdas para enviarlas por red ("0102…"). */
export function encodeTiles(tiles: Uint8Array): string {
  let out = '';
  for (let i = 0; i < tiles.length; i++) out += String(tiles[i]);
  return out;
}

export function decodeTiles(encoded: string): Uint8Array {
  const tiles = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) tiles[i] = encoded.charCodeAt(i) - 48;
  return tiles;
}
