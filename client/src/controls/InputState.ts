import { normalizeIntent } from '../../../shared/math';

/**
 * Estado de entrada del jugador local. Teclado, ratón, controles táctiles y
 * el mecanismo de entrada de prueba escriben aquí; `GameClient` lo envía al
 * servidor como intención. Nada de esto mueve al jugador por sí mismo.
 */
export class InputState {
  moveX = 0;
  moveY = 0;
  aim = 0;
  fire = false;
  dash = false;
  /** Habilidades activas (solo intención; el servidor valida propiedad y recarga). */
  teleport = false;
  overload = false;

  /** Entrada inyectada por pruebas: sustituye al movimiento hasta `until`. */
  private injected: { x: number; y: number; until: number } | null = null;

  /** Intención de movimiento efectiva, con magnitud ≤ 1. */
  movement(now: number = performance.now()): { x: number; y: number } {
    if (this.injected && now < this.injected.until) return normalizeIntent(this.injected.x, this.injected.y);
    this.injected = null;
    return normalizeIntent(this.moveX, this.moveY);
  }

  inject(x: number, y: number, durationMs: number): void {
    this.injected = { x, y, until: performance.now() + durationMs };
  }

  reset(): void {
    this.moveX = 0;
    this.moveY = 0;
    this.fire = false;
    this.dash = false;
    this.teleport = false;
    this.overload = false;
    this.injected = null;
  }
}
