import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../database/pool';
import { avatarUrlFor, deleteSession, findSessionUser, insertSession } from '../database/repositories';
import type { PublicUser } from '../../../shared/protocol';

export const SESSION_COOKIE = 'cg_session';

/**
 * Sesiones opacas: el navegador recibe un token aleatorio de 256 bits en una
 * cookie HttpOnly; en la base de datos solo se guarda su SHA-256. Así, una
 * filtración de la tabla `sessions` no permite suplantar sesiones, y cerrar
 * sesión revoca el token de inmediato.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export class SessionService {
  constructor(
    private readonly db: Queryable,
    private readonly ttlMs: number,
  ) {}

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await insertSession(this.db, hashToken(token), userId, expiresAt);
    return { token, expiresAt };
  }

  async resolve(token: string | undefined | null): Promise<PublicUser | null> {
    if (!token || token.length < 20 || token.length > 100) return null;
    const row = await findSessionUser(this.db, hashToken(token));
    return row ? { id: row.id, username: row.username, avatarUrl: avatarUrlFor(row.avatar_id) } : null;
  }

  async revoke(token: string): Promise<void> {
    await deleteSession(this.db, hashToken(token));
  }
}

/** Analiza la cabecera Cookie sin dependencias externas. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Extrae el token de la cookie o de `Authorization: Bearer …` (útil para curl/Postman). */
export function extractToken(headers: { cookie?: string | undefined; authorization?: string | undefined }): string | null {
  const auth = headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return parseCookies(headers.cookie)[SESSION_COOKIE] ?? null;
}
