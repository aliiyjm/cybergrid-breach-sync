import { describe, expect, it } from 'vitest';
import { GAME, TILE } from '../../shared/constants';
import { decodeTiles, encodeTiles, floodFill, generateMap, validateMap } from '../../shared/MapGenerator';

describe('Generación procedural de mapas', () => {
  it('genera una arena con las dimensiones configuradas y borde sólido', () => {
    const map = generateMap(1234);
    expect(map.cols).toBe(GAME.MAP_COLS);
    expect(map.rows).toBe(GAME.MAP_ROWS);
    expect(map.tiles).toHaveLength(GAME.MAP_COLS * GAME.MAP_ROWS);
    for (let x = 0; x < map.cols; x++) {
      expect(map.tiles[x]).toBe(TILE.WALL);
      expect(map.tiles[(map.rows - 1) * map.cols + x]).toBe(TILE.WALL);
    }
    // Contiene obstáculos y coberturas además del borde.
    const interior = [...map.tiles].filter((t, i) => {
      const x = i % map.cols;
      const y = Math.floor(i / map.cols);
      return x > 0 && y > 0 && x < map.cols - 1 && y < map.rows - 1 && t !== TILE.FLOOR;
    });
    expect(interior.length).toBeGreaterThan(20);
    expect(map.tiles.includes(TILE.COVER)).toBe(true);
  });

  it('es reproducible: la misma semilla produce exactamente el mismo mapa', () => {
    const a = generateMap(987654321);
    const b = generateMap(987654321);
    expect(encodeTiles(a.tiles)).toBe(encodeTiles(b.tiles));
    expect(a.spawnPoints).toEqual(b.spawnPoints);
  });

  it('semillas distintas producen mapas distintos', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) seen.add(encodeTiles(generateMap(seed).tiles));
    expect(seen.size).toBe(20);
  });

  it('valida posiciones iniciales y conectividad en 500 semillas', () => {
    for (let seed = 0; seed < 500; seed++) {
      const map = generateMap(seed * 7919);
      const result = validateMap(map);
      expect(result.errors, `semilla ${seed * 7919}`).toEqual([]);
      expect(map.spawnPoints.length).toBeGreaterThanOrEqual(GAME.MAX_ROOM_CAPACITY);
      for (const s of map.spawnPoints) {
        const col = Math.floor(s.x / map.tileSize);
        const row = Math.floor(s.y / map.tileSize);
        // La celda inicial y sus 8 vecinas están libres de obstáculos.
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) expect(map.tiles[(row + dy) * map.cols + col + dx]).toBe(TILE.FLOOR);
      }
    }
  });

  it('ninguna zona transitable queda aislada (los obstáculos no bloquean el mapa)', () => {
    const map = generateMap(42);
    const start = map.tiles.indexOf(TILE.FLOOR);
    const reach = floodFill(map.tiles, map.cols, map.rows, start);
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === TILE.FLOOR) expect(reach[i]).toBe(1);
    }
    expect(validateMap(map).walkableRatio).toBeGreaterThan(0.55);
  });

  it('la validación detecta un mapa bloqueado', () => {
    const map = generateMap(7);
    const broken = { ...map, tiles: new Uint8Array(map.tiles) };
    // Muro vertical que parte el mapa en dos.
    for (let y = 0; y < broken.rows; y++) broken.tiles[y * broken.cols + 20] = TILE.WALL;
    const result = validateMap(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('aisladas'))).toBe(true);
  });

  it('codifica y decodifica las celdas sin pérdidas', () => {
    const map = generateMap(5);
    expect(decodeTiles(encodeTiles(map.tiles))).toEqual(map.tiles);
  });
});
