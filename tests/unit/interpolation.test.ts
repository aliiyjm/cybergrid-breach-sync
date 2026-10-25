import { describe, expect, it } from 'vitest';
import type { GameSnapshot, PlayerSnapshot } from '../../shared/protocol';
import { SnapshotInterpolator, interpolatePlayer } from '../../client/src/network/Interpolator';

function player(id: string, x: number, y: number, extra: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    id,
    x,
    y,
    aim: 0,
    hp: 100,
    energy: 100,
    alive: true,
    score: 0,
    kills: 0,
    deaths: 0,
    shards: 0,
    dashing: false,
    protected: false,
    connected: true,
    respawnInMs: 0,
    ...extra,
  };
}

function snap(tick: number, serverTime: number, players: PlayerSnapshot[]): GameSnapshot {
  return { tick, serverTime, remainingMs: 1000, players, projectiles: [], shards: [], acks: {} };
}

describe('Interpolación de posiciones', () => {
  it('interpola linealmente entre dos estados', () => {
    const out = { x: 0, y: 0, aim: 0, alive: true };
    interpolatePlayer(player('a', 100, 200), player('a', 200, 100), 0.5, out);
    expect(out.x).toBeCloseTo(150);
    expect(out.y).toBeCloseTo(150);
  });

  it('interpola el ángulo por el camino más corto', () => {
    const out = { x: 0, y: 0, aim: 0, alive: true };
    interpolatePlayer(player('a', 0, 0, { aim: 3.0 }), player('a', 0, 0, { aim: -3.0 }), 0.5, out);
    // Entre 3.0 y -3.0 el camino corto pasa por ±π, no por 0.
    expect(Math.abs(Math.abs(out.aim) - Math.PI)).toBeLessThan(0.01);
  });

  it('no extrapola: t se limita a [0, 1]', () => {
    const out = { x: 0, y: 0, aim: 0, alive: true };
    interpolatePlayer(player('a', 0, 0), player('a', 100, 0), 2, out);
    expect(out.x).toBe(100);
    interpolatePlayer(player('a', 0, 0), player('a', 100, 0), -1, out);
    expect(out.x).toBe(0);
  });

  it('salta sin interpolar en una reaparición (teletransporte)', () => {
    const out = { x: 0, y: 0, aim: 0, alive: true };
    interpolatePlayer(player('a', 100, 100), player('a', 1200, 900), 0.3, out);
    expect(out).toMatchObject({ x: 1200, y: 900 });
  });

  it('elige el par de instantáneas que rodea el instante de render y reutiliza objetos', () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, 1000, [player('a', 0, 0)]));
    interp.push(snap(2, 1033, [player('a', 33, 0)]));
    interp.push(snap(3, 1066, [player('a', 66, 0)]));
    interp.push(snap(2, 1033, [player('a', 999, 0)])); // duplicada: se ignora

    const first = interp.sample(1049.5).get('a');
    expect(first?.x).toBeCloseTo(49.5, 1);
    const again = interp.sample(1066).get('a');
    expect(again).toBe(first); // mismo objeto: sin asignaciones por fotograma
    expect(again?.x).toBeCloseTo(66);
    // Más allá del último estado conocido se mantiene la última posición.
    expect(interp.sample(5000).get('a')?.x).toBe(66);
  });
});
