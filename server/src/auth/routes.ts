import { Router, type Request, type Response } from 'express';
import type { Database } from '../database/pool';
import { avatarUrlFor, createUser, findUserByUsername, getAvatarIdForUser } from '../database/repositories';
import { HttpError, validationError } from '../lib/errors';
import { FixedWindowLimiter } from '../lib/RateLimiter';
import { loginSchema, registerSchema } from '../validation/schemas';
import { getDummyHash, hashPassword, verifyPassword } from './password';
import { SESSION_COOKIE, extractToken, type SessionService } from './SessionService';
import { requireAuth, type AuthLocals } from './middleware';

export interface AuthRouterOptions {
  db: Database;
  sessions: SessionService;
  sessionTtlMs: number;
  cookieSecure: boolean;
  /** Se invoca al cerrar sesión para desconectar los sockets de ese usuario. */
  onLogout?: (userId: string) => void;
  /** En el entorno de pruebas se relajan los límites para no interferir con las suites. */
  relaxedRateLimits?: boolean;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { db, sessions } = options;
  const router = Router();
  const factor = options.relaxedRateLimits ? 100 : 1;
  const loginLimiter = new FixedWindowLimiter(10 * factor, 5 * 60_000);
  const registerLimiter = new FixedWindowLimiter(30 * factor, 60 * 60_000);

  const setSessionCookie = (res: Response, token: string): void => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure,
      maxAge: options.sessionTtlMs,
      path: '/',
    });
  };

  const rateLimit = (limiter: FixedWindowLimiter, key: string, res: Response): void => {
    const retryMs = limiter.hit(key);
    if (retryMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
      throw new HttpError(429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera unos minutos y vuelve a probar.');
    }
  };

  router.post('/register', async (req: Request, res: Response) => {
    rateLimit(registerLimiter, req.ip ?? 'desconocida', res);
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const passwordHash = await hashPassword(parsed.data.password);
    const user = await createUser(db, parsed.data.username, passwordHash);
    if (!user) throw new HttpError(409, 'USUARIO_EXISTE', 'Ese nombre de usuario ya está en uso');

    const session = await sessions.create(user.id);
    setSessionCookie(res, session.token);
    res.status(201).json({ user: { id: user.id, username: user.username, avatarUrl: null } });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);
    const limiterKey = `${req.ip ?? 'desconocida'}:${parsed.data.username.toLowerCase()}`;
    rateLimit(loginLimiter, limiterKey, res);

    const user = await findUserByUsername(db, parsed.data.username);
    // Si el usuario no existe se verifica igualmente contra un hash ficticio
    // para no revelar, por tiempo de respuesta, qué nombres están registrados.
    const valid = await verifyPassword(parsed.data.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !valid) {
      throw new HttpError(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos');
    }
    loginLimiter.reset(limiterKey);
    const session = await sessions.create(user.id);
    setSessionCookie(res, session.token);
    const avatarUrl = avatarUrlFor(await getAvatarIdForUser(db, user.id));
    res.json({ user: { id: user.id, username: user.username, avatarUrl } });
  });

  router.post('/logout', async (req: Request, res: Response) => {
    const token = extractToken(req.headers);
    if (token) {
      const user = await sessions.resolve(token);
      await sessions.revoke(token);
      if (user) options.onLogout?.(user.id);
    }
    res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: options.cookieSecure });
    res.status(204).end();
  });

  router.get('/me', requireAuth(sessions), (_req: Request, res: Response) => {
    res.json({ user: (res.locals as AuthLocals).user });
  });

  return router;
}
