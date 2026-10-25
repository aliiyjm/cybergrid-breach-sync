import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createRoomViaUi, joinRoomFromList, registerViaUi, uniqueUser, waitOnline } from './helpers';

test('E2E 2 · Lobbies: dos jugadores, listo en tiempo real, WebSocket, inicio y regreso al lobby sin duplicados', async ({
  browser,
}, testInfo) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Registro de los WebSockets abiertos por cada página.
  const sockets: string[] = [];
  pageA.on('websocket', (ws) => sockets.push(ws.url()));

  // 1. Autenticar dos usuarios de prueba.
  const userA = uniqueUser('host');
  const userB = uniqueUser('guest');
  await registerViaUi(pageA, userA);
  await registerViaUi(pageB, userB);

  // 7. Conexión WebSocket real (Socket.IO sobre transporte websocket).
  await waitOnline(pageA);
  await waitOnline(pageB);
  await expect.poll(() => pageA.evaluate(() => (window as any).__cybergrid.net.transport)).toBe('websocket');
  expect(sockets.some((url) => url.includes('/socket.io/') && url.includes('transport=websocket'))).toBe(true);

  // 2. Crear una sala con la puntuación para ganar de 25 puntos.
  const roomName = `Lobby ${Math.floor(Math.random() * 1e6)}`;
  const roomId = await createRoomViaUi(pageA, roomName, { capacity: 4, scoreToWin: 25 });
  await expect(pageA.locator('#room-meta')).toHaveAttribute('data-score-to-win', '25');
  await expect(pageA.locator('#room-meta')).toContainText('25 puntos');
  await expect(pageA.getByTestId('room-member')).toHaveCount(1);
  await expect(pageA.getByTestId('room-member').first()).toContainText('creador');

  // 3. Conectar al otro jugador: ve la sala aparecer en tiempo real y se une.
  await joinRoomFromList(pageB, roomName);

  // 4. Ambos aparecen en la sala, en las dos pantallas.
  for (const page of [pageA, pageB]) {
    await expect(page.getByTestId('room-member')).toHaveCount(2);
    await expect(page.locator(`[data-testid="room-member"][data-username="${userA}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="room-member"][data-username="${userB}"]`)).toBeVisible();
  }

  // 5-6. B se marca como listo y A lo ve sin recargar.
  await pageB.getByTestId('ready-btn').click();
  const bOnA = pageA.locator(`[data-testid="room-member"][data-username="${userB}"]`);
  await expect(bOnA).toHaveAttribute('data-state', 'listo');
  await expect(bOnA.getByTestId('member-state')).toHaveText('Listo');
  await expect(pageA.getByTestId('room-status')).toHaveText('1 de 2 jugadores listos');

  // Cancelar el estado de listo también se propaga.
  await pageB.getByTestId('ready-btn').click();
  await expect(bOnA).toHaveAttribute('data-state', 'conectado');
  await pageB.getByTestId('ready-btn').click();
  await expect(bOnA).toHaveAttribute('data-state', 'listo');

  // Latencia ping/pong medida sobre el WebSocket (se registra como evidencia).
  await pageA.evaluate(async () => {
    for (let i = 0; i < 10; i++) await (window as any).__cybergrid.net.measure();
  });
  const latency = await pageA.evaluate(() => (window as any).__cybergrid.net.stats());
  expect(latency.samples).toBeGreaterThanOrEqual(10);
  await expect(pageA.getByTestId('ping-value')).toHaveText(/\d+ ms/);
  testInfo.annotations.push({
    type: 'latencia',
    description: `ping/pong: media ${latency.avgMs} ms, p95 ${latency.p95Ms} ms, máx ${latency.maxMs} ms (${latency.samples} muestras)`,
  });
  await mkdir('reports', { recursive: true });
  await writeFile('reports/e2e-latency.json', JSON.stringify({ measuredAt: new Date().toISOString(), ...latency }, null, 2));
  expect(latency.avgMs).toBeLessThan(100);

  // 8. Con todos listos empieza la cuenta atrás y la partida.
  await pageA.getByTestId('ready-btn').click();
  await expect(pageA.getByTestId('room-status')).toContainText('La partida empieza en');
  await expect(pageA).toHaveURL(/#\/partida/, { timeout: 15_000 });
  await expect(pageB).toHaveURL(/#\/partida/, { timeout: 15_000 });
  await expect(pageA.getByTestId('game-canvas')).toBeVisible();
  await expect(pageB.getByTestId('scoreboard').locator('li')).toHaveCount(2);
  // Ambos jugadores reciben la misma configuración del servidor.
  for (const page of [pageA, pageB]) {
    await expect(page.locator('#hud-target')).toHaveText('25');
    await expect(page.getByTestId('hud-status')).toContainText('25');
  }

  // 9. Fin de partida: B abandona (confirma el diálogo) y A ve los resultados.
  pageB.once('dialog', (dialog) => void dialog.accept());
  await pageB.locator('#game-exit').click();
  await expect(pageB).toHaveURL(/#\/lobby/);
  await expect(pageA).toHaveURL(/#\/resultados/, { timeout: 15_000 });
  await expect(pageA.locator('#results-meta')).toContainText('Objetivo 25 puntos');

  // 10. «Volver al lobby de la sala» con doble clic: misma sala, sin duplicados.
  await pageA.getByTestId('results-return').dblclick();
  await expect(pageA).toHaveURL(new RegExp(`#/sala/${roomId}$`));
  await expect(pageA.getByTestId('room-member')).toHaveCount(1);
  await expect(pageA.locator(`[data-testid="room-member"][data-username="${userA}"]`)).toHaveCount(1);
  // B (en el lobby general) ve UNA sola sala con ese nombre, con 1 jugador, y no es su sala.
  const items = pageB.getByTestId('room-item').filter({ hasText: roomName });
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute('data-room-id', roomId);
  await expect(items.first().locator('.room-item__count')).toHaveText('1/4');
  await expect(pageB.getByTestId('current-room')).toBeHidden();

  await contextA.close();
  await contextB.close();
});
