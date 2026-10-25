import { afterEach, describe, expect, it } from 'vitest';
import { GAME } from '../../shared/constants';
import {
  SCORE_TARGETS,
  buildMatchConfig,
  calculateMatchDuration,
  isScoreTarget,
} from '../../shared/matchConfig';
import { tiebreakCriterion } from '../../shared/stats';
import type { MatchResult } from '../../shared/protocol';
import { GameServer } from '../../server/src/game/GameServer';
import { RoomManager, type RoomNotifier } from '../../server/src/rooms/RoomManager';
import { createRoomSchema } from '../../server/src/validation/schemas';

const BASE_MS = GAME.DEFAULT_MATCH_DURATION_S * 1000;
const STEP = 1000 / GAME.TICK_RATE;
const idle = { moveX: 0, moveY: 0, aim: 0, fire: false, dash: false };

const silentNotifier: RoomNotifier = {
  roomState: () => undefined,
  roomsChanged: () => undefined,
  roomClosed: () => undefined,
  gameStart: () => undefined,
  snapshot: () => undefined,
  event: () => undefined,
  gameEnd: () => undefined,
  appearance: () => undefined,
};

let manager: RoomManager | null = null;
afterEach(() => {
  manager?.dispose();
  manager = null;
});

describe('Configuración centralizada de puntuación y duración', () => {
  it('el modo de 15 puntos conserva exactamente la duración base actual', () => {
    expect(calculateMatchDuration(BASE_MS, 15)).toBe(BASE_MS);
    expect(calculateMatchDuration(90_000, 15)).toBe(90_000); // también con otra base (MATCH_DURATION_S)
  });

  it('25 y 30 puntos aumentan la duración de forma progresiva (base × objetivo / 15)', () => {
    const config = buildMatchConfig(BASE_MS);
    expect(config[15].durationMs).toBe(180_000);
    expect(config[25].durationMs).toBe(300_000);
    expect(config[30].durationMs).toBe(360_000);
    expect(config[25].durationMs).toBeGreaterThan(config[15].durationMs);
    expect(config[30].durationMs).toBeGreaterThan(config[25].durationMs);
    expect(SCORE_TARGETS).toEqual([15, 25, 30]);
  });

  it('solo acepta exactamente 15, 25 o 30 (servidor y esquema Zod)', () => {
    for (const ok of [15, 25, 30]) expect(isScoreTarget(ok)).toBe(true);
    for (const bad of [0, 14, 16, 20, 31, 100, '25', null, Number.NaN]) expect(isScoreTarget(bad)).toBe(false);
    const base = { name: 'Sala', maxPlayers: 4, isPrivate: false };
    expect(createRoomSchema.parse(base).scoreToWin).toBe(15); // valor por defecto
    expect(createRoomSchema.parse({ ...base, scoreToWin: 25 }).scoreToWin).toBe(25);
    expect(createRoomSchema.safeParse({ ...base, scoreToWin: 20 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ ...base, scoreToWin: '30' }).success).toBe(false);
    expect(createRoomSchema.safeParse({ ...base, scoreToWin: 30.5 }).success).toBe(false);
  });

  it('la sala guarda la configuración calculada por el servidor', () => {
    manager = new RoomManager({ notifier: silentNotifier, matchDurationMs: BASE_MS, persistMatch: async () => undefined });
    const room = manager.create({ id: 'u1', username: 'ada' }, { name: 'Larga', maxPlayers: 2, isPrivate: false, scoreToWin: 30 });
    expect(room.scoreToWin).toBe(30);
    expect(room.durationMs).toBe(360_000);
    const state = manager.state(room);
    expect(state).toMatchObject({ scoreToWin: 30, durationMs: 360_000 });
    expect(manager.list()[0]).toMatchObject({ scoreToWin: 30, durationMs: 360_000 });
    // Un valor manipulado que llegara sin pasar por Zod también se rechaza.
    expect(() =>
      manager!.create({ id: 'u2', username: 'bit' }, { name: 'Trampa', maxPlayers: 2, isPrivate: false, scoreToWin: 99 }),
    ).toThrow(/15, 25 o 30/);
  });
});

describe('Condiciones de victoria con objetivo variable', () => {
  function duel(scoreToWin: number, durationMs = 600_000) {
    let result: MatchResult | null = null;
    const game = new GameServer({
      matchId: 'm',
      roomId: 'r',
      seed: 42,
      players: [
        { id: 'a', username: 'Ada' },
        { id: 'b', username: 'Bit' },
      ],
      durationMs,
      scoreToWin,
      onEnd: (r) => {
        result = r;
      },
    });
    return { game, result: () => result };
  }

  it('con objetivo 25 la partida NO termina al llegar a 15', () => {
    const { game, result } = duel(25);
    const a = game.players.get('a')!;
    a.score = 15;
    game.step(STEP);
    expect(game.isEnded).toBe(false);
    a.score = 25;
    game.step(STEP);
    expect(result()).toMatchObject({ reason: 'puntuacion', winnerId: 'a', scoreToWin: 25 });
  });

  it('termina al agotar el tiempo del modo y guarda la configuración usada', () => {
    const { game, result } = duel(30, 2000);
    for (let i = 0; i < 70; i++) game.step(STEP);
    expect(result()).toMatchObject({ reason: 'tiempo', scoreToWin: 30, timeLimitMs: 2000, durationMs: 2000 });
  });

  it('no acumula puntos ni acepta entradas después de terminar', () => {
    const { game, result } = duel(15);
    game.players.get('a')!.score = 15;
    game.step(STEP);
    const final = result()!;
    expect(game.handleInput('a', { seq: 99, ...idle, fire: true })).toBe(false);
    const before = game.elapsedMs;
    game.step(STEP);
    expect(game.elapsedMs).toBe(before);
    expect(result()).toBe(final);
  });

  it('resuelve los empates de forma explícita y consistente', () => {
    const base = { score: 10, kills: 3, deaths: 2, survivalMs: 5000, joinOrder: 0 };
    expect(tiebreakCriterion(base, { ...base, score: 9 })).toBeNull();
    expect(tiebreakCriterion({ ...base, kills: 4 }, base)).toBe('eliminaciones');
    expect(tiebreakCriterion({ ...base, deaths: 1 }, base)).toBe('muertes');
    expect(tiebreakCriterion({ ...base, survivalMs: 6000 }, base)).toBe('supervivencia');
    expect(tiebreakCriterion(base, { ...base, joinOrder: 1 })).toBe('orden_de_ingreso');

    const { game, result } = duel(15, 1000);
    for (const id of ['a', 'b']) Object.assign(game.players.get(id)!, { score: 5, kills: 1, deaths: 0 });
    for (let i = 0; i < 31; i++) game.step(STEP);
    expect(result()).toMatchObject({ reason: 'tiempo', winnerId: 'a', tiebreak: 'orden_de_ingreso' });
  });
});
