import { TILE } from '../../../shared/constants';
import { generateMap, type GameMap } from '../../../shared/MapGenerator';

/**
 * Vista previa de la pantalla de inicio: usa el MISMO generador procedural
 * que el servidor para dibujar una arena real a partir de una semilla, con
 * una única animación de barrido al generarla.
 */
export class MapPreview {
  private readonly ctx: CanvasRenderingContext2D | null;
  private map: GameMap | null = null;
  private rafId: number | null = null;
  private revealStart = 0;
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d');
  }

  show(seed: number): void {
    this.map = generateMap(seed);
    this.revealStart = performance.now();
    this.start();
  }

  start(): void {
    if (this.rafId !== null) return;
    const loop = (now: number): void => {
      this.draw(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    const map = this.map;
    if (!ctx || !map) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const cell = Math.min(w / map.cols, h / map.rows);
    const ox = (w - cell * map.cols) / 2;
    const oy = (h - cell * map.rows) / 2;
    const progress = this.reducedMotion ? 1 : Math.min(1, (now - this.revealStart) / 1400);
    const revealRow = progress * (map.rows + 4);

    ctx.fillStyle = '#060914';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < map.rows; y++) {
      if (y > revealRow) break;
      for (let x = 0; x < map.cols; x++) {
        const t = map.tiles[y * map.cols + x];
        const px = ox + x * cell;
        const py = oy + y * cell;
        if (t === TILE.WALL) ctx.fillStyle = '#16275e';
        else if (t === TILE.COVER) ctx.fillStyle = '#3a2280';
        else ctx.fillStyle = (x + y) % 2 === 0 ? '#0a1124' : '#0b1328';
        ctx.fillRect(px, py, cell - 1, cell - 1);
      }
    }
    // Línea de barrido.
    if (progress < 1) {
      const sy = oy + revealRow * cell;
      ctx.fillStyle = 'rgba(46, 230, 255, 0.8)';
      ctx.fillRect(ox, sy, cell * map.cols, Math.max(2, dpr * 2));
    } else {
      // Posiciones iniciales: pulso suave.
      const pulse = 0.55 + Math.sin(now / 400) * 0.25;
      map.spawnPoints.forEach((s, i) => {
        const cx = ox + (s.x / map.tileSize) * cell;
        const cy = oy + (s.y / map.tileSize) * cell;
        ctx.globalAlpha = pulse;
        ctx.fillStyle = i % 2 === 0 ? '#2ee6ff' : '#ff2fb3';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.38, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
  }
}
