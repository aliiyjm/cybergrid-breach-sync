import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createServerApp, type ServerApp } from '../../server/src/app';
import { loadConfig } from '../../server/src/config';
import { createPool, type Database } from '../../server/src/database/pool';
import { configureLogger } from '../../server/src/lib/logger';

export interface TestServer {
  baseUrl: string;
  db: Database;
  server: ServerApp;
  close: () => Promise<void>;
}

/** Arranca la aplicación real (Express + Socket.IO + PostgreSQL) en un puerto libre. */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  configureLogger('warn', false);
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: url,
    NODE_ENV: 'test',
    SERVE_CLIENT: 'false',
    PORT: '0',
    LOG_LEVEL: 'warn',
    ...env,
  });
  const db = createPool(config);
  const server = createServerApp(config, db);
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    server,
    close: async () => {
      await server.close();
      await db.end();
    },
  };
}

let counter = 0;
export function uniqueName(prefix = 'u'): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 1e4)}`.slice(0, 20);
}

/** Registra un usuario y devuelve la cookie de sesión. */
export async function registerUser(
  baseUrl: string,
  username = uniqueName(),
  password = 'clave-de-prueba-123',
): Promise<{ username: string; cookie: string; id: string }> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) throw new Error(`Registro fallido: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  const body = (await res.json()) as { user: { id: string } };
  return { username, cookie, id: body.user.id };
}

/** Cliente Socket.IO autenticado con la cookie de sesión. */
export function connectSocket(baseUrl: string, cookie?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      extraHeaders: cookie ? { Cookie: cookie } : {},
      reconnection: false,
      forceNew: true,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

export function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 8000, predicate?: (data: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Tiempo agotado esperando "${event}"`));
    }, timeoutMs);
    const handler = (data: T): void => {
      if (predicate && !predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });
}
