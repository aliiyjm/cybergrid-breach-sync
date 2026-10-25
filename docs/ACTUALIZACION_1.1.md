# Actualización 1.1 — Personaje, puntuación para ganar y regreso al lobby

Cambios hechos sobre la arquitectura existente, sin reconstruir el juego. Todas las funciones
anteriores (autenticación, salas, Canvas, controles, telemetría, `/api/test/telemetry`,
`/api/test/seed`, CI y despliegue) se mantienen.

## 1. Archivos modificados y nuevos

**Nuevos**

| Archivo | Para qué |
|---|---|
| `shared/matchConfig.ts` | Configuración centralizada de 15/25/30 puntos y fórmula de duración |
| `server/src/profile/avatarProcessor.ts` | Validación y re-codificación segura de la imagen (sharp) |
| `server/src/profile/routes.ts` | `GET /api/profile`, `POST/DELETE /api/profile/avatar`, `GET /api/avatars/<id>.png` |
| `client/src/canvas/AvatarCache.ts` | Caché de imágenes, sprite hexagonal y dibujo común de la unidad |
| `client/src/screens/ProfileScreen.ts` | Pantalla «Personalizar personaje» con encuadre y vista previa |
| `tests/unit/matchConfig.test.ts` | 8 pruebas de puntuación, duración, victoria y desempates |
| `tests/unit/returnToLobby.test.ts` | 9 pruebas de regresión del regreso al lobby |
| `tests/unit/avatar.test.ts` | 7 pruebas de validación de imágenes |
| `tests/integration/returnToLobby.test.ts` | 4 pruebas con Socket.IO + PostgreSQL reales |
| `tests/integration/profile.test.ts` | 4 pruebas de la API de apariencia |
| `docs/ACTUALIZACION_1.1.md` | Este documento |

**Modificados**

| Archivo | Cambio |
|---|---|
| `shared/protocol.ts` | `scoreToWin`/`durationMs` en salas, `avatarUrl` en usuarios y miembros, lista versionada, eventos `room:current`, `room:return`, `player:appearance`, `tiebreak` en resultados |
| `shared/stats.ts` | `tiebreakCriterion` (criterio que resolvió un empate) |
| `server/src/rooms/RoomManager.ts` | Objetivo y duración por sala, `returnToRoom` idempotente, `current`, `updateAppearance`, difusiones sin duplicados, lista versionada |
| `server/src/sockets/socketServer.ts` | Eventos `room:return`, `room:current`, `player:appearance`; actualización de la apariencia del socket |
| `server/src/game/GameServer.ts` | Apariencia por jugador (solo visual), `scoreToWin`, `timeLimitMs` y `tiebreak` en el resultado |
| `server/src/game/matchRecord.ts`, `telemetry/seedGenerator.ts` | Guardan la configuración de la partida |
| `server/src/telemetry/TelemetryService.ts` | Nuevo bloque `byScoreTarget` (los campos existentes no cambian) |
| `server/src/database/migrations.ts` | Migración 2 |
| `server/src/database/repositories.ts` | Columnas nuevas y funciones de apariencia |
| `server/src/auth/*`, `api/*`, `app.ts`, `config.ts` | `avatarUrl` en sesión, rutas de perfil, CSRF acepta PNG/JPEG binario, CSP `img-src blob:`, variables nuevas |
| `server/src/validation/schemas.ts` | `scoreToWin` (15/25/30), `room:return`, encuadre de la imagen |
| `server/package.json` | Dependencia `sharp` |
| `client/index.html`, `styles/main.css` | Selector de puntuación, aviso de sala actual, pantalla de personaje, HUD, botones de resultados |
| `client/src/main.ts` | Estado de sala tomado solo del servidor; ruta `#/personaje`; sin estado de sala inventado al terminar |
| `client/src/screens/LobbyScreen.ts`, `RoomScreen.ts`, `ResultsScreen.ts`, `types.ts` | Lista versionada, sala actual, regreso idempotente, objetivo y duración |
| `client/src/game/GameClient.ts`, `canvas/GameRenderer.ts` | HUD `puntos / objetivo`, tiempo restante y estado; dibujo de la imagen |
| `client/src/network/api.ts`, `SocketClient.ts` | Llamadas nuevas |
| `tests/e2e/auth.spec.ts`, `lobby.spec.ts`, `helpers.ts`, `tests/unit/roomManager.test.ts` | Ampliados (siguen siendo exactamente 3 flujos E2E) |
| `.env.example`, `README.md` | Variables y documentación |

## 2. Personalización del personaje

**Flujo:** el jugador abre «Personalizar personaje» (botón «Personaje» de la barra superior o
tarjeta del lobby), sube una imagen, la encuadra (arrastrar y zoom; teclado: flechas y +/−), ve en
dos vistas previas cómo queda su unidad actual y la nueva, y pulsa «Guardar apariencia». También
puede «Cancelar» la imagen elegida o «Restablecer apariencia».

**Validación en el navegador:** extensión `.png/.jpg/.jpeg`, tipo MIME, tamaño (2 MB), firma real
de los primeros bytes, decodificación con `createImageBitmap` y dimensiones (32-4096 px). Sirve
para dar el error al instante; el servidor no confía en ella.

**Validación en el servidor** (`avatarProcessor.ts`), en este orden:

1. Tamaño: vacío → 400; mayor que `AVATAR_MAX_BYTES` → 413 (el cuerpo se corta al leerlo).
2. Extensión del nombre original, tipo MIME declarado y firma real (bytes mágicos PNG/JPEG).
   Los tres tienen que coincidir: un GIF, WebP, SVG o EXE renombrado a `.png` se rechaza (415).
3. Rechazo de contenido activo incrustado (`<script`, `<html`, `<svg`, `<?php`…) (415).
4. Lectura de cabecera con libvips: formato real, una sola imagen (sin animación), límite de
   píxeles antes de decodificar y dimensiones entre 32 y `AVATAR_MAX_DIMENSION` (422).
5. Decodificación completa (una imagen dañada o truncada → 422), orientación EXIF, recorte cuadrado
   pedido por el cliente (siempre forzado dentro de la imagen) y **re-codificación a PNG 128×128 sin
   metadatos**. Se guarda solo lo que genera el servidor, nunca el archivo original.

**Almacenamiento:** tabla `user_avatars` en PostgreSQL (una fila por usuario, `ON DELETE CASCADE`).
El identificador lo genera el servidor (UUID) y forma la URL `/api/avatars/<uuid>.png`; cualquier
otra ruta responde 404, así que no hay nombres ni rutas manipulables. Al subir una imagen nueva, la
anterior se borra en la misma transacción; «Restablecer» la elimina. Se guarda en la base de datos
y no en disco porque el disco de Render/Railway se pierde en cada despliegue.

**Permisos:** los endpoints de escritura no reciben ningún id de usuario; siempre actúan sobre el
usuario de la sesión. Ver imágenes exige sesión. Las imágenes se sirven con `nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox` y caché inmutable (la URL cambia con cada
imagen).

**Sincronización:** la sesión incluye `avatarUrl`; al entrar en una sala el miembro la lleva y la
partida la reparte en `game:start`. Si el jugador cambia la imagen estando en una sala o partida,
el servidor actualiza ese miembro (sin quitarlo ni volver a añadirlo), difunde `room:state` y, si
hay partida, `player:appearance`.

**Renderizado:** `AvatarCache` descarga cada URL una vez, la prerenderiza recortada en hexágono y
el renderizador hace un único `drawImage` por jugador. Mientras carga o si falla se dibuja el
aspecto predeterminado. La imagen se dibuja dentro del radio lógico de 16 px: **la hitbox, la
velocidad y el daño no cambian** (la simulación del servidor no usa la imagen).

## 3. Puntuación para ganar

La duración predeterminada que ya usaba el juego es `MATCH_DURATION_S` (por defecto 180 s), y es la
base del modo de 15 puntos.

| Puntuación | Descripción | Duración | Con la base de 180 s | Con `MATCH_DURATION_S=90` (E2E) |
|---|---|---|---|---|
| 15 | Partida estándar | base (sin cambios) | 3:00 | 1:30 |
| 25 | Partida extendida | base × 25 / 15 | 5:00 | 2:30 |
| 30 | Partida larga | base × 30 / 15 | 6:00 | 3:00 |

**Fórmula:** `duración(objetivo) = round(duración_base × objetivo / 15)`; para 15 devuelve
exactamente la base. Es proporcional para mantener el mismo ritmo de puntos por minuto en los tres
modos. Implementada solo en `shared/matchConfig.ts` (`calculateMatchDuration`).

**Reglas del servidor:** Zod acepta exactamente 15, 25 o 30 (por defecto 15); `RoomManager` lo
vuelve a comprobar y calcula la duración. Ambos valores se guardan en la sala, viajan a todos en
`room:state` y `game:start`, y no existe ningún evento para cambiarlos después. La partida termina al
alcanzar el objetivo o al agotar el tiempo; después ya no avanza ni acepta entradas. El ganador sale
de la clasificación ya existente (puntos → eliminaciones → menos muertes → más supervivencia →
orden de ingreso) y, si hubo empate a puntos, el resultado indica el criterio (`tiebreak`). Cada
partida guarda `score_to_win` y `time_limit_ms`; la telemetría añade `byScoreTarget`.

**Interfaz:** selector de tres opciones con su descripción y el tiempo máximo calculado por el
servidor (radios nativos: ratón, teclado y táctil); 15 marcado por defecto. La sala muestra el
objetivo y el tiempo; el HUD muestra `12 / 25 puntos`, «Tiempo restante» y el estado de la partida.

## 4. Causa del «duplicado» de salas y solución

**Qué pasaba (confirmado en el código de la versión 1.0):**

1. En la pantalla de resultados, «Ir al lobby» era un enlace (`<a href="#/lobby">`) que **no
   avisaba al servidor**. El jugador seguía siendo miembro de la sala original, pero en el lobby la
   veía en la lista como una sala ajena más a la que «unirse».
2. Desde ahí, al crear otra sala (a menudo con el mismo nombre) el servidor lo sacaba de la
   original, que seguía existiendo con los demás jugadores: aparecían **dos salas iguales**. Los
   demás jugadores, mientras tanto, lo seguían viendo como miembro «conectado» de la sala original.
3. Al terminar la partida, el cliente **inventaba** el estado de la sala
   (`{ ...this.room, status: 'lobby' }`), y la pantalla de sala reutilizaba esa copia local sin
   preguntar al servidor si seguía siendo válida.
4. La lista del lobby se podía sobrescribir con una respuesta HTTP más antigua que la última
   actualización recibida por WebSocket (no había orden entre ambas fuentes).

No había listeners duplicados ni jugadores repetidos dentro de una sala (los miembros ya se
guardaban en un `Map` por usuario); se comprobó y quedó cubierto por pruebas.

**Solución:**

- Operación de servidor **`room:return { roomId }`**, idempotente: comprueba que la sala existe y
  que el jugador sigue siendo miembro, reutiliza el mismo id, no crea salas, no vuelve a añadir al
  jugador y, si nada cambia, no emite nada. Si la sala ya no existe responde `SALA_NO_EXISTE`; si el
  jugador ya no es miembro, `NO_ERES_MIEMBRO`; en ambos casos el cliente vuelve al lobby general.
- Resultados: «Volver al lobby de la sala» usa `room:return` y bloquea el botón mientras espera
  (doble clic seguro); «Salir al lobby general» hace `room:leave` explícito.
- **Una sola fuente de verdad:** el cliente ya no inventa estados de sala; la pantalla de sala
  siempre confirma con el servidor; `room:state` solo se acepta si el usuario figura como miembro;
  el lobby pregunta `room:current` y muestra «Sigues en la sala X — Volver / Salir» y marca esa
  sala como «Tu sala».
- `RoomManager` solo difunde el estado de una sala o la lista cuando cambian, y la lista lleva un
  número de versión: el lobby descarta respuestas más antiguas.
- `socket.join()` sigue siendo idempotente y los listeners del cliente se registran una vez y se
  liberan al cambiar de pantalla (verificado en la prueba de integración: un socket por miembro en
  el canal de la sala).

**Pruebas de regresión** (número de la lista solicitada → prueba):

| # | Comprobación | Prueba |
|---|---|---|
| 1 | Conserva el id original | `unit/returnToLobby` «conserva el identificador…», `integration/returnToLobby`, E2E 2 |
| 2 | Sin participantes repetidos | `unit/returnToLobby` «aparece una sola vez», E2E 2 |
| 3 | Doble clic no crea sala | `integration/returnToLobby` (peticiones simultáneas), E2E 2 (`dblclick`) |
| 4 | Retransmisión no repite la operación | `unit/returnToLobby` «doble clic o retransmisión…» |
| 5 | Los demás reciben la lista actualizada | `unit` «los demás jugadores reciben…», `integration` «los demás reciben…» |
| 6 | Sin suscripciones duplicadas | `integration` (tamaño del canal = miembros) |
| 7 | No queda como miembro activo de la partida terminada | `unit` «no sigue como miembro activo…» |
| 8 | Sala eliminada → respuesta válida | `unit` y `integration` «si la sala fue eliminada…» |
| 9 | Con 2 y con varios jugadores | `unit` «funciona con varios participantes…» (3 jugadores) |
| 10 | La sala no desaparece mientras sea válida | `unit` «funciona con varios participantes…» |

## 5. Resultados de las pruebas ejecutadas

El entorno de desarrollo sigue **sin acceso al registro de npm**, así que no se pudieron instalar
Express, Socket.IO ni Vitest. Lo que sí se ejecutó:

| Qué | Cómo | Resultado |
|---|---|---|
| 82 pruebas unitarias (incluidas las 25 nuevas) | sustituto local de Vitest; `sharp` 0.35 real; PostgreSQL 16 real | **82/82** → `reports/evidencias/pruebas-unitarias-local.txt` |
| Migración 2 sobre una BD de la 1.0, imágenes en BD, objetivo guardado, telemetría | código real contra PostgreSQL 16 | 12/12 comprobaciones → `reports/evidencias/sql-version-1.1.txt` |
| Tipos | `tsc` real con declaraciones provisionales de las librerías ausentes | sin errores propios |
| Compilación | esbuild | correcta |
| Interfaz | Chromium con un servidor simulado | `captura-lobby-v1.1.png`, `captura-personalizar-personaje.png`; un GIF muestra el error esperado |

**Pendiente de ejecutar con las librerías reales** (lo hace GitHub Actions o tu equipo):
`npm run typecheck`, las 25 pruebas de integración (9 nuevas) y los 3 flujos E2E ampliados.

## 6. Cómo probarlo a mano

**Preparación:** sustituye los archivos del proyecto por los de esta versión **conservando tu
`.env`**, y ejecuta `npm install` (añade `sharp` y actualiza `package-lock.json`, que debes subir a
GitHub). Después `npm run dev`. La migración 2 se aplica sola al arrancar.

**Personaje**

1. Inicia sesión → botón «Personaje».
2. Sube un `.gif` o un `.txt` renombrado a `.png` → mensaje «Formato no permitido…».
3. Sube un PNG o JPEG → arrástralo, usa el zoom y mira la vista previa «Nueva» → «Guardar apariencia».
4. Cierra sesión y vuelve a entrar: la imagen sigue ahí.
5. Con otra cuenta (ventana de incógnito) entra en la misma sala: verás la imagen en la lista de
   miembros y dentro de la unidad durante la partida. Cámbiala en mitad de una partida: el otro
   jugador la ve cambiar sin que nadie se desconecte.
6. «Restablecer apariencia» vuelve al aspecto predeterminado.

**Puntuación para ganar**

1. En «Crear sala» elige 25 puntos: la tarjeta muestra el tiempo máximo (5:00 con la base de 180 s).
2. En la sala se ve «Gana quien llegue a 25 puntos · Tiempo máximo 5:00».
3. En la partida el HUD muestra `0 / 25 puntos`, «Tiempo restante» y el estado; en el último medio
   minuto cambia a «Últimos segundos».
4. Comprueba en `GET /api/test/telemetry` el bloque `byScoreTarget`.

**Regreso al lobby**

1. Juega una partida con dos cuentas (puedes terminarla con «Abandonar» en una de ellas).
2. En resultados pulsa varias veces seguidas «Volver al lobby de la sala»: vuelves a la MISMA sala
   (mismo ID en la cabecera) y apareces una sola vez.
3. En la otra ventana, el lobby muestra una sola sala con ese nombre.
4. Termina otra partida y pulsa «Salir al lobby general»: dejas de ser miembro y la sala ya no te
   muestra a ti.
5. Si en el lobby sigues perteneciendo a una sala (por ejemplo, llegaste desde «Personaje»), verás
   el aviso «Sigues en la sala X» con «Volver» y «Salir».

## 7. Migración, variables y configuración

- **Migración 2** (`puntuacion_objetivo_y_avatares`), automática al arrancar o con
  `npm run db:migrate`: añade `matches.score_to_win` (por defecto 15, con `CHECK` 15/25/30),
  `matches.time_limit_ms` y la tabla `user_avatars`.
- **Variables nuevas** (opcionales): `AVATAR_MAX_BYTES` (2 MB) y `AVATAR_MAX_DIMENSION` (4096).
  `MATCH_DURATION_S` sigue siendo la duración base (modo de 15 puntos).
- **Dependencia nueva:** `sharp` (binarios precompilados para Linux, Windows y macOS; funciona en
  Render y Railway sin configuración). Ejecuta `npm install` y sube el `package-lock.json` nuevo.
- Los endpoints oficiales `/api/test/telemetry` y `/api/test/seed` no cambian de ruta ni de
  contrato; la telemetría solo añade el campo `byScoreTarget`.

## 8. Corrección 1.1.1 — la imagen no aparecía dentro de la partida

**Síntoma:** la imagen se guardaba y se veía en «Personalizar personaje», pero en la partida la
unidad seguía dibujándose con el hexágono por defecto. Además, en el HUD el botón «Abandonar» tapaba
el texto «x / 25 puntos».

**Causa real:** al conectarse, el servidor de sockets copiaba el usuario de la sesión en una
variable local (`const user = socket.data.user`). Al subir la imagen, `updateUserAppearance`
sustituía `socket.data.user` por un objeto NUEVO, pero los manejadores `room:create`, `room:join` y
`room:return` seguían usando la copia antigua, con `avatarUrl: null`. Así, si la imagen se subía
después de iniciar sesión (el caso normal), la sala y `game:start` se creaban sin imagen. Solo se
veía tras recargar la página, porque la reconexión volvía a leer la sesión.

**Corrección:**
- `server/src/sockets/socketServer.ts`: la apariencia se actualiza sobre el MISMO objeto de usuario
  del socket y los manejadores leen siempre `socket.data.user` (valor actual).
- `server/src/rooms/RoomManager.ts`: `syncAppearance` al reingresar o volver a una sala, de modo que
  el miembro y la partida en curso usan la apariencia actual (y se avisa con `player:appearance`).
- `client/index.html` y `client/src/styles/main.css`: «Abandonar» pasa al bloque de vitales, debajo
  del marcador, en lugar de estar posicionado de forma absoluta encima de él.

**Pruebas añadidas:**
- Unitaria (`tests/unit/returnToLobby.test.ts`): al volver o reingresar se usa la apariencia actual y
  la siguiente partida la reparte a todos. Ejecutada: 82/82 con el sustituto local.
- Integración (`tests/integration/profile.test.ts`): conectarse, subir la imagen DESPUÉS, crear una
  sala nueva y empezar la partida → ambos jugadores reciben la imagen en `game:start`. Escrita pero
  **no ejecutada aquí** (requiere Vitest, Express y Socket.IO reales: `npm run test:integration`).
- Captura: `reports/evidencias/captura-partida-avatar-v1.1.1.png` (cliente real con servidor
  simulado; por eso muestra «Reconectando con el servidor…»).

**Cómo aplicarla:** sustituye los archivos del proyecto (conserva tu `.env`), reinicia
`npm run dev` y entra en una sala nueva. No hay dependencias ni migraciones nuevas.
