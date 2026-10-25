import { GAME, TILE } from '../../../shared/constants';
import { distanceSq, normalizeIntent } from '../../../shared/math';
import { encodeTiles, generateMap, type GameMap, type SpawnPoint } from '../../../shared/MapGenerator';
import { SeededRandom } from '../../../shared/random';
import { compareRanking, computeKdr, tiebreakCriterion } from '../../../shared/stats';
import {
  PLAYER_COLORS,
  type AbilityStateView,
  type GameEvent,
  type GameSnapshot,
  type GameStartPayload,
  type InputIntent,
  type MatchResult,
  type PlayerResult,
  type PlayerSnapshot,
  type PlayerUpgradeView,
} from '../../../shared/protocol';
import { PROGRESSION, UPGRADE_LIMITS, computeLoadout, type Loadout, type UpgradeId } from '../../../shared/upgrades';
import {
  findTeleportDestination,
  pickChainTarget,
  renewCorrosion,
  satellitePositions,
  type CorrosionState,
} from './Abilities';
import { moveWithCollision, overlapsSolid, raycastSolid, raycastSolidHit, segmentCircleHit, separateBodies } from './CollisionSystem';
import { absorbWithShield, applyDamage, canFire, computeDamage, streakMultiplier } from './CombatSystem';
import {
  UpgradeError,
  addProgress,
  chooseUpgrade,
  createUpgradeState,
  cryptoRandom,
  openNextOffer,
  toUpgradeView,
  type RandomSource,
  type UpgradeState,
} from './UpgradeSystem';

/**
 * Simulación autoritativa de una partida.
 *
 * El cliente solo aporta intenciones (`InputIntent`). Aquí se decide todo lo
 * demás: posiciones, velocidad, colisiones, proyectiles, daño, vida,
 * eliminaciones, reapariciones, recursos recogidos, puntuación y resultado.
 * También las mejoras y habilidades (rebotes, rayo, satélites, teletransporte,
 * corrosión, sobrecarga, cadenas, fragmentos y sinergias).
 *
 * El paso de simulación es fijo (1/TICK_RATE s) y se ejecuta con un
 * acumulador sobre el reloj real; ante pausas largas se limita el número de
 * pasos para no producir saltos.
 */

export interface MatchPlayerInit {
  id: string;
  username: string;
  /** Solo apariencia: no afecta a hitbox, velocidad ni daño. */
  avatarUrl?: string | null;
}

export interface SatelliteState {
  /** Daño bloqueado desde la última recuperación. */
  damage: number;
  /** >0 mientras está roto: momento en que se recupera (ms de simulación). */
  brokenUntil: number;
}

export interface SimPlayer {
  id: string;
  username: string;
  color: string;
  avatarUrl: string | null;
  joinOrder: number;
  x: number;
  y: number;
  aim: number;
  hp: number;
  energy: number;
  alive: boolean;
  connected: boolean;
  left: boolean;
  protectedUntil: number;
  respawnAt: number;
  lastFireAt: number;
  dashUntil: number;
  dashHeld: boolean;
  input: InputIntent;
  lastSeq: number;
  kills: number;
  deaths: number;
  shards: number;
  score: number;
  streak: number;
  survivalMs: number;
  currentLifeMs: number;
  longestLifeMs: number;
  /* --- Mejoras (estado temporal de ESTA partida) --- */
  upgrades: UpgradeState;
  /** Parámetros efectivos derivados de las mejoras (se recalculan al elegir). */
  loadout: Loadout;
  shieldHp: number;
  lastDamagedAt: number;
  droneNextFireAt: number;
  /** Protección mientras elige mejora (ms de simulación). */
  guardUntil: number;
  lastGuardAt: number;
  /* --- Habilidades de la expansión 1.3 (ms de simulación) --- */
  tpHeld: boolean;
  ovHeld: boolean;
  beamReadyAt: number;
  teleportReadyAt: number;
  teleportCount: number;
  overloadUntil: number;
  overloadReadyAt: number;
  overloadAnnounced: boolean;
  hunterUntil: number;
  reactiveUntil: number;
  satellites: SatelliteState[];
  corrosion: CorrosionState | null;
}

type ProjectileKind = 'normal' | 'pesado' | 'dron' | 'fragmento';

interface Projectile {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  traveled: number;
  /** Daño base antes de la caída por distancia (y de la racha, si aplica). Incluye la Sobrecarga activa al disparar. */
  baseDamage: number;
  /** Mismo daño SIN Sobrecarga ni Cazador (para los fragmentos sin Fragmentación eléctrica). */
  rawDamage: number;
  useStreak: boolean;
  /** Si el daño cae con la distancia (no en el dron ni en los fragmentos: daño fijo). */
  falloff: boolean;
  /** Alcance máximo de este proyectil (px). */
  range: number;
  kind: ProjectileKind;
  /** Rebotes que le quedan (Bala rebotadora). */
  bouncesLeft: number;
  /** Puede dividirse al impactar (Bala fragmentada). Los fragmentos nunca. */
  canSplit: boolean;
  /** Daño por pulso de la corrosión que aplica (0 = no corrosivo). */
  corrosionTick: number;
  /** Cadena eléctrica que puede lanzar: saltos y límite compartido (fragmentos). */
  chain: { jumps: number; budget: { left: number } | null } | null;
  /** Disparado con Sobrecarga activa. */
  overloaded: boolean;
  /** Fragmento eléctrico (visual de Fragmentación eléctrica). */
  electric: boolean;
  /** Objetivo que este proyectil no puede golpear (el que originó el fragmento). */
  ignoreId: string | null;
}

interface Shard {
  id: number;
  x: number;
  y: number;
}

export interface GameServerOptions {
  matchId: string;
  roomId: string;
  seed: number;
  players: MatchPlayerInit[];
  durationMs?: number;
  scoreToWin?: number;
  /** Reloj en ms (inyectable en pruebas). */
  now?: () => number;
  onSnapshot?: (snapshot: GameSnapshot) => void;
  onEvent?: (event: GameEvent) => void;
  onEnd?: (result: MatchResult) => void;
  /** Estado privado de mejoras de un jugador (solo se envía a ese jugador). */
  onUpgrades?: (playerId: string, view: PlayerUpgradeView) => void;
  /** Fuente aleatoria de las opciones de mejora (por defecto, criptográfica). */
  upgradeRandom?: RandomSource;
}

const IDLE_INPUT: InputIntent = { seq: 0, moveX: 0, moveY: 0, aim: 0, fire: false, dash: false };

/**
 * ESTADO INICIAL de un jugador al comenzar una partida (función única y
 * reutilizable). Todo lo que devuelve pertenece EXCLUSIVAMENTE a esta partida
 * y se crea de cero cada vez: vida, energía, posición, protección, progreso e
 * hitos de mejora, mejoras y niveles, sinergias, arma (balas por defecto),
 * cadencia, daño, velocidad, rebotes, fragmentación, munición especial,
 * escudo, satélites, dron, teletransporte, rayo, Sobrecarga, Cazador de
 * energía, corrosión y estadísticas de la partida.
 *
 * Lo PERMANENTE del jugador (no se toca): id, nombre e imagen personalizada
 * (`avatarUrl`), que vienen de su cuenta. El color depende del orden de ingreso.
 *
 * Las habilidades no usan temporizadores propios: todos sus tiempos se miden
 * con el reloj de simulación de la partida (empieza en 0), así que ningún
 * temporizador de una partida anterior puede alterar este estado.
 */
export function createInitialPlayerState(init: MatchPlayerInit, joinOrder: number, spawn: SpawnPoint): SimPlayer {
  return {
    id: init.id,
    username: init.username,
    color: PLAYER_COLORS[joinOrder % PLAYER_COLORS.length] as string,
    avatarUrl: init.avatarUrl ?? null,
    joinOrder,
    x: spawn.x,
    y: spawn.y,
    aim: 0,
    hp: GAME.MAX_HP,
    energy: GAME.MAX_ENERGY,
    alive: true,
    connected: true,
    left: false,
    protectedUntil: GAME.SPAWN_PROTECTION_MS,
    respawnAt: 0,
    lastFireAt: -Infinity,
    dashUntil: 0,
    dashHeld: false,
    input: { ...IDLE_INPUT },
    lastSeq: -1,
    kills: 0,
    deaths: 0,
    shards: 0,
    score: 0,
    streak: 0,
    survivalMs: 0,
    currentLifeMs: 0,
    longestLifeMs: 0,
    // Mejoras: sin progreso, sin hitos, sin mejoras, equipamiento de serie
    // (arma de balas, cadencia/daño/velocidad base, sin sinergias).
    upgrades: createUpgradeState(),
    loadout: computeLoadout({}),
    shieldHp: 0,
    lastDamagedAt: -Infinity,
    droneNextFireAt: 0,
    guardUntil: 0,
    lastGuardAt: -Infinity,
    // Habilidades activas y efectos temporales: todo desactivado y sin recarga.
    tpHeld: false,
    ovHeld: false,
    beamReadyAt: 0,
    teleportReadyAt: 0,
    teleportCount: 0,
    overloadUntil: 0,
    overloadReadyAt: 0,
    overloadAnnounced: false,
    hunterUntil: 0,
    reactiveUntil: 0,
    satellites: [],
    corrosion: null,
  };
}
const STEP_MS = 1000 / GAME.TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;
const MUZZLE = GAME.PLAYER_RADIUS + 2;

export class GameServer {
  readonly matchId: string;
  readonly roomId: string;
  readonly map: GameMap;
  readonly durationMs: number;
  readonly scoreToWin: number;
  readonly players = new Map<string, SimPlayer>();

  private readonly projectiles: Projectile[] = [];
  private readonly shards: Shard[] = [];
  private readonly rng: SeededRandom;
  private readonly now: () => number;
  private readonly opts: GameServerOptions;

  /** Tiempo de simulación transcurrido (ms). */
  private simTime = 0;
  private tick = 0;
  private nextProjectileId = 1;
  private nextShardId = 1;
  private nextShardAt = 0;
  private startedAtWall = 0;
  private lastWall = 0;
  private accumulator = 0;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  /** Partida retirada de su sala: ya no acepta ninguna operación ni emite nada. */
  private disposed = false;
  private endResult: MatchResult | null = null;
  private readonly upgradeRandom: RandomSource;
  /** Jugadores cuyo estado de mejoras cambió en este paso. */
  private readonly upgradesDirty = new Set<string>();
  /** Cadenas eléctricas resueltas en el paso actual (límite global). */
  private chainsThisTick = 0;

  constructor(options: GameServerOptions) {
    if (options.players.length < 1) throw new Error('Una partida necesita al menos un jugador');
    this.opts = options;
    this.matchId = options.matchId;
    this.roomId = options.roomId;
    this.map = generateMap(options.seed);
    this.durationMs = options.durationMs ?? GAME.DEFAULT_MATCH_DURATION_S * 1000;
    this.scoreToWin = options.scoreToWin ?? GAME.SCORE_TO_WIN;
    this.now = options.now ?? (() => Date.now());
    this.rng = new SeededRandom((options.seed ^ 0x5eed1234) >>> 0);
    this.upgradeRandom = options.upgradeRandom ?? cryptoRandom;

    options.players.forEach((p, index) => {
      const spawn = this.map.spawnPoints[index % this.map.spawnPoints.length] as SpawnPoint;
      this.players.set(p.id, createInitialPlayerState(p, index, spawn));
    });
  }

  /* ------------------------------ Ciclo de vida ------------------------------ */

  start(): void {
    if (this.timer) return;
    this.startedAtWall = this.now();
    this.lastWall = this.startedAtWall;
    this.timer = setInterval(() => this.update(), STEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Libera la partida cuando la sala la retira: detiene el bucle, elimina
   * proyectiles, rayos/cadenas pendientes (no hay: son instantáneos),
   * fragmentos, satélites, corrosión y efectos temporales, y desactiva todos
   * los callbacks. Idempotente. Las partidas nuevas no comparten nada con esta.
   */
  dispose(): void {
    if (this.disposed) return;
    // Sin resultado ni persistencia: quien retira la partida decide si terminó.
    this.ended = true;
    this.disposed = true;
    this.stop();
    this.projectiles.length = 0;
    this.shards.length = 0;
    this.upgradesDirty.clear();
    for (const p of this.players.values()) {
      p.corrosion = null;
      p.satellites.length = 0;
      p.overloadUntil = 0;
      p.overloadAnnounced = false;
      p.hunterUntil = 0;
      p.reactiveUntil = 0;
      p.guardUntil = 0;
      Object.assign(p.input, { moveX: 0, moveY: 0, fire: false, dash: false, tp: false, ov: false });
    }
  }

  get elapsedMs(): number {
    return this.simTime;
  }

  get currentTick(): number {
    return this.tick;
  }

  /** Avanza la simulación según el reloj real con paso fijo. */
  private update(): void {
    const wall = this.now();
    // Limita el tiempo acumulado tras una pausa larga del proceso.
    this.accumulator += Math.min(wall - this.lastWall, STEP_MS * MAX_STEPS_PER_FRAME);
    this.lastWall = wall;
    let steps = 0;
    while (this.accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME && !this.ended) {
      this.step(STEP_MS);
      this.accumulator -= STEP_MS;
      steps++;
    }
    if (!this.ended && steps > 0) this.opts.onSnapshot?.(this.snapshot());
  }

  /* ------------------------------ Entradas ------------------------------ */

  /**
   * Registra la intención más reciente del jugador. La entrada ya llega
   * validada por Zod; aquí se aplican reglas de juego (secuencia, estado).
   * Devuelve false si se descarta.
   */
  handleInput(playerId: string, input: InputIntent): boolean {
    const player = this.players.get(playerId);
    if (!player || player.left || this.ended || this.disposed) return false;
    if (input.seq <= player.lastSeq) return false; // fuera de orden o repetida
    player.lastSeq = input.seq;
    const intent = normalizeIntent(input.moveX, input.moveY);
    player.input.seq = input.seq;
    player.input.moveX = intent.x;
    player.input.moveY = intent.y;
    player.input.aim = input.aim;
    player.input.fire = input.fire;
    // El impulso y las habilidades activas se activan en el flanco de subida
    // (pulsar, no mantener): repetir el mensaje no las vuelve a activar, y el
    // servidor comprueba además la propiedad de la mejora y su recarga.
    if (input.dash && !player.dashHeld) player.input.dash = true;
    player.dashHeld = input.dash;
    const tp = input.tp === true;
    if (tp && !player.tpHeld) player.input.tp = true;
    player.tpHeld = tp;
    const ov = input.ov === true;
    if (ov && !player.ovHeld) player.input.ov = true;
    player.ovHeld = ov;
    return true;
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    if (!connected) {
      Object.assign(player.input, { moveX: 0, moveY: 0, fire: false, dash: false, tp: false, ov: false });
      player.dashHeld = false;
      player.tpHeld = false;
      player.ovHeld = false;
      // La elección pendiente se conserva para la reconexión, pero la
      // protección de elección termina (no se acumula ni se reactiva al volver).
      player.guardUntil = Math.min(player.guardUntil, this.simTime);
    }
  }

  /** El jugador abandona definitivamente: deja de participar pero conserva sus estadísticas. */
  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || player.left) return;
    this.closeLife(player);
    this.clearTransient(player);
    player.left = true;
    player.connected = false;
    player.alive = false;
    const active = [...this.players.values()].filter((p) => !p.left);
    if (active.length < GAME.MIN_PLAYERS_TO_START) this.finish('abandono');
  }

  /* ------------------------------ Simulación ------------------------------ */

  /** Un paso fijo de simulación. Público para poder probarlo de forma determinista. */
  step(dtMs: number): void {
    if (this.ended || this.disposed) return;
    this.simTime += dtMs;
    this.tick++;
    this.chainsThisTick = 0;
    const dt = dtMs / 1000;

    const bodies: SimPlayer[] = [];
    for (const p of this.players.values()) {
      if (p.left) continue;
      if (!p.alive) {
        if (this.simTime >= p.respawnAt) this.respawn(p);
        continue;
      }
      this.updatePlayer(p, dt, dtMs);
      bodies.push(p);
    }
    separateBodies(this.map, bodies, GAME.PLAYER_RADIUS);

    for (const p of bodies) {
      if (!p.input.fire || !p.alive) continue;
      // Con el rayo equipado NO se disparan balas: el rayo tiene su propia recarga.
      if (p.loadout.weapon === 'rayo') {
        if (this.simTime >= p.beamReadyAt) this.fireBeam(p);
      } else if (canFire(p.lastFireAt, this.simTime, p.loadout.fireCooldownMs)) {
        this.fire(p);
      }
    }
    for (const p of bodies) {
      if (p.alive && p.loadout.drone) this.updateDrone(p);
    }

    this.updateProjectiles(dt);
    this.updateCorrosion();
    this.updateShards();
    this.checkEnd();
    // Los hitos se resuelven DESPUÉS de comprobar el final: si la partida
    // terminó en este paso, no se abre ninguna elección nueva.
    this.flushUpgrades();
  }

  private updatePlayer(p: SimPlayer, dt: number, dtMs: number): void {
    p.energy = Math.min(GAME.MAX_ENERGY, p.energy + GAME.ENERGY_REGEN * dt);
    const shield = p.loadout.shield;
    if (shield && p.shieldHp < shield.capacity && this.simTime - p.lastDamagedAt >= shield.rechargeDelayMs) {
      p.shieldHp = Math.min(shield.capacity, p.shieldHp + shield.rechargePerSecond * dt);
    }
    if (p.input.dash) {
      p.input.dash = false;
      if (p.energy >= GAME.DASH_COST && this.simTime >= p.dashUntil) {
        p.energy -= GAME.DASH_COST;
        p.dashUntil = this.simTime + GAME.DASH_DURATION_MS;
      }
    }
    if (p.input.ov) {
      p.input.ov = false;
      this.tryOverload(p);
    }
    if (p.overloadAnnounced && this.simTime >= p.overloadUntil) {
      p.overloadAnnounced = false;
      this.opts.onEvent?.({ type: 'overload', playerId: p.id, active: false });
    }
    this.updateSatellites(p);

    const speed =
      GAME.PLAYER_SPEED * p.loadout.moveSpeedMultiplier * (this.simTime < p.dashUntil ? GAME.DASH_MULTIPLIER : 1);
    moveWithCollision(this.map, p, p.input.moveX * speed * dt, p.input.moveY * speed * dt, GAME.PLAYER_RADIUS);
    p.aim = p.input.aim;
    if (p.input.tp) {
      p.input.tp = false;
      this.tryTeleport(p);
    }
    p.survivalMs += dtMs;
    p.currentLifeMs += dtMs;
  }

  /** Multiplicador temporal del arma: Sobrecarga o, si no, Cazador de energía (nunca ambos). */
  private damageBoost(p: SimPlayer, weapon: 'bala' | 'rayo'): number {
    const ov = p.loadout.overload;
    if (!ov) return 1;
    if (this.simTime < p.overloadUntil) return weapon === 'rayo' ? ov.beamMultiplier : ov.damageMultiplier;
    if (ov.hunter && this.simTime < p.hunterUntil) return ov.hunter.damageMultiplier;
    return 1;
  }

  /**
   * Disparo de balas según el equipamiento: una ráfaga con 1–5 proyectiles
   * (patrón, rebotes y factores de daño calculados en `computeLoadout`).
   */
  private fire(p: SimPlayer): void {
    p.lastFireAt = this.simTime;
    // Disparar termina la protección de elección: no se puede atacar siendo invulnerable.
    if (p.guardUntil > this.simTime) p.guardUntil = this.simTime;
    const lo = p.loadout;
    const perpX = -Math.sin(p.aim);
    const perpY = Math.cos(p.aim);
    this.opts.onEvent?.({
      type: 'fire',
      playerId: p.id,
      x: p.x + Math.cos(p.aim) * MUZZLE,
      y: p.y + Math.sin(p.aim) * MUZZLE,
      aim: p.aim,
    });
    const boost = this.damageBoost(p, 'bala');
    // Límite explícito: ninguna combinación supera MAX_DAMAGE_MULTIPLIER sobre el daño base.
    const maxBase = GAME.BASE_DAMAGE * UPGRADE_LIMITS.MAX_DAMAGE_MULTIPLIER;
    const raw = Math.min(GAME.BASE_DAMAGE * lo.damageMultiplier, maxBase);
    const boosted = Math.min(GAME.BASE_DAMAGE * lo.damageMultiplier * boost, maxBase);
    const corrosion = lo.corrosion;
    const corrosionTick =
      corrosion === null ? 0 : lo.projectileKind === 'pesado' ? (corrosion.heavyTickDamage ?? 0) : corrosion.tickDamage;
    for (const shot of lo.volley) {
      const angle = p.aim + shot.angle;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      const sx = p.x + dirX * MUZZLE + perpX * shot.offset;
      const sy = p.y + dirY * MUZZLE + perpY * shot.offset;
      // Si el cañón está dentro de un muro el disparo se pierde.
      if (raycastSolid(this.map, p.x, p.y, sx, sy) !== null) {
        this.opts.onEvent?.({ type: 'impact', x: sx, y: sy });
        continue;
      }
      this.spawnProjectile({
        ownerId: p.id,
        x: sx,
        y: sy,
        vx: dirX * lo.projectileSpeed,
        vy: dirY * lo.projectileSpeed,
        traveled: MUZZLE,
        baseDamage: boosted * shot.damageFactor,
        rawDamage: raw * shot.damageFactor,
        useStreak: true,
        falloff: true,
        range: GAME.PROJECTILE_RANGE,
        kind: lo.projectileKind,
        bouncesLeft: shot.bounces,
        canSplit: lo.fragments !== null,
        corrosionTick,
        chain: lo.chain ? { jumps: lo.chain.jumps, budget: null } : null,
        overloaded: boost > 1 && this.simTime < p.overloadUntil,
        electric: false,
        ignoreId: null,
      });
    }
  }

  private spawnProjectile(data: Omit<Projectile, 'id'>): boolean {
    // Límite global: ninguna combinación puede crear proyectiles sin control.
    if (this.projectiles.length >= UPGRADE_LIMITS.MAX_ACTIVE_PROJECTILES) return false;
    this.projectiles.push({ id: this.nextProjectileId++, ...data });
    return true;
  }

  /* ------------------------------ Rayo perforante ------------------------------ */

  /**
   * Rayo instantáneo (hitscan) que SUSTITUYE al disparo normal mientras está
   * equipado. Atraviesa hasta `maxTargets` enemigos y se detiene en la primera
   * pared. Cada enemigo recibe daño UNA vez por disparo. Recarga propia, que no
   * modifican Disparo acelerado, Munición pesada ni Proyectiles veloces.
   */
  private fireBeam(p: SimPlayer): void {
    const beam = p.loadout.beam;
    if (!beam || this.simTime < p.beamReadyAt) return;
    p.beamReadyAt = this.simTime + beam.cooldownMs;
    p.lastFireAt = this.simTime;
    if (p.guardUntil > this.simTime) p.guardUntil = this.simTime;

    const dirX = Math.cos(p.aim);
    const dirY = Math.sin(p.aim);
    const x1 = p.x + dirX * MUZZLE;
    const y1 = p.y + dirY * MUZZLE;
    // Si el cañón está dentro de un muro, el rayo no sale.
    if (raycastSolid(this.map, p.x, p.y, x1, y1) !== null) {
      this.opts.onEvent?.({ type: 'impact', x: x1, y: y1 });
      return;
    }
    let x2 = x1 + dirX * beam.range;
    let y2 = y1 + dirY * beam.range;
    const wallT = raycastSolid(this.map, x1, y1, x2, y2);
    if (wallT !== null) {
      x2 = x1 + (x2 - x1) * wallT;
      y2 = y1 + (y2 - y1) * wallT;
    }

    // Objetivos a lo largo del rayo, ordenados por distancia; cada uno una sola vez.
    const hitRadius = GAME.PLAYER_RADIUS + beam.halfWidth;
    const candidates: { target: SimPlayer; t: number }[] = [];
    for (const o of this.players.values()) {
      if (o === p || !o.alive || o.left) continue;
      const t = segmentCircleHit(x1, y1, x2, y2, o.x, o.y, hitRadius);
      if (t !== null) candidates.push({ target: o, t });
    }
    candidates.sort((a, b) => a.t - b.t || (a.target.id < b.target.id ? -1 : 1));

    const boost = this.damageBoost(p, 'rayo');
    const damage = Math.min(
      UPGRADE_LIMITS.MAX_BEAM_DAMAGE,
      Math.round(beam.damage * boost * streakMultiplier(p.streak)),
    );
    const hits: string[] = [];
    let firstDamaged: SimPlayer | null = null;
    for (const { target, t } of candidates.slice(0, beam.maxTargets)) {
      const hx = x1 + (x2 - x1) * t;
      const hy = y1 + (y2 - y1) * t;
      hits.push(target.id);
      // Un satélite del objetivo situado en la trayectoria absorbe el rayo destinado a él.
      const sat = this.satelliteOnSegment(target, x1, y1, x2, y2, t);
      if (sat !== null) {
        this.damageSatellite(target, sat, damage, hx, hy);
        continue;
      }
      if (this.dealDamage(p, target, damage, hx, hy)) firstDamaged ??= target;
      else this.opts.onEvent?.({ type: 'impact', x: hx, y: hy });
    }
    const overloadActive = this.simTime < p.overloadUntil && p.loadout.overload !== null;
    const power: 0 | 1 | 2 = overloadActive ? (p.loadout.synergies.includes('rayo_sobrecargado') ? 2 : 1) : 0;
    this.opts.onEvent?.({ type: 'beam', playerId: p.id, x1, y1, x2, y2, hits, power });

    // Cadena perforante: UNA cadena por disparo, desde el primer enemigo dañado,
    // sin volver a dañar a ninguno de los atravesados por el rayo.
    if (firstDamaged && p.loadout.chain?.fromBeam) {
      this.runChain(p, firstDamaged, damage, p.loadout.chain.jumps, new Set(hits), null);
    }
  }

  /* ------------------------------ Dron de apoyo ------------------------------ */

  /** Posición del dron de apoyo (órbita determinista según el tiempo de simulación). */
  private dronePosition(p: SimPlayer): { x: number; y: number; angle: number } {
    const d = p.loadout.drone;
    const angle = ((this.simTime / 1000) * (d?.orbitSpeed ?? 0) + p.joinOrder * 1.3) % (Math.PI * 2);
    const r = d?.orbitRadius ?? 0;
    return { x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r, angle };
  }

  /** El dron dispara al rival visible más cercano dentro de su alcance, con intervalo mínimo. */
  private updateDrone(p: SimPlayer): void {
    const drone = p.loadout.drone;
    if (!drone || this.simTime < p.droneNextFireAt) return;
    const pos = this.dronePosition(p);
    if (raycastSolid(this.map, p.x, p.y, pos.x, pos.y) !== null) return; // dron tras un muro
    let target: SimPlayer | null = null;
    let bestD = drone.range * drone.range;
    for (const o of this.players.values()) {
      if (o === p || !o.alive || o.left) continue;
      if (this.isProtected(o)) continue;
      const d = distanceSq(pos.x, pos.y, o.x, o.y);
      if (d > bestD) continue;
      if (raycastSolid(this.map, pos.x, pos.y, o.x, o.y) !== null) continue;
      bestD = d;
      target = o;
    }
    if (!target) return; // se vuelve a intentar en el siguiente paso
    const aim = Math.atan2(target.y - pos.y, target.x - pos.x);
    p.droneNextFireAt = this.simTime + drone.intervalMs;
    this.opts.onEvent?.({ type: 'fire', playerId: p.id, x: pos.x, y: pos.y, aim, source: 'dron' });
    this.spawnProjectile({
      ownerId: p.id,
      x: pos.x,
      y: pos.y,
      vx: Math.cos(aim) * drone.projectileSpeed,
      vy: Math.sin(aim) * drone.projectileSpeed,
      traveled: 0,
      baseDamage: drone.damage,
      rawDamage: drone.damage,
      useStreak: false,
      falloff: false,
      range: drone.range,
      kind: 'dron',
      bouncesLeft: 0,
      canSplit: false,
      corrosionTick: 0,
      chain: null,
      overloaded: false,
      electric: false,
      ignoreId: null,
    });
  }

  /* ------------------------------ Proyectiles ------------------------------ */

  private updateProjectiles(dt: number): void {
    const hitRadius = GAME.PLAYER_RADIUS + GAME.PROJECTILE_RADIUS;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i] as Projectile;
      let nx = pr.x + pr.vx * dt;
      let ny = pr.y + pr.vy * dt;
      let segLen = Math.hypot(nx - pr.x, ny - pr.y);
      // Alcance máximo: se recorta el último tramo.
      const remaining = pr.range - pr.traveled;
      let expired = false;
      if (segLen >= remaining) {
        const k = remaining / segLen;
        nx = pr.x + (nx - pr.x) * k;
        ny = pr.y + (ny - pr.y) * k;
        segLen = remaining;
        expired = true;
      }

      const wall = raycastSolidHit(this.map, pr.x, pr.y, nx, ny);
      let bestT = wall?.t ?? null;
      let target: SimPlayer | null = null;
      let blocker: { owner: SimPlayer; index: number } | null = null;
      for (const p of this.players.values()) {
        if (!p.alive || p.left || p.id === pr.ownerId) continue;
        if (p.id !== pr.ignoreId) {
          const t = segmentCircleHit(pr.x, pr.y, nx, ny, p.x, p.y, hitRadius);
          if (t !== null && (bestT === null || t < bestT)) {
            bestT = t;
            target = p;
            blocker = null;
          }
        }
        // Satélites protectores del jugador: interceptan proyectiles enemigos.
        const sats = this.activeSatellites(p);
        for (const s of sats) {
          const t = segmentCircleHit(pr.x, pr.y, nx, ny, s.x, s.y, s.radius + GAME.PROJECTILE_RADIUS);
          if (t !== null && (bestT === null || t < bestT)) {
            bestT = t;
            target = null;
            blocker = { owner: p, index: s.index };
          }
        }
      }

      if (bestT !== null) {
        const hx = pr.x + (nx - pr.x) * bestT;
        const hy = pr.y + (ny - pr.y) * bestT;
        const distance = pr.traveled + segLen * bestT;
        if (target) {
          this.resolveHit(pr, target, distance, hx, hy);
        } else if (blocker) {
          // El proyectil se elimina al bloquearse: no puede bloquearse dos veces.
          this.damageSatellite(blocker.owner, blocker.index, this.projectileDamage(pr, distance), hx, hy);
        } else if (wall && pr.bouncesLeft > 0 && (wall.nx !== 0 || wall.ny !== 0)) {
          // Rebote: reflexión respecto a la normal de la pared. El proyectil se
          // detiene en este paso justo fuera de la pared (un solo rebote por
          // contacto) y conserva su alcance total y su contador propio.
          pr.x = hx + wall.nx * 0.5;
          pr.y = hy + wall.ny * 0.5;
          if (wall.nx !== 0) pr.vx = -pr.vx;
          if (wall.ny !== 0) pr.vy = -pr.vy;
          pr.bouncesLeft--;
          pr.traveled += segLen * bestT;
          this.opts.onEvent?.({ type: 'bounce', x: hx, y: hy });
          continue;
        } else if (wall) {
          this.opts.onEvent?.({ type: 'impact', x: hx, y: hy });
        }
        this.projectiles.splice(i, 1);
        continue;
      }

      pr.x = nx;
      pr.y = ny;
      pr.traveled += segLen;
      if (expired) this.projectiles.splice(i, 1);
    }
  }

  private projectileDamage(pr: Projectile, distance: number): number {
    const attacker = this.players.get(pr.ownerId);
    return pr.falloff
      ? computeDamage(distance, pr.useStreak ? (attacker?.streak ?? 0) : 0, pr.baseDamage)
      : Math.max(0, Math.round(pr.baseDamage));
  }

  private resolveHit(pr: Projectile, target: SimPlayer, distance: number, hx: number, hy: number): void {
    const attacker = this.players.get(pr.ownerId) ?? null;
    // Disparos de la nave: caída por distancia y racha. Dron y fragmentos: daño fijo.
    const damage = this.projectileDamage(pr, distance);
    if (!this.dealDamage(attacker, target, damage, hx, hy)) {
      // Protegido: el impacto no causa daño ni efectos secundarios.
      this.opts.onEvent?.({ type: 'impact', x: hx, y: hy });
      return;
    }
    if (!attacker) return;
    // Efectos al impactar, resueltos en el servidor y en este orden:
    // 1) corrosión, 2) cadena eléctrica (puede contagiar corrosión), 3) fragmentos.
    if (pr.corrosionTick > 0 && target.alive && attacker.loadout.corrosion) {
      const c = attacker.loadout.corrosion;
      this.applyCorrosion(target, attacker.id, pr.corrosionTick, c.tickMs, c.durationMs, true);
    }
    if (pr.chain) {
      this.runChain(attacker, target, damage, pr.chain.jumps, new Set([target.id]), pr.chain.budget);
    }
    if (pr.canSplit) this.spawnFragments(attacker, pr, hx, hy, target.id);
  }

  /* ------------------------------ Daño centralizado ------------------------------ */

  private isProtected(p: SimPlayer): boolean {
    return this.simTime < p.protectedUntil || this.simTime < p.guardUntil;
  }

  /**
   * ÚNICO punto por el que se aplica daño a una nave (balas, rayo, dron,
   * cadena, fragmentos y corrosión): protección, escudo, vida, evento de
   * impacto y eliminación. Devuelve true si causó algún efecto.
   */
  private dealDamage(
    attacker: SimPlayer | null,
    target: SimPlayer,
    amount: number,
    x: number,
    y: number,
    dot = false,
  ): boolean {
    if (!target.alive || target.left || this.isProtected(target)) return false;
    const damage = Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
    if (damage <= 0) return false;
    // El escudo absorbe primero; el resto va a la vida.
    const shield = absorbWithShield(target.shieldHp, damage);
    target.shieldHp = shield.shield;
    target.lastDamagedAt = this.simTime;
    const outcome = applyDamage(target, shield.remaining, this.simTime);
    if (outcome.applied <= 0 && shield.absorbed <= 0) return false;
    this.opts.onEvent?.({
      type: 'hit',
      targetId: target.id,
      attackerId: attacker?.id ?? target.id,
      damage: outcome.applied,
      x,
      y,
      ...(shield.absorbed > 0 ? { absorbed: shield.absorbed } : {}),
      ...(dot ? { dot: true } : {}),
    });
    if (outcome.killed) this.handleKill(attacker, target);
    return true;
  }

  private handleKill(attacker: SimPlayer | null, target: SimPlayer): void {
    target.deaths++;
    target.streak = 0;
    target.respawnAt = this.simTime + GAME.RESPAWN_MS;
    this.closeLife(target);
    // Los efectos temporales no sobreviven a la eliminación.
    this.clearTransient(target);
    if (attacker && attacker.id !== target.id) {
      attacker.kills++;
      attacker.streak++;
      attacker.score += GAME.SCORE_PER_KILL;
      this.gainProgress(attacker, PROGRESSION.PROGRESS_PER_KILL);
    }
    this.opts.onEvent?.({
      type: 'kill',
      killerId: attacker?.id ?? target.id,
      victimId: target.id,
      x: target.x,
      y: target.y,
    });
  }

  /** Corrosión y efectos temporales del jugador (al morir, abandonar o terminar). */
  private clearTransient(p: SimPlayer): void {
    p.corrosion = null;
    if (p.overloadUntil > this.simTime) p.overloadUntil = this.simTime; // la recarga sigue su curso
    if (p.overloadAnnounced) {
      p.overloadAnnounced = false;
      this.opts.onEvent?.({ type: 'overload', playerId: p.id, active: false });
    }
    p.hunterUntil = 0;
    p.reactiveUntil = 0;
  }

  /* ------------------------------ Cadena eléctrica ------------------------------ */

  /**
   * Cadena eléctrica desde `start`: salta al enemigo más cercano con línea de
   * visión dentro del radio, sin repetir objetivos (`excluded`), con daño
   * decreciente (50 %, 30 %…) del daño inicial y como mucho `jumps` saltos.
   * `budget` limita los saltos compartidos entre los fragmentos de una bala.
   * Límite global de cadenas por paso. No se encadena desde otra cadena.
   */
  private runChain(
    attacker: SimPlayer,
    start: SimPlayer,
    initialDamage: number,
    jumps: number,
    excluded: Set<string>,
    budget: { left: number } | null,
  ): void {
    const cfg = attacker.loadout.chain;
    if (!cfg || jumps <= 0 || this.chainsThisTick >= UPGRADE_LIMITS.MAX_CHAINS_PER_TICK) return;
    if (budget && budget.left <= 0) return;
    this.chainsThisTick++;
    excluded.add(attacker.id);
    const spread = attacker.loadout.corrosion?.spread ?? null;
    let spreadCount = 0;
    let corrosive = false;
    const points = [{ x: start.x, y: start.y }];
    let current = start;
    let factor = cfg.firstFactor;
    const maxJumps = Math.min(jumps, UPGRADE_LIMITS.MAX_CHAIN_JUMPS);
    const candidates = [...this.players.values()].filter((o) => o.alive && !o.left && !this.isProtected(o));
    for (let j = 0; j < maxJumps; j++) {
      if (budget && budget.left <= 0) break;
      const next = pickChainTarget(current, candidates, cfg.radius, excluded, (x0, y0, x1, y1) =>
        raycastSolid(this.map, x0, y0, x1, y1) === null,
      );
      if (!next) break;
      excluded.add(next.id);
      if (budget) budget.left--;
      // Reacción corrosiva: el salto desde un enemigo con corrosión PRIMARIA contagia una débil.
      const sourceCorroded = current.corrosion !== null && current.corrosion.spreadable;
      this.dealDamage(attacker, next, Math.max(1, Math.round(initialDamage * factor)), next.x, next.y);
      if (spread && sourceCorroded && spreadCount < spread.maxTargets && next.alive) {
        const tickMs = attacker.loadout.corrosion?.tickMs ?? 500;
        this.applyCorrosion(next, attacker.id, spread.tickDamage, tickMs, spread.durationMs, false);
        spreadCount++;
        corrosive = true;
      }
      points.push({ x: next.x, y: next.y });
      current = next;
      factor *= cfg.decay;
    }
    if (points.length > 1) this.opts.onEvent?.({ type: 'chain', playerId: attacker.id, points, corrosive });
  }

  /* ------------------------------ Bala fragmentada ------------------------------ */

  /**
   * Divide una bala en fragmentos al impactar. Los fragmentos no se dividen,
   * no rebotan, no golpean al objetivo original y tienen alcance corto y daño
   * fijo. La Sobrecarga se hereda UNA vez solo con Fragmentación eléctrica.
   */
  private spawnFragments(owner: SimPlayer, parent: Projectile, x: number, y: number, hitId: string): void {
    const cfg = owner.loadout.fragments;
    if (!cfg || !parent.canSplit) return;
    let active = 0;
    for (const pr of this.projectiles) if (pr.kind === 'fragmento') active++;
    const count = Math.min(cfg.count, UPGRADE_LIMITS.MAX_FRAGMENTS_PER_SPLIT, UPGRADE_LIMITS.MAX_ACTIVE_FRAGMENTS - active);
    if (count <= 0) return;
    const dir = Math.atan2(parent.vy, parent.vx);
    const spread = (cfg.spreadDeg * Math.PI) / 180;
    const base = (cfg.inheritOverload ? parent.baseDamage : parent.rawDamage) * cfg.damageFactor;
    const electric = cfg.inheritOverload && parent.overloaded;
    const fromFragments = owner.loadout.chain?.fromFragments ?? null;
    // Cadena de fragmentos: límite de saltos COMPARTIDO por todos los fragmentos de esta bala.
    const budget = fromFragments ? { left: fromFragments.budgetPerBullet } : null;
    for (let k = 0; k < count; k++) {
      const angle = count === 1 ? dir : dir - spread + (2 * spread * k) / (count - 1);
      this.spawnProjectile({
        ownerId: owner.id,
        x,
        y,
        vx: Math.cos(angle) * cfg.speed,
        vy: Math.sin(angle) * cfg.speed,
        traveled: 0,
        baseDamage: base,
        rawDamage: base,
        useStreak: false,
        falloff: false,
        range: cfg.range,
        kind: 'fragmento',
        bouncesLeft: 0,
        canSplit: false,
        corrosionTick: 0,
        chain: fromFragments && budget ? { jumps: fromFragments.jumpsPerFragment, budget } : null,
        overloaded: false,
        electric,
        ignoreId: hitId,
      });
    }
    this.opts.onEvent?.({ type: 'fragment', playerId: owner.id, x, y, electric });
  }

  /* ------------------------------ Munición corrosiva ------------------------------ */

  private applyCorrosion(
    target: SimPlayer,
    sourceId: string,
    tickDamage: number,
    tickMs: number,
    durationMs: number,
    spreadable: boolean,
  ): void {
    if (!target.alive || target.left) return;
    target.corrosion = renewCorrosion(target.corrosion, {
      sourceId,
      until: this.simTime + durationMs,
      nextTickAt: this.simTime + tickMs,
      tickDamage: Math.min(tickDamage, UPGRADE_LIMITS.MAX_CORROSION_TICK_DAMAGE),
      tickMs,
      spreadable,
    });
  }

  /** Pulsos de corrosión calculados en el servidor; terminan con su duración o la eliminación. */
  private updateCorrosion(): void {
    for (const p of this.players.values()) {
      const c = p.corrosion;
      if (!c) continue;
      if (!p.alive || p.left) {
        p.corrosion = null;
        continue;
      }
      if (this.simTime >= c.nextTickAt && c.nextTickAt <= c.until) {
        c.nextTickAt += c.tickMs;
        const source = this.players.get(c.sourceId) ?? null;
        this.dealDamage(source && !source.left ? source : null, p, c.tickDamage, p.x, p.y, true);
      }
      if (p.corrosion && this.simTime >= p.corrosion.until) p.corrosion = null;
    }
  }

  /* ------------------------------ Satélites protectores ------------------------------ */

  private satelliteCapacity(p: SimPlayer): number {
    const cfg = p.loadout.satellites;
    if (!cfg) return 0;
    // Defensa orbital: capacidad extra solo mientras el escudo tiene carga.
    return Math.min(UPGRADE_LIMITS.MAX_SATELLITE_CAPACITY, cfg.capacity + (p.shieldHp > 0 ? cfg.shieldBonus : 0));
  }

  private satelliteOrbit(p: SimPlayer): { angle: number; radius: number } {
    const cfg = p.loadout.satellites;
    const angle = (((this.simTime / 1000) * (cfg?.orbitSpeed ?? 0) + p.joinOrder * 0.7) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const radius = cfg?.reactive && this.simTime < p.reactiveUntil ? cfg.reactive.orbitRadius : (cfg?.orbitRadius ?? 0);
    return { angle, radius };
  }

  /** Satélites activos (no rotos) con su posición actual. */
  private activeSatellites(p: SimPlayer): { x: number; y: number; radius: number; index: number }[] {
    const cfg = p.loadout.satellites;
    if (!cfg || !p.alive || p.satellites.length === 0) return [];
    const orbit = this.satelliteOrbit(p);
    const positions = satellitePositions(p.x, p.y, p.satellites.length, orbit.angle, orbit.radius);
    const out: { x: number; y: number; radius: number; index: number }[] = [];
    p.satellites.forEach((s, index) => {
      if (s.brokenUntil > 0) return;
      const pos = positions[index] as { x: number; y: number };
      out.push({ x: pos.x, y: pos.y, radius: cfg.radius, index });
    });
    return out;
  }

  /** Primer satélite de `p` que corta el segmento antes de la fracción `beforeT`. */
  private satelliteOnSegment(p: SimPlayer, x1: number, y1: number, x2: number, y2: number, beforeT: number): number | null {
    let best: { index: number; t: number } | null = null;
    for (const s of this.activeSatellites(p)) {
      const t = segmentCircleHit(x1, y1, x2, y2, s.x, s.y, s.radius);
      if (t !== null && t <= beforeT && (!best || t < best.t)) best = { index: s.index, t };
    }
    return best?.index ?? null;
  }

  /** Un satélite bloquea daño; al agotar su capacidad se rompe y se recupera más tarde. */
  private damageSatellite(owner: SimPlayer, index: number, amount: number, x: number, y: number): void {
    const sat = owner.satellites[index];
    const cfg = owner.loadout.satellites;
    if (!sat || !cfg || sat.brokenUntil > 0) return;
    sat.damage += Math.max(0, amount);
    this.opts.onEvent?.({ type: 'block', playerId: owner.id, x, y });
    if (sat.damage >= this.satelliteCapacity(owner)) {
      sat.brokenUntil = this.simTime + cfg.recoverMs;
      sat.damage = 0;
      this.opts.onEvent?.({ type: 'satellite', playerId: owner.id, index, state: 'roto', x, y });
    }
  }

  private updateSatellites(p: SimPlayer): void {
    if (!p.loadout.satellites) return;
    p.satellites.forEach((s, index) => {
      if (s.brokenUntil > 0 && this.simTime >= s.brokenUntil) {
        s.brokenUntil = 0;
        s.damage = 0;
        this.opts.onEvent?.({ type: 'satellite', playerId: p.id, index, state: 'restaurado', x: p.x, y: p.y });
      }
    });
  }

  /** Ajusta el número de satélites al nivel de la mejora (nunca por encima del máximo). */
  private syncSatelliteCount(p: SimPlayer): void {
    const count = Math.min(p.loadout.satellites?.count ?? 0, UPGRADE_LIMITS.MAX_SATELLITES);
    while (p.satellites.length < count) p.satellites.push({ damage: 0, brokenUntil: 0 });
    p.satellites.length = count;
  }

  /* ------------------------------ Habilidades activas ------------------------------ */

  /**
   * Teletransporte corto (servidor): requiere la mejora y la recarga lista.
   * El destino se calcula en `findTeleportDestination` (nunca atraviesa paredes
   * ni termina dentro de un obstáculo; si no hay sitio, se cancela sin gastar la recarga).
   */
  private tryTeleport(p: SimPlayer): void {
    const cfg = p.loadout.teleport;
    if (!cfg || !p.alive || this.simTime < p.teleportReadyAt) return;
    const dest = findTeleportDestination(this.map, p.x, p.y, p.input.aim, cfg.distance, GAME.PLAYER_RADIUS);
    if (!dest) return;
    const fromX = p.x;
    const fromY = p.y;
    p.x = dest.x;
    p.y = dest.y;
    p.teleportReadyAt = this.simTime + cfg.cooldownMs;
    p.teleportCount++;
    this.opts.onEvent?.({ type: 'teleport', playerId: p.id, fromX, fromY, x: p.x, y: p.y });
    // Cazador de energía: solo con la Sobrecarga lista (ni activa ni en recarga);
    // fija una ventana corta, sin tocar la duración ni la recarga de la Sobrecarga.
    const hunter = p.loadout.overload?.hunter;
    if (hunter && this.simTime >= p.overloadReadyAt && this.simTime >= p.overloadUntil) {
      p.hunterUntil = this.simTime + hunter.durationMs;
    }
    // Escudo reactivo: amplía la órbita de los satélites un instante (no crea satélites).
    const reactive = p.loadout.satellites?.reactive;
    if (reactive) p.reactiveUntil = this.simTime + reactive.durationMs;
    this.upgradesDirty.add(p.id);
  }

  /** Sobrecarga (servidor): requiere la mejora y la recarga lista; nunca se acumula. */
  private tryOverload(p: SimPlayer): void {
    const cfg = p.loadout.overload;
    if (!cfg || !p.alive || this.simTime < p.overloadReadyAt) return;
    p.overloadUntil = this.simTime + cfg.durationMs;
    // La recarga cuenta desde la activación y siempre dura más que el efecto.
    p.overloadReadyAt = this.simTime + Math.max(cfg.cooldownMs, cfg.durationMs);
    p.hunterUntil = 0;
    p.overloadAnnounced = true;
    this.opts.onEvent?.({ type: 'overload', playerId: p.id, active: true });
    this.upgradesDirty.add(p.id);
  }

  /* ------------------------------ Muerte y reaparición ------------------------------ */

  private closeLife(p: SimPlayer): void {
    p.longestLifeMs = Math.max(p.longestLifeMs, p.currentLifeMs);
    p.currentLifeMs = 0;
  }

  /** Reaparición en la posición inicial más alejada de los rivales vivos. */
  private respawn(p: SimPlayer): void {
    let best: SpawnPoint | null = null;
    let bestScore = -1;
    for (const s of this.map.spawnPoints) {
      let minD = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive || o.left) continue;
        minD = Math.min(minD, distanceSq(s.x, s.y, o.x, o.y));
      }
      if (minD > bestScore) {
        bestScore = minD;
        best = s;
      }
    }
    const spawn = best ?? (this.map.spawnPoints[0] as SpawnPoint);
    p.x = spawn.x;
    p.y = spawn.y;
    p.hp = GAME.MAX_HP;
    p.energy = GAME.MAX_ENERGY;
    p.alive = true;
    p.protectedUntil = this.simTime + GAME.SPAWN_PROTECTION_MS;
    p.dashUntil = 0;
    p.shieldHp = p.loadout.shield?.capacity ?? 0;
    p.lastDamagedAt = -Infinity;
    p.corrosion = null;
    p.satellites.forEach((s, index) => {
      if (s.brokenUntil > 0) {
        this.opts.onEvent?.({ type: 'satellite', playerId: p.id, index, state: 'restaurado', x: p.x, y: p.y });
      }
      s.damage = 0;
      s.brokenUntil = 0;
    });
    this.opts.onEvent?.({ type: 'respawn', playerId: p.id, x: p.x, y: p.y });
  }

  /* ------------------------------ Fragmentos de datos ------------------------------ */

  private updateShards(): void {
    if (this.shards.length < GAME.SHARD_MAX_ACTIVE && this.simTime >= this.nextShardAt) {
      this.spawnShard();
      this.nextShardAt = this.simTime + GAME.SHARD_RESPAWN_MS;
    }
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i] as Shard;
      for (const p of this.players.values()) {
        if (!p.alive || p.left) continue;
        // Radio de recogida por jugador (Imán de energía; base = radio nave + radio fragmento).
        if (distanceSq(p.x, p.y, s.x, s.y) <= p.loadout.pickupRadius ** 2) {
          p.shards++;
          p.score += GAME.SCORE_PER_SHARD;
          this.gainProgress(p, PROGRESSION.PROGRESS_PER_SHARD);
          p.energy = Math.min(GAME.MAX_ENERGY, p.energy + GAME.SHARD_ENERGY);
          p.hp = Math.min(GAME.MAX_HP, p.hp + GAME.SHARD_HEAL);
          this.shards.splice(i, 1);
          this.opts.onEvent?.({ type: 'pickup', playerId: p.id, x: s.x, y: s.y });
          break;
        }
      }
    }
  }

  private spawnShard(): void {
    const { cols, rows, tileSize, tiles } = this.map;
    for (let attempt = 0; attempt < 40; attempt++) {
      const col = this.rng.int(1, cols - 2);
      const row = this.rng.int(1, rows - 2);
      if (tiles[row * cols + col] !== TILE.FLOOR) continue;
      const x = (col + 0.5) * tileSize;
      const y = (row + 0.5) * tileSize;
      if (overlapsSolid(this.map, x, y, GAME.SHARD_RADIUS)) continue;
      let tooClose = false;
      for (const p of this.players.values()) {
        if (p.alive && distanceSq(p.x, p.y, x, y) < 120 * 120) tooClose = true;
      }
      for (const s of this.shards) if (distanceSq(s.x, s.y, x, y) < 200 * 200) tooClose = true;
      if (tooClose) continue;
      this.shards.push({ id: this.nextShardId++, x, y });
      return;
    }
  }

  /* ------------------------------ Mejoras ------------------------------ */

  private gainProgress(p: SimPlayer, amount: number): void {
    addProgress(p.upgrades, amount);
    this.upgradesDirty.add(p.id);
  }

  /**
   * Abre las elecciones de los hitos alcanzados y envía el estado privado a
   * quien cambió. No hace nada si la partida ya terminó.
   */
  private flushUpgrades(): void {
    if (this.ended || this.upgradesDirty.size === 0) return;
    for (const id of this.upgradesDirty) {
      const p = this.players.get(id);
      if (!p || p.left) continue;
      if (openNextOffer(p.upgrades, this.upgradeRandom)) this.grantChoiceGuard(p);
      this.opts.onUpgrades?.(p.id, this.upgradeView(p.id) as PlayerUpgradeView);
    }
    this.upgradesDirty.clear();
  }

  /**
   * Protección breve al abrir una elección: dura como máximo CHOICE_PROTECTION_MS,
   * no se suma a la existente, no se concede de nuevo antes de
   * CHOICE_PROTECTION_COOLDOWN_MS y termina al elegir, disparar o desconectarse.
   */
  private grantChoiceGuard(p: SimPlayer): void {
    if (!p.alive || !p.connected) return;
    if (this.simTime - p.lastGuardAt < PROGRESSION.CHOICE_PROTECTION_COOLDOWN_MS) return;
    p.guardUntil = this.simTime + PROGRESSION.CHOICE_PROTECTION_MS;
    p.lastGuardAt = this.simTime;
  }

  /**
   * Elección del jugador (validada en `chooseUpgrade`). Recalcula los efectos
   * y las sinergias en el servidor y abre la siguiente elección encolada.
   */
  chooseUpgrade(playerId: string, milestone: number, upgradeId: UpgradeId): PlayerUpgradeView {
    const p = this.players.get(playerId);
    if (!p || p.left) throw new UpgradeError('NO_ESTAS_EN_PARTIDA', 'No participas en esta partida');
    if (this.ended || this.disposed) throw new UpgradeError('PARTIDA_TERMINADA', 'La partida ya terminó');
    const outcome = chooseUpgrade(p.upgrades, milestone, upgradeId);
    if (outcome === 'aplicada') {
      const before = p.loadout;
      p.loadout = computeLoadout(p.upgrades.levels);
      if (p.loadout.shield && !before.shield) p.shieldHp = p.loadout.shield.capacity;
      if (p.loadout.drone && !before.drone) p.droneNextFireAt = this.simTime + p.loadout.drone.intervalMs;
      this.syncSatelliteCount(p);
      if (p.guardUntil > this.simTime) p.guardUntil = this.simTime;
      openNextOffer(p.upgrades, this.upgradeRandom);
      const view = this.upgradeView(p.id) as PlayerUpgradeView;
      this.opts.onUpgrades?.(p.id, view);
      return view;
    }
    return this.upgradeView(p.id) as PlayerUpgradeView;
  }

  /** Hora del servidor (ms epoch) que corresponde a un instante de simulación. */
  private wallTime(sim: number): number {
    return Math.round(this.now() + (sim - this.simTime));
  }

  private abilityView(p: SimPlayer): AbilityStateView {
    const lo = p.loadout;
    return {
      weapon: lo.weapon,
      beamCooldownMs: lo.beam?.cooldownMs ?? null,
      teleportCooldownMs: lo.teleport?.cooldownMs ?? null,
      teleportReadyAt: lo.teleport ? this.wallTime(p.teleportReadyAt) : null,
      overloadCooldownMs: lo.overload?.cooldownMs ?? null,
      overloadDurationMs: lo.overload?.durationMs ?? null,
      overloadUntil: lo.overload ? this.wallTime(p.overloadUntil) : null,
      overloadReadyAt: lo.overload ? this.wallTime(p.overloadReadyAt) : null,
    };
  }

  /** Estado privado de mejoras de un jugador. */
  upgradeView(playerId: string): PlayerUpgradeView | null {
    const p = this.players.get(playerId);
    // Etiquetado con la partida: el cliente descarta estados de otra partida.
    return p ? { ...toUpgradeView(p.upgrades, p.loadout, this.abilityView(p)), matchId: this.matchId } : null;
  }

  private checkEnd(): void {
    for (const p of this.players.values()) {
      if (p.score >= this.scoreToWin) {
        this.finish('puntuacion');
        return;
      }
    }
    // Tolerancia de 0,5 ms frente al error de redondeo al sumar pasos de 1/30 s.
    if (this.simTime >= this.durationMs - 0.5) this.finish('tiempo');
  }

  /** Termina la partida (idempotente) y notifica el resultado. */
  finish(reason: MatchResult['reason']): MatchResult {
    if (this.endResult) return this.endResult;
    this.ended = true;
    this.stop();
    for (const p of this.players.values()) if (p.alive) this.closeLife(p);
    // Limpieza de entidades y efectos temporales: nada pasa a la siguiente partida.
    this.projectiles.length = 0;
    for (const p of this.players.values()) {
      p.corrosion = null;
      p.overloadUntil = Math.min(p.overloadUntil, this.simTime);
      p.overloadAnnounced = false;
      p.hunterUntil = 0;
      p.reactiveUntil = 0;
      p.guardUntil = Math.min(p.guardUntil, this.simTime);
    }

    const ordered = [...this.players.values()].sort((a, b) => {
      // En un abandono, quien sigue en la partida va por delante.
      if (reason === 'abandono' && a.left !== b.left) return a.left ? 1 : -1;
      return compareRanking(a, b);
    });
    const winner = ordered[0] && !(reason === 'abandono' && ordered[0].left) ? ordered[0] : null;
    // Empate a puntos en el primer puesto: se informa del criterio que lo resolvió.
    const runnerUp = ordered[1] && !ordered[1].left ? ordered[1] : undefined;
    const tiebreak = winner ? tiebreakCriterion(winner, runnerUp) : null;
    const durationMs = Math.min(Math.round(this.simTime), this.durationMs);
    const players: PlayerResult[] = ordered.map((p, index) => ({
      userId: p.id,
      username: p.username,
      rank: index + 1,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      shards: p.shards,
      survivalMs: Math.min(Math.round(p.survivalMs), durationMs),
      longestLifeMs: Math.min(Math.round(p.longestLifeMs), durationMs),
      kdr: computeKdr(p.kills, p.deaths),
      won: winner !== null && p.id === winner.id,
    }));
    this.endResult = {
      matchId: this.matchId,
      roomId: this.roomId,
      durationMs,
      scoreToWin: this.scoreToWin,
      timeLimitMs: this.durationMs,
      reason,
      winnerId: winner?.id ?? null,
      tiebreak,
      players,
      persisted: false,
    };
    this.opts.onEnd?.(this.endResult);
    return this.endResult;
  }

  /* ------------------------------ Estado de red ------------------------------ */

  snapshot(): GameSnapshot {
    const acks: Record<string, number> = {};
    const players: PlayerSnapshot[] = [];
    for (const p of this.players.values()) {
      acks[p.id] = p.lastSeq;
      const guarded = p.alive && this.simTime < p.guardUntil;
      const snap: PlayerSnapshot = {
        id: p.id,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        aim: Math.round(p.aim * 1000) / 1000,
        hp: p.hp,
        energy: Math.round(p.energy),
        alive: p.alive,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        shards: p.shards,
        dashing: this.simTime < p.dashUntil,
        protected: p.alive && (this.simTime < p.protectedUntil || guarded),
        connected: p.connected && !p.left,
        respawnInMs: p.alive ? 0 : Math.max(0, Math.round(p.respawnAt - this.simTime)),
      };
      // Solo lo visible para los demás (escudo, dron, satélites, arma, estados);
      // el progreso, las opciones y las recargas viajan en privado (game:upgrades).
      if (p.loadout.shield) {
        snap.shield = Math.round(p.shieldHp);
        snap.shieldMax = p.loadout.shield.capacity;
      }
      if (p.loadout.drone) snap.drone = Math.round(this.dronePosition(p).angle * 100) / 100;
      if (guarded) snap.choosing = true;
      if (p.loadout.weapon === 'rayo') snap.wpn = 'r';
      if (p.alive && this.simTime < p.overloadUntil) snap.ov = true;
      if (p.alive && this.simTime < p.hunterUntil) snap.hunt = true;
      if (p.corrosion) snap.cor = true;
      if (p.satellites.length > 0) {
        const cap = this.satelliteCapacity(p);
        snap.sats = p.satellites.map((s) =>
          s.brokenUntil > 0 ? 0 : Math.max(0.01, Math.round((1 - s.damage / Math.max(1, cap)) * 100) / 100),
        );
        const orbit = this.satelliteOrbit(p);
        snap.satA = Math.round(orbit.angle * 100) / 100;
        snap.satR = orbit.radius;
      }
      if (p.teleportCount > 0) snap.tp = p.teleportCount;
      players.push(snap);
    }
    return {
      matchId: this.matchId,
      tick: this.tick,
      serverTime: this.now(),
      remainingMs: Math.max(0, Math.round(this.durationMs - this.simTime)),
      players,
      projectiles: this.projectiles.map((p) => {
        const out: GameSnapshot['projectiles'][number] = { id: p.id, x: Math.round(p.x), y: Math.round(p.y), ownerId: p.ownerId };
        if (p.kind === 'dron') out.k = 'd';
        else if (p.kind === 'fragmento') out.k = p.electric ? 'e' : 'f';
        else if (p.kind === 'pesado') out.k = 'p';
        else if (p.corrosionTick > 0) out.k = 'c';
        else if (p.bouncesLeft > 0) out.k = 'b';
        return out;
      }),
      shards: this.shards.map((s) => ({ id: s.id, x: s.x, y: s.y })),
      acks,
    };
  }

  startPayload(forPlayerId: string): GameStartPayload {
    return {
      matchId: this.matchId,
      roomId: this.roomId,
      map: {
        seed: this.map.seed,
        cols: this.map.cols,
        rows: this.map.rows,
        tileSize: this.map.tileSize,
        tiles: encodeTiles(this.map.tiles),
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        username: p.username,
        color: p.color,
        avatarUrl: p.avatarUrl,
      })),
      durationMs: this.durationMs,
      scoreToWin: this.scoreToWin,
      startedAt: this.startedAtWall,
      serverTime: this.now(),
      tickRate: GAME.TICK_RATE,
      yourId: forPlayerId,
      ...(this.players.has(forPlayerId) ? { upgrades: this.upgradeView(forPlayerId) as PlayerUpgradeView } : {}),
    };
  }

  /** Cambia solo la apariencia de un jugador (sin tocar su estado de juego). */
  setAppearance(playerId: string, avatarUrl: string | null): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    player.avatarUrl = avatarUrl;
    return true;
  }

  /** Acceso de solo lectura al estado de un jugador (pruebas y depuración). */
  getPlayer(id: string): Readonly<SimPlayer> | undefined {
    return this.players.get(id);
  }

  /** Número de proyectiles vivos (pruebas y métricas). */
  get projectileCount(): number {
    return this.projectiles.length;
  }
}
