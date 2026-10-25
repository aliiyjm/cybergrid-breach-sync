/**
 * Partículas con un conjunto preasignado (object pool): no se crean objetos
 * durante la partida, se reutilizan las partículas inactivas.
 */
interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export class ParticleSystem {
  private readonly pool: Particle[];
  private cursor = 0;

  constructor(capacity = 500) {
    this.pool = Array.from({ length: capacity }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 1,
      size: 2,
      color: '#fff',
    }));
  }

  burst(x: number, y: number, color: string, count: number, speed: number, life: number, size = 2.5): void {
    for (let i = 0; i < count; i++) {
      const p = this.pool[this.cursor] as Particle;
      this.cursor = (this.cursor + 1) % this.pool.length;
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * v;
      p.vy = Math.sin(angle) * v;
      p.life = life * (0.6 + Math.random() * 0.4);
      p.maxLife = p.life;
      p.size = size;
      p.color = color;
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-4 * dt);
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
    }
  }

  /** Dibuja en coordenadas de mundo (la transformación de cámara ya está aplicada). */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.pool) if (p.active) n++;
    return n;
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
  }
}
