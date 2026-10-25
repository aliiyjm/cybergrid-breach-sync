import { Disposer } from '../ui/dom';
import type { InputState } from './InputState';

const DEADZONE = 0.15;

/** Captura el puntero si el navegador lo permite (algunos lo rechazan para punteros sintéticos). */
function safeCapture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* sin captura el control sigue funcionando mientras el dedo esté sobre el elemento */
  }
}

/**
 * Controles táctiles: joystick virtual (abajo a la izquierda) y botones de
 * disparo e impulso (abajo a la derecha).
 *
 * - Usa Pointer Events con captura del puntero: aunque el dedo salga del
 *   área del joystick se conserva el control hasta levantarlo.
 * - `touch-action: none` (CSS) y preventDefault evitan desplazamientos y zoom.
 * - pointercancel / lostpointercapture devuelven el joystick al centro.
 * - El vector es analógico y admite diagonales con magnitud máxima 1.
 */
export class TouchControls {
  private readonly disposer = new Disposer();
  private stickPointer: number | null = null;
  private centerX = 0;
  private centerY = 0;
  private radius = 1;

  constructor(
    private readonly input: InputState,
    private readonly root: HTMLElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly fireBtn: HTMLElement,
    private readonly dashBtn: HTMLElement,
    /** Botones de habilidades activas (se muestran solo si el jugador las tiene). */
    private readonly teleportBtn: HTMLElement | null = null,
    private readonly overloadBtn: HTMLElement | null = null,
  ) {}

  attach(): void {
    const d = this.disposer;
    this.root.hidden = false;

    d.on(this.stick, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      if (this.stickPointer !== null) return;
      this.stickPointer = e.pointerId;
      safeCapture(this.stick, e.pointerId);
      const rect = this.stick.getBoundingClientRect();
      this.centerX = rect.left + rect.width / 2;
      this.centerY = rect.top + rect.height / 2;
      this.radius = rect.width / 2;
      this.updateStick(e.clientX, e.clientY);
    });
    d.on(this.stick, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      e.preventDefault();
      this.updateStick(e.clientX, e.clientY);
    });
    const releaseStick = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.input.moveX = 0;
      this.input.moveY = 0;
      this.knob.style.transform = 'translate(0px, 0px)';
    };
    d.on(this.stick, 'pointerup', releaseStick);
    d.on(this.stick, 'pointercancel', releaseStick);
    d.on(this.stick, 'lostpointercapture', releaseStick);

    this.bindButton(this.fireBtn, (pressed) => {
      this.input.fire = pressed;
    });
    this.bindButton(this.dashBtn, (pressed) => {
      this.input.dash = pressed;
    });
    if (this.teleportBtn) {
      this.bindButton(this.teleportBtn, (pressed) => {
        this.input.teleport = pressed;
      });
    }
    if (this.overloadBtn) {
      this.bindButton(this.overloadBtn, (pressed) => {
        this.input.overload = pressed;
      });
    }

    // Evita el menú contextual por pulsación larga y el desplazamiento de la página.
    d.on(this.root, 'contextmenu', (e: Event) => e.preventDefault());
    d.on(this.root, 'touchmove', (e: Event) => e.preventDefault(), { passive: false });
  }

  private bindButton(btn: HTMLElement, setPressed: (pressed: boolean) => void): void {
    let pointer: number | null = null;
    const d = this.disposer;
    d.on(btn, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      pointer = e.pointerId;
      safeCapture(btn, e.pointerId);
      btn.dataset.active = 'true';
      setPressed(true);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      btn.dataset.active = 'false';
      setPressed(false);
    };
    d.on(btn, 'pointerup', release);
    d.on(btn, 'pointercancel', release);
    d.on(btn, 'lostpointercapture', release);
  }

  private updateStick(clientX: number, clientY: number): void {
    let dx = (clientX - this.centerX) / this.radius;
    let dy = (clientY - this.centerY) / this.radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    const magnitude = Math.min(1, len);
    if (magnitude < DEADZONE) {
      this.input.moveX = 0;
      this.input.moveY = 0;
    } else {
      // Reescala para que el movimiento empiece suave tras la zona muerta.
      const scaled = (magnitude - DEADZONE) / (1 - DEADZONE);
      this.input.moveX = (dx / magnitude) * scaled;
      this.input.moveY = (dy / magnitude) * scaled;
      this.input.aim = Math.atan2(dy, dx);
    }
    const travel = this.radius * 0.6;
    this.knob.style.transform = `translate(${(dx * travel).toFixed(1)}px, ${(dy * travel).toFixed(1)}px)`;
  }

  detach(): void {
    this.disposer.dispose();
    this.stickPointer = null;
    this.input.moveX = 0;
    this.input.moveY = 0;
    this.input.fire = false;
    this.input.dash = false;
    this.input.teleport = false;
    this.input.overload = false;
    this.knob.style.transform = 'translate(0px, 0px)';
    this.root.hidden = true;
  }
}
