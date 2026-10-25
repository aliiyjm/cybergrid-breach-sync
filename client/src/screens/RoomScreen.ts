import type { MemberState } from '../../../shared/protocol';
import { SocketActionError } from '../network/SocketClient';
import { $, Disposer, formatDuration, h, setLoading } from '../ui/dom';
import { toast } from '../ui/toast';
import type { AppContext, Route, Screen } from './types';

const STATE_LABEL: Record<MemberState, string> = {
  conectado: 'Conectado',
  listo: 'Listo',
  desconectado: 'Desconectado',
};

function avatarBadge(url: string | null): HTMLElement {
  const el = h('span', { class: 'member__avatar', 'aria-hidden': 'true' });
  if (url) el.style.backgroundImage = `url("${url}")`;
  return el;
}

export class RoomScreen implements Screen {
  private readonly disposer = new Disposer();
  private countdownTimer: number | null = null;
  private roomId = '';

  constructor(private readonly ctx: AppContext) {}

  async mount(route: Route): Promise<void> {
    this.roomId = route.params.id ?? '';
    this.ctx.socket.connect();
    this.disposer.on($('#ready-btn'), 'click', () => void this.toggleReady());
    this.disposer.on($('#room-leave'), 'click', () => void this.leave());

    // El estado de la sala SIEMPRE se confirma con el servidor (única fuente de
    // verdad); nunca se reutiliza una copia local que pudo quedar obsoleta.
    try {
      this.ctx.room = await this.ctx.socket.returnToRoom(this.roomId);
    } catch (error) {
      if (error instanceof SocketActionError && error.code === 'NO_ERES_MIEMBRO') {
        // Acceso directo por URL a una sala ajena: se aplican las reglas de ingreso.
        try {
          this.ctx.room = await this.ctx.socket.joinRoom({ roomId: this.roomId });
        } catch (joinError) {
          this.fail(joinError);
          return;
        }
      } else {
        this.fail(error);
        return;
      }
    }
    this.render();
  }

  private fail(error: unknown): void {
    if (this.ctx.room?.id === this.roomId) this.ctx.room = null;
    toast(error instanceof SocketActionError ? error.message : 'No se pudo entrar en la sala', 'error');
    this.ctx.navigate('#/lobby');
  }

  onRoomState(): void {
    this.render();
  }

  private render(): void {
    const room = this.ctx.room;
    if (!room || room.id !== this.roomId) return;
    if (room.status === 'en_partida' && this.ctx.game.active) {
      this.ctx.navigate('#/partida');
      return;
    }
    const me = this.ctx.user;
    $('#room-name').textContent = room.name;
    $('#room-meta').textContent =
      `${room.isPrivate ? 'Sala privada' : 'Sala pública'} · ${room.members.length}/${room.maxPlayers} jugadores · ` +
      `Gana quien llegue a ${room.scoreToWin} puntos · Tiempo máximo ${formatDuration(room.durationMs)} · ID ${room.id}`;
    $('#room-meta').dataset.scoreToWin = String(room.scoreToWin);

    $('#room-members').replaceChildren(
      ...room.members.map((m) =>
        h(
          'li',
          { class: 'member', 'data-testid': 'room-member', 'data-username': m.username, 'data-state': m.state },
          h(
            'span',
            {},
            avatarBadge(m.avatarUrl),
            h('span', { class: 'member__name' }, m.username),
            m.isOwner ? h('span', { class: 'member__owner' }, 'creador') : null,
            m.userId === me?.id ? h('span', { class: 'member__you' }, '(tú)') : null,
          ),
          h('span', { class: 'chip', 'data-state': m.state, 'data-testid': 'member-state' }, STATE_LABEL[m.state]),
        ),
      ),
    );

    const mine = room.members.find((m) => m.userId === me?.id);
    const readyBtn = $<HTMLButtonElement>('#ready-btn');
    const isReady = mine?.state === 'listo';
    readyBtn.textContent = isReady ? 'Cancelar listo' : 'Estoy listo';
    readyBtn.classList.toggle('btn--ready', isReady);
    readyBtn.classList.toggle('btn--primary', !isReady);
    readyBtn.disabled = room.status === 'en_partida';
    readyBtn.dataset.ready = String(isReady);

    this.updateStatus();
    if (room.status === 'cuenta_atras' && this.countdownTimer === null) {
      this.countdownTimer = window.setInterval(() => this.updateStatus(), 200);
    } else if (room.status !== 'cuenta_atras' && this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private updateStatus(): void {
    const room = this.ctx.room;
    const status = $('#room-status');
    if (!room) return;
    status.dataset.status = room.status;
    if (room.status === 'cuenta_atras' && room.countdownEndsAt) {
      const left = Math.max(0, room.countdownEndsAt - this.ctx.socket.latency.serverNow());
      status.textContent = `La partida empieza en ${Math.ceil(left / 1000)} s`;
    } else if (room.status === 'en_partida') {
      status.textContent = 'Partida en curso…';
    } else {
      const ready = room.members.filter((m) => m.state === 'listo').length;
      status.textContent =
        room.members.length < 2 ? 'Esperando a más jugadores' : `${ready} de ${room.members.length} jugadores listos`;
    }
  }

  private async toggleReady(): Promise<void> {
    const btn = $<HTMLButtonElement>('#ready-btn');
    const ready = btn.dataset.ready !== 'true';
    setLoading(btn, true);
    try {
      this.ctx.room = await this.ctx.socket.setReady(ready);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo cambiar el estado', 'error');
    } finally {
      setLoading(btn, false);
      this.render();
    }
  }

  private async leave(): Promise<void> {
    try {
      await this.ctx.socket.leaveRoom();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo salir de la sala', 'error');
      return;
    }
    this.ctx.room = null;
    this.ctx.navigate('#/lobby');
  }

  unmount(): void {
    this.disposer.dispose();
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }
}
