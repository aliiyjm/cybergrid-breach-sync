import type { GameStartPayload, MatchResult, PublicUser, RoomState } from '../../shared/protocol';
import { GameClient } from './game/GameClient';
import { api } from './network/api';
import { SocketClient, type ConnectionState } from './network/SocketClient';
import { AuthScreen } from './screens/AuthScreen';
import { GameScreen } from './screens/GameScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { RoomScreen } from './screens/RoomScreen';
import { PROTECTED_SCREENS, parseRoute, type AppContext, type Screen, type ScreenName } from './screens/types';
import { $ } from './ui/dom';
import { toast } from './ui/toast';

const NET_LABEL: Record<ConnectionState, string> = {
  online: 'En línea',
  connecting: 'Conectando…',
  offline: 'Sin conexión',
};

class App implements AppContext {
  user: PublicUser | null = null;
  room: RoomState | null = null;
  lastResult: MatchResult | null = null;
  readonly socket = new SocketClient();
  readonly game: GameClient;
  private readonly screens: Record<ScreenName, Screen>;
  private current: { name: ScreenName; screen: Screen } | null = null;
  private routing = Promise.resolve();
  private loggingOut = false;

  constructor() {
    this.game = new GameClient(this.socket);
    this.screens = {
      home: new HomeScreen(this),
      auth: new AuthScreen(this),
      lobby: new LobbyScreen(this),
      room: new RoomScreen(this),
      game: new GameScreen(this),
      results: new ResultsScreen(this),
      profile: new ProfileScreen(this),
    };
  }

  async init(): Promise<void> {
    this.bindSocket();
    this.bindTopbar();
    try {
      const { user } = await api.me();
      this.setUser(user);
    } catch {
      this.setUser(null);
    }
    window.addEventListener('hashchange', () => this.route());
    this.route();
    this.exposeDebugApi();
  }

  navigate(hash: string): void {
    if (window.location.hash === hash) this.route();
    else window.location.hash = hash;
  }

  setUser(user: PublicUser | null): void {
    this.user = user;
    $('#topbar-user').hidden = !user;
    $('#topbar-username').textContent = user?.username ?? '';
    if (user) this.socket.connect();
    else {
      this.socket.disconnect();
      this.room = null;
      this.game.stop();
    }
  }

  /** Cambia de pantalla de forma secuencial (evita carreras entre montajes). */
  private route(): void {
    this.routing = this.routing.then(() => this.doRoute()).catch((error: unknown) => {
      console.error(error);
    });
  }

  private async doRoute(): Promise<void> {
    const route = parseRoute(window.location.hash);
    if (PROTECTED_SCREENS.has(route.screen) && !this.user) {
      const next = encodeURIComponent(window.location.hash || '#/lobby');
      window.location.replace(`#/acceso?motivo=protegida&next=${next}`);
      return;
    }
    if (route.screen !== 'game' && this.game.active && this.room?.status === 'en_partida') {
      // Mientras hay partida activa solo se puede estar en la pantalla de juego.
      window.location.replace('#/partida');
      return;
    }
    this.current?.screen.unmount();
    for (const section of document.querySelectorAll<HTMLElement>('section[data-screen]')) {
      section.hidden = section.dataset.screen !== route.screen;
    }
    document.body.dataset.currentScreen = route.screen;
    const screen = this.screens[route.screen];
    this.current = { name: route.screen, screen };
    await screen.mount(route);
  }

  private bindTopbar(): void {
    $('#logout-btn').addEventListener('click', async () => {
      this.loggingOut = true;
      try {
        await api.logout();
      } catch {
        /* la sesión se elimina igualmente en el cliente */
      }
      this.loggingOut = false;
      this.setUser(null);
      toast('Sesión cerrada', 'ok');
      this.navigate('#/');
    });

    const net = $('#net-status');
    const label = $('#net-label');
    const ping = $('#net-ping');
    this.socket.onState((state) => {
      net.dataset.state = state;
      net.dataset.transport = this.socket.transport ?? '';
      label.textContent = NET_LABEL[state];
      if (state !== 'online') ping.textContent = '— ms';
    });
    this.socket.latency.onUpdate((stats) => {
      ping.textContent = `${Math.round(stats.lastMs)} ms`;
      ping.dataset.pingMs = String(stats.lastMs);
      ping.title = `Media ${stats.avgMs} ms · p95 ${stats.p95Ms} ms · ${stats.samples} muestras`;
      net.dataset.transport = this.socket.transport ?? '';
      this.game.setPing(stats.lastMs);
    });
  }

  private bindSocket(): void {
    const s = this.socket.socket;
    this.socket.onAuthFailure(() => {
      if (!this.user) return;
      this.setUser(null);
      toast('Tu sesión ha caducado. Inicia sesión de nuevo.', 'error');
      this.navigate('#/acceso');
    });

    s.on('session:ready', ({ user, roomId }) => {
      if (this.user && user.id === this.user.id) this.user = { ...this.user, avatarUrl: user.avatarUrl ?? null };
      if (!roomId) {
        this.room = null;
        return;
      }
      const route = parseRoute(window.location.hash);
      if (route.screen === 'lobby' || route.screen === 'home') this.navigate(`#/sala/${encodeURIComponent(roomId)}`);
    });

    s.on('session:replaced', () => {
      if (this.loggingOut) return;
      toast('Tu sesión se abrió en otra pestaña o se cerró. Esta conexión se ha detenido.', 'error', 6000);
      this.game.stop();
      this.socket.disconnect();
      void api
        .me()
        .then(({ user }) => {
          this.user = user;
        })
        .catch(() => this.setUser(null))
        .finally(() => this.navigate('#/'));
    });

    // El estado de sala del cliente solo refleja lo que dice el servidor: se
    // acepta si el usuario figura como miembro y se descarta si ya no figura.
    s.on('room:state', (state: RoomState) => {
      const isMember = !!this.user && state.members.some((m) => m.userId === this.user?.id);
      if (isMember) this.room = state;
      else if (this.room?.id === state.id) this.room = null;
      else return;
      this.current?.screen.onRoomState?.();
    });

    s.on('room:closed', ({ roomId, reason }) => {
      if (this.room?.id !== roomId) return;
      this.room = null;
      toast(reason, 'info');
      if (this.current?.name === 'room') this.navigate('#/lobby');
    });

    s.on('game:start', (payload: GameStartPayload) => {
      this.game.start(payload);
      this.navigate('#/partida');
    });

    s.on('game:end', (result: MatchResult) => {
      this.lastResult = result;
      this.game.stop();
      // No se modifica el estado de la sala localmente: el servidor envía el
      // room:state actualizado (sala en espera, mismos miembros, mismo id).
      this.navigate('#/resultados');
    });

    s.on('error:event', (err) => {
      console.warn(`[servidor] ${err.code}: ${err.message}`);
      document.body.dataset.lastServerError = err.code;
      document.body.dataset.lastServerErrorEvent = err.event ?? '';
    });
  }

  /**
   * API de depuración y pruebas (`window.__cybergrid`). No otorga ninguna
   * capacidad especial: inyecta INTENCIONES que el servidor valida igual que
   * las del teclado.
   */
  private exposeDebugApi(): void {
    const api = {
      get user() {
        return app.user;
      },
      get room() {
        return app.room;
      },
      net: {
        stats: () => app.socket.latency.stats(),
        samples: () => [...app.socket.latency.samples],
        measure: () => app.socket.latency.measure(),
        get transport() {
          return app.socket.transport;
        },
        get state() {
          return app.socket.connectionState;
        },
      },
      test: {
        /** Mantiene una intención de movimiento durante `ms` milisegundos. */
        injectMove: (x: number, y: number, ms: number) => app.game.input.inject(x, y, ms),
        /** Emite un evento sin validar en el cliente (para comprobar el rechazo del servidor). */
        rawEmit: (event: string, payload: unknown) => app.socket.rawEmit(event, payload),
        get fps() {
          return app.game.fps;
        },
      },
    };
    (window as unknown as { __cybergrid: typeof api }).__cybergrid = api;
  }
}

const app = new App();
void app.init();
