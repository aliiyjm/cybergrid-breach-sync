import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AckResponse, GameStartPayload, MatchResult, RoomListPayload, RoomState } from '../../shared/protocol';
import { connectSocket, registerUser, startTestServer, waitForEvent, type TestServer } from '../helpers/testServer';

/**
 * Regresión de extremo a extremo (HTTP + Socket.IO reales) del regreso al
 * lobby tras una partida y de la configuración de puntuación.
 */

let ctx: TestServer;
const sockets: Socket[] = [];

async function player(): Promise<{ socket: Socket; id: string; cookie: string }> {
  const user = await registerUser(ctx.baseUrl);
  const socket = await connectSocket(ctx.baseUrl, user.cookie);
  sockets.push(socket);
  return { socket, id: user.id, cookie: user.cookie };
}

function ack<T>(socket: Socket, event: string, payload?: unknown): Promise<AckResponse<T>> {
  return payload === undefined
    ? socket.timeout(5000).emitWithAck(event)
    : socket.timeout(5000).emitWithAck(event, payload);
}

/** Crea sala, une a todos, los marca listos y termina la partida desde el servidor. */
async function playAndFinish(players: Array<{ socket: Socket; id: string }>, scoreToWin = 15) {
  const [host, ...rest] = players as [{ socket: Socket; id: string }, ...Array<{ socket: Socket; id: string }>];
  const created = await ack<RoomState>(host.socket, 'room:create', {
    name: `Regreso ${Math.floor(Math.random() * 1e6)}`,
    maxPlayers: 8,
    isPrivate: false,
    scoreToWin,
  });
  expect(created.ok).toBe(true);
  const room = created.data as RoomState;
  for (const p of rest) expect((await ack(p.socket, 'room:join', { roomId: room.id })).ok).toBe(true);
  const starts = players.map((p) => waitForEvent<GameStartPayload>(p.socket, 'game:start', 10_000));
  for (const p of players) await ack(p.socket, 'room:ready', { ready: true });
  const payloads = await Promise.all(starts);
  const ends = players.map((p) => waitForEvent<MatchResult>(p.socket, 'game:end', 10_000));
  // Tras el fin, el servidor devuelve la sala a «en espera»: se espera ese estado.
  const lobbies = players.map((p) =>
    waitForEvent<RoomState>(p.socket, 'room:state', 10_000, (s) => s.id === room.id && s.status === 'lobby'),
  );
  ctx.server.rooms.get(room.id)!.game!.finish('puntuacion');
  const results = await Promise.all(ends);
  await Promise.all(lobbies);
  return { room, payloads, results };
}

beforeAll(async () => {
  ctx = await startTestServer({ MATCH_DURATION_S: '60' });
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await ctx?.close();
});

describe('Puntuación para ganar', () => {
  it('el servidor fija objetivo y duración y todos reciben la misma configuración', async () => {
    const a = await player();
    const b = await player();
    const rejected = await ack(a.socket, 'room:create', { name: 'Trampa', maxPlayers: 2, isPrivate: false, scoreToWin: 999 });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'VALIDACION' } });

    const { room, payloads, results } = await playAndFinish([a, b], 25);
    expect(room).toMatchObject({ scoreToWin: 25, durationMs: 100_000 }); // 60 s × 25 / 15
    for (const p of payloads) expect(p).toMatchObject({ scoreToWin: 25, durationMs: 100_000 });
    for (const r of results) expect(r).toMatchObject({ scoreToWin: 25, timeLimitMs: 100_000 });

    const list = (await fetch(`${ctx.baseUrl}/api/rooms`, { headers: { Cookie: a.cookie } }).then((r) => r.json())) as {
      matchOptions: Array<{ scoreToWin: number; durationMs: number }>;
    };
    const options = list.matchOptions;
    expect(options).toEqual([
      { scoreToWin: 15, durationMs: 60_000 },
      { scoreToWin: 25, durationMs: 100_000 },
      { scoreToWin: 30, durationMs: 120_000 },
    ]);
    const saved = await ctx.db.query<{ score_to_win: number; time_limit_ms: number }>(
      'SELECT score_to_win, time_limit_ms FROM matches WHERE id = $1',
      [results[0]!.matchId],
    );
    expect(saved.rows[0]).toEqual({ score_to_win: 25, time_limit_ms: 100_000 });
  });
});

describe('Volver al lobby tras una partida', () => {
  it('conserva el id, no duplica jugadores ni salas y es idempotente ante doble clic', async () => {
    const a = await player();
    const b = await player();
    const { room } = await playAndFinish([a, b]);

    const listSocket = await player();
    const listsSeen: RoomListPayload[] = [];
    listSocket.socket.on('rooms:changed', (p: RoomListPayload) => listsSeen.push(p));
    const statesSeenByB: RoomState[] = [];
    b.socket.on('room:state', (s: RoomState) => statesSeenByB.push(s));

    // Doble clic: dos peticiones simultáneas y una retransmisión.
    const [r1, r2] = await Promise.all([
      ack<RoomState>(a.socket, 'room:return', { roomId: room.id }),
      ack<RoomState>(a.socket, 'room:return', { roomId: room.id }),
    ]);
    const r3 = await ack<RoomState>(a.socket, 'room:return', { roomId: room.id });
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(true);
      expect(r.data?.id).toBe(room.id);
      expect(r.data?.status).toBe('lobby');
      expect(r.data?.members.filter((m) => m.userId === a.id)).toHaveLength(1);
      expect(r.data?.members).toHaveLength(2);
    }
    await new Promise((r) => setTimeout(r, 200));
    // Nada cambió: ni lista ni estado de sala se re-emiten.
    expect(listsSeen).toHaveLength(0);
    expect(statesSeenByB).toHaveLength(0);

    const listed = (await fetch(`${ctx.baseUrl}/api/rooms`, { headers: { Cookie: a.cookie } }).then((r) => r.json())) as RoomListPayload;
    expect(listed.rooms.filter((r) => r.id === room.id)).toHaveLength(1);
    expect(listed.rooms.filter((r) => r.name === room.name)).toHaveLength(1);

    // Suscripción única: el canal de la sala contiene exactamente un socket por miembro.
    const channel = ctx.server.io.of('/').adapter.rooms.get(`room:${room.id}`);
    expect(channel?.size).toBe(2);
  });

  it('los demás reciben el estado actualizado y quien sale al lobby general deja de ser miembro', async () => {
    const a = await player();
    const b = await player();
    const c = await player();
    const { room } = await playAndFinish([a, b, c]);
    for (const p of [a, b, c]) expect((await ack(p.socket, 'room:return', { roomId: room.id })).ok).toBe(true);

    const update = waitForEvent<RoomState>(a.socket, 'room:state', 5000, (s) => s.members.length === 2);
    expect((await ack(c.socket, 'room:leave')).ok).toBe(true);
    const state = await update;
    expect(state.id).toBe(room.id);
    expect(state.members.map((m) => m.userId).sort()).toEqual([a.id, b.id].sort());

    const back = await ack(c.socket, 'room:return', { roomId: room.id });
    expect(back).toMatchObject({ ok: false, error: { code: 'NO_ERES_MIEMBRO' } });
    expect((await ack<RoomState | null>(c.socket, 'room:current')).data).toBeNull();
    expect((await ack<RoomState | null>(a.socket, 'room:current')).data?.id).toBe(room.id);
  });

  it('si la sala fue eliminada la respuesta es explícita y se puede seguir en el lobby', async () => {
    const a = await player();
    const b = await player();
    const { room } = await playAndFinish([a, b]);
    await ack(a.socket, 'room:leave');
    await ack(b.socket, 'room:leave');
    const back = await ack(a.socket, 'room:return', { roomId: room.id });
    expect(back).toMatchObject({ ok: false, error: { code: 'SALA_NO_EXISTE' } });
    const list = await ack<RoomListPayload>(a.socket, 'room:list');
    expect(list.data?.rooms.some((r) => r.id === room.id)).toBe(false);
    expect((await ack(a.socket, 'room:create', { name: 'Nueva', maxPlayers: 2, isPrivate: false })).ok).toBe(true);
  });
});
