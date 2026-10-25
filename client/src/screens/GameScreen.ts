import { $, Disposer } from '../ui/dom';
import { toast } from '../ui/toast';
import type { AppContext, Screen } from './types';

export class GameScreen implements Screen {
  private readonly disposer = new Disposer();

  constructor(private readonly ctx: AppContext) {}

  mount(): void {
    if (!this.ctx.game.active) {
      // Sin partida activa (p. ej. recarga): el servidor reenviará game:start si sigue en curso.
      this.ctx.navigate(this.ctx.room ? `#/sala/${encodeURIComponent(this.ctx.room.id)}` : '#/lobby');
      return;
    }
    this.disposer.on($('#game-exit'), 'click', () => void this.exit());
  }

  private async exit(): Promise<void> {
    if (!window.confirm('¿Abandonar la partida? Contará como derrota.')) return;
    try {
      await this.ctx.socket.leaveRoom();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo abandonar', 'error');
      return;
    }
    this.ctx.game.stop();
    this.ctx.room = null;
    this.ctx.navigate('#/lobby');
  }

  unmount(): void {
    this.disposer.dispose();
  }
}
