import { describe, expect, it } from 'vitest';
import { TILE } from '../../shared/constants';
import {
  moveWithCollision,
  overlapsSolid,
  raycastSolid,
  segmentCircleHit,
  separateBodies,
} from '../../server/src/game/CollisionSystem';

/** Mapa 10×10 de 40 px con borde y un muro vertical en la columna 5 (filas 2-7). */
function testMap() {
  const cols = 10;
  const rows = 10;
  const tiles = new Uint8Array(cols * rows);
  for (let i = 0; i < cols; i++) {
    tiles[i] = TILE.WALL;
    tiles[(rows - 1) * cols + i] = TILE.WALL;
    tiles[i * cols] = TILE.WALL;
    tiles[i * cols + cols - 1] = TILE.WALL;
  }
  for (let y = 2; y <= 7; y++) tiles[y * cols + 5] = TILE.WALL;
  return { cols, rows, tileSize: 40, tiles };
}

const R = 16;

describe('Colisiones autoritativas jugador-mapa', () => {
  it('detiene al jugador contra un muro', () => {
    const map = testMap();
    const body = { x: 150, y: 200 };
    moveWithCollision(map, body, 100, 0, R);
    expect(body.x).toBeLessThan(5 * 40 - R);
    expect(body.x).toBeGreaterThan(5 * 40 - R - 0.01);
    expect(overlapsSolid(map, body.x, body.y, R)).toBe(false);
  });

  it('permite deslizarse a lo largo de la pared', () => {
    const map = testMap();
    const body = { x: 180, y: 150 };
    moveWithCollision(map, body, 50, 30, R);
    expect(body.x).toBeLessThan(5 * 40 - R); // bloqueado en X
    expect(body.y).toBeCloseTo(180); // libre en Y
  });

  it('no atraviesa muros con desplazamientos grandes ni sale del mapa', () => {
    const map = testMap();
    const body = { x: 100, y: 200 };
    moveWithCollision(map, body, 400, 0, R);
    expect(body.x).toBeLessThan(5 * 40);
    moveWithCollision(map, body, -1000, -1000, R);
    expect(body.x).toBeGreaterThanOrEqual(40 + R);
    expect(body.y).toBeGreaterThanOrEqual(40 + R);
    expect(overlapsSolid(map, body.x, body.y, R)).toBe(false);
  });

  it('separa jugadores solapados', () => {
    const map = testMap();
    const a = { x: 100, y: 330 };
    const b = { x: 110, y: 330 };
    separateBodies(map, [a, b], R);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * R - 1e-6);
  });
});

describe('Trayectorias de proyectiles', () => {
  it('el raycast encuentra el primer muro en la trayectoria', () => {
    const map = testMap();
    const t = raycastSolid(map, 100, 100, 300, 100);
    expect(t).not.toBeNull();
    expect(100 + 200 * (t as number)).toBeCloseTo(200); // borde izquierdo de la columna 5
    expect(raycastSolid(map, 100, 60, 300, 60)).toBeNull(); // fila 1: libre
  });

  it('detecta el impacto de un segmento con un círculo', () => {
    expect(segmentCircleHit(0, 0, 100, 0, 50, 0, 10)).toBeCloseTo(0.4);
    expect(segmentCircleHit(0, 0, 100, 0, 50, 30, 10)).toBeNull();
    expect(segmentCircleHit(0, 0, 30, 0, 50, 0, 10)).toBeNull(); // no llega
  });
});
