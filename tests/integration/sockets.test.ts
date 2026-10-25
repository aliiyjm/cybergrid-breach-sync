import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AckResponse, GameSnapshot, GameStartPayload, RoomState, ServerError } from '../../shared/protocol';
import { connectSocket, registerUser, startTestServer, waitForEvent, type TestServer } from '../helpers/testServer';

let ctx: TestServer;
const sockets: Socket[] = [];

async function userSocket(): Promise<{ socket: Socket; id: string; cookie: string }> {
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

beforeAll(async () => {
  ctx = await startTestServer({ MATCH_DURATION_S: '30' });
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await ctx?.close();
});

describe('Socket.IO autenticado', () => {
  it('rechaza conexiones sin sesión válida', async () => {
    await expect(connectSocket(ctx.baseUrl)).rejects.toThrow('NO_AUTENTICADO');
    await expect(connectSocket(ctx.baseUrl, 'cg_session=token-falso-de-prueba-123456')).rejects.toThrow('NO_AUTENTICADO');
  });

  it('mide la latencia con ping/pong por WebSocket', async () => {
    const { socket } = await userSocket();
    expect(socket.io.engine.transport.name).toBe('websocket');
    const rtts: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const res = (await socket.timeout(2000).emitWithAck('net:ping', { t })) as { t: number; serverTime: number };
      expect(res.t).toBe(t);
      rtts.push(performance.now() - t);
    }
    rtts.sort((a, b) => a - b);
    console.log(`[ping] min=${rtts[0]?.toFixed(2)} ms mediana=${rtts[10]?.toFixed(2)} ms max=${rtts[19]?.toFixed(2)} ms`);
    expect(rtts[10]).toBeLessThan(100);
  });
});

describe('Salas y partida en tiempo real', () => {
  it('protege salas privadas, sincroniza estados de listo e inicia la partida', async () => {
    const a = await userSocket();
    const b = await userSocket();

    const created = await ack<RoomState>(a.socket, 'room:create', {
      name: 'Prueba integración',
      maxPlayers: 2,
      isPrivate: true,
      accessCode: 'CLAVE9',
    });
    expect(created.ok).toBe(true);
    const roomId = (created.data as RoomState).id;

    const denied = await ack(b.socket, 'room:join', { roomId, accessCode: 'MALA00' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'ACCESO_DENEGADO' } });

    // REST: un no miembro no puede ver la sala privada.
    const rest = await fetch(`${ctx.baseUrl}/api/rooms/${roomId}`, { headers: { Cookie: b.cookie } });
    expect(rest.status).toBe(403);

    const aSeesJoin = waitForEvent<RoomState>(a.socket, 'room:state', 5000, (s) => s.members.length === 2);
    const joined = await ack<RoomState>(b.socket, 'room:join', { roomId, accessCode: 'CLAVE9' });
    expect(joined.ok).toBe(true);
    expect((await aSeesJoin).members.map((m) => m.state)).toEqual(['conectado', 'conectado']);

    const aSeesReady = waitForEvent<RoomState>(a.socket, 'room:state', 5000, (s) =>
      s.members.some((m) => m.userId === b.id && m.state === 'listo'),
    );
    await ack(b.socket, 'room:ready', { ready: true });
    await aSeesReady;

    const startA = waitForEvent<GameStartPayload>(a.socket, 'game:start', 8000);
    const startB = waitForEvent<GameStartPayload>(b.socket, 'game:start', 8000);
    await ack(a.socket, 'room:ready', { ready: true });
    const [payloadA, payloadB] = await Promise.all([startA, startB]);
    expect(payloadA.matchId).toBe(payloadB.matchId);
    expect(payloadA.yourId).toBe(a.id);
    expect(payloadA.map.tiles).toHaveLength(payloadA.map.cols * payloadA.map.rows);

    // Movimiento autoritativo: se envía una intención y el servidor mueve al jugador.
    const first = await waitForEvent<GameSnapshot>(a.socket, 'game:snapshot');
    const start = first.players.find((p) => p.id === a.id)!;
    let seq = 1;
    const interval = setInterval(() => {
      a.socket.emit('game:input', { seq: seq++, moveX: 1, moveY: 0, aim: 0, fire: false, dash: false });
    }, 33);
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(interval);
    const later = await waitForEvent<GameSnapshot>(a.socket, 'game:snapshot');
    const end = later.players.find((p) => p.id === a.id)!;
    const elapsedS = (later.serverTime - first.serverTime) / 1000;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    // Puede chocar con un muro, pero nunca superar la velocidad máxima del servidor.
    expect(moved).toBeLessThanOrEqual(220 * elapsedS + 10);
    expect(later.acks[a.id]).toBeGreaterThan(0);

    // Una intención manipulada se rechaza y se notifica.
    const rejected = waitForEvent<ServerError>(a.socket, 'error:event');
    a.socket.emit('game:input', { seq: 99999, moveX: 50, moveY: 0, aim: 0, fire: false, dash: false, x: 9999 });
    expect((await rejected).code).toBe('EVENTO_INVALIDO');
  });
});
