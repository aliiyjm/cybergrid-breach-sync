import type { PlayerUpgradeView } from '../../../shared/protocol';
import { SYNERGY_CATALOG, synergiesCompletedBy, type SynergyId } from '../../../shared/synergies';
import {
  UPGRADE_CATALOG,
  UPGRADE_CATEGORY_LABEL,
  UPGRADE_RARITY_LABEL,
  UPGRADE_TYPE_LABEL,
  type UpgradeId,
  type UpgradeLevels,
} from '../../../shared/upgrades';
import type { ConnectionState, SocketClient } from '../network/SocketClient';
import { SocketActionError } from '../network/SocketClient';
import { Disposer, h } from '../ui/dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Tecla de cada habilidad activa (solo para mostrarla). */
const ACTIVE_KEY: Partial<Record<UpgradeId, string>> = { teletransporte: 'E', sobrecarga: 'Q' };

export function upgradeIcon(id: UpgradeId, size = 28): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('upgrade-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', UPGRADE_CATALOG[id].icon);
  svg.append(path);
  return svg;
}

export interface UpgradePanelElements {
  panel: HTMLElement;
  milestone: HTMLElement;
  options: HTMLElement;
  status: HTMLElement;
  later: HTMLButtonElement;
  progressFill: HTMLElement;
  progressText: HTMLElement;
  perks: HTMLElement;
  reopen: HTMLButtonElement;
}

/**
 * Ventana «¡Mejora tu nave!» y progreso de mejoras del HUD.
 *
 * Solo MUESTRA el estado que envía el servidor y SOLICITA una elección
 * (hito + identificador). No aplica efectos: el servidor los calcula y
 * responde con el estado nuevo. La partida no se pausa: la ventana es
 * compacta, no tapa los controles y se puede posponer («Más tarde» / M).
 */
export class UpgradePanel {
  private view: PlayerUpgradeView | null = null;
  private sending = false;
  private minimizedFor: number | null = null;
  private connection: ConnectionState = 'online';
  private guarded = false;
  private message: { text: string; kind: 'error' | 'info' } | null = null;
  private renderedKey = '';
  private readonly disposer = new Disposer();

  constructor(
    private readonly el: UpgradePanelElements,
    private readonly socket: SocketClient,
    private readonly onApplied: (id: UpgradeId) => void,
    /** Sinergias que aparecen por primera vez en esta partida (para avisar). */
    private readonly onSynergy: (id: SynergyId) => void = () => undefined,
  ) {
    this.disposer.on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e));
    this.disposer.on(el.later, 'click', () => this.minimize());
    this.disposer.on(el.reopen, 'click', () => this.reopen());
    this.disposer.on(el.options, 'click', (e: Event) => {
      const card = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-upgrade]');
      if (card && !card.disabled) void this.choose(card.dataset.upgrade as UpgradeId);
    });
  }

  /** Estado autoritativo recibido del servidor (game:start o game:upgrades). */
  update(view: PlayerUpgradeView): void {
    const previousPending = this.view?.pending?.milestone ?? null;
    const known = new Set(this.view?.synergies ?? []);
    const firstView = this.view === null;
    this.view = view;
    if (!firstView) for (const id of view.synergies ?? []) if (!known.has(id)) this.onSynergy(id);
    if (view.pending?.milestone !== previousPending) {
      this.message = null;
      this.sending = false;
    }
    this.renderHud();
    this.renderPanel();
  }

  setConnection(state: ConnectionState): void {
    if (state === this.connection) return;
    this.connection = state;
    this.renderPanel(true);
  }

  /** Protección temporal confirmada por el servidor (instantánea `choosing`). */
  setGuarded(guarded: boolean): void {
    if (guarded === this.guarded) return;
    this.guarded = guarded;
    this.renderPanel(true);
  }

  reset(): void {
    this.view = null;
    this.sending = false;
    this.minimizedFor = null;
    this.message = null;
    this.renderedKey = '';
    this.el.panel.hidden = true;
    this.el.reopen.hidden = true;
    this.el.perks.replaceChildren();
    this.el.progressFill.style.transform = 'scaleX(0)';
    this.el.progressText.textContent = '0/10';
  }

  dispose(): void {
    this.reset();
    this.disposer.dispose();
  }

  /** Último estado recibido del servidor (o null fuera de partida). */
  get current(): PlayerUpgradeView | null {
    return this.view;
  }

  get isOpen(): boolean {
    return !this.el.panel.hidden;
  }

  /* ------------------------------ Acciones ------------------------------ */

  private async choose(id: UpgradeId): Promise<void> {
    const pending = this.view?.pending;
    if (!pending || this.sending || this.connection !== 'online') return;
    if (!pending.options.includes(id)) return;
    this.sending = true;
    this.message = { text: 'Confirmando con el servidor…', kind: 'info' };
    this.renderPanel(true);
    try {
      const view = await this.socket.chooseUpgrade({ milestone: pending.milestone, upgradeId: id });
      // La partida pudo terminar mientras se esperaba la respuesta: no se arrastra nada.
      if (!this.view) return;
      this.sending = false;
      this.message = null;
      this.onApplied(id);
      this.update(view);
    } catch (error) {
      if (!this.view) return;
      this.sending = false;
      const code = error instanceof SocketActionError ? error.code : 'ERROR';
      this.message = {
        kind: 'error',
        text:
          code === 'SIN_RESPUESTA'
            ? 'El servidor no respondió. Vuelve a intentarlo: la mejora no se aplicará dos veces.'
            : error instanceof Error
              ? error.message
              : 'No se pudo aplicar la mejora.',
      };
      this.renderPanel(true);
    }
  }

  private minimize(): void {
    const pending = this.view?.pending;
    if (!pending) return;
    this.minimizedFor = pending.milestone;
    this.renderPanel(true);
  }

  private reopen(): void {
    this.minimizedFor = null;
    this.renderPanel(true);
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const pending = this.view?.pending;
    if (!pending) return;
    if (e.code === 'KeyM') {
      if (this.isOpen) this.minimize();
      else this.reopen();
      return;
    }
    if (!this.isOpen) return;
    if (e.code === 'Escape') {
      this.minimize();
      return;
    }
    const index = e.code === 'Digit1' || e.code === 'Numpad1' ? 0 : e.code === 'Digit2' || e.code === 'Numpad2' ? 1 : -1;
    const id = index >= 0 ? pending.options[index] : undefined;
    if (id) {
      e.preventDefault();
      void this.choose(id);
    }
  }

  /* ------------------------------ Dibujo ------------------------------ */

  private renderHud(): void {
    const v = this.view;
    if (!v) return;
    const base = v.nextMilestone - v.milestoneStep;
    const ratio = Math.max(0, Math.min(1, (v.progress - base) / v.milestoneStep));
    this.el.progressFill.style.transform = `scaleX(${ratio})`;
    this.el.progressText.textContent = `${v.progress}/${v.nextMilestone}`;
    this.el.perks.replaceChildren(
      ...v.levels.map(({ id, level }) => {
        const def = UPGRADE_CATALOG[id];
        const li = h('li', { title: `${def.name}${def.maxLevel > 1 ? ` (nivel ${level})` : ''}: ${def.description}`, 'data-upgrade': id });
        li.append(upgradeIcon(id, 16));
        if (def.maxLevel > 1) li.append(h('span', { class: 'perk__level' }, String(level)));
        return li;
      }),
      // Sinergias activas: chip propio con su descripción como ayuda.
      ...(v.synergies ?? []).map((id) =>
        h(
          'li',
          { class: 'perk--synergy', 'data-synergy': id, title: `${SYNERGY_CATALOG[id].name}: ${SYNERGY_CATALOG[id].description}` },
          SYNERGY_CATALOG[id].name,
        ),
      ),
      // Versión compacta (pantallas estrechas): un solo chip con el total y los nombres como ayuda.
      ...((v.synergies ?? []).length > 0
        ? [
            h(
              'li',
              {
                class: 'perk--synergy-count',
                title: (v.synergies ?? []).map((id) => SYNERGY_CATALOG[id].name).join(' · '),
                'aria-label': `${(v.synergies ?? []).length} sinergias activas`,
              },
              `⚡ ${(v.synergies ?? []).length}`,
            ),
          ]
        : []),
    );
  }

  private renderPanel(force = false): void {
    const v = this.view;
    const pending = v?.pending ?? null;
    const minimized = pending !== null && this.minimizedFor === pending.milestone;
    this.el.panel.hidden = !pending || minimized;
    this.el.reopen.hidden = !pending || !minimized;
    if (!pending || !v) return;

    // Las tarjetas solo se reconstruyen si cambia la elección.
    const key = `${pending.milestone}:${pending.options.join(',')}`;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      this.el.milestone.textContent = `Hito ${pending.milestone}${v.queued > 0 ? ` · ${v.queued} más en cola` : ''}`;
      const levels: UpgradeLevels = Object.fromEntries(v.levels.map((l) => [l.id, l.level]));
      this.el.options.replaceChildren(
        ...pending.options.map((id, index) => {
          const def = UPGRADE_CATALOG[id];
          const current = v.levels.find((l) => l.id === id)?.level ?? 0;
          const completes = synergiesCompletedBy(levels, id);
          const typeLabel = def.type === 'activa' ? `Activa · ${ACTIVE_KEY[id] ?? ''}` : UPGRADE_TYPE_LABEL[def.type];
          const card = h(
            'button',
            {
              type: 'button',
              class: 'upgrade-card',
              'data-upgrade': id,
              'data-category': def.category,
              'data-testid': `upgrade-option-${index + 1}`,
            },
            h('span', { class: 'upgrade-card__key', 'aria-hidden': 'true' }, String(index + 1)),
            h('span', { class: 'upgrade-card__name' }, def.name),
            h(
              'span',
              { class: 'upgrade-card__tags' },
              h('span', { class: 'chip', 'data-category': def.category }, UPGRADE_CATEGORY_LABEL[def.category]),
              h('span', { class: 'chip chip--rarity', 'data-rarity': def.rarity }, UPGRADE_RARITY_LABEL[def.rarity]),
              def.type !== 'pasiva' ? h('span', { class: 'chip chip--type', 'data-type': def.type }, typeLabel) : null,
              def.maxLevel > 1 ? h('span', { class: 'chip' }, `Nivel ${current + 1}/${def.maxLevel}`) : null,
            ),
            h('span', { class: 'upgrade-card__desc' }, def.description),
            completes.length > 0
              ? h(
                  'span',
                  { class: 'upgrade-card__synergy', 'data-testid': 'upgrade-synergy-hint' },
                  `Sinergia: ${completes.map((sid) => SYNERGY_CATALOG[sid].name).join(', ')}`,
                )
              : null,
          );
          card.prepend(upgradeIcon(id, 30));
          return card;
        }),
      );
    } else if (!force) {
      return;
    }

    const offline = this.connection !== 'online';
    for (const card of this.el.options.querySelectorAll<HTMLButtonElement>('[data-upgrade]')) {
      card.disabled = this.sending || offline;
    }
    this.el.panel.dataset.state = this.sending ? 'enviando' : offline ? 'sin_conexion' : 'eligiendo';
    this.el.panel.setAttribute('aria-busy', String(this.sending));
    const status = this.el.status;
    status.dataset.kind = offline ? 'error' : (this.message?.kind ?? 'info');
    status.textContent = offline
      ? 'Sin conexión con el servidor. Tu elección pendiente se conservará al reconectar.'
      : this.message
        ? this.message.text
        : this.guarded
          ? 'Protegido mientras eliges (máx. 2 s; termina si disparas). Clic o teclas 1 / 2.'
          : 'Elige con clic, toque o teclas 1 / 2. La partida sigue en marcha.';
  }
}
