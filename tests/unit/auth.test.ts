import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../server/src/auth/password';
import { extractToken, generateToken, hashToken, parseCookies } from '../../server/src/auth/SessionService';
import { FixedWindowLimiter, TokenBucket } from '../../server/src/lib/RateLimiter';

describe('Contraseñas y sesiones', () => {
  it('almacena un hash scrypt con sal y lo verifica', async () => {
    const hash = await hashPassword('contraseña-segura');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(hash).not.toContain('contraseña-segura');
    expect(await verifyPassword('contraseña-segura', hash)).toBe(true);
    expect(await verifyPassword('otra', hash)).toBe(false);
    expect(await verifyPassword('contraseña-segura', 'texto-plano')).toBe(false);
    // Misma contraseña ⇒ hash distinto (sal aleatoria).
    expect(await hashPassword('contraseña-segura')).not.toBe(hash);
  });

  it('genera tokens de sesión opacos y solo guarda su SHA-256', () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(token);
    expect(generateToken()).not.toBe(token);
  });

  it('extrae el token de la cookie o de la cabecera Authorization', () => {
    expect(parseCookies('a=1; cg_session=abc%2Fdef; b=2')).toEqual({ a: '1', cg_session: 'abc/def', b: '2' });
    expect(extractToken({ cookie: 'cg_session=xyz' })).toBe('xyz');
    expect(extractToken({ authorization: 'Bearer tok123', cookie: 'cg_session=xyz' })).toBe('tok123');
    expect(extractToken({})).toBeNull();
  });
});

describe('Control de frecuencia', () => {
  it('el cubo de fichas limita ráfagas y se recarga con el tiempo', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 10, () => now);
    expect([1, 2, 3, 4].map(() => bucket.tryConsume())).toEqual([true, true, true, false]);
    now += 100; // +1 ficha
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('la ventana fija bloquea intentos de fuerza bruta', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 1000, () => now);
    expect(limiter.hit('ip:user')).toBe(0);
    expect(limiter.hit('ip:user')).toBe(0);
    expect(limiter.hit('ip:user')).toBeGreaterThan(0);
    expect(limiter.hit('otra')).toBe(0);
    now = 1001;
    expect(limiter.hit('ip:user')).toBe(0);
  });
});
