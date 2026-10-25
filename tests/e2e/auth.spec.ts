import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { PASSWORD, createRoomViaUi, registerViaUi, uniqueUser, waitOnline } from './helpers';

test('E2E 1 · Autenticación: credenciales inválidas, registro, acceso, salas privadas y apariencia del jugador', async ({
  page,
  browser,
  request,
}) => {
  // 1. Abrir la aplicación.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CyberGrid');

  // Una ruta privada sin sesión redirige al acceso.
  await page.goto('/#/lobby');
  await expect(page).toHaveURL(/#\/acceso\?motivo=protegida/);
  await expect(page.getByTestId('login-error')).toContainText('Inicia sesión');

  // 2-3. Credenciales inválidas → mensaje de error.
  await page.getByTestId('login-username').fill('usuario_que_no_existe');
  await page.getByTestId('login-password').fill('contraseña-incorrecta');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText('Usuario o contraseña incorrectos');
  await expect(page).toHaveURL(/#\/acceso/);

  // Validación del formulario de registro en el cliente.
  await page.getByTestId('tab-register').click();
  await page.getByTestId('register-username').fill('ab');
  await page.getByTestId('register-password').fill('123');
  await page.getByTestId('register-confirm').fill('123');
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-error')).toContainText('3-20 caracteres');

  // 4-5. Registro de un usuario de prueba y acceso permitido.
  const username = uniqueUser('e2e');
  await registerViaUi(page, username);
  await waitOnline(page);
  await expect(page.getByTestId('create-room-form')).toBeVisible();

  // Cerrar sesión y volver a entrar con las credenciales correctas.
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goto('/#/acceso');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/#\/lobby/);
  await expect(page.getByTestId('current-user')).toHaveText(username);

  // 6. Salas privadas protegidas.
  // 6a. La API de salas exige sesión.
  const anonymous = await request.get('/api/rooms');
  expect(anonymous.status()).toBe(401);

  // 6b. Otro usuario crea una sala privada con código.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await registerViaUi(owner, uniqueUser('dueno'));
  await waitOnline(owner);
  const roomName = `Privada ${Math.floor(Math.random() * 1e6)}`;
  const roomId = await createRoomViaUi(owner, roomName, { accessCode: 'NEON42' });

  // 6c. Con código incorrecto no se puede entrar.
  const item = page.getByTestId('room-item').filter({ hasText: roomName });
  await expect(item).toContainText('Privada');
  await item.getByTestId('join-room').click();
  await page.getByTestId('join-code-input').fill('MALA00');
  await page.getByTestId('join-code-submit').click();
  await expect(page.getByTestId('join-error')).toContainText('Código de acceso incorrecto');
  await expect(page).toHaveURL(/#\/lobby/);

  // 6d. Tampoco por URL directa ni por la API.
  const viaApi = await page.request.get(`/api/rooms/${roomId}`);
  expect(viaApi.status()).toBe(403);
  await page.goto(`/#/sala/${roomId}`);
  await expect(page).toHaveURL(/#\/lobby/);
  await expect(owner.getByTestId('room-member')).toHaveCount(1);

  // 6e. Con el código correcto sí.
  await page.getByTestId('room-item').filter({ hasText: roomName }).getByTestId('join-room').click();
  await page.getByTestId('join-code-input').fill('NEON42');
  await page.getByTestId('join-code-submit').click();
  await expect(page).toHaveURL(new RegExp(`#/sala/${roomId}`));
  await expect(owner.getByTestId('room-member')).toHaveCount(2);

  await ownerContext.close();

  // 7. Personalizar personaje: el formato no permitido se rechaza y una imagen válida se guarda.
  await page.goto('/#/personaje');
  await expect(page.getByTestId('avatar-pick')).toBeVisible();
  const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).gif().toBuffer();
  await page.getByTestId('avatar-input').setInputFiles({ name: 'animado.gif', mimeType: 'image/gif', buffer: gif });
  await expect(page.getByTestId('avatar-error')).toContainText('Formato no permitido');
  const png = await sharp({ create: { width: 320, height: 240, channels: 4, background: '#ff2fb3' } }).png().toBuffer();
  await page.getByTestId('avatar-input').setInputFiles({ name: 'robot.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('avatar-save')).toBeEnabled();
  await page.getByTestId('avatar-save').click();
  await expect(page.getByTestId('avatar-ok')).toContainText('Apariencia guardada');
  const avatarUrl = await page.evaluate(() => (window as any).__cybergrid.user.avatarUrl as string | null);
  expect(avatarUrl).toMatch(/^\/api\/avatars\/[0-9a-f-]{36}\.png$/);
  // Queda guardada en el perfil persistente del usuario (base de datos).
  const profile = await page.request.get('/api/profile');
  expect((await profile.json()).user.avatarUrl).toBe(avatarUrl);
  await page.getByTestId('avatar-reset').click();
  await expect(page.getByTestId('avatar-ok')).toContainText('restablecida');
});
