import { h } from './dom';

export type ToastKind = 'info' | 'ok' | 'error';

/** Mensaje breve no bloqueante (confirmaciones y errores). */
export function toast(message: string, kind: ToastKind = 'info', durationMs = 3500): void {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = h('div', { class: 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  container.append(el);
  while (container.children.length > 4) container.firstElementChild?.remove();
  window.setTimeout(() => el.remove(), durationMs);
}
