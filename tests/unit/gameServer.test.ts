import { describe, expect, it } from 'vitest';
import { GAME } from '../../shared/constants';
import type { GameEvent, MatchResult } from '../../shared/protocol';
import { GameServer } from '../../server/src/game/GameServer';

const STEP = 1000 / GAME.TICK_RATE;

/** Partida de prueba con dos jugadores en la zona central despejada del mapa. */
function setup(options: Partial<ConstructorParameters<typeof GameServer>[0]> = {}) {
  const events: GameEvent[] = [];
  let result: MatchResult | null = null;
  const game = new GameServer({
    matchId: 'm1',
    roomId: 'r1',
    seed: 42,
    players: [
      { id: 'a', username: 'Ada' },
      { id: 'b', username: 'Bit' },
    ],
    durationMs: 60_000,
    onEvent: (e) => events.push(e),
    onEnd: (r) => {
      result = r;
    },
    ...options,
  });
  const cx = (game.map.cols / 2) * game.map.tileSize;
  const cy = (game.map.rows / 2) * game.map.tileSize;
  const a = game.players.get('a')!;
  const b = game.players.get('b')!;
  return { game, events, a, b, cx, cy, result: () => result };
}

/** Avanza `ms` milisegundos en pasos fijos (número entero de pasos). */
function run(game: GameServer, ms: number): void {
  const steps = Math.round(ms / STEP);
  for (let i = 0; i < steps; i++) game.step(STEP);
}

const idle = { moveX: 0, moveY: 0, aim: 0, fire: false, dash: false };

describe('Simulación autoritativa', () => {
  it('mueve al jugador a la velocidad del servidor, independiente del cliente', () => {
    const { game, a, cx, cy } = setup();
    a.x = cx - 40;
    a.y = cy;
    game.handleInput('a', { seq: 1, ...idle, moveX: 1 });
    run(game, 10 * STEP);
    expect(a.x - (cx - 40)).toBeCloseTo((GAME.PLAYER_SPEED * 10) / GAME.TICK_RATE, 3);
  });

  it('normaliza la diagonal y limita intenciones manipuladas (anti speed-hack)', () => {
    const { game, a, cx, cy } = setup();
    a.x = cx - 40;
    a.y = cy - 40;
    // Aunque llegara una intención de 50 (Zod ya la rechaza), el servidor la limita a 1.
    game.handleInput('a', { seq: 1, ...idle, moveX: 50, moveY: 50 });
    run(game, 5 * STEP);
    const moved = Math.hypot(a.x - (cx - 40), a.y - (cy - 40));
    expect(moved).toBeCloseTo((GAME.PLAYER_SPEED * 5) / GAME.TICK_RATE, 3);
  });

  it('descarta entradas repetidas o fuera de orden', () => {
    const { game } = setup();
    expect(game.handleInput('a', { seq: 5, ...idle })).toBe(true);
    expect(game.handleInput('a', { seq: 3, ...idle, moveX: 1 })).toBe(false);
    expect(game.handleInput('a', { seq: 5, ...idle, moveX: 1 })).toBe(false);
    expect(game.handleInput('desconocido', { seq: 9, ...idle })).toBe(false);
  });

  it('impone la cadencia de disparo en el servidor', () => {
    const { game, events, a, cx, cy } = setup();
    a.x = cx - 40;
    a.y = cy;
    game.handleInput('a', { seq: 1, ...idle, aim: Math.PI / 2, fire: true });
    run(game, 1000);
    const shots = events.filter((e) => e.type === 'fire' && e.playerId === 'a').length;
    expect(shots).toBeLessThanOrEqual(Math.ceil(1000 / GAME.FIRE_COOLDOWN_MS));
    expect(shots).toBeGreaterThanOrEqual(3);
  });

  it('calcula impactos, daño, eliminación, estadísticas y reaparición', () => {
    const { game, events, a, b, cx, cy } = setup();
    a.x = cx - 60;
    a.y = cy;
    b.x = cx + 30;
    b.y = cy;
    b.protectedUntil = 0;
    game.handleInput('a', { seq: 1, ...idle, aim: 0, fire: true });
    run(game, 2000);
    const hits = events.filter((e) => e.type === 'hit');
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits.every((h) => h.type === 'hit' && h.damage === GAME.BASE_DAMAGE)).toBe(true);
    expect(b.deaths).toBeGreaterThanOrEqual(1);
    expect(a.kills).toBe(b.deaths);
    expect(a.score).toBe(a.kills * GAME.SCORE_PER_KILL + a.shards * GAME.SCORE_PER_SHARD);
    expect(events.some((e) => e.type === 'kill' && e.killerId === 'a' && e.victimId === 'b')).toBe(true);

    game.handleInput('a', { seq: 2, ...idle });
    run(game, GAME.RESPAWN_MS + 100);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(GAME.MAX_HP);
    expect(events.some((e) => e.type === 'respawn' && e.playerId === 'b')).toBe(true);
  });

  it('termina por puntuación y clasifica a los jugadores', () => {
    const { game, a, b, cx, cy, result } = setup({ scoreToWin: GAME.SCORE_PER_KILL });
    a.x = cx - 60;
    a.y = cy;
    b.x = cx + 30;
    b.y = cy;
    b.protectedUntil = 0;
    game.handleInput('a', { seq: 1, ...idle, aim: 0, fire: true });
    run(game, 3000);
    const r = result();
    expect(r?.reason).toBe('puntuacion');
    expect(r?.winnerId).toBe('a');
    expect(r?.players.map((p) => p.userId)).toEqual(['a', 'b']);
    expect(r?.players[0]).toMatchObject({ rank: 1, won: true, kills: 1, kdr: 1 });
    expect(r?.players[1]).toMatchObject({ rank: 2, won: false, deaths: 1, kdr: 0 });
    expect(game.isEnded).toBe(true);
  });

  it('termina por tiempo y registra la supervivencia', () => {
    const { game, result } = setup({ durationMs: 1000 });
    run(game, 1100);
    const r = result();
    expect(r?.reason).toBe('tiempo');
    expect(r?.durationMs).toBe(1000);
    for (const p of r?.players ?? []) {
      expect(p.survivalMs).toBe(1000);
      expect(p.longestLifeMs).toBe(1000);
    }
  });

  it('declara ganador al jugador que permanece si el rival abandona', () => {
    const { game, result } = setup();
    run(game, 500);
    game.removePlayer('b');
    const r = result();
    expect(r?.reason).toBe('abandono');
    expect(r?.winnerId).toBe('a');
  });
});
