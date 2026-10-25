import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchResult, RoomState } from '../../shared/protocol';
import { RoomError, RoomManager, type RoomNotifier } from '../../server/src/rooms/RoomManager';

const ada = { id: 'u-ada', username: 'ada' };
const bit = { id: 'u-bit', username: 'bit' };
const cy = { id: 'u-cy', username: 'cy' };

function createManager() {
  const states: RoomState[] = [];
  const started: string[] = [];
  const notifier: RoomNotifier = {
    roomState: (s) => states.push(s),
    roomsChanged: () => undefined,
    roomClosed: () => undefined,
    gameStart: (room) => started.push(room.id),
    snapshot: () => undefined,
    event: () => undefined,
    gameEnd: () => undefined,
    appearance: () => undefined,
  };
  const persisted: MatchResult[] = [];
  const manager = new RoomManager({
    notifier,
    matchDurationMs: 60_000,
    countdownMs: 50,
    graceMs: 100,
    persistMatch: async (r) => {
      persisted.push(r);
    },
  });
  return { manager, states, started, persisted };
}

let current: RoomManager | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
  vi.useRealTimers();
});

describe('Salas: permisos y capacidad', () => {
  it('protege las salas privadas con código y respeta la capacidad', () => {
    const { manager } = createManager();
    current = manager;
    const room = manager.create(ada, { name: 'Bóveda', maxPlayers: 2, isPrivate: true, accessCode: 'NEON42' });
    expect(() => manager.join(bit, { roomId: room.id })).toThrowError(RoomError);
    expect(() => manager.join(bit, { roomId: room.id, accessCode: 'MAL123' })).toThrow(/Código de acceso incorrecto/);
    manager.join(bit, { roomId: room.id, accessCode: 'neon42' }); // no distingue mayúsculas
    expect(() => manager.join(cy, { roomId: room.id, accessCode: 'NEON42' })).toThrow(/llena/);
    expect(() => manager.join(cy, { roomId: 'noexiste' })).toThrow(/no existe/);
    expect(manager.state(room).members.map((m) => m.username)).toEqual(['ada', 'bit']);
    expect(manager.state(room).members[0]?.isOwner).toBe(true);
  });

  it('transfiere la propiedad al salir el creador y cierra la sala vacía', () => {
    const { manager } = createManager();
    current = manager;
    const room = manager.create(ada, { name: 'Nodo', maxPlayers: 4, isPrivate: false });
    manager.join(bit, { roomId: room.id });
    manager.leave(ada.id);
    expect(manager.get(room.id)?.ownerId).toBe(bit.id);
    manager.leave(bit.id);
    expect(manager.get(room.id)).toBeUndefined();
  });
});

describe('Salas: estado de listo e inicio de partida', () => {
  it('inicia la cuenta atrás solo cuando todos están listos y la cancela si alguien deja de estarlo', async () => {
    const { manager, started } = createManager();
    current = manager;
    const room = manager.create(ada, { name: 'Nodo', maxPlayers: 4, isPrivate: false });
    manager.setReady(ada.id, true);
    expect(room.status).toBe('lobby'); // un solo jugador no basta
    manager.join(bit, { roomId: room.id });
    manager.setReady(bit.id, true);
    expect(room.status).toBe('cuenta_atras');
    manager.setReady(bit.id, false);
    expect(room.status).toBe('lobby');
    manager.setReady(bit.id, true);
    await new Promise((r) => setTimeout(r, 120));
    expect(room.status).toBe('en_partida');
    expect(started).toEqual([room.id]);
    expect(room.game?.players.size).toBe(2);
    expect(() => manager.join(cy, { roomId: room.id })).toThrow(/en curso/);
  });

  it('marca desconectados, permite reconectar y expulsa tras el periodo de gracia', async () => {
    const { manager } = createManager();
    current = manager;
    const room = manager.create(ada, { name: 'Nodo', maxPlayers: 4, isPrivate: false });
    manager.join(bit, { roomId: room.id });
    manager.disconnect(bit.id);
    expect(manager.state(room).members.find((m) => m.userId === bit.id)?.state).toBe('desconectado');
    manager.reconnect(bit.id);
    expect(manager.state(room).members.find((m) => m.userId === bit.id)?.state).toBe('conectado');
    manager.disconnect(bit.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.isMember(room.id, bit.id)).toBe(false);
  });
});
