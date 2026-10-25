import { afterEach, describe, expect, it } from 'vitest';
import type { MatchResult, RoomListPayload, RoomState } from '../../shared/protocol';
import { RoomError, RoomManager, type Room, type RoomNotifier } from '../../server/src/rooms/RoomManager';

/**
 * Regresión: «Volver al lobby» tras una partida.
 * Antes, salir de los resultados no avisaba al servidor (el jugador seguía
 * como miembro «fantasma») y el cliente reconstruía el estado de la sala
 * localmente. Ahora existe una operación de regreso idempotente en el servidor.
 */

const users = ['ada', 'bit', 'cy', 'dot'].map((name) => ({ id: `u-${name}`, username: name }));
const [ada, bit, cy] = users as [(typeof users)[0], (typeof users)[0], (typeof users)[0]];

function setup() {
  const states: RoomState[] = [];
  const lists: RoomListPayload[] = [];
  const ends: MatchResult[] = [];
  const notifier: RoomNotifier = {
    roomState: (s) => states.push(s),
    roomsChanged: (l) => lists.push(l),
    roomClosed: () => undefined,
    gameStart: () => undefined,
    snapshot: () => undefined,
    event: () => undefined,
    gameEnd: (_roomId, r) => ends.push(r),
    appearance: () => undefined,
  };
  const manager = new RoomManager({
    notifier,
    matchDurationMs: 60_000,
    countdownMs: 10,
    graceMs: 60_000,
    persistMatch: async () => undefined,
  });
  return { manager, states, lists, ends };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Crea una sala con `players`, los marca listos, inicia y termina una partida. */
async function playMatch(manager: RoomManager, players: typeof users): Promise<Room> {
  const room = manager.create(players[0]!, { name: 'Arena', maxPlayers: 8, isPrivate: false });
  for (const p of players.slice(1)) manager.join(p, { roomId: room.id });
  for (const p of players) manager.setReady(p.id, true);
  await wait(40);
  expect(room.status).toBe('en_partida');
  room.game!.finish('puntuacion');
  await wait(10); // persistMatch es asíncrono
  return room;
}

let current: RoomManager | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

describe('Regreso al lobby tras una partida', () => {
  it('conserva el identificador de la sala y no la duplica', async () => {
    const { manager } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    const roomsBefore = manager.list().length;
    const back = manager.returnToRoom(ada, room.id);
    expect(back.id).toBe(room.id);
    expect(back).toBe(room);
    expect(manager.list()).toHaveLength(roomsBefore);
    expect(manager.list().filter((r) => r.name === 'Arena')).toHaveLength(1);
  });

  it('el jugador aparece una sola vez en la lista de participantes', async () => {
    const { manager } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    manager.returnToRoom(ada, room.id);
    manager.returnToRoom(ada, room.id);
    manager.join(ada, { roomId: room.id }); // incluso reingresando por la lista
    const ids = manager.state(room).members.map((m) => m.userId);
    expect(ids.filter((id) => id === ada.id)).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });

  it('un doble clic o la retransmisión del evento no repite la operación ni emite duplicados', async () => {
    const { manager, states, lists } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    const statesBefore = states.length;
    const listsBefore = lists.length;
    manager.returnToRoom(ada, room.id);
    manager.returnToRoom(ada, room.id);
    manager.returnToRoom(bit, room.id);
    // Nada cambió (ya estaban en la sala en espera): no hay difusiones nuevas.
    expect(states.length).toBe(statesBefore);
    expect(lists.length).toBe(listsBefore);
  });

  it('los demás jugadores reciben la lista actualizada cuando el estado cambia', async () => {
    const { manager, states } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    manager.disconnect(bit.id); // p. ej. recargó la página de resultados
    manager.returnToRoom(bit, room.id);
    const last = states[states.length - 1]!;
    expect(last.id).toBe(room.id);
    expect(last.members.find((m) => m.userId === bit.id)?.state).toBe('conectado');
    expect(last.status).toBe('lobby');
  });

  it('el jugador no sigue como miembro activo de la partida terminada', async () => {
    const { manager, ends } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    expect(ends).toHaveLength(1);
    expect(room.game).toBeNull();
    expect(room.status).toBe('lobby');
    expect(manager.state(room).members.every((m) => m.state === 'conectado')).toBe(true);
    expect(manager.handleInput(ada.id, { seq: 1, moveX: 1, moveY: 0, aim: 0, fire: false, dash: false })).toBe(false);
  });

  it('si la sala fue eliminada responde de forma explícita', async () => {
    const { manager } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    manager.leave(ada.id);
    manager.leave(bit.id); // la sala queda vacía y se cierra
    expect(manager.get(room.id)).toBeUndefined();
    let error: unknown = null;
    try {
      manager.returnToRoom(ada, room.id);
    } catch (e) {
      error = e;
    }
    expect(error instanceof RoomError && error.code).toBe('SALA_NO_EXISTE');
    expect(manager.current(ada.id)).toBeUndefined();
  });

  it('quien salió al lobby general ya no puede «volver» y no queda en dos salas', async () => {
    const { manager } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit]);
    manager.leave(bit.id); // «Salir al lobby general»
    expect(() => manager.returnToRoom(bit, room.id)).toThrow(/Ya no formas parte/);
    const other = manager.create(bit, { name: 'Otra', maxPlayers: 2, isPrivate: false });
    expect(manager.current(bit.id)?.id).toBe(other.id);
    expect(manager.isMember(room.id, bit.id)).toBe(false);
    // Crear otra sala desde la sala original también la abandona (nunca dos a la vez).
    manager.create(ada, { name: 'Tercera', maxPlayers: 2, isPrivate: false });
    expect(manager.isMember(room.id, ada.id)).toBe(false);
  });

  it('funciona con varios participantes y la sala sigue existiendo mientras sea válida', async () => {
    const { manager } = setup();
    current = manager;
    const room = await playMatch(manager, [ada, bit, cy]);
    for (const p of [ada, bit, cy]) expect(manager.returnToRoom(p, room.id).id).toBe(room.id);
    expect(manager.state(room).members).toHaveLength(3);
    manager.leave(cy.id);
    expect(manager.get(room.id)).toBeDefined(); // quedan 2 miembros: la sala sigue
    expect(manager.state(room).members.map((m) => m.username)).toEqual(['ada', 'bit']);
    // Se puede volver a jugar en la misma sala.
    manager.setReady(ada.id, true);
    manager.setReady(bit.id, true);
    await wait(40);
    expect(room.status).toBe('en_partida');
    expect(manager.list().filter((r) => r.id === room.id)).toHaveLength(1);
  });

  it('la lista de salas está versionada y solo cambia cuando cambia su contenido', () => {
    const { manager, lists } = setup();
    current = manager;
    manager.create(ada, { name: 'Uno', maxPlayers: 2, isPrivate: false });
    const v1 = manager.listPayload().version;
    manager.reconnect(ada.id); // sin cambios
    expect(manager.listPayload().version).toBe(v1);
    manager.join(bit, { roomId: manager.list()[0]!.id });
    expect(manager.listPayload().version).toBe(v1 + 1);
    const versions = lists.map((l) => l.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
