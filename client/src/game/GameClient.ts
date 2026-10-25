import { NET } from '../../../shared/constants';
import { decodeTiles } from '../../../shared/MapGenerator';
import type { GameEvent, GameSnapshot, GameStartPayload, InputIntent, PlayerSnapshot } from '../../../shared/protocol';
import { GameLoop } from '../canvas/GameLoop';
import { GameRenderer, type RenderPlayer } from '../canvas/GameRenderer';
import { InputState } from '../controls/InputState';
import { KeyboardControls } from '../controls/KeyboardControls';
import { TouchControls } from '../controls/TouchControls';
import { isTouchDevice } from '../controls/device';
import { SnapshotInterpolator } from '../network/Interpolator';
import type { SocketClient } from '../network/SocketClient';
import { $, Disposer, formatDuration, h } from '../ui/dom';
import { UPGRADE_CATALOG } from '../../../shared/upgrades';
import { SYNERGY_CATALOG } from '../../../shared/synergies';
import type { PlayerUpgradeView } from '../../../shared/protocol';
import { UpgradePanel } from './UpgradePanel';

/**
 * Orquesta una partida en el cliente:
 *  - envía intenciones a 30 Hz (nunca posiciones),
 *  - recibe instantáneas autoritativas y las interpola para dibujar,
 *  - actualiza el HUD y expone el estado autoritativo en el DOM
 *    (`data-player-x`, `data-player-y`…) para las pruebas E2E.
 */
export class GameClient {
  readonly input = new InputState();
  private readonly renderer: GameRenderer;
  private readonly loop: GameLoop;
  private readonly interpolator = new SnapshotInterpolator();
  private readonly disposer = new Disposer();
  private readonly renderPlayers = new Map<string, RenderPlayer>();
  private keyboard: KeyboardControls | null = null;
  private touch: TouchControls | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private inputTimer: number | null = null;
  private payload: GameStartPayload | null = null;
  private localAuth: PlayerSnapshot | null = null;
  private localX = 0;
  private localY = 0;
  private seq = 0;
  private lastSent: InputIntent | null = null;
  private lastSentAt = 0;
  private time = 0;
  private scoreboardKey = '';
  private readonly el: Record<string, HTMLElement>;
  /** Ventana de mejoras y progreso del HUD (solo muestra el estado del servidor). */
  readonly upgrades: UpgradePanel;

  constructor(private readonly socket: SocketClient) {
    const canvas = $<HTMLCanvasElement>('#game-canvas');
    this.renderer = new GameRenderer(canvas);
    this.el = {
      root: $('#game-root'),
      canvas,
      state: $('#player-state'),
      world: $('#world-state'),
      hp: $('#hud-hp'),
      hpFill: $('#hud-hp-fill'),
      energy: $('#hud-energy'),
      energyFill: $('#hud-energy-fill'),
      shards: $('#hud-shards'),
      timer: $('#hud-timer'),
      goal: $('#hud-goal'),
      score: $('#hud-score'),
      target: $('#hud-target'),
      scores: $('#hud-scores'),
      fps: $('#hud-fps'),
      ping: $('#hud-ping'),
      tick: $('#hud-tick'),
      feed: $('#hud-feed'),
      overlay: $('#hud-overlay'),
      touchRoot: $('#touch-controls'),
      stick: $('#touch-stick'),
      knob: $('#touch-knob'),
      fire: $('#touch-fire'),
      dash: $('#touch-dash'),
      touchTp: $('#touch-tp'),
      touchOv: $('#touch-ov'),
      abilities: $('#hud-abilities'),
    };
    this.upgrades = new UpgradePanel(
      {
        panel: $('#upgrade-panel'),
        milestone: $('#upgrade-milestone'),
        options: $('#upgrade-options'),
        status: $('#upgrade-status'),
        later: $<HTMLButtonElement>('#upgrade-later'),
        progressFill: $('#hud-upgrade-fill'),
        progressText: $('#hud-upgrade-text'),
        perks: $('#hud-perks'),
        reopen: $<HTMLButtonElement>('#hud-upgrade-open'),
      },
      socket,
      (id) => this.pushFeed(`Mejora instalada: ${UPGRADE_CATALOG[id].name}`),
      (id) => this.pushFeed(`Sinergia activada: ${SYNERGY_CATALOG[id].name}`),
    );
    this.loop = new GameLoop({
      update: (dt) => this.update(dt),
      render: () => this.render(),
      onFps: (fps) => {
        (this.el.fps as HTMLElement).textContent = String(fps);
        (this.el.root as HTMLElement).dataset.fps = String(fps);
      },
    });
  }

  get active(): boolean {
    return this.payload !== null;
  }

  get matchId(): string | null {
    return this.payload?.matchId ?? null;
  }

  start(payload: GameStartPayload): void {
    if (this.payload?.matchId === payload.matchId) {
      // Resincronización (reconexión): se restaura el estado de mejoras del servidor.
      if (payload.upgrades) this.upgrades.update(payload.upgrades);
      return;
    }
    this.stop();
    this.payload = payload;
    this.seq = 0;
    this.lastSent = null;
    this.localAuth = null;
    this.interpolator.clear();
    this.renderPlayers.clear();
    this.renderer.clear();
    this.scoreboardKey = '';
    this.resetAbilityHud();
    this.lastTp = 0;

    const tiles = decodeTiles(payload.map.tiles);
    this.renderer.setMap(tiles, payload.map.cols, payload.map.rows, payload.map.tileSize);
    this.renderer.setPlayers(payload.players);
    this.socket.latency.seedOffset(payload.serverTime);
    (this.el.target as HTMLElement).textContent = String(payload.scoreToWin);
    (this.el.score as HTMLElement).textContent = '0';
    this.statusKey = '';
    this.setStatus('en_curso');
    (this.el.state as HTMLElement).dataset.playerId = payload.yourId;
    (this.el.feed as HTMLElement).replaceChildren();
    // Estado de mejoras de ESTA partida (nunca se arrastra de la anterior).
    this.upgrades.reset();
    if (payload.upgrades) this.upgrades.update(payload.upgrades);

    // Controles según el dispositivo.
    const touch = isTouchDevice();
    (this.el.root as HTMLElement).dataset.touch = String(touch);
    if (touch) {
      this.touch = new TouchControls(
        this.input,
        this.el.touchRoot as HTMLElement,
        this.el.stick as HTMLElement,
        this.el.knob as HTMLElement,
        this.el.fire as HTMLElement,
        this.el.dash as HTMLElement,
        this.el.touchTp as HTMLElement,
        this.el.touchOv as HTMLElement,
      );
      this.touch.attach();
    } else {
      (this.el.touchRoot as HTMLElement).hidden = true;
    }
    // El teclado también se atiende en táctiles con teclado físico.
    this.keyboard = new KeyboardControls(this.input, this.el.canvas as HTMLCanvasElement, () => this.localScreenPos());
    this.keyboard.attach();

    this.disposer.add(this.onSocket('game:snapshot', (s: GameSnapshot) => this.onSnapshot(s)));
    this.disposer.add(this.onSocket('game:event', (e: GameEvent) => this.onEvent(e)));
    this.disposer.add(
      this.onSocket('player:appearance', (d: { playerId: string; avatarUrl: string | null }) =>
        this.renderer.setAvatar(d.playerId, d.avatarUrl),
      ),
    );
    this.disposer.add(
      this.onSocket('game:upgrades', (v: PlayerUpgradeView) => {
        // Solo el estado de ESTA partida: nunca se aplican mejoras de otra.
        if (v.matchId && v.matchId !== this.payload?.matchId) return;
        this.upgrades.update(v);
      }),
    );
    this.disposer.add(
      this.socket.onState((state) => {
        this.upgrades.setConnection(state);
        if (state !== 'online') this.showOverlay('Reconectando con el servidor…');
        else this.showOverlay(null);
      }),
    );
    this.upgrades.setConnection(this.socket.connectionState);

    this.resizeObserver = new ResizeObserver(() => this.renderer.resize());
    this.resizeObserver.observe(this.el.canvas as HTMLCanvasElement);
    this.renderer.resize();

    this.inputTimer = window.setInterval(() => this.sendInput(), 1000 / NET.INPUT_SEND_RATE);
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    if (this.inputTimer !== null) window.clearInterval(this.inputTimer);
    this.inputTimer = null;
    this.keyboard?.detach();
    this.keyboard = null;
    this.touch?.detach();
    this.touch = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposer.dispose();
    this.input.reset();
    this.payload = null;
    this.upgrades.reset();
    this.resetAbilityHud();
    this.renderer.clear();
    this.showOverlay(null);
  }

  private onSocket<T>(
    event: 'game:snapshot' | 'game:event' | 'player:appearance' | 'game:upgrades',
    handler: (data: T) => void,
  ): () => void {
    const fn = handler as (data: never) => void;
    this.socket.socket.on(event, fn);
    return () => this.socket.socket.off(event, fn);
  }

  /* ------------------------------ Red ------------------------------ */

  private sendInput(): void {
    if (!this.payload) return;
    const move = this.input.movement();
    const intent: InputIntent = {
      seq: this.seq + 1,
      moveX: Math.round(move.x * 1000) / 1000,
      moveY: Math.round(move.y * 1000) / 1000,
      aim: Math.round(this.input.aim * 1000) / 1000,
      fire: this.input.fire,
      dash: this.input.dash,
      tp: this.input.teleport,
      ov: this.input.overload,
    };
    const prev = this.lastSent;
    const changed =
      !prev ||
      prev.moveX !== intent.moveX ||
      prev.moveY !== intent.moveY ||
      Math.abs(prev.aim - intent.aim) > 0.01 ||
      prev.fire !== intent.fire ||
      prev.dash !== intent.dash ||
      prev.tp !== intent.tp ||
      prev.ov !== intent.ov;
    const now = performance.now();
    // Se envía al cambiar o, como latido, cada 100 ms.
    if (!changed && now - this.lastSentAt < 100) return;
    this.seq = intent.seq;
    this.lastSent = intent;
    this.lastSentAt = now;
    this.socket.sendInput(intent);
  }

  private onSnapshot(snapshot: GameSnapshot): void {
    if (!this.payload) return;
    if (snapshot.matchId && snapshot.matchId !== this.payload.matchId) return; // de otra partida
    this.interpolator.push(snapshot);
    const me = snapshot.players.find((p) => p.id === this.payload?.yourId) ?? null;
    if (me) {
      // Teletransporte confirmado por el servidor: la nave aparece en el destino al instante.
      const teleported = (me.tp ?? 0) !== this.lastTp;
      this.lastTp = me.tp ?? 0;
      if (!this.localAuth || teleported || Math.hypot(me.x - this.localX, me.y - this.localY) > 160) {
        this.localX = me.x;
        this.localY = me.y;
        if (!this.localAuth) this.renderer.camera.snapTo(me.x, me.y);
      }
      this.localAuth = me;
      this.upgrades.setGuarded(me.choosing === true);
      this.updateHud(me, snapshot);
      const st = this.el.state as HTMLElement;
      st.dataset.playerX = me.x.toFixed(1);
      st.dataset.playerY = me.y.toFixed(1);
      st.dataset.playerHp = String(me.hp);
      st.dataset.serverTick = String(snapshot.tick);
    }
    (this.el.world as HTMLElement).dataset.players = JSON.stringify(
      snapshot.players.map((p) => ({ id: p.id, x: p.x, y: p.y, hp: p.hp, alive: p.alive, score: p.score })),
    );
    (this.el.tick as HTMLElement).textContent = String(snapshot.tick);
  }

  private onEvent(e: GameEvent): void {
    const parts = this.renderer.particles;
    switch (e.type) {
      case 'fire':
        if (e.source === 'dron') parts.burst(e.x, e.y, '#3dffc4', 3, 90, 0.12, 1.5);
        else parts.burst(e.x, e.y, this.renderer.colorOf(e.playerId), 4, 120, 0.15, 2);
        break;
      case 'impact':
        parts.burst(e.x, e.y, '#9fb4ff', 6, 140, 0.25, 2);
        break;
      case 'hit':
        if (e.absorbed) parts.burst(e.x, e.y, '#7ad7ff', 10, 200, 0.3, 2);
        if (e.damage > 0) parts.burst(e.x, e.y, this.renderer.colorOf(e.targetId), 10, 220, 0.35, 2.5);
        break;
      case 'kill':
        parts.burst(e.x, e.y, this.renderer.colorOf(e.victimId), 40, 320, 0.8, 3);
        parts.burst(e.x, e.y, '#ffffff', 12, 180, 0.4, 2);
        this.pushFeed(`${this.nameOf(e.killerId)} desconectó a ${this.nameOf(e.victimId)}`);
        break;
      case 'pickup':
        parts.burst(e.x, e.y, '#3dffc4', 14, 160, 0.45, 2.5);
        break;
      case 'respawn':
        parts.burst(e.x, e.y, this.renderer.colorOf(e.playerId), 20, 200, 0.5, 2.5);
        break;
      /* --- Expansión 1.3 --- */
      case 'beam':
        this.renderer.addBeam(e.x1, e.y1, e.x2, e.y2, e.playerId, e.power);
        parts.burst(e.x2, e.y2, e.power === 2 ? '#ffe28a' : '#e8fbff', 8, 160, 0.25, 2);
        if (e.playerId === this.payload?.yourId) {
          const cd = this.upgrades.current?.abilities.beamCooldownMs ?? 0;
          this.beamReadyAt = this.socket.latency.serverNow() + cd;
        }
        break;
      case 'chain':
        this.renderer.addChain(e.points, e.corrosive);
        break;
      case 'bounce':
        parts.burst(e.x, e.y, '#ffffff', 5, 140, 0.18, 1.5);
        break;
      case 'teleport': {
        const color = this.renderer.colorOf(e.playerId);
        parts.burst(e.fromX, e.fromY, color, 18, 160, 0.35, 2);
        parts.burst(e.x, e.y, color, 22, 200, 0.4, 2.5);
        this.renderer.addRing(e.fromX, e.fromY, color, 26);
        this.renderer.addRing(e.x, e.y, color, 34);
        break;
      }
      case 'overload':
        if (e.active) {
          const pl = this.renderPlayers.get(e.playerId);
          if (pl) this.renderer.addRing(pl.x, pl.y, '#ffb22e', 40);
          if (e.playerId === this.payload?.yourId) this.pushFeed('Sobrecarga activa');
        }
        break;
      case 'block':
        parts.burst(e.x, e.y, '#7ad7ff', 8, 160, 0.25, 2);
        break;
      case 'satellite':
        if (e.state === 'roto') {
          parts.burst(e.x, e.y, '#7ad7ff', 22, 240, 0.45, 2.5);
          this.renderer.addRing(e.x, e.y, '#7ad7ff', 22);
        }
        break;
      case 'fragment':
        parts.burst(e.x, e.y, e.electric ? '#fff36b' : this.renderer.colorOf(e.playerId), 10, 220, 0.3, 2);
        break;
    }
  }

  private nameOf(id: string): string {
    return this.payload?.players.find((p) => p.id === id)?.username ?? '¿?';
  }

  private pushFeed(text: string): void {
    const feed = this.el.feed as HTMLElement;
    const item = h('li', {}, text);
    feed.append(item);
    while (feed.children.length > 4) feed.firstElementChild?.remove();
    window.setTimeout(() => item.remove(), 5000);
  }

  /* ------------------------------ HUD ------------------------------ */

  private updateHud(me: PlayerSnapshot, snapshot: GameSnapshot): void {
    (this.el.hp as HTMLElement).textContent = String(me.hp);
    (this.el.hpFill as HTMLElement).style.transform = `scaleX(${me.hp / 100})`;
    (this.el.energy as HTMLElement).textContent = String(me.energy);
    (this.el.energyFill as HTMLElement).style.transform = `scaleX(${me.energy / 100})`;
    (this.el.shards as HTMLElement).textContent = String(me.shards);
    (this.el.timer as HTMLElement).textContent = formatDuration(snapshot.remainingMs);
    (this.el.score as HTMLElement).textContent = String(me.score);
    this.setStatus(snapshot.remainingMs <= 30_000 ? 'ultimos' : 'en_curso');

    if (!me.alive) this.showOverlay(`Desconectado. Reapareces en ${Math.ceil(me.respawnInMs / 1000)} s`);
    else if (this.socket.connectionState === 'online') this.showOverlay(null);

    const sorted = [...snapshot.players].sort((a, b) => b.score - a.score || b.kills - a.kills);
    const key = sorted.map((p) => `${p.id}:${p.score}:${p.kills}:${p.deaths}:${p.connected}`).join('|');
    if (key === this.scoreboardKey) return;
    this.scoreboardKey = key;
    const list = this.el.scores as HTMLElement;
    list.replaceChildren(
      ...sorted.map((p) => {
        const swatch = h('span', { class: 'swatch' });
        swatch.style.background = this.renderer.colorOf(p.id);
        return h(
          'li',
          { 'data-self': String(p.id === me.id), 'data-connected': String(p.connected) },
          h('span', {}, swatch, this.nameOf(p.id)),
          h('span', {}, `${p.score} pts · ${p.kills}/${p.deaths}`),
        );
      }),
    );
  }

  private statusKey = '';
  /** Estado de la partida en el HUD (el fin real lo decide el servidor con game:end). */
  setStatus(state: 'en_curso' | 'ultimos' | 'finalizada'): void {
    if (state === this.statusKey || !this.payload) return;
    this.statusKey = state;
    const goal = this.el.goal as HTMLElement;
    goal.dataset.state = state;
    const target = this.payload.scoreToWin;
    goal.textContent =
      state === 'finalizada'
        ? 'Partida finalizada'
        : state === 'ultimos'
          ? `Últimos segundos · gana quien llegue a ${target}`
          : `En curso · gana quien llegue a ${target}`;
  }

  private overlayText: string | null = null;
  private showOverlay(text: string | null): void {
    if (text === this.overlayText) return;
    this.overlayText = text;
    const overlay = this.el.overlay as HTMLElement;
    overlay.hidden = text === null;
    overlay.textContent = text ?? '';
  }

  /* ------------------------------ Bucle ------------------------------ */

  private update(dt: number): void {
    this.time += dt;
    this.renderer.particles.update(dt);
    if (this.localAuth) {
      // Suavizado hacia la última posición AUTORITATIVA (sin predicción).
      const k = 1 - Math.exp(-25 * dt);
      this.localX += (this.localAuth.x - this.localX) * k;
      this.localY += (this.localAuth.y - this.localY) * k;
      this.renderer.camera.follow(this.localX, this.localY, dt);
    }
  }

  private localScreenPos(): { x: number; y: number } | null {
    if (!this.localAuth) return null;
    const cam = this.renderer.camera;
    return { x: cam.worldToScreenX(this.localX), y: cam.worldToScreenY(this.localY) };
  }

  private render(): void {
    if (!this.payload) return;
    this.keyboard?.updateAim();
    const renderTime = this.socket.latency.serverNow() - NET.INTERPOLATION_DELAY_MS;
    const sampled = this.interpolator.sample(renderTime);
    for (const s of sampled.values()) {
      let rp = this.renderPlayers.get(s.id);
      if (!rp) {
        rp = {
          id: s.id,
          x: 0,
          y: 0,
          aim: 0,
          alive: true,
          hp: 100,
          dashing: false,
          protected: false,
          connected: true,
          shield: 0,
          shieldMax: 0,
          drone: null,
          choosing: false,
          beamWeapon: false,
          overload: false,
          hunter: false,
          corroded: false,
          satellites: null,
          satAngle: 0,
          satRadius: 0,
        };
        this.renderPlayers.set(s.id, rp);
      }
      const isLocal = s.id === this.payload.yourId;
      const latest = s.latest;
      rp.x = isLocal ? this.localX : s.x;
      rp.y = isLocal ? this.localY : s.y;
      rp.aim = isLocal ? this.input.aim : s.aim;
      rp.alive = isLocal ? (latest?.alive ?? s.alive) : s.alive;
      rp.hp = latest?.hp ?? 100;
      rp.dashing = latest?.dashing ?? false;
      rp.protected = latest?.protected ?? false;
      rp.connected = latest?.connected ?? true;
      rp.shield = latest?.shield ?? 0;
      rp.shieldMax = latest?.shieldMax ?? 0;
      rp.drone = latest?.drone ?? null;
      rp.choosing = latest?.choosing ?? false;
      rp.beamWeapon = latest?.wpn === 'r';
      rp.overload = latest?.ov === true;
      rp.hunter = latest?.hunt === true;
      rp.corroded = latest?.cor === true;
      rp.satellites = latest?.sats ?? null;
      rp.satAngle = latest?.satA ?? 0;
      rp.satRadius = latest?.satR ?? 0;
    }
    this.updateAbilityHud();
    const projectiles = this.interpolator.sampleProjectiles();
    this.renderer.render({
      players: this.renderPlayers.values(),
      projectiles: projectiles.items,
      projectileCount: projectiles.count,
      shards: this.interpolator.latest?.shards ?? [],
      localId: this.payload.yourId,
      time: this.time,
    });
  }

  /* ------------------------------ Habilidades (HUD) ------------------------------ */

  /** null = HUD vacío y sin construir (estado inicial de cada partida). */
  private abilityKey: string | null = null;
  private beamReadyAt = 0;
  private lastTp = 0;
  private readonly abilityItems = new Map<string, { el: HTMLElement; state: HTMLElement }>();

  /**
   * Vacía de verdad la barra de habilidades y los botones táctiles: sin
   * elementos, recargas ni estados de la partida anterior. Se reconstruyen
   * solo a partir del estado que envíe el servidor para la partida nueva.
   */
  private resetAbilityHud(): void {
    this.abilityKey = null;
    this.beamReadyAt = 0;
    this.abilityItems.clear();
    const list = this.el.abilities as HTMLElement;
    list.replaceChildren();
    list.hidden = true;
    for (const btn of [this.el.touchTp, this.el.touchOv, this.el.fire] as HTMLElement[]) {
      btn.style.removeProperty('--cd');
      delete btn.dataset.state;
      delete btn.dataset.cd;
    }
    (this.el.touchTp as HTMLElement).hidden = true;
    (this.el.touchOv as HTMLElement).hidden = true;
  }

  /**
   * Recargas y duración restante, a partir de los instantes que envía el
   * servidor (solo se muestran: el servidor valida cada activación).
   */
  private updateAbilityHud(): void {
    const view = this.upgrades.current;
    const a = view?.abilities;
    const list = this.el.abilities as HTMLElement;
    const entries: { id: string; name: string; key: string; readyAt: number; total: number; activeUntil?: number; duration?: number }[] = [];
    if (a?.weapon === 'rayo' && a.beamCooldownMs) {
      entries.push({ id: 'rayo', name: 'Rayo', key: 'Clic', readyAt: this.beamReadyAt, total: a.beamCooldownMs });
    }
    if (a?.teleportCooldownMs && a.teleportReadyAt !== null) {
      entries.push({ id: 'tp', name: 'Teletransporte', key: 'E', readyAt: a.teleportReadyAt, total: a.teleportCooldownMs });
    }
    if (a?.overloadCooldownMs && a.overloadReadyAt !== null) {
      entries.push({
        id: 'ov',
        name: 'Sobrecarga',
        key: 'Q',
        readyAt: a.overloadReadyAt,
        total: a.overloadCooldownMs,
        activeUntil: a.overloadUntil ?? 0,
        duration: a.overloadDurationMs ?? 0,
      });
    }
    const key = entries.map((e) => e.id).join(',');
    if (key !== this.abilityKey) {
      this.abilityKey = key;
      this.abilityItems.clear();
      list.replaceChildren(
        ...entries.map((e) => {
          const state = h('span', { class: 'ability__state' }, 'Lista');
          const el = h(
            'li',
            { class: 'ability', 'data-ability': e.id, 'data-testid': `ability-${e.id}` },
            h('span', { class: 'ability__name' }, h('span', {}, e.name), h('span', { class: 'ability__key' }, e.key)),
            state,
          );
          this.abilityItems.set(e.id, { el, state });
          return el;
        }),
      );
      list.hidden = entries.length === 0;
      (this.el.touchTp as HTMLElement).hidden = !entries.some((e) => e.id === 'tp');
      (this.el.touchOv as HTMLElement).hidden = !entries.some((e) => e.id === 'ov');
    }
    const now = this.socket.latency.serverNow();
    for (const e of entries) {
      const item = this.abilityItems.get(e.id);
      if (!item) continue;
      let state: 'lista' | 'recarga' | 'activa';
      let cd: number;
      let text: string;
      if (e.activeUntil && now < e.activeUntil && e.duration) {
        state = 'activa';
        cd = (e.activeUntil - now) / e.duration;
        text = `Activa ${((e.activeUntil - now) / 1000).toFixed(1)} s`;
      } else if (now < e.readyAt) {
        state = 'recarga';
        cd = Math.min(1, (e.readyAt - now) / e.total);
        text = `${((e.readyAt - now) / 1000).toFixed(1)} s`;
      } else {
        state = 'lista';
        cd = 0;
        text = 'Lista';
      }
      if (item.el.dataset.state !== state) item.el.dataset.state = state;
      item.el.style.setProperty('--cd', cd.toFixed(3));
      if (item.state.textContent !== text) item.state.textContent = text;
      // Mismo estado en los botones táctiles (y la recarga del rayo en «Disparar»).
      const btn = e.id === 'tp' ? this.el.touchTp : e.id === 'ov' ? this.el.touchOv : this.el.fire;
      if (btn) {
        btn.style.setProperty('--cd', state === 'recarga' ? cd.toFixed(3) : '0');
        btn.dataset.state = state;
        if (e.id === 'rayo') btn.dataset.cd = '';
      }
    }
  }

  /** Ping visible en el HUD. */
  setPing(ms: number): void {
    (this.el.ping as HTMLElement).textContent = `${Math.round(ms)} ms`;
  }

  get fps(): number {
    return this.loop.fps;
  }
}
