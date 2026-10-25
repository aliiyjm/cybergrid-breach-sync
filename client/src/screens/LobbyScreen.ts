import {
  DEFAULT_SCORE_TARGET,
  SCORE_TARGETS,
  SCORE_TARGET_LABELS,
  formatScoreTargets,
  isScoreTarget,
} from '../../../shared/matchConfig';
import type { RoomListPayload, RoomState, RoomSummary } from '../../../shared/protocol';
import { api, describeError } from '../network/api';
import { SocketActionError } from '../network/SocketClient';
import { $, Disposer, formatDuration, h, setLoading, showError } from '../ui/dom';
import { toast } from '../ui/toast';
import type { AppContext, Screen } from './types';

const STATUS_LABEL: Record<RoomSummary['status'], string> = {
  lobby: 'Esperando',
  cuenta_atras: 'Empezando',
  en_partida: 'En partida',
};

export class LobbyScreen implements Screen {
  private readonly disposer = new Disposer();
  private pendingPrivate: RoomSummary | null = null;
  private rooms: RoomSummary[] = [];
  /** Versión de la última lista aplicada: se ignoran respuestas más antiguas. */
  private listVersion = -1;
  /** Sala a la que pertenece el usuario según el servidor. */
  private currentRoom: RoomState | null = null;

  constructor(private readonly ctx: AppContext) {}

  mount(): void {
    const socket = this.ctx.socket;
    socket.connect();
    this.listVersion = -1;
    this.renderScoreOptions();

    const onRooms = (payload: RoomListPayload): void => this.applyRoomList(payload);
    socket.socket.on('rooms:changed', onRooms);
    this.disposer.add(() => socket.socket.off('rooms:changed', onRooms));
    void this.refreshRooms();
    void this.refreshCurrentRoom();
    void this.loadStats();
    this.renderAvatarTeaser();

    this.disposer.on($('#rooms-refresh'), 'click', () => {
      void this.refreshRooms();
      void this.refreshCurrentRoom();
    });
    this.disposer.on($('#current-room-return'), 'click', () => void this.returnToCurrent());
    this.disposer.on($('#current-room-leave'), 'click', () => void this.leaveCurrent());

    const form = $<HTMLFormElement>('#create-room-form');
    const privateBox = $<HTMLInputElement>('[data-testid="room-private"]');
    const codeField = $('#access-code-field');
    codeField.hidden = !privateBox.checked;
    this.disposer.on(privateBox, 'change', () => {
      codeField.hidden = !privateBox.checked;
    });
    this.disposer.on(form, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      void this.createRoom(form);
    });

    const joinForm = $<HTMLFormElement>('#join-code-form');
    this.disposer.on(joinForm, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      const code = String(new FormData(joinForm).get('code') ?? '').trim();
      if (this.pendingPrivate) void this.join(this.pendingPrivate, code);
    });
    this.disposer.on($('#join-code-cancel'), 'click', () => this.hideJoinCode());

    // Delegación de eventos para los botones de la lista.
    this.disposer.on($('#room-list'), 'click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-room-id]');
      if (!btn) return;
      const room = this.rooms.find((r) => r.id === btn.dataset.roomId);
      if (!room) return;
      if (room.id === this.currentRoom?.id) void this.returnToCurrent();
      else if (room.isPrivate) this.showJoinCode(room);
      else void this.join(room);
    });
  }

  private async refreshRooms(): Promise<void> {
    try {
      const payload = await api.rooms();
      this.applyRoomList(payload);
      if (payload.matchOptions) this.renderScoreTimes(payload.matchOptions);
    } catch (error) {
      toast(describeError(error), 'error');
    }
  }

  /** Aplica una lista solo si es más reciente que la que ya se muestra. */
  private applyRoomList(payload: RoomListPayload): void {
    if (payload.version < this.listVersion) return;
    this.listVersion = payload.version;
    this.renderRooms(payload.rooms);
  }

  /** Pregunta al servidor (fuente de verdad) si el usuario sigue en alguna sala. */
  private async refreshCurrentRoom(): Promise<void> {
    try {
      this.currentRoom = await this.ctx.socket.currentRoom();
    } catch {
      return;
    }
    this.ctx.room = this.currentRoom;
    const banner = $('#current-room');
    banner.hidden = !this.currentRoom;
    $('#current-room-name').textContent = this.currentRoom?.name ?? '';
    this.renderRooms(this.rooms);
  }

  private async returnToCurrent(): Promise<void> {
    const room = this.currentRoom;
    if (!room) return;
    try {
      this.ctx.room = await this.ctx.socket.returnToRoom(room.id);
      this.ctx.navigate(`#/sala/${encodeURIComponent(room.id)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo volver a la sala', 'error');
      await this.refreshCurrentRoom();
    }
  }

  private async leaveCurrent(): Promise<void> {
    try {
      await this.ctx.socket.leaveRoom();
      toast('Has salido de la sala', 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo salir de la sala', 'error');
    }
    await this.refreshCurrentRoom();
  }

  /**
   * Selector «Puntuación para ganar» generado desde SCORE_TARGETS: cambiar las
   * puntuaciones en shared/matchConfig.ts actualiza esta pantalla sola.
   * Se construye una vez para conservar la opción elegida entre visitas.
   */
  private renderScoreOptions(): void {
    const container = $('#score-options');
    if (container.childElementCount > 0) return;
    container.replaceChildren(
      ...SCORE_TARGETS.map((target) => {
        const input = h('input', {
          type: 'radio',
          name: 'scoreToWin',
          value: String(target),
          'data-testid': `score-${target}`,
        }) as HTMLInputElement;
        input.checked = target === DEFAULT_SCORE_TARGET;
        return h(
          'label',
          { class: 'score-option' },
          input,
          h('span', { class: 'score-option__value' }, `${target} puntos`),
          h('span', { class: 'score-option__desc' }, SCORE_TARGET_LABELS[target]),
          h('span', { class: 'score-option__time', 'data-score-time': String(target) }),
        );
      }),
    );
  }

  private renderScoreTimes(options: Array<{ scoreToWin: number; durationMs: number }>): void {
    for (const option of options) {
      const el = document.querySelector<HTMLElement>(`[data-score-time="${option.scoreToWin}"]`);
      if (el) el.textContent = `${formatDuration(option.durationMs)} máx.`;
    }
  }

  private renderAvatarTeaser(): void {
    const el = $('#lobby-avatar');
    const url = this.ctx.user?.avatarUrl;
    el.style.backgroundImage = url ? `url("${url}")` : '';
  }

  private renderRooms(rooms: RoomSummary[]): void {
    this.rooms = rooms;
    const list = $('#room-list');
    $('#room-list-empty').hidden = rooms.length > 0;
    list.replaceChildren(
      ...rooms.map((room) => {
        const mine = room.id === this.currentRoom?.id;
        const full = room.players >= room.maxPlayers;
        const joinable = mine || (room.status === 'lobby' && !full);
        return h(
          'li',
          {
            class: 'room-item',
            'data-private': String(room.isPrivate),
            'data-testid': 'room-item',
            'data-room-name': room.name,
            'data-room-id': room.id,
            'data-mine': String(mine),
          },
          h(
            'div',
            {},
            h('div', { class: 'room-item__name' }, room.name,
              room.isPrivate ? h('span', { class: 'badge badge--private' }, 'Privada') : null,
              room.status !== 'lobby' ? h('span', { class: 'badge badge--live' }, STATUS_LABEL[room.status]) : null),
            h(
              'div',
              { class: 'room-item__meta' },
              `Creada por ${room.ownerName} · ${room.scoreToWin} puntos · ${formatDuration(room.durationMs)}`,
              mine ? h('span', { class: 'room-item__mine' }, ' · Tu sala') : null,
            ),
          ),
          h('span', { class: 'room-item__count', 'aria-label': `${room.players} de ${room.maxPlayers} jugadores` }, `${room.players}/${room.maxPlayers}`),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost btn--small',
              'data-room-id': room.id,
              'data-testid': 'join-room',
              disabled: !joinable,
            },
            mine ? 'Volver' : full ? 'Llena' : joinable ? 'Unirse' : 'En curso',
          ),
        );
      }),
    );
  }

  private showJoinCode(room: RoomSummary): void {
    this.pendingPrivate = room;
    $('#join-code-room').textContent = room.name;
    const form = $<HTMLFormElement>('#join-code-form');
    form.hidden = false;
    form.reset();
    showError($('[data-testid="join-error"]'), null);
    ($('[data-testid="join-code-input"]') as HTMLInputElement).focus();
  }

  private hideJoinCode(): void {
    this.pendingPrivate = null;
    $('#join-code-form').hidden = true;
  }

  private async join(room: RoomSummary, accessCode?: string): Promise<void> {
    const errorEl = $('[data-testid="join-error"]');
    try {
      const state = await this.ctx.socket.joinRoom(accessCode ? { roomId: room.id, accessCode } : { roomId: room.id });
      this.ctx.room = state;
      this.hideJoinCode();
      this.ctx.navigate(`#/sala/${encodeURIComponent(state.id)}`);
    } catch (error) {
      const message = error instanceof SocketActionError ? error.message : describeError(error);
      if (room.isPrivate) showError(errorEl, message);
      else toast(message, 'error');
    }
  }

  private async createRoom(form: HTMLFormElement): Promise<void> {
    const errorEl = $('[data-testid="create-room-error"]');
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const maxPlayers = Number(data.get('maxPlayers') ?? 4);
    const isPrivate = data.get('isPrivate') === 'on';
    const accessCode = String(data.get('accessCode') ?? '').trim();
    const scoreToWin = Number(data.get('scoreToWin') ?? DEFAULT_SCORE_TARGET);

    if (name.length < 3 || name.length > 32) {
      showError(errorEl, 'El nombre de la sala debe tener entre 3 y 32 caracteres.');
      return;
    }
    if (!isScoreTarget(scoreToWin)) {
      showError(errorEl, `Elige una puntuación para ganar: ${formatScoreTargets()} puntos.`);
      return;
    }
    if (isPrivate && !/^[A-Za-z0-9]{4,12}$/.test(accessCode)) {
      showError(errorEl, 'El código de acceso debe tener 4-12 letras o números.');
      return;
    }
    const button = $<HTMLButtonElement>('[data-testid="create-room-submit"]');
    setLoading(button, true);
    showError(errorEl, null);
    try {
      const state = await this.ctx.socket.createRoom(
        isPrivate ? { name, maxPlayers, isPrivate, accessCode, scoreToWin } : { name, maxPlayers, isPrivate, scoreToWin },
      );
      this.ctx.room = state;
      form.reset();
      toast(`Sala «${state.name}» creada`, 'ok');
      this.ctx.navigate(`#/sala/${encodeURIComponent(state.id)}`);
    } catch (error) {
      showError(errorEl, error instanceof Error ? error.message : 'No se pudo crear la sala');
    } finally {
      setLoading(button, false);
    }
  }

  private async loadStats(): Promise<void> {
    const statsEl = $('#career-stats');
    const boardEl = $('#leaderboard');
    try {
      const [{ stats }, { leaderboard }] = await Promise.all([api.myStats(), api.leaderboard()]);
      const items: Array<[string, string]> = [
        ['Partidas', String(stats.matchesPlayed)],
        ['Victorias', String(stats.wins)],
        ['Win rate', `${stats.winRate}%`],
        ['Elim.', String(stats.kills)],
        ['Muertes', String(stats.deaths)],
        ['KDR', stats.kdr.toFixed(2)],
        ['Superv. media', formatDuration(stats.avgSurvivalMs)],
        ['Mejor vida', formatDuration(stats.bestLifeMs)],
        ['Fragmentos', String(stats.shards)],
      ];
      statsEl.replaceChildren(...items.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
      boardEl.replaceChildren(
        ...(leaderboard.length > 0
          ? leaderboard.map((e) =>
              h('li', {}, `${e.username} `, h('span', {}, `${e.wins} victorias · KDR ${e.kdr.toFixed(2)}`)),
            )
          : [h('li', {}, 'Aún no hay partidas registradas.')]),
      );
    } catch {
      statsEl.replaceChildren(h('div', {}, h('dt', {}, 'Estado'), h('dd', {}, 'Sin datos')));
    }
  }

  unmount(): void {
    this.disposer.dispose();
    this.hideJoinCode();
  }
}
