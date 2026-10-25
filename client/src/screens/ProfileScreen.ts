import { GAME } from '../../../shared/constants';
import { PLAYER_COLORS } from '../../../shared/protocol';
import { AVATAR_SPRITE_SIZE, avatarCache, drawUnit, hexPath, renderHexSprite } from '../canvas/AvatarCache';
import { api, describeError, type AvatarLimits } from '../network/api';
import { $, Disposer, setLoading, showError } from '../ui/dom';
import { toast } from '../ui/toast';
import type { AppContext, Screen } from './types';

const DEFAULT_LIMITS: AvatarLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxDimension: 4096,
  minDimension: 32,
  outputSize: 128,
  extensions: ['.png', '.jpg', '.jpeg'],
  mimeTypes: ['image/png', 'image/jpeg'],
};

type Kind = 'png' | 'jpeg';

interface Pending {
  file: File;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Centro del recorte en píxeles de la imagen y zoom (1 = lado menor completo). */
  cx: number;
  cy: number;
  zoom: number;
}

function kindFromName(name: string): Kind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpeg';
  return null;
}

async function kindFromSignature(file: File): Promise<Kind | null> {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

const FORMAT_ERROR = 'Formato no permitido. Solo se aceptan imágenes PNG o JPEG (.png, .jpg, .jpeg).';

/**
 * «Personalizar personaje»: elegir una imagen, encuadrarla (arrastrar + zoom),
 * ver cómo queda en la arena y guardarla. La validación se repite en el
 * servidor, que es quien decide y re-codifica la imagen definitiva.
 */
export class ProfileScreen implements Screen {
  private readonly disposer = new Disposer();
  private limits: AvatarLimits = DEFAULT_LIMITS;
  private pending: Pending | null = null;
  private saving = false;
  private drag: { pointerId: number; x: number; y: number } | null = null;

  constructor(private readonly ctx: AppContext) {}

  async mount(): Promise<void> {
    const input = $<HTMLInputElement>('#avatar-input');
    const cropper = $('#cropper');
    this.clearMessages();
    this.discardPending();

    this.disposer.on($('#avatar-pick'), 'click', () => input.click());
    this.disposer.on(input, 'change', () => {
      const file = input.files?.[0];
      input.value = ''; // permite volver a elegir el mismo archivo
      if (file) void this.selectFile(file);
    });
    this.disposer.on($('#avatar-save'), 'click', () => void this.save());
    this.disposer.on($('#avatar-cancel'), 'click', () => {
      this.discardPending();
      this.clearMessages();
    });
    this.disposer.on($('#avatar-reset'), 'click', () => void this.reset());
    this.disposer.on($('#cropper-zoom'), 'input', (e: Event) => {
      if (!this.pending) return;
      this.pending.zoom = Number((e.target as HTMLInputElement).value);
      this.clampPending();
      this.drawEditor();
    });

    // Arrastrar para centrar (ratón, táctil y lápiz).
    this.disposer.on(cropper, 'pointerdown', (e: PointerEvent) => {
      if (!this.pending) return;
      e.preventDefault();
      this.drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      try {
        cropper.setPointerCapture(e.pointerId);
      } catch {
        /* sin captura sigue funcionando dentro del área */
      }
    });
    this.disposer.on(cropper, 'pointermove', (e: PointerEvent) => {
      if (!this.pending || !this.drag || e.pointerId !== this.drag.pointerId) return;
      const rect = cropper.getBoundingClientRect();
      const perPixel = this.cropSide() / rect.width;
      this.pending.cx -= (e.clientX - this.drag.x) * perPixel;
      this.pending.cy -= (e.clientY - this.drag.y) * perPixel;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.clampPending();
      this.drawEditor();
    });
    const endDrag = (): void => {
      this.drag = null;
    };
    this.disposer.on(cropper, 'pointerup', endDrag);
    this.disposer.on(cropper, 'pointercancel', endDrag);
    // Teclado: flechas para mover, +/- para zoom.
    this.disposer.on(cropper, 'keydown', (e: KeyboardEvent) => {
      if (!this.pending) return;
      const step = this.cropSide() * 0.05;
      const keys: Record<string, () => void> = {
        ArrowLeft: () => (this.pending!.cx -= step),
        ArrowRight: () => (this.pending!.cx += step),
        ArrowUp: () => (this.pending!.cy -= step),
        ArrowDown: () => (this.pending!.cy += step),
        '+': () => (this.pending!.zoom = Math.min(4, this.pending!.zoom + 0.1)),
        '-': () => (this.pending!.zoom = Math.max(1, this.pending!.zoom - 0.1)),
      };
      const action = keys[e.key];
      if (!action) return;
      e.preventDefault();
      action();
      this.clampPending();
      ($('#cropper-zoom') as HTMLInputElement).value = String(this.pending.zoom);
      this.drawEditor();
    });

    this.disposer.add(avatarCache.onLoad(() => this.drawCurrent()));
    this.drawCurrent();

    try {
      const profile = await api.profile();
      this.limits = profile.limits;
      if (this.ctx.user) this.ctx.user = { ...this.ctx.user, avatarUrl: profile.user.avatarUrl ?? null };
      const mb = (this.limits.maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
      $('#avatar-limits').textContent =
        `PNG o JPEG · máximo ${mb} MB · entre ${this.limits.minDimension} y ${this.limits.maxDimension} px por lado.`;
      this.drawCurrent();
    } catch (error) {
      showError($('#avatar-error'), describeError(error));
    }
  }

  /* ------------------------------ Selección ------------------------------ */

  private async selectFile(file: File): Promise<void> {
    this.clearMessages();
    const cropper = $('#cropper');
    cropper.dataset.state = 'loading';
    try {
      const byName = kindFromName(file.name);
      if (!byName) throw new Error(FORMAT_ERROR);
      if (file.type && !this.limits.mimeTypes.includes(file.type)) throw new Error(FORMAT_ERROR);
      if (file.size === 0) throw new Error('El archivo está vacío.');
      if (file.size > this.limits.maxBytes) {
        const mb = (this.limits.maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
        throw new Error(`La imagen pesa ${(file.size / (1024 * 1024)).toFixed(1)} MB; el máximo es ${mb} MB.`);
      }
      const bySignature = await kindFromSignature(file);
      if (!bySignature) throw new Error('El contenido del archivo no es una imagen PNG o JPEG.');
      if (bySignature !== byName) throw new Error('La extensión no coincide con el contenido real del archivo.');

      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        throw new Error('La imagen está dañada o no se puede leer.');
      }
      const { width, height } = bitmap;
      if (width > this.limits.maxDimension || height > this.limits.maxDimension) {
        bitmap.close();
        throw new Error(`La imagen mide ${width}×${height} px; el máximo es ${this.limits.maxDimension} px por lado.`);
      }
      if (width < this.limits.minDimension || height < this.limits.minDimension) {
        bitmap.close();
        throw new Error(`La imagen debe medir al menos ${this.limits.minDimension} px por lado.`);
      }

      this.discardPending();
      this.pending = { file, bitmap, width, height, cx: width / 2, cy: height / 2, zoom: 1 };
      ($('#cropper-zoom') as HTMLInputElement).value = '1';
      $('#cropper-zoom-field').hidden = false;
      $('#cropper-empty').hidden = true;
      cropper.dataset.state = 'ready';
      this.updateButtons();
      this.drawEditor();
    } catch (error) {
      cropper.dataset.state = this.pending ? 'ready' : 'empty';
      showError($('#avatar-error'), error instanceof Error ? error.message : FORMAT_ERROR);
    }
  }

  /** Lado del recorte cuadrado en píxeles de la imagen. */
  private cropSide(): number {
    const p = this.pending;
    return p ? Math.min(p.width, p.height) / p.zoom : 1;
  }

  private clampPending(): void {
    const p = this.pending;
    if (!p) return;
    p.zoom = Math.min(4, Math.max(1, p.zoom));
    const half = this.cropSide() / 2;
    p.cx = Math.min(p.width - half, Math.max(half, p.cx));
    p.cy = Math.min(p.height - half, Math.max(half, p.cy));
  }

  /** Recorte en fracciones (el formato que valida el servidor). */
  private cropFractions(): { x: number; y: number; size: number } {
    const p = this.pending as Pending;
    const side = this.cropSide();
    return {
      x: Math.max(0, (p.cx - side / 2) / p.width),
      y: Math.max(0, (p.cy - side / 2) / p.height),
      size: Math.min(1, side / Math.min(p.width, p.height)),
    };
  }

  /* ------------------------------ Dibujo ------------------------------ */

  private drawEditor(): void {
    const canvas = $<HTMLCanvasElement>('#cropper-canvas');
    const g = canvas.getContext('2d');
    const p = this.pending;
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!p) return;
    const side = this.cropSide();
    g.imageSmoothingQuality = 'high';
    g.drawImage(p.bitmap, p.cx - side / 2, p.cy - side / 2, side, side, 0, 0, canvas.width, canvas.height);
    // Oscurece lo que queda fuera del hexágono (lo que no se verá en la arena).
    g.save();
    g.fillStyle = 'rgba(6, 9, 20, 0.6)';
    g.beginPath();
    g.rect(0, 0, canvas.width, canvas.height);
    hexPath(g, canvas.width / 2, canvas.height / 2, canvas.width / 2 - 2, false);
    g.fill('evenodd');
    g.strokeStyle = '#2ee6ff';
    g.lineWidth = 2;
    hexPath(g, canvas.width / 2, canvas.height / 2, canvas.width / 2 - 2);
    g.stroke();
    g.restore();
    this.drawNewPreview();
  }

  private pendingSprite(): HTMLCanvasElement | null {
    const p = this.pending;
    if (!p) return null;
    const side = this.cropSide();
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = AVATAR_SPRITE_SIZE;
    const g = tmp.getContext('2d');
    if (!g) return null;
    g.drawImage(p.bitmap, p.cx - side / 2, p.cy - side / 2, side, side, 0, 0, AVATAR_SPRITE_SIZE, AVATAR_SPRITE_SIZE);
    return renderHexSprite(tmp, AVATAR_SPRITE_SIZE, AVATAR_SPRITE_SIZE);
  }

  private paintPreview(canvas: HTMLCanvasElement, sprite: HTMLCanvasElement | null): void {
    const g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    // Misma figura que en la arena, ampliada: radio lógico × escala de la vista previa.
    const scale = canvas.width / (GAME.PLAYER_RADIUS * 4);
    g.save();
    g.scale(scale, scale);
    const c = (canvas.width / scale) / 2;
    drawUnit(g, c, c, GAME.PLAYER_RADIUS, -0.5, PLAYER_COLORS[0], sprite, true);
    g.restore();
  }

  private drawCurrent(): void {
    this.paintPreview($<HTMLCanvasElement>('#avatar-preview-current'), avatarCache.get(this.ctx.user?.avatarUrl));
    if (!this.pending) this.paintPreview($<HTMLCanvasElement>('#avatar-preview-new'), null);
  }

  private drawNewPreview(): void {
    this.paintPreview($<HTMLCanvasElement>('#avatar-preview-new'), this.pendingSprite());
  }

  /* ------------------------------ Acciones ------------------------------ */

  private async save(): Promise<void> {
    if (!this.pending || this.saving) return;
    this.saving = true;
    const button = $<HTMLButtonElement>('#avatar-save');
    setLoading(button, true);
    $('#cropper').dataset.state = 'loading';
    this.clearMessages();
    try {
      const { avatarUrl } = await api.uploadAvatar(this.pending.file, this.cropFractions());
      if (this.ctx.user) this.ctx.user = { ...this.ctx.user, avatarUrl };
      avatarCache.preload([avatarUrl]);
      this.discardPending();
      showOk('Apariencia guardada. Los demás jugadores la verán en la sala y en la partida.');
      toast('Apariencia guardada', 'ok');
    } catch (error) {
      $('#cropper').dataset.state = 'ready';
      showError($('#avatar-error'), describeError(error));
    } finally {
      this.saving = false;
      setLoading(button, false);
      this.updateButtons();
      this.drawCurrent();
    }
  }

  private async reset(): Promise<void> {
    const button = $<HTMLButtonElement>('#avatar-reset');
    setLoading(button, true);
    this.clearMessages();
    try {
      await api.resetAvatar();
      if (this.ctx.user) this.ctx.user = { ...this.ctx.user, avatarUrl: null };
      this.discardPending();
      showOk('Apariencia restablecida: vuelves a usar el aspecto predeterminado.');
    } catch (error) {
      showError($('#avatar-error'), describeError(error));
    } finally {
      setLoading(button, false);
      this.drawCurrent();
    }
  }

  private discardPending(): void {
    this.pending?.bitmap.close();
    this.pending = null;
    this.drag = null;
    const cropper = document.getElementById('cropper');
    if (cropper) cropper.dataset.state = 'empty';
    const empty = document.getElementById('cropper-empty');
    if (empty) empty.hidden = false;
    const zoom = document.getElementById('cropper-zoom-field');
    if (zoom) zoom.hidden = true;
    const canvas = document.getElementById('cropper-canvas') as HTMLCanvasElement | null;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    this.updateButtons();
    const preview = document.getElementById('avatar-preview-new') as HTMLCanvasElement | null;
    if (preview) this.paintPreview(preview, null);
  }

  private updateButtons(): void {
    const save = document.getElementById('avatar-save') as HTMLButtonElement | null;
    const cancel = document.getElementById('avatar-cancel') as HTMLButtonElement | null;
    if (save) save.disabled = !this.pending || this.saving;
    if (cancel) cancel.disabled = !this.pending;
  }

  private clearMessages(): void {
    showError($('#avatar-error'), null);
    const ok = $('#avatar-ok');
    ok.hidden = true;
    ok.textContent = '';
  }

  unmount(): void {
    this.disposer.dispose();
    this.discardPending();
  }
}

function showOk(message: string): void {
  const ok = $('#avatar-ok');
  ok.textContent = message;
  ok.hidden = false;
}
