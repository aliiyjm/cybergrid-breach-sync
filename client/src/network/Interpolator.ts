import { clamp, lerp, lerpAngle } from '../../../shared/math';
import type { GameSnapshot, PlayerSnapshot, ProjectileSnapshot } from '../../../shared/protocol';

/**
 * Interpolación de entidades remotas.
 *
 * El cliente dibuja a los demás jugadores con un retardo fijo
 * (NET.INTERPOLATION_DELAY_MS) entre las dos instantáneas del servidor que
 * rodean ese instante. Así el movimiento es fluido aunque las instantáneas
 * lleguen a 30 Hz y con variaciones de red, y SIN cambiar la autoridad: las
 * posiciones interpoladas solo se usan para dibujar.
 */

export interface InterpolatedPlayer {
  id: string;
  x: number;
  y: number;
  aim: number;
  alive: boolean;
  /** Referencia a la instantánea más reciente usada (vida, energía…). */
  latest: PlayerSnapshot | null;
}

/** Distancia (px) por encima de la cual se considera un teletransporte (reaparición). */
export const TELEPORT_THRESHOLD = 160;

/**
 * Interpola un jugador entre dos estados. Escribe en `out` (sin asignar memoria).
 * `t` se limita a [0, 1]: nunca se extrapola más allá del último estado conocido.
 */
export function interpolatePlayer(
  a: Pick<PlayerSnapshot, 'x' | 'y' | 'aim' | 'alive' | 'tp'>,
  b: Pick<PlayerSnapshot, 'x' | 'y' | 'aim' | 'alive' | 'tp'>,
  t: number,
  out: { x: number; y: number; aim: number; alive: boolean },
): void {
  const k = clamp(t, 0, 1);
  // Salto: distancia grande o un teletransporte confirmado por el servidor
  // (contador `tp` distinto): la nave aparece en el destino sin recorrer el camino.
  const jump = Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_THRESHOLD || (a.tp ?? 0) !== (b.tp ?? 0);
  if (jump || a.alive !== b.alive) {
    // Reaparición o muerte: se usa el estado más cercano en el tiempo.
    const src = k < 0.5 && !jump ? a : b;
    out.x = src.x;
    out.y = src.y;
    out.aim = src.aim;
    out.alive = src.alive;
    return;
  }
  out.x = lerp(a.x, b.x, k);
  out.y = lerp(a.y, b.y, k);
  out.aim = lerpAngle(a.aim, b.aim, k);
  out.alive = b.alive;
}

export interface InterpolatedProjectile {
  id: number;
  x: number;
  y: number;
  ownerId: string;
  /** Tipo visual enviado por el servidor (ver ProjectileSnapshot.k). */
  k?: ProjectileSnapshot['k'];
}

export class SnapshotInterpolator {
  private readonly buffer: GameSnapshot[] = [];
  private readonly results = new Map<string, InterpolatedPlayer>();
  private readonly projectilePool: InterpolatedProjectile[] = [];
  private pairA: GameSnapshot | null = null;
  private pairB: GameSnapshot | null = null;
  private pairT = 1;

  constructor(private readonly maxBuffered = 40) {}

  push(snapshot: GameSnapshot): void {
    const last = this.buffer[this.buffer.length - 1];
    if (last && snapshot.tick <= last.tick) return; // duplicada o desordenada
    this.buffer.push(snapshot);
    if (this.buffer.length > this.maxBuffered) this.buffer.splice(0, this.buffer.length - this.maxBuffered);
  }

  get latest(): GameSnapshot | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  get size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer.length = 0;
    this.results.clear();
    this.pairA = null;
    this.pairB = null;
  }

  /**
   * Calcula las posiciones de todos los jugadores en `renderTime` (hora del
   * servidor, ms). Devuelve un mapa reutilizado entre fotogramas.
   */
  sample(renderTime: number): Map<string, InterpolatedPlayer> {
    const buf = this.buffer;
    if (buf.length === 0) return this.results;

    // Busca el par (a, b) con a.serverTime ≤ renderTime < b.serverTime.
    let a = buf[0] as GameSnapshot;
    let b = a;
    if (renderTime >= (buf[buf.length - 1] as GameSnapshot).serverTime) {
      a = b = buf[buf.length - 1] as GameSnapshot;
    } else if (renderTime > a.serverTime) {
      for (let i = buf.length - 1; i > 0; i--) {
        const prev = buf[i - 1] as GameSnapshot;
        if (prev.serverTime <= renderTime) {
          a = prev;
          b = buf[i] as GameSnapshot;
          break;
        }
      }
    }
    const span = b.serverTime - a.serverTime;
    const t = span > 0 ? (renderTime - a.serverTime) / span : 1;
    this.pairA = a;
    this.pairB = b;
    this.pairT = clamp(t, 0, 1);

    // Descarta instantáneas que ya no se necesitarán.
    const aIndex = buf.indexOf(a);
    if (aIndex > 2) buf.splice(0, aIndex - 2);

    for (const pb of b.players) {
      let out = this.results.get(pb.id);
      if (!out) {
        out = { id: pb.id, x: pb.x, y: pb.y, aim: pb.aim, alive: pb.alive, latest: null };
        this.results.set(pb.id, out);
      }
      let pa: PlayerSnapshot | undefined;
      for (const p of a.players) {
        if (p.id === pb.id) {
          pa = p;
          break;
        }
      }
      interpolatePlayer(pa ?? pb, pb, t, out);
      out.latest = pb;
    }
    return this.results;
  }

  /**
   * Proyectiles interpolados con el mismo par de instantáneas que el último
   * `sample()`. Reutiliza objetos; devuelve cuántos son válidos.
   */
  sampleProjectiles(): { items: readonly InterpolatedProjectile[]; count: number } {
    const a = this.pairA;
    const b = this.pairB;
    if (!a || !b) return { items: this.projectilePool, count: 0 };
    let count = 0;
    for (const pb of b.projectiles) {
      let out = this.projectilePool[count];
      if (!out) {
        out = { id: 0, x: 0, y: 0, ownerId: '' };
        this.projectilePool.push(out);
      }
      let pa = null;
      for (const p of a.projectiles) {
        if (p.id === pb.id) {
          pa = p;
          break;
        }
      }
      out.id = pb.id;
      out.ownerId = pb.ownerId;
      out.k = pb.k;
      out.x = pa ? lerp(pa.x, pb.x, this.pairT) : pb.x;
      out.y = pa ? lerp(pa.y, pb.y, this.pairT) : pb.y;
      count++;
    }
    return { items: this.projectilePool, count };
  }
}
