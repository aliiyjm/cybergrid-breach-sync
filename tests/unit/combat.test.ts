import { describe, expect, it } from 'vitest';
import { GAME } from '../../shared/constants';
import {
  applyDamage,
  canFire,
  computeDamage,
  damageFalloff,
  streakMultiplier,
} from '../../server/src/game/CombatSystem';

describe('Fórmula de daño', () => {
  it('aplica el daño base completo a corta distancia', () => {
    expect(computeDamage(0)).toBe(GAME.BASE_DAMAGE);
    expect(computeDamage(GAME.FALLOFF_START)).toBe(GAME.BASE_DAMAGE);
  });

  it('reduce el daño linealmente hasta el 50 % en el alcance máximo', () => {
    expect(damageFalloff(GAME.PROJECTILE_RANGE)).toBeCloseTo(GAME.FALLOFF_MIN);
    const mid = (GAME.FALLOFF_START + GAME.PROJECTILE_RANGE) / 2;
    expect(damageFalloff(mid)).toBeCloseTo((1 + GAME.FALLOFF_MIN) / 2);
    expect(computeDamage(GAME.PROJECTILE_RANGE)).toBe(Math.round(GAME.BASE_DAMAGE * GAME.FALLOFF_MIN));
    // Más allá del alcance no baja del mínimo.
    expect(damageFalloff(GAME.PROJECTILE_RANGE * 3)).toBeCloseTo(GAME.FALLOFF_MIN);
  });

  it('nunca produce daño negativo', () => {
    expect(computeDamage(-50)).toBe(GAME.BASE_DAMAGE);
    expect(computeDamage(100, -3)).toBe(GAME.BASE_DAMAGE);
    expect(computeDamage(100, 0, 0)).toBe(0);
  });
});

describe('Escalado del daño por racha', () => {
  it('suma un 10 % por eliminación consecutiva', () => {
    expect(streakMultiplier(0)).toBe(1);
    expect(streakMultiplier(1)).toBeCloseTo(1.1);
    expect(computeDamage(0, 2)).toBe(Math.round(GAME.BASE_DAMAGE * 1.2));
  });

  it('limita la bonificación al 30 %', () => {
    expect(streakMultiplier(3)).toBeCloseTo(1.3);
    expect(streakMultiplier(50)).toBeCloseTo(1.3);
    expect(computeDamage(0, 50)).toBe(26);
  });
});

describe('Aplicación de daño y cadencia', () => {
  it('resta vida, elimina al llegar a 0 y respeta la protección de reaparición', () => {
    const target = { hp: 30, alive: true, protectedUntil: 1000 };
    expect(applyDamage(target, 20, 500)).toEqual({ applied: 0, killed: false }); // protegido
    expect(applyDamage(target, 20, 1500)).toEqual({ applied: 20, killed: false });
    expect(target.hp).toBe(10);
    expect(applyDamage(target, 20, 1600)).toEqual({ applied: 10, killed: true });
    expect(target).toMatchObject({ hp: 0, alive: false });
    expect(applyDamage(target, 20, 1700).applied).toBe(0); // ya eliminado
  });

  it('impone la cadencia de disparo', () => {
    expect(canFire(-Infinity, 0)).toBe(true);
    expect(canFire(1000, 1000 + GAME.FIRE_COOLDOWN_MS - 1)).toBe(false);
    expect(canFire(1000, 1000 + GAME.FIRE_COOLDOWN_MS)).toBe(true);
  });
});
