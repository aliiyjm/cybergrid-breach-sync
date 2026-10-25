import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = 'clave-e2e-segura-1';

export function uniqueUser(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 20);
}

/** Registra un usuario mediante la interfaz y espera a llegar al lobby. */
export async function registerViaUi(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/#/acceso?modo=registro');
  await page.getByTestId('register-username').fill(username);
  await page.getByTestId('register-password').fill(password);
  await page.getByTestId('register-confirm').fill(password);
  await page.getByTestId('register-submit').click();
  await expect(page).toHaveURL(/#\/lobby/);
  await expect(page.getByTestId('current-user')).toHaveText(username);
}

export async function waitOnline(page: Page): Promise<void> {
  await expect(page.getByTestId('net-status')).toHaveAttribute('data-state', 'online');
}

export async function createRoomViaUi(
  page: Page,
  name: string,
  options: { capacity?: number; accessCode?: string; scoreToWin?: 15 | 25 | 30 } = {},
): Promise<string> {
  await page.getByTestId('room-name').fill(name);
  await page.getByTestId('room-capacity').selectOption(String(options.capacity ?? 2));
  if (options.scoreToWin) await page.getByTestId(`score-${options.scoreToWin}`).check();
  if (options.accessCode) {
    await page.getByTestId('room-private').check();
    await page.getByTestId('room-code').fill(options.accessCode);
  }
  await page.getByTestId('create-room-submit').click();
  await expect(page).toHaveURL(/#\/sala\//);
  await expect(page.getByTestId('room-title')).toHaveText(name);
  return decodeURIComponent(page.url().split('#/sala/')[1] ?? '');
}

export async function joinRoomFromList(page: Page, roomName: string): Promise<void> {
  const item = page.getByTestId('room-item').filter({ hasText: roomName });
  await expect(item).toBeVisible();
  await item.getByTestId('join-room').click();
  await expect(page).toHaveURL(/#\/sala\//);
}

export interface MatchSetup {
  contextA: BrowserContext;
  contextB: BrowserContext;
  pageA: Page;
  pageB: Page;
  userA: string;
  userB: string;
}

/** Prepara una partida con dos jugadores reales; B puede usar un perfil móvil. */
export async function startMatch(
  browser: Browser,
  options: { mobileB?: Parameters<Browser['newContext']>[0] } = {},
): Promise<MatchSetup> {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext(options.mobileB ?? {});
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const userA = uniqueUser('pa');
  const userB = uniqueUser('pb');
  await registerViaUi(pageA, userA);
  await registerViaUi(pageB, userB);
  await waitOnline(pageA);
  await waitOnline(pageB);

  const roomName = `Arena ${Math.floor(Math.random() * 1e6)}`;
  await createRoomViaUi(pageA, roomName);
  await joinRoomFromList(pageB, roomName);
  await expect(pageA.getByTestId('room-member')).toHaveCount(2);

  await pageA.getByTestId('ready-btn').click();
  await pageB.getByTestId('ready-btn').click();
  await expect(pageA).toHaveURL(/#\/partida/, { timeout: 15_000 });
  await expect(pageB).toHaveURL(/#\/partida/, { timeout: 15_000 });
  return { contextA, contextB, pageA, pageB, userA, userB };
}

/** Posición autoritativa del jugador local según el atributo del DOM. */
export async function readPlayerState(page: Page): Promise<{ x: number; y: number; tick: number; id: string }> {
  const el = page.getByTestId('player-state');
  await expect(el).not.toHaveAttribute('data-player-x', '');
  return el.evaluate((node) => ({
    x: Number((node as HTMLElement).dataset.playerX),
    y: Number((node as HTMLElement).dataset.playerY),
    tick: Number((node as HTMLElement).dataset.serverTick),
    id: String((node as HTMLElement).dataset.playerId),
  }));
}
