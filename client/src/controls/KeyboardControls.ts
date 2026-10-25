import { Disposer } from '../ui/dom';
import type { InputState } from './InputState';

const MOVE_KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};
const DASH_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'Space']);
/** Habilidades activas: E = Teletransporte, Q = Sobrecarga. */
const TELEPORT_KEY = 'KeyE';
const OVERLOAD_KEY = 'KeyQ';

/**
 * Controles de PC: WASD/flechas (keydown/keyup), ratón para apuntar,
 * clic izquierdo para disparar y Mayús/Espacio para el impulso.
 */
export class KeyboardControls {
  private readonly pressed = { up: false, down: false, left: false, right: false };
  private readonly disposer = new Disposer();
  private pointerX = 0;
  private pointerY = 0;
  private hasPointer = false;

  constructor(
    private readonly input: InputState,
    private readonly canvas: HTMLCanvasElement,
    /** Posición en pantalla (px CSS relativos al canvas) del jugador local. */
    private readonly playerScreenPos: () => { x: number; y: number } | null,
  ) {}

  attach(): void {
    const d = this.disposer;
    d.on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    d.on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    d.on(window, 'blur', () => this.releaseAll());
    d.on(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    d.on(this.canvas, 'pointermove', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const rect = this.canvas.getBoundingClientRect();
      this.pointerX = e.clientX - rect.left;
      this.pointerY = e.clientY - rect.top;
      this.hasPointer = true;
    });
    d.on(this.canvas, 'pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      this.input.fire = true;
      this.canvas.setPointerCapture(e.pointerId);
    });
    d.on(this.canvas, 'pointerup', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.input.fire = false;
    });
    d.on(this.canvas, 'lostpointercapture', () => {
      this.input.fire = false;
    });
    d.on(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
  }

  /** Recalcula el ángulo de apuntado (se llama cada fotograma). */
  updateAim(): void {
    if (!this.hasPointer) return;
    const player = this.playerScreenPos();
    if (!player) return;
    this.input.aim = Math.atan2(this.pointerY - player.y, this.pointerX - player.x);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const dir = MOVE_KEYS[e.code];
    if (dir) {
      this.pressed[dir] = down;
      e.preventDefault();
    } else if (DASH_KEYS.has(e.code)) {
      this.input.dash = down;
      e.preventDefault();
    } else if (e.code === TELEPORT_KEY) {
      this.input.teleport = down;
    } else if (e.code === OVERLOAD_KEY) {
      this.input.overload = down;
    } else {
      return;
    }
    this.input.moveX = (this.pressed.right ? 1 : 0) - (this.pressed.left ? 1 : 0);
    this.input.moveY = (this.pressed.down ? 1 : 0) - (this.pressed.up ? 1 : 0);
  }

  private releaseAll(): void {
    this.pressed.up = this.pressed.down = this.pressed.left = this.pressed.right = false;
    this.input.moveX = 0;
    this.input.moveY = 0;
    this.input.fire = false;
    this.input.dash = false;
    this.input.teleport = false;
    this.input.overload = false;
  }

  detach(): void {
    this.releaseAll();
    this.disposer.dispose();
  }
}
