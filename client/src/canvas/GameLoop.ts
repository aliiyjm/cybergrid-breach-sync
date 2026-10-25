/**
 * Bucle principal con requestAnimationFrame y tiempo delta.
 *
 * - `update(dt)` se ejecuta con paso FIJO (1/60 s) mediante un acumulador, de
 *   modo que la lógica visual se comporta igual a 60, 120 o 144 Hz.
 * - Tras una pausa larga (pestaña oculta, depurador) el delta se limita a
 *   MAX_FRAME_DT y como mucho se ejecutan MAX_STEPS pasos: no hay saltos.
 * - `render(alpha, dt)` se llama una vez por fotograma de pantalla.
 * - Mide los FPS reales cada 500 ms.
 */
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.25;
export const MAX_STEPS = 5;

export interface LoopCallbacks {
  update: (dt: number) => void;
  render: (alpha: number, frameDt: number) => void;
  onFps?: (fps: number) => void;
}

/** Cálculo puro del número de pasos fijos para un delta dado (testeable). */
export function planSteps(accumulator: number, frameDt: number): { steps: number; accumulator: number } {
  let acc = accumulator + Math.min(Math.max(frameDt, 0), MAX_FRAME_DT);
  let steps = 0;
  while (acc >= FIXED_DT && steps < MAX_STEPS) {
    acc -= FIXED_DT;
    steps++;
  }
  // Si se alcanzó el máximo, se descarta el tiempo sobrante para no acumular deuda.
  if (steps === MAX_STEPS && acc >= FIXED_DT) acc = 0;
  return { steps, accumulator: acc };
}

export class GameLoop {
  private rafId: number | null = null;
  private last = 0;
  private accumulator = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private _fps = 0;

  constructor(private readonly callbacks: LoopCallbacks) {}

  get fps(): number {
    return this._fps;
  }

  get running(): boolean {
    return this.rafId !== null;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.last = performance.now();
    this.accumulator = 0;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private readonly frame = (now: number): void => {
    const frameDt = Math.max(0, (now - this.last) / 1000);
    this.last = now;

    const plan = planSteps(this.accumulator, frameDt);
    this.accumulator = plan.accumulator;
    for (let i = 0; i < plan.steps; i++) this.callbacks.update(FIXED_DT);

    this.callbacks.render(this.accumulator / FIXED_DT, Math.min(frameDt, MAX_FRAME_DT));

    this.fpsFrames++;
    this.fpsTime += frameDt;
    if (this.fpsTime >= 0.5) {
      this._fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
      this.callbacks.onFps?.(this._fps);
    }
    this.rafId = requestAnimationFrame(this.frame);
  };
}
