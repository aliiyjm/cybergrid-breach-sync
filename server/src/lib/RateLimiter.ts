/**
 * Cubo de fichas (token bucket) para limitar la frecuencia de mensajes.
 * `capacity` fichas como ráfaga máxima, recarga a `refillPerSecond`.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryConsume(cost = 1): boolean {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  get available(): number {
    return this.tokens;
  }
}

/**
 * Ventana fija por clave (p. ej. IP + usuario) para frenar ataques de fuerza
 * bruta en el inicio de sesión. Limpia claves caducadas periódicamente.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Devuelve los milisegundos hasta poder reintentar, o 0 si se permite. */
  hit(key: string): number {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.prune(t);
      return 0;
    }
    entry.count++;
    return entry.count > this.limit ? entry.resetAt - t : 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(t: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key);
  }
}
