import { clamp } from '../../../shared/math';

/**
 * Cámara 2D que sigue al jugador local con suavizado exponencial
 * independiente de la frecuencia de refresco, y se limita a los bordes del mapa.
 */
export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  viewWidth = 1;
  viewHeight = 1;
  private worldWidth = 1;
  private worldHeight = 1;

  setWorld(width: number, height: number): void {
    this.worldWidth = width;
    this.worldHeight = height;
  }

  /**
   * Ajusta el zoom para que se vea una superficie de mundo parecida (≈ 960×640 px)
   * en cualquier pantalla, también en vertical en el móvil.
   */
  setViewport(width: number, height: number): void {
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
    this.scale = clamp(Math.sqrt((this.viewWidth * this.viewHeight) / (960 * 640)), 0.55, 1.4);
  }

  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clampToWorld();
  }

  /** Sigue al objetivo; `dt` en segundos. */
  follow(targetX: number, targetY: number, dt: number, stiffness = 8): void {
    const k = 1 - Math.exp(-stiffness * dt);
    this.x += (targetX - this.x) * k;
    this.y += (targetY - this.y) * k;
    this.clampToWorld();
  }

  private clampToWorld(): void {
    const halfW = this.viewWidth / this.scale / 2;
    const halfH = this.viewHeight / this.scale / 2;
    this.x = this.worldWidth <= halfW * 2 ? this.worldWidth / 2 : clamp(this.x, halfW, this.worldWidth - halfW);
    this.y = this.worldHeight <= halfH * 2 ? this.worldHeight / 2 : clamp(this.y, halfH, this.worldHeight - halfH);
  }

  worldToScreenX(wx: number): number {
    return (wx - this.x) * this.scale + this.viewWidth / 2;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.y) * this.scale + this.viewHeight / 2;
  }

  /** Rectángulo visible en coordenadas de mundo (para descartar dibujos fuera de pantalla). */
  isVisible(wx: number, wy: number, margin: number): boolean {
    const halfW = this.viewWidth / this.scale / 2 + margin;
    const halfH = this.viewHeight / this.scale / 2 + margin;
    return Math.abs(wx - this.x) <= halfW && Math.abs(wy - this.y) <= halfH;
  }
}
