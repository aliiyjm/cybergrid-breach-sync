import type { PublicUser, RoomListPayload, RoomState } from '../../../shared/protocol';

/** Cliente HTTP mínimo. Las cookies de sesión viajan automáticamente (HttpOnly). */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * URL del backend. Vacía = mismo origen (despliegue recomendado). Se fija en
 * la compilación con la variable PUBLIC_SERVER_URL (ver scripts/build-client.mjs).
 */
declare const __SERVER_URL__: string;
export const SERVER_URL = typeof __SERVER_URL__ === 'string' ? __SERVER_URL__ : '';
const API_BASE = SERVER_URL;

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  raw?: { data: Blob; contentType: string; headers?: Record<string, string> },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: raw
        ? { 'Content-Type': raw.contentType, ...raw.headers }
        : body !== undefined
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'SIN_RED', 'No se pudo contactar con el servidor. Comprueba tu conexión.');
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string; details?: Array<{ path: string; message: string }> } })
    | null;
  if (!response.ok) {
    const err = data?.error;
    throw new ApiError(response.status, err?.code ?? 'ERROR', err?.message ?? `Error ${response.status}`, err?.details);
  }
  return data as T;
}

export interface AvatarLimits {
  maxBytes: number;
  maxDimension: number;
  minDimension: number;
  outputSize: number;
  extensions: string[];
  mimeTypes: string[];
}

export interface CareerStats {
  matchesPlayed: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  shards: number;
  avgSurvivalMs: number;
  bestLifeMs: number;
  kdr: number;
  winRate: number;
}

export const api = {
  me: () => request<{ user: PublicUser }>('GET', '/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: PublicUser }>('POST', '/api/auth/login', { username, password }),
  register: (username: string, password: string) =>
    request<{ user: PublicUser }>('POST', '/api/auth/register', { username, password }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  rooms: () =>
    request<RoomListPayload & { matchOptions?: Array<{ scoreToWin: number; durationMs: number }> }>(
      'GET',
      '/api/rooms',
    ),
  room: (id: string) => request<{ room: RoomState }>('GET', `/api/rooms/${encodeURIComponent(id)}`),
  myStats: () => request<{ stats: CareerStats }>('GET', '/api/stats/me'),
  profile: () => request<{ user: PublicUser; limits: AvatarLimits }>('GET', '/api/profile'),
  /** Sube el archivo ORIGINAL con el encuadre elegido; el servidor valida, recorta y re-codifica. */
  uploadAvatar: (file: File, crop: { x: number; y: number; size: number }) =>
    request<{ avatarUrl: string }>(
      'POST',
      `/api/profile/avatar?x=${crop.x.toFixed(4)}&y=${crop.y.toFixed(4)}&size=${crop.size.toFixed(4)}`,
      undefined,
      {
        data: file,
        // Algunos sistemas no informan el tipo: se declara según la extensión y el
        // servidor lo contrasta igualmente con la firma real del contenido.
        contentType: file.type || (/\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg'),
        headers: { 'X-File-Name': encodeURIComponent(file.name) },
      },
    ),
  resetAvatar: () => request<{ avatarUrl: null; removed: boolean }>('DELETE', '/api/profile/avatar'),
  leaderboard: () =>
    request<{ leaderboard: Array<{ username: string; wins: number; kdr: number; matchesPlayed: number }> }>(
      'GET',
      '/api/stats/leaderboard',
    ),
};

/** Traduce un error de validación a un mensaje legible. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.details && error.details.length > 0) {
      return error.details.map((d) => `${traducirCampo(d.path)}: ${d.message}`).join('. ');
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Error desconocido';
}

function traducirCampo(path: string): string {
  const map: Record<string, string> = {
    username: 'Usuario',
    password: 'Contraseña',
    name: 'Nombre',
    accessCode: 'Código',
    maxPlayers: 'Capacidad',
    scoreToWin: 'Puntuación para ganar',
  };
  return map[path] ?? path;
}
