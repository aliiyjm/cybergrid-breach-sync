/**
 * Detección del tipo de dispositivo.
 * Se puede forzar con `?touch=1` o `?touch=0` en la URL (útil para probar).
 */
export function isTouchDevice(): boolean {
  const forced = new URLSearchParams(window.location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const fine = window.matchMedia?.('(pointer: fine)').matches ?? false;
  return coarse || (navigator.maxTouchPoints > 0 && !fine);
}
