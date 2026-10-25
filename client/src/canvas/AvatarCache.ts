import { SERVER_URL } from '../network/api';

/**
 * Caché de imágenes de apariencia.
 *
 * - Cada URL se descarga UNA sola vez (nunca en cada fotograma).
 * - Al cargarse se prerenderiza recortada en hexágono en un lienzo propio,
 *   así el renderizador solo hace un drawImage por jugador.
 * - Mientras carga, o si falla, `get()` devuelve null y se dibuja el aspecto
 *   predeterminado.
 */

type Entry =
  | { status: 'loading' }
  | { status: 'ready'; sprite: HTMLCanvasElement }
  | { status: 'error' };

/** Resolución del sprite prerenderizado (px). */
export const AVATAR_SPRITE_SIZE = 96;

export function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, newPath = true): void {
  if (newPath) ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6; // hexágono con vértice arriba
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Dibuja `source` recortada en hexágono, cubriendo el área sin deformarse. */
export function renderHexSprite(source: CanvasImageSource, srcW: number, srcH: number, size = AVATAR_SPRITE_SIZE): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  const side = Math.min(srcW, srcH);
  g.save();
  hexPath(g, size / 2, size / 2, size / 2);
  g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, (srcW - side) / 2, (srcH - side) / 2, side, side, 0, 0, size, size);
  g.restore();
  return canvas;
}

export class AvatarCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(url: string) => void>();

  /** Sprite listo para dibujar, o null (se dibuja el aspecto predeterminado). */
  get(url: string | null | undefined): HTMLCanvasElement | null {
    if (!url) return null;
    const entry = this.entries.get(url);
    if (!entry) {
      this.load(url);
      return null;
    }
    return entry.status === 'ready' ? entry.sprite : null;
  }

  /** Avisa cuando una imagen termina de cargar (para repintar vistas estáticas). */
  onLoad(fn: (url: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  preload(urls: Array<string | null | undefined>): void {
    for (const url of urls) if (url && !this.entries.has(url)) this.load(url);
  }

  private load(url: string): void {
    this.entries.set(url, { status: 'loading' });
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.entries.set(url, { status: 'ready', sprite: renderHexSprite(img, img.naturalWidth, img.naturalHeight) });
      for (const fn of this.listeners) fn(url);
    };
    img.onerror = () => {
      this.entries.set(url, { status: 'error' });
    };
    img.src = `${SERVER_URL}${url}`;
  }
}

/** Caché única para toda la aplicación. */
export const avatarCache = new AvatarCache();

/**
 * Dibuja una unidad (cuerpo, imagen opcional y cañón) centrada en (x, y).
 * Lo usan el renderizador de la partida y las vistas previas, así el
 * personaje se ve igual en ambos sitios. El radio es siempre el lógico del
 * juego: la imagen nunca cambia el tamaño ni la hitbox.
 */
export function drawUnit(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  aim: number,
  color: string,
  sprite: HTMLCanvasElement | null,
  isLocal: boolean,
): void {
  if (sprite) {
    ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#0b1230';
    hexPath(ctx, x, y, r);
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, r * 0.15);
  hexPath(ctx, x, y, r);
  ctx.stroke();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aim);
  ctx.fillStyle = color;
  ctx.fillRect(r - 4, -r * 0.19, r * 0.875, r * 0.375);
  if (!sprite) {
    ctx.beginPath();
    ctx.arc(0, 0, isLocal ? r * 0.375 : r * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
