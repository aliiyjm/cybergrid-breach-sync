import sharp from 'sharp';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AckResponse, RoomState } from '../../shared/protocol';
import { connectSocket, registerUser, startTestServer, waitForEvent, type TestServer } from '../helpers/testServer';

let ctx: TestServer;
const sockets: Socket[] = [];

const png = (w = 200, h = 160) =>
  sharp({ create: { width: w, height: h, channels: 4, background: '#2ee6ff' } }).png().toBuffer();

function upload(cookie: string, body: Buffer, opts: { name?: string; type?: string; query?: string } = {}) {
  return fetch(`${ctx.baseUrl}/api/profile/avatar${opts.query ?? ''}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': opts.type ?? 'image/png',
      'X-File-Name': encodeURIComponent(opts.name ?? 'yo.png'),
    },
    body: new Uint8Array(body),
  });
}

beforeAll(async () => {
  ctx = await startTestServer({ AVATAR_MAX_BYTES: String(200 * 1024) });
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await ctx?.close();
});

describe('Apariencia personalizada', () => {
  it('sube, sirve, reemplaza y restablece la imagen del propio usuario', async () => {
    const { cookie } = await registerUser(ctx.baseUrl);
    const res = await upload(cookie, await png(), { query: '?x=0.1&y=0&size=0.8' });
    expect(res.status).toBe(200);
    const { avatarUrl } = (await res.json()) as { avatarUrl: string };
    expect(avatarUrl).toMatch(/^\/api\/avatars\/[0-9a-f-]{36}\.png$/);

    const img = await fetch(`${ctx.baseUrl}${avatarUrl}`, { headers: { Cookie: cookie } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 128, 128]);

    const me = (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json())) as {
      user: { avatarUrl: string };
    };
    expect(me.user.avatarUrl).toBe(avatarUrl);

    // Reemplazar elimina la anterior.
    const second = (await (await upload(cookie, await png(300, 300))).json()) as { avatarUrl: string };
    expect(second.avatarUrl).not.toBe(avatarUrl);
    expect((await fetch(`${ctx.baseUrl}${avatarUrl}`, { headers: { Cookie: cookie } })).status).toBe(404);

    const reset = await fetch(`${ctx.baseUrl}/api/profile/avatar`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(reset.status).toBe(200);
    expect((await fetch(`${ctx.baseUrl}${second.avatarUrl}`, { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it('rechaza formatos, tamaños y contenidos no válidos en el backend', async () => {
    const { cookie } = await registerUser(ctx.baseUrl);
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).gif().toBuffer();
    expect((await upload(cookie, gif, { type: 'image/gif', name: 'a.gif' })).status).toBe(415);
    expect((await upload(cookie, gif, { name: 'a.png' })).status).toBe(415);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await upload(cookie, html, { name: 'x.png' })).status).toBe(415);
    expect((await upload(cookie, Buffer.alloc(300 * 1024, 1))).status).toBe(413);
    const corrupt = (await png()).subarray(0, 80);
    expect((await upload(cookie, corrupt)).status).toBe(422);
    expect((await upload(cookie, await png(), { query: '?path=../../etc' })).status).toBe(400);
  });

  it('solo se modifica la propia apariencia y hace falta sesión', async () => {
    expect((await upload('cg_session=no-es-valido-123456789012', await png())).status).toBe(401);
    expect((await fetch(`${ctx.baseUrl}/api/avatars/../../etc/passwd`)).status).toBeGreaterThanOrEqual(400);
    const { cookie } = await registerUser(ctx.baseUrl);
    expect((await fetch(`${ctx.baseUrl}/api/avatars/no-es-un-id.png`, { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it('se sincroniza con la sala sin duplicar ni desconectar al jugador', async () => {
    const a = await registerUser(ctx.baseUrl);
    const b = await registerUser(ctx.baseUrl);
    const sa = await connectSocket(ctx.baseUrl, a.cookie);
    const sb = await connectSocket(ctx.baseUrl, b.cookie);
    sockets.push(sa, sb);
    const created = (await sa.timeout(5000).emitWithAck('room:create', {
      name: 'Galería',
      maxPlayers: 2,
      isPrivate: false,
    })) as AckResponse<RoomState>;
    const roomId = created.data!.id;
    await sb.timeout(5000).emitWithAck('room:join', { roomId });

    const updated = waitForEvent<RoomState>(sb, 'room:state', 5000, (s) =>
      s.members.some((m) => m.userId === a.id && m.avatarUrl !== null),
    );
    const res = await upload(a.cookie, await png());
    const { avatarUrl } = (await res.json()) as { avatarUrl: string };
    const state = await updated;
    expect(state.id).toBe(roomId);
    expect(state.members).toHaveLength(2);
    expect(state.members.find((m) => m.userId === a.id)?.avatarUrl).toBe(avatarUrl);
    expect(state.members.find((m) => m.userId === a.id)?.state).toBe('conectado');
    expect(sa.connected).toBe(true);
    // El otro jugador puede descargar la imagen para dibujarla.
    expect((await fetch(`${ctx.baseUrl}${avatarUrl}`, { headers: { Cookie: b.cookie } })).status).toBe(200);
  });
});
