import { GAME, TILE } from '../../../shared/constants';
import type { GamePlayerInfo, ShardSnapshot } from '../../../shared/protocol';
import { UPGRADE_CATALOG } from '../../../shared/upgrades';
import type { InterpolatedProjectile } from '../network/Interpolator';
import { avatarCache, drawUnit } from './AvatarCache';
import { Camera } from './Camera';
import { ParticleSystem } from './ParticleSystem';

export interface RenderPlayer {
  id: string;
  x: number;
  y: number;
  aim: number;
  alive: boolean;
  hp: number;
  dashing: boolean;
  protected: boolean;
  connected: boolean;
  /** Estado visible de las mejoras (autoritativo, de la última instantánea). */
  shield: number;
  shieldMax: number;
  drone: number | null;
  choosing: boolean;
  /* Expansión 1.3 (estado autoritativo de la última instantánea) */
  beamWeapon: boolean;
  overload: boolean;
  hunter: boolean;
  corroded: boolean;
  satellites: number[] | null;
  satAngle: number;
  satRadius: number;
}

/** Efectos visuales efímeros (nunca afectan a colisiones ni daño). */
interface BeamFx {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  power: number;
  t0: number;
}
interface ChainFx {
  points: { x: number; y: number }[];
  corrosive: boolean;
  t0: number;
}
interface RingFx {
  x: number;
  y: number;
  color: string;
  radius: number;
  t0: number;
}

const BEAM_FX_S = 0.16;
const CHAIN_FX_S = 0.22;
const RING_FX_S = 0.35;
const MAX_FX = 48;

export interface RenderFrame {
  players: Iterable<RenderPlayer>;
  projectiles: readonly InterpolatedProjectile[];
  projectileCount: number;
  shards: readonly ShardSnapshot[];
  localId: string;
  time: number;
}

const COLORS = {
  floor: '#070c1c',
  gridMinor: 'rgba(46, 230, 255, 0.05)',
  gridMajor: 'rgba(61, 107, 255, 0.16)',
  wall: '#101c45',
  wallEdge: '#3d6bff',
  cover: '#1c1240',
  coverEdge: '#9b6bff',
  shard: '#3dffc4',
  hpBack: 'rgba(255,255,255,0.12)',
  hp: '#3dffc4',
  hpLow: '#ff5470',
  label: '#dbe6ff',
};

/**
 * Renderizador Canvas 2D.
 *
 * Optimizaciones:
 *  - El mapa estático (suelo, rejilla, muros) se dibuja UNA vez en un lienzo
 *    fuera de pantalla y luego se copia con drawImage cada fotograma.
 *  - Los brillos se precalculan como sprites (sin shadowBlur por fotograma).
 *  - Partículas en un pool preasignado; se omiten entidades fuera de cámara.
 *  - Resolución adaptada a devicePixelRatio (limitada a 2).
 */
export class GameRenderer {
  readonly camera = new Camera();
  readonly particles = new ParticleSystem(600);
  private readonly ctx: CanvasRenderingContext2D;
  private mapLayer: HTMLCanvasElement | null = null;
  private worldWidth = 0;
  private worldHeight = 0;
  private dpr = 1;
  private readonly colors = new Map<string, string>();
  private readonly names = new Map<string, string>();
  /** URL de apariencia por jugador (solo visual; no afecta a la simulación). */
  private readonly avatars = new Map<string, string | null>();
  private readonly glowSprites = new Map<string, HTMLCanvasElement>();
  private shardSprite: HTMLCanvasElement | null = null;
  private readonly beams: BeamFx[] = [];
  private readonly chains: ChainFx[] = [];
  private readonly rings: RingFx[] = [];
  private fxTime = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D no disponible en este navegador');
    this.ctx = ctx;
  }

  setPlayers(players: GamePlayerInfo[]): void {
    this.colors.clear();
    this.names.clear();
    this.avatars.clear();
    for (const p of players) {
      this.colors.set(p.id, p.color);
      this.names.set(p.id, p.username);
      this.avatars.set(p.id, p.avatarUrl ?? null);
      if (!this.glowSprites.has(p.color)) this.glowSprites.set(p.color, makeGlow(p.color, 24));
    }
    if (!this.shardSprite) this.shardSprite = makeGlow(COLORS.shard, 18);
    avatarCache.preload(players.map((p) => p.avatarUrl));
  }

  /** Cambio de apariencia durante la partida: se actualiza solo la imagen. */
  setAvatar(playerId: string, avatarUrl: string | null): void {
    if (!this.names.has(playerId)) return;
    this.avatars.set(playerId, avatarUrl);
    avatarCache.preload([avatarUrl]);
  }

  /* ------------------------------ Efectos de habilidades ------------------------------ */

  /** Rayo perforante: haz luminoso breve (más ancho y dorado si está sobrecargado). */
  addBeam(x1: number, y1: number, x2: number, y2: number, ownerId: string, power: number): void {
    this.pushFx(this.beams, { x1, y1, x2, y2, color: this.colorOf(ownerId), power, t0: this.fxTime });
  }

  /** Cadena eléctrica: arcos quebrados entre los objetivos. */
  addChain(points: { x: number; y: number }[], corrosive: boolean): void {
    this.pushFx(this.chains, { points: points.map((p) => ({ ...p })), corrosive, t0: this.fxTime });
  }

  /** Anillo expansivo (teletransporte, rotura de satélite, sobrecarga). */
  addRing(x: number, y: number, color: string, radius: number): void {
    this.pushFx(this.rings, { x, y, color, radius, t0: this.fxTime });
  }

  private pushFx<T>(list: T[], item: T): void {
    list.push(item);
    // Sin acumulación de entidades visuales.
    if (list.length > MAX_FX) list.splice(0, list.length - MAX_FX);
  }

  private pruneFx(): void {
    const t = this.fxTime;
    const keep = <T extends { t0: number }>(list: T[], life: number) => {
      let n = 0;
      for (const item of list) if (t - item.t0 < life) list[n++] = item;
      list.length = n;
    };
    keep(this.beams, BEAM_FX_S);
    keep(this.chains, CHAIN_FX_S);
    keep(this.rings, RING_FX_S);
  }

  colorOf(id: string): string {
    return this.colors.get(id) ?? '#ffffff';
  }

  /** Prerrenderiza el mapa estático. */
  setMap(tiles: Uint8Array, cols: number, rows: number, tileSize: number): void {
    this.worldWidth = cols * tileSize;
    this.worldHeight = rows * tileSize;
    this.camera.setWorld(this.worldWidth, this.worldHeight);
    const layer = document.createElement('canvas');
    layer.width = this.worldWidth;
    layer.height = this.worldHeight;
    const g = layer.getContext('2d');
    if (!g) return;
    g.fillStyle = COLORS.floor;
    g.fillRect(0, 0, layer.width, layer.height);

    g.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      g.strokeStyle = x % 5 === 0 ? COLORS.gridMajor : COLORS.gridMinor;
      g.beginPath();
      g.moveTo(x * tileSize + 0.5, 0);
      g.lineTo(x * tileSize + 0.5, layer.height);
      g.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      g.strokeStyle = y % 5 === 0 ? COLORS.gridMajor : COLORS.gridMinor;
      g.beginPath();
      g.moveTo(0, y * tileSize + 0.5);
      g.lineTo(layer.width, y * tileSize + 0.5);
      g.stroke();
    }

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const t = tiles[y * cols + x];
        if (t === TILE.FLOOR) continue;
        const px = x * tileSize;
        const py = y * tileSize;
        const isWall = t === TILE.WALL;
        g.fillStyle = isWall ? COLORS.wall : COLORS.cover;
        g.fillRect(px, py, tileSize, tileSize);
        // Bordes de neón solo donde la celda limita con suelo.
        g.strokeStyle = isWall ? COLORS.wallEdge : COLORS.coverEdge;
        g.lineWidth = 2;
        const floorAt = (cx: number, cy: number) =>
          cx >= 0 && cy >= 0 && cx < cols && cy < rows && tiles[cy * cols + cx] === TILE.FLOOR;
        g.beginPath();
        if (floorAt(x, y - 1)) {
          g.moveTo(px, py + 1);
          g.lineTo(px + tileSize, py + 1);
        }
        if (floorAt(x, y + 1)) {
          g.moveTo(px, py + tileSize - 1);
          g.lineTo(px + tileSize, py + tileSize - 1);
        }
        if (floorAt(x - 1, y)) {
          g.moveTo(px + 1, py);
          g.lineTo(px + 1, py + tileSize);
        }
        if (floorAt(x + 1, y)) {
          g.moveTo(px + tileSize - 1, py);
          g.lineTo(px + tileSize - 1, py + tileSize);
        }
        g.stroke();
        if (!isWall) {
          // Cobertura: trama diagonal para distinguirla de los muros.
          g.strokeStyle = 'rgba(155, 107, 255, 0.35)';
          g.lineWidth = 1;
          g.beginPath();
          for (let k = -tileSize; k < tileSize; k += 10) {
            g.moveTo(px + Math.max(0, k), py + Math.max(0, -k));
            g.lineTo(px + Math.min(tileSize, tileSize + k), py + Math.min(tileSize, tileSize - k));
          }
          g.stroke();
        }
      }
    }
    this.mapLayer = layer;
  }

  /** Ajusta el lienzo al tamaño del contenedor y a la densidad de píxeles. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.camera.setViewport(rect.width, rect.height);
  }

  render(frame: RenderFrame): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04060f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const s = cam.scale * this.dpr;
    ctx.setTransform(s, 0, 0, s, (-cam.x * cam.scale + cam.viewWidth / 2) * this.dpr, (-cam.y * cam.scale + cam.viewHeight / 2) * this.dpr);

    if (this.mapLayer) ctx.drawImage(this.mapLayer, 0, 0);

    // Fragmentos de datos (pulso suave).
    const pulse = 1 + Math.sin(frame.time * 4) * 0.12;
    for (const shard of frame.shards) {
      if (!cam.isVisible(shard.x, shard.y, 40)) continue;
      if (this.shardSprite) {
        const size = 36 * pulse;
        ctx.drawImage(this.shardSprite, shard.x - size / 2, shard.y - size / 2, size, size);
      }
      ctx.fillStyle = COLORS.shard;
      ctx.beginPath();
      const r = GAME.SHARD_RADIUS * 0.8 * pulse;
      ctx.moveTo(shard.x, shard.y - r);
      ctx.lineTo(shard.x + r * 0.7, shard.y);
      ctx.lineTo(shard.x, shard.y + r);
      ctx.lineTo(shard.x - r * 0.7, shard.y);
      ctx.closePath();
      ctx.fill();
    }

    this.fxTime = frame.time;
    this.pruneFx();

    // Proyectiles con brillo precalculado y mezcla aditiva.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < frame.projectileCount; i++) {
      const p = frame.projectiles[i] as InterpolatedProjectile;
      if (!cam.isVisible(p.x, p.y, 30)) continue;
      const color = this.colorOf(p.ownerId);
      const glow = this.glowSprites.get(color);
      // Apariencia por tipo (solo visual: la colisión la calcula el servidor).
      // p pesado · d dron · f fragmento · e fragmento eléctrico · c corrosivo · b rebotador
      const small = p.k === 'd' || p.k === 'f' || p.k === 'e';
      const g = p.k === 'p' ? 40 : small ? 18 : 28;
      if (glow) ctx.drawImage(glow, p.x - g / 2, p.y - g / 2, g, g);
      ctx.fillStyle =
        p.k === 'd' ? '#3dffc4' : p.k === 'c' ? '#8dff5a' : p.k === 'e' ? '#fff36b' : '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.k === 'p' ? 6 : small ? 2.5 : GAME.PROJECTILE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      if (p.k === 'b') {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    this.drawBeams(ctx);
    this.drawChains(ctx);
    this.particles.draw(ctx);
    this.drawRings(ctx);
    ctx.globalCompositeOperation = 'source-over';

    // Jugadores.
    for (const p of frame.players) {
      if (!p.alive || !cam.isVisible(p.x, p.y, 60)) continue;
      this.drawPlayer(p, p.id === frame.localId, frame.time);
    }
  }

  private drawBeams(ctx: CanvasRenderingContext2D): void {
    for (const b of this.beams) {
      const k = 1 - (this.fxTime - b.t0) / BEAM_FX_S;
      const core = b.power === 2 ? '#ffe28a' : '#e8fbff';
      const width = b.power === 2 ? 10 : b.power === 1 ? 8 : 6;
      ctx.lineCap = 'round';
      ctx.strokeStyle = hexToRgba(b.power > 0 ? '#ffb22e' : b.color, 0.35 * k);
      ctx.lineWidth = width * 2.2;
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.strokeStyle = hexToRgba(b.color, 0.8 * k);
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.strokeStyle = core;
      ctx.globalAlpha = k;
      ctx.lineWidth = width * 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = 'butt';
  }

  private drawChains(ctx: CanvasRenderingContext2D): void {
    for (const c of this.chains) {
      const k = 1 - (this.fxTime - c.t0) / CHAIN_FX_S;
      ctx.strokeStyle = c.corrosive ? `rgba(141, 255, 90, ${0.9 * k})` : `rgba(160, 220, 255, ${0.9 * k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 1; i < c.points.length; i++) {
        const a = c.points[i - 1] as { x: number; y: number };
        const b = c.points[i] as { x: number; y: number };
        ctx.moveTo(a.x, a.y);
        // Arco quebrado: cuatro tramos con desplazamientos perpendiculares.
        const nx = -(b.y - a.y);
        const ny = b.x - a.x;
        const len = Math.hypot(nx, ny) || 1;
        for (let s = 1; s < 4; s++) {
          const t = s / 4;
          const off = (s % 2 === 0 ? -1 : 1) * 7 * Math.sin(this.fxTime * 60 + i + s);
          ctx.lineTo(a.x + (b.x - a.x) * t + (nx / len) * off, a.y + (b.y - a.y) * t + (ny / len) * off);
        }
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
  }

  private drawRings(ctx: CanvasRenderingContext2D): void {
    for (const r of this.rings) {
      const t = (this.fxTime - r.t0) / RING_FX_S;
      ctx.strokeStyle = hexToRgba(r.color, 0.8 * (1 - t));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius * (0.4 + t), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Satélites protectores: placas BLINDADAS compactas (hexágono achatado con
   * borde luminoso propio), orientadas hacia fuera. Diseño distinto del dron
   * de apoyo (rombo relleno del color del jugador que dispara).
   */
  private drawSatellites(p: RenderPlayer): void {
    if (!p.satellites) return;
    const ctx = this.ctx;
    const n = p.satellites.length;
    for (let i = 0; i < n; i++) {
      const charge = p.satellites[i] as number;
      const a = p.satAngle + (i * Math.PI * 2) / n;
      const x = p.x + Math.cos(a) * p.satRadius;
      const y = p.y + Math.sin(a) * p.satRadius;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(-4, -8);
      ctx.lineTo(4, -8);
      ctx.lineTo(7, 0);
      ctx.lineTo(4, 8);
      ctx.lineTo(-4, 8);
      ctx.lineTo(-6, 0);
      ctx.closePath();
      if (charge <= 0) {
        // Roto: solo un contorno tenue discontinuo mientras se recupera.
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(122, 215, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = '#0b1530';
        ctx.fill();
        ctx.strokeStyle = `rgba(122, 215, 255, ${0.45 + 0.55 * charge})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#7ad7ff';
        ctx.fillRect(1, -5 * charge, 2, 10 * charge); // carga restante
      }
      ctx.restore();
    }
  }

  private drawPlayer(p: RenderPlayer, isLocal: boolean, time: number): void {
    const ctx = this.ctx;
    const color = this.colorOf(p.id);
    const r = GAME.PLAYER_RADIUS;
    ctx.globalAlpha = p.connected ? 1 : 0.4;

    // Sobrecarga: resplandor de energía pulsante. Cazador: destello breve.
    if (p.overload || p.hunter) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 14);
      ctx.strokeStyle = p.overload ? `rgba(255, 178, 46, ${0.5 + 0.4 * pulse})` : 'rgba(46, 230, 255, 0.7)';
      ctx.lineWidth = p.overload ? 3 : 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 9 + pulse * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Corrosión: burbujas ácidas verdes alrededor de la nave afectada.
    if (p.corroded) {
      ctx.fillStyle = 'rgba(141, 255, 90, 0.7)';
      for (let i = 0; i < 5; i++) {
        const a = time * 2 + i * 1.26;
        const rr = r + 3 + ((time * 18 + i * 7) % 10);
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const glow = this.glowSprites.get(color);
    if (glow) {
      const g = p.dashing ? 96 : 64;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(glow, p.x - g / 2, p.y - g / 2, g, g);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Chasis hexagonal con la imagen del jugador (si ya está cargada) y cañón
    // orientado hacia donde apunta. Mismo radio lógico para todos los jugadores.
    drawUnit(ctx, p.x, p.y, r, p.aim, color, avatarCache.get(this.avatars.get(p.id)), isLocal);
    // Arma de rayo: emisor luminoso alargado en lugar del cañón de balas.
    if (p.beamWeapon) {
      ctx.strokeStyle = '#e8fbff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(p.aim) * (r - 2), p.y + Math.sin(p.aim) * (r - 2));
      ctx.lineTo(p.x + Math.cos(p.aim) * (r + 12), p.y + Math.sin(p.aim) * (r + 12));
      ctx.stroke();
    }
    this.drawSatellites(p);

    // Escudo de energía: anillo cuya parte iluminada indica la carga restante.
    if (p.shieldMax > 0) {
      const ratio = Math.max(0, Math.min(1, p.shield / p.shieldMax));
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(122, 215, 255, 0.18)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
      if (ratio > 0) {
        ctx.strokeStyle = `rgba(122, 215, 255, ${0.45 + 0.45 * ratio})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
        ctx.stroke();
      }
    }

    // Dron de apoyo en la posición orbital que calcula el servidor.
    if (p.drone !== null) {
      const orbit = UPGRADE_CATALOG.dron_apoyo.params.orbitRadius;
      const dx = p.x + Math.cos(p.drone) * orbit;
      const dy = p.y + Math.sin(p.drone) * orbit;
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dx, dy - 6);
      ctx.lineTo(dx + 6, dy);
      ctx.lineTo(dx, dy + 6);
      ctx.lineTo(dx - 6, dy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    if (p.protected) {
      ctx.strokeStyle = 'rgba(46, 230, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -time * 20;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Barra de vida y nombre.
    const w = 34;
    const hpRatio = Math.max(0, Math.min(1, p.hp / GAME.MAX_HP));
    ctx.fillStyle = COLORS.hpBack;
    ctx.fillRect(p.x - w / 2, p.y - r - 12, w, 4);
    ctx.fillStyle = hpRatio < 0.35 ? COLORS.hpLow : COLORS.hp;
    ctx.fillRect(p.x - w / 2, p.y - r - 12, w * hpRatio, 4);
    ctx.fillStyle = isLocal ? color : COLORS.label;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.names.get(p.id) ?? '', p.x, p.y - r - 17);
    if (p.choosing) {
      ctx.fillStyle = '#3dffc4';
      ctx.font = '600 9px system-ui, sans-serif';
      // Por debajo de la órbita del dron para que nunca se solapen.
      ctx.fillText('eligiendo mejora', p.x, p.y + r + 32);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.particles.clear();
    this.beams.length = 0;
    this.chains.length = 0;
    this.rings.length = 0;
  }
}

function makeGlow(color: string, radius: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = radius * 2;
  const g = c.getContext('2d');
  if (!g) return c;
  const grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
  grad.addColorStop(0, hexToRgba(color, 0.55));
  grad.addColorStop(0.4, hexToRgba(color, 0.18));
  grad.addColorStop(1, hexToRgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, radius * 2, radius * 2);
  return c;
}

function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
