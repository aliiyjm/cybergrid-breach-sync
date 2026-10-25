import { formatScoreTargets } from '../../../shared/matchConfig';
import { MapPreview } from '../canvas/MapPreview';
import { $, Disposer } from '../ui/dom';
import type { AppContext, Screen } from './types';

export class HomeScreen implements Screen {
  private readonly preview = new MapPreview($<HTMLCanvasElement>('#map-preview'));
  private readonly disposer = new Disposer();
  private seed = 0;

  constructor(private readonly ctx: AppContext) {}

  mount(): void {
    const cta = $<HTMLAnchorElement>('#home-cta');
    const register = $<HTMLAnchorElement>('#home-register');
    if (this.ctx.user) {
      cta.textContent = 'Ir al lobby';
      cta.href = '#/lobby';
      register.hidden = true;
    } else {
      cta.textContent = 'Iniciar sesión';
      cta.href = '#/acceso';
      register.hidden = false;
    }
    // Puntuaciones para ganar, desde la configuración central (shared/matchConfig.ts).
    for (const el of document.querySelectorAll<HTMLElement>('[data-score-targets]')) el.textContent = formatScoreTargets();
    this.seed = (Math.random() * 2 ** 32) >>> 0;
    this.show();
    this.disposer.on($('#preview-reroll'), 'click', () => {
      this.seed = (Math.random() * 2 ** 32) >>> 0;
      this.show();
    });
  }

  private show(): void {
    $('#preview-seed').textContent = `#${this.seed.toString(16).padStart(8, '0')}`;
    this.preview.show(this.seed);
  }

  unmount(): void {
    this.preview.stop();
    this.disposer.dispose();
  }
}
