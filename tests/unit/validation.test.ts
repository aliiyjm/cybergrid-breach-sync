import { describe, expect, it } from 'vitest';
import {
  createRoomSchema,
  inputSchema,
  joinRoomSchema,
  loginSchema,
  registerSchema,
  seedPayloadSchema,
} from '../../server/src/validation/schemas';

describe('Esquemas Zod: payloads válidos', () => {
  it('acepta una intención de movimiento válida', () => {
    const r = inputSchema.safeParse({ seq: 1, moveX: -1, moveY: 0.5, aim: 3.14, fire: true, dash: false });
    expect(r.success).toBe(true);
  });

  it('acepta un payload de seed y aplica valores por defecto', () => {
    const r = seedPayloadSchema.parse({ matches: 100 });
    expect(r).toEqual({ matches: 100, playersPerMatch: 4, reset: false, maxDurationS: 180 });
    expect(seedPayloadSchema.safeParse({ matches: 1000, playersPerMatch: 8, seed: 42, batchId: 'lote-1' }).success).toBe(true);
  });

  it('acepta salas públicas y privadas bien formadas', () => {
    expect(createRoomSchema.safeParse({ name: 'Nodo Sur', maxPlayers: 4, isPrivate: false }).success).toBe(true);
    expect(
      createRoomSchema.safeParse({ name: 'Bóveda #2', maxPlayers: 2, isPrivate: true, accessCode: 'NEON42' }).success,
    ).toBe(true);
    expect(joinRoomSchema.safeParse({ roomId: 'abcDEF12', accessCode: 'NEON42' }).success).toBe(true);
  });
});

describe('Esquemas Zod: rechazo de payloads inválidos', () => {
  it('rechaza intenciones fuera de rango, no finitas o con campos extra', () => {
    const base = { seq: 1, moveX: 0, moveY: 0, aim: 0, fire: false, dash: false };
    expect(inputSchema.safeParse({ ...base, moveX: 5 }).success).toBe(false); // velocidad ilegal
    expect(inputSchema.safeParse({ ...base, moveY: Number.NaN }).success).toBe(false);
    expect(inputSchema.safeParse({ ...base, aim: 10 }).success).toBe(false);
    expect(inputSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(inputSchema.safeParse({ ...base, x: 500, y: 500 }).success).toBe(false); // posición inyectada
    expect(inputSchema.safeParse({ ...base, damage: 999 }).success).toBe(false);
    expect(inputSchema.safeParse('hola').success).toBe(false);
  });

  it('rechaza seeds fuera de 100-1000 partidas o con tipos incorrectos', () => {
    expect(seedPayloadSchema.safeParse({ matches: 99 }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({ matches: 1001 }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({ matches: '500' }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({ matches: 150.5 }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({ matches: 100, playersPerMatch: 9 }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({ matches: 100, batchId: '../../etc' }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({ matches: 100, hack: true }).success).toBe(false);
    expect(seedPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rechaza credenciales y salas mal formadas con mensajes en español', () => {
    const r = registerSchema.safeParse({ username: 'ab', password: '123' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages).toContain('Debe tener al menos 3 caracteres');
      expect(messages).toContain('Debe tener al menos 8 caracteres');
    }
    expect(registerSchema.safeParse({ username: 'José!', password: '12345678' }).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'neo' }).success).toBe(false);
    // Sala privada sin código.
    expect(createRoomSchema.safeParse({ name: 'Secreta', maxPlayers: 4, isPrivate: true }).success).toBe(false);
    expect(createRoomSchema.safeParse({ name: 'Sala', maxPlayers: 99, isPrivate: false }).success).toBe(false);
    expect(createRoomSchema.safeParse({ name: '<script>', maxPlayers: 4, isPrivate: false }).success).toBe(false);
  });
});
