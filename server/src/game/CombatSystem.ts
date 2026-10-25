import { GAME } from '../../../shared/constants';
import { clamp, lerp } from '../../../shared/math';

/**
 * Reglas de combate verificadas en el servidor.
 *
 * Fórmula de daño:
 *   daño = round( BASE × caída(d) × (1 + bonusRacha) )
 *   caída(d) = 1                                  si d ≤ FALLOFF_START
 *            = lerp(1, FALLOFF_MIN, (d − START) / (RANGE − START))  en otro caso
 *   bonusRacha = min(racha × STREAK_BONUS, STREAK_BONUS_MAX)
 *
 * Con los valores por defecto: 20 de daño a corta distancia, 10 en el alcance
 * máximo (650 px) y hasta 26 con una racha de 3 o más eliminaciones.
 */

export function damageFalloff(distance: number): number {
  if (distance <= GAME.FALLOFF_START) return 1;
  const t = clamp((distance - GAME.FALLOFF_START) / (GAME.PROJECTILE_RANGE - GAME.FALLOFF_START), 0, 1);
  return lerp(1, GAME.FALLOFF_MIN, t);
}

export function streakMultiplier(streak: number): number {
  return 1 + Math.min(Math.max(0, streak) * GAME.STREAK_BONUS, GAME.STREAK_BONUS_MAX);
}

export function computeDamage(distance: number, streak = 0, base: number = GAME.BASE_DAMAGE): number {
  const value = base * damageFalloff(Math.max(0, distance)) * streakMultiplier(streak);
  return Math.max(0, Math.round(value));
}

export function canFire(lastFireAt: number, now: number, cooldownMs: number = GAME.FIRE_COOLDOWN_MS): boolean {
  return now - lastFireAt >= cooldownMs;
}

export interface Damageable {
  hp: number;
  alive: boolean;
  protectedUntil: number;
}

export interface DamageOutcome {
  applied: number;
  killed: boolean;
}

/** Aplica daño respetando la protección de reaparición. Modifica `target`. */
export function applyDamage(target: Damageable, amount: number, now: number): DamageOutcome {
  if (!target.alive || amount <= 0 || now < target.protectedUntil) return { applied: 0, killed: false };
  const applied = Math.min(target.hp, amount);
  target.hp -= applied;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    return { applied, killed: true };
  }
  return { applied, killed: false };
}

/**
 * Escudo de energía: absorbe daño antes que la vida.
 * Devuelve el escudo restante, lo absorbido y el daño que pasa a la vida.
 */
export function absorbWithShield(shield: number, amount: number): { shield: number; absorbed: number; remaining: number } {
  const current = Number.isFinite(shield) ? Math.max(0, shield) : 0;
  const dmg = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const absorbed = Math.min(current, dmg);
  return { shield: current - absorbed, absorbed: Math.round(absorbed * 100) / 100, remaining: dmg - absorbed };
}
