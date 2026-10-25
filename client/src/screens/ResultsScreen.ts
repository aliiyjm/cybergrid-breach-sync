import { SocketActionError } from '../network/SocketClient';
import { $, Disposer, formatDuration, h, setLoading, showError } from '../ui/dom';
import { toast } from '../ui/toast';
import type { AppContext, Screen } from './types';

const REASON: Record<string, string> = {
  tiempo: 'Se agotó el tiempo',
  puntuacion: 'Se alcanzó la puntuación objetivo',
  abandono: 'La partida terminó por abandono',
};

const TIEBREAK: Record<string, string> = {
  eliminaciones: 'más eliminaciones',
  muertes: 'menos muertes',
  supervivencia: 'más tiempo de supervivencia',
  orden_de_ingreso: 'orden de ingreso a la sala',
};

/**
 * Pantalla de resultados.
 *  - «Volver al lobby de la sala»: room:return con el id ORIGINAL de la sala.
 *    Es idempotente en el servidor y el botón se bloquea mientras espera, de
 *    modo que un doble clic no crea salas ni duplica al jugador.
 *  - «Salir al lobby general»: room:leave explícito; el jugador deja de ser
 *    miembro (antes era un enlace que lo dejaba como miembro «fantasma»).
 */
export class ResultsScreen implements Screen {
  private readonly disposer = new Disposer();
  private busy = false;

  constructor(private readonly ctx: AppContext) {}

  mount(): void {
    const result = this.ctx.lastResult;
    if (!result) {
      this.ctx.navigate('#/lobby');
      return;
    }
    this.busy = false;
    const me = this.ctx.user;
    const winner = result.players.find((p) => p.won);
    $('#results-winner').textContent = winner
      ? winner.userId === me?.id
        ? 'Has ganado la partida'
        : `Gana ${winner.username}`
      : 'Partida sin ganador';
    const tiebreak = result.tiebreak ? ` · Empate a puntos resuelto por ${TIEBREAK[result.tiebreak]}` : '';
    $('#results-meta').textContent =
      `${REASON[result.reason] ?? ''} · Objetivo ${result.scoreToWin} puntos · ` +
      `Duración ${formatDuration(result.durationMs)} de ${formatDuration(result.timeLimitMs)}${tiebreak}`;
    $('#results-body').replaceChildren(
      ...result.players.map((p) =>
        h(
          'tr',
          { 'data-won': String(p.won), 'data-self': String(p.userId === me?.id), 'data-testid': 'result-row' },
          h('td', {}, String(p.rank)),
          h('td', {}, p.username),
          h('td', {}, String(p.score)),
          h('td', {}, String(p.kills)),
          h('td', {}, String(p.deaths)),
          h('td', {}, p.kdr.toFixed(2)),
          h('td', {}, String(p.shards)),
          h('td', {}, formatDuration(p.survivalMs)),
        ),
      ),
    );
    $('#results-note').textContent = result.persisted
      ? 'Resultado guardado en tu historial.'
      : 'No se pudo guardar el resultado en el historial.';
    showError($('#results-error'), null);

    const back = $<HTMLButtonElement>('#results-room');
    const leave = $<HTMLButtonElement>('#results-leave');
    back.hidden = false;
    this.disposer.on(back, 'click', () => void this.returnToRoom(result.roomId, back));
    this.disposer.on(leave, 'click', () => void this.leaveToLobby(leave));
  }

  private async returnToRoom(roomId: string, button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    setLoading(button, true);
    try {
      this.ctx.room = await this.ctx.socket.returnToRoom(roomId);
      this.ctx.navigate(`#/sala/${encodeURIComponent(roomId)}`);
    } catch (error) {
      // La sala ya no existe o el jugador dejó de pertenecer a ella: lobby general.
      if (this.ctx.room?.id === roomId) this.ctx.room = null;
      const message = error instanceof SocketActionError ? error.message : 'No se pudo volver a la sala';
      showError($('#results-error'), message);
      toast(message, 'info');
      this.ctx.navigate('#/lobby');
    } finally {
      this.busy = false;
      setLoading(button, false);
    }
  }

  private async leaveToLobby(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    setLoading(button, true);
    try {
      await this.ctx.socket.leaveRoom();
    } catch {
      /* si la sala ya no existía no hay nada que abandonar */
    } finally {
      this.ctx.room = null;
      this.busy = false;
      setLoading(button, false);
    }
    this.ctx.navigate('#/lobby');
  }

  unmount(): void {
    this.disposer.dispose();
  }
}
