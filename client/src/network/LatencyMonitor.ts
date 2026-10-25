import { NET } from '../../../shared/constants';

/**
 * Mide la latencia real de ida y vuelta (RTT) del canal WebSocket con un
 * ping/pong de aplicación (`net:ping` con acuse del servidor) y estima el
 * desfase entre el reloj local y el del servidor.
 *
 * Los resultados se exponen en la interfaz y en `window.__cybergrid.net`
 * para que las pruebas automatizadas puedan registrarlos.
 */

export interface LatencyStats {
  samples: number;
  lastMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  under100Pct: number;
}

type PingFn = (t: number) => Promise<{ t: number; serverTime: number }>;

export class LatencyMonitor {
  private readonly history: number[] = [];
  private timer: number | null = null;
  private offsetMs = 0;
  private bestRtt = Infinity;
  private listeners = new Set<(stats: LatencyStats) => void>();

  constructor(
    private readonly ping: PingFn,
    private readonly maxSamples = 120,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.measure();
    this.timer = window.setInterval(() => void this.measure(), NET.PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  onUpdate(fn: (stats: LatencyStats) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Estimación inicial del desfase a partir de una hora del servidor, si aún no hay pings. */
  seedOffset(serverTime: number): void {
    if (this.history.length === 0) this.offsetMs = serverTime - Date.now();
  }

  /** Hora estimada del servidor (ms epoch). */
  serverNow(): number {
    return Date.now() + this.offsetMs;
  }

  async measure(): Promise<number | null> {
    const sentAt = performance.now();
    const sentWall = Date.now();
    try {
      const res = await this.ping(sentAt);
      const rtt = performance.now() - res.t;
      if (!Number.isFinite(rtt) || rtt < 0) return null;
      this.record(rtt, res.serverTime, sentWall);
      return rtt;
    } catch {
      return null;
    }
  }

  private record(rtt: number, serverTime: number, sentWall: number): void {
    this.history.push(rtt);
    if (this.history.length > this.maxSamples) this.history.shift();
    // El desfase se toma de la muestra con menor RTT (la menos afectada por colas).
    const estimate = serverTime - (sentWall + rtt / 2);
    if (rtt <= this.bestRtt * 1.2 || this.history.length <= 3) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      this.offsetMs = this.history.length <= 1 ? estimate : this.offsetMs * 0.7 + estimate * 0.3;
    }
    const stats = this.stats();
    for (const fn of this.listeners) fn(stats);
  }

  stats(): LatencyStats {
    const n = this.history.length;
    if (n === 0) return { samples: 0, lastMs: 0, avgMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, under100Pct: 0 };
    const sorted = [...this.history].sort((x, y) => x - y);
    const sum = this.history.reduce((acc, v) => acc + v, 0);
    const round = (v: number) => Math.round(v * 10) / 10;
    return {
      samples: n,
      lastMs: round(this.history[n - 1] as number),
      avgMs: round(sum / n),
      minMs: round(sorted[0] as number),
      maxMs: round(sorted[n - 1] as number),
      p95Ms: round(sorted[Math.min(n - 1, Math.floor(n * 0.95))] as number),
      under100Pct: round((this.history.filter((v) => v < 100).length / n) * 100),
    };
  }

  get samples(): readonly number[] {
    return this.history;
  }
}
