import type { MatchResult, PublicUser, RoomState } from '../../../shared/protocol';
import type { GameClient } from '../game/GameClient';
import type { SocketClient } from '../network/SocketClient';

export type ScreenName = 'home' | 'auth' | 'lobby' | 'room' | 'game' | 'results' | 'profile';

export interface Route {
  screen: ScreenName;
  params: Record<string, string>;
  query: URLSearchParams;
}

/** Estado compartido de la aplicación (sesión, sala actual, último resultado). */
export interface AppContext {
  user: PublicUser | null;
  room: RoomState | null;
  lastResult: MatchResult | null;
  readonly socket: SocketClient;
  readonly game: GameClient;
  navigate(hash: string): void;
  setUser(user: PublicUser | null): void;
}

export interface Screen {
  mount(route: Route): void | Promise<void>;
  unmount(): void;
  /** Notificación de que cambió el estado de la sala (solo pantallas interesadas). */
  onRoomState?(): void;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', queryString = ''] = raw.split('?');
  const query = new URLSearchParams(queryString);
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case undefined:
      return { screen: 'home', params: {}, query };
    case 'acceso':
      return { screen: 'auth', params: {}, query };
    case 'lobby':
      return { screen: 'lobby', params: {}, query };
    case 'sala':
      return { screen: 'room', params: { id: decodeURIComponent(parts[1] ?? '') }, query };
    case 'partida':
      return { screen: 'game', params: {}, query };
    case 'resultados':
      return { screen: 'results', params: {}, query };
    case 'personaje':
      return { screen: 'profile', params: {}, query };
    default:
      return { screen: 'home', params: {}, query };
  }
}

/** Pantallas que exigen sesión iniciada. */
export const PROTECTED_SCREENS: ReadonlySet<ScreenName> = new Set(['lobby', 'room', 'game', 'results', 'profile']);
