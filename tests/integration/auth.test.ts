import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerUser, startTestServer, uniqueName, type TestServer } from '../helpers/testServer';

let ctx: TestServer;

const json = (method: string, path: string, body?: unknown, cookie?: string) =>
  fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx?.close();
});

describe('Autenticación HTTP', () => {
  it('registra, inicia sesión, consulta /me y cierra sesión', async () => {
    const username = uniqueName('neo');
    const { cookie } = await registerUser(ctx.baseUrl, username, 'matrix-1999');
    expect(cookie).toMatch(/^cg_session=/);

    const me = await json('GET', '/api/auth/me', undefined, cookie);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe(username);

    const login = await json('POST', '/api/auth/login', { username: username.toUpperCase(), password: 'matrix-1999' });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const logout = await json('POST', '/api/auth/logout', undefined, cookie);
    expect(logout.status).toBe(204);
    expect((await json('GET', '/api/auth/me', undefined, cookie)).status).toBe(401);
  });

  it('rechaza credenciales incorrectas sin revelar si el usuario existe', async () => {
    const { username } = await registerUser(ctx.baseUrl);
    const wrongPass = await json('POST', '/api/auth/login', { username, password: 'incorrecta-123' });
    const noUser = await json('POST', '/api/auth/login', { username: 'nadie_existe_aqui', password: 'incorrecta-123' });
    expect(wrongPass.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(await wrongPass.json()).toEqual(await noUser.json());
  });

  it('impide nombres duplicados y valida el formulario', async () => {
    const { username } = await registerUser(ctx.baseUrl);
    expect((await json('POST', '/api/auth/register', { username, password: 'otra-clave-1' })).status).toBe(409);
    const bad = await json('POST', '/api/auth/register', { username: 'a', password: 'x' });
    expect(bad.status).toBe(400);
  });

  it('no guarda contraseñas en texto plano', async () => {
    const { username } = await registerUser(ctx.baseUrl, uniqueName('plain'), 'texto-visible-42');
    const { rows } = await ctx.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE username = $1', [username]);
    expect(rows[0]?.password_hash).toMatch(/^scrypt\$/);
    expect(rows[0]?.password_hash).not.toContain('texto-visible-42');
  });

  it('protege las rutas privadas y bloquea peticiones de otros orígenes', async () => {
    expect((await fetch(`${ctx.baseUrl}/api/rooms`)).status).toBe(401);
    expect((await fetch(`${ctx.baseUrl}/api/stats/me`)).status).toBe(401);
    const forged = await fetch(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://sitio-malicioso.example' },
      body: JSON.stringify({ username: 'x', password: 'y' }),
    });
    expect(forged.status).toBe(403);
    const health = await fetch(`${ctx.baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-response-time')).toMatch(/ms$/);
  });
});
