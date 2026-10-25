import { devices, expect, test, type Page } from '@playwright/test';
import { readPlayerState, startMatch } from './helpers';

const SPEED = 220; // px/s, GAME.PLAYER_SPEED en el servidor
const TICK_RATE = 30;

/** Intenta mover al jugador en las 4 direcciones hasta que el servidor confirme un desplazamiento. */
async function moveUntilDisplaced(page: Page, inject: (dx: number, dy: number) => Promise<void>) {
  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of dirs) {
    const before = await readPlayerState(page);
    await inject(dx, dy);
    await page.waitForTimeout(250); // margen para recibir la instantánea final
    const after = await readPlayerState(page);
    const dist = Math.hypot(after.x - before.x, after.y - before.y);
    if (dist > 20) return { before, after, dist, dir: [dx, dy] as const };
  }
  throw new Error('El jugador no pudo desplazarse en ninguna dirección');
}

test('E2E 3 · Canvas: render, entrada inyectada, coordenadas autoritativas y controles táctiles', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await startMatch(browser, {
    mobileB: { ...devices['Pixel 7'] },
  });

  // 1-2. El Canvas se renderiza con contenido real.
  const canvas = pageA.getByTestId('game-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box && box.width > 300 && box.height > 200).toBeTruthy();
  await pageA.waitForTimeout(500);
  const distinctColors = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    return colors.size;
  });
  expect(distinctColors).toBeGreaterThan(5);
  await expect.poll(() => pageA.evaluate(() => (window as any).__cybergrid.test.fps)).toBeGreaterThan(0);
  await expect(pageA.getByTestId('fps-value')).not.toHaveText('0');

  // Controles: ocultos en escritorio, visibles en el móvil emulado.
  await expect(pageA.getByTestId('touch-controls')).toBeHidden();
  await expect(pageB.getByTestId('touch-controls')).toBeVisible();

  // 3-5. Inyección de movimiento mediante el mecanismo de entrada de prueba.
  const moved = await moveUntilDisplaced(pageA, (dx, dy) =>
    pageA.evaluate(([x, y]) => (window as any).__cybergrid.test.injectMove(x, y, 600), [dx, dy]).then(() =>
      pageA.waitForTimeout(650),
    ),
  );
  expect(moved.dist).toBeGreaterThan(20);

  // 6. El desplazamiento respeta la velocidad máxima del servidor.
  const ticks = moved.after.tick - moved.before.tick;
  expect(ticks).toBeGreaterThan(0);
  expect(moved.dist).toBeLessThanOrEqual((SPEED * ticks) / TICK_RATE + 2);

  // 7. No es una animación local: el OTRO navegador ve la misma posición, recibida del servidor.
  const myId = moved.after.id;
  await expect
    .poll(async () => {
      const own = await readPlayerState(pageA);
      const seenByB = await pageB.getByTestId('world-state').evaluate((el, id) => {
        const players = JSON.parse((el as HTMLElement).dataset.players ?? '[]') as Array<{ id: string; x: number; y: number }>;
        return players.find((p) => p.id === id) ?? null;
      }, myId);
      return seenByB ? Math.hypot(seenByB.x - own.x, seenByB.y - own.y) : Infinity;
    })
    .toBeLessThan(1);

  // Una intención manipulada (velocidad x40) es rechazada por el servidor.
  const beforeCheat = await readPlayerState(pageA);
  await pageA.evaluate(() =>
    (window as any).__cybergrid.test.rawEmit('game:input', {
      seq: 2_000_000,
      moveX: 40,
      moveY: 0,
      aim: 0,
      fire: false,
      dash: false,
    }),
  );
  await expect(pageA.locator('body')).toHaveAttribute('data-last-server-error', 'EVENTO_INVALIDO');
  await pageA.waitForTimeout(300);
  const afterCheat = await readPlayerState(pageA);
  expect(Math.hypot(afterCheat.x - beforeCheat.x, afterCheat.y - beforeCheat.y)).toBeLessThan(5);

  // Joystick táctil del móvil: gestos de puntero táctil sobre el joystick mueven al jugador B.
  const stick = pageB.locator('#touch-stick');
  const sbox = (await stick.boundingBox())!;
  const cx = sbox.x + sbox.width / 2;
  const cy = sbox.y + sbox.height / 2;
  const touchMoved = await moveUntilDisplaced(pageB, async (dx, dy) => {
    await stick.evaluate(
      (el, [x0, y0, x1, y1]) => {
        const opts = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x1, clientY: y1 }));
      },
      [cx, cy, cx + dx * sbox.width * 0.45, cy + dy * sbox.height * 0.45],
    );
    await pageB.waitForTimeout(650);
    await stick.evaluate((el) =>
      el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', bubbles: true })),
    );
  });
  expect(touchMoved.dist).toBeGreaterThan(20);

  await contextA.close();
  await contextB.close();
});
