/** Utilidades DOM sin dependencias. */

export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento no encontrado: ${selector}`);
  return el;
}

type Attrs = Record<string, string | number | boolean | undefined | null>;

/** Crea un elemento. El texto siempre se asigna con textContent (sin inyección de HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function setLoading(button: HTMLButtonElement, loading: boolean): void {
  button.disabled = loading;
  button.dataset.loading = loading ? 'true' : 'false';
  button.setAttribute('aria-busy', loading ? 'true' : 'false');
}

export function showError(el: HTMLElement, message: string | null): void {
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Registro de oyentes con limpieza en bloque (evita fugas al cambiar de pantalla). */
export class Disposer {
  private readonly fns: Array<() => void> = [];

  on(
    target: EventTarget,
    type: string,
    // `never` acepta manejadores con cualquier tipo de evento concreto.
    handler: (ev: never) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    const listener = handler as unknown as EventListener;
    target.addEventListener(type, listener, options);
    this.fns.push(() => target.removeEventListener(type, listener, options));
  }

  add(fn: () => void): void {
    this.fns.push(fn);
  }

  dispose(): void {
    while (this.fns.length > 0) this.fns.pop()?.();
  }
}
