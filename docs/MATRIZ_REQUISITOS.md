# Matriz de requisitos → implementación → evidencia (Fase 7)

## Qué se pudo ejecutar en el entorno de desarrollo

El entorno donde se construyó el proyecto **no tenía acceso al registro de npm** (petición
bloqueada por la política de red). Estaban disponibles Node.js 22, TypeScript 6, Zod 3.25,
esbuild 0.28, tsx, Playwright 1.63 con Chromium y PostgreSQL 16, pero **no** Express, Socket.IO,
Vitest ni el driver `pg`. Por eso:

| Comprobación | Cómo se hizo | Resultado |
|---|---|---|
| Tipos de `shared/` | `tsc` real | sin errores |
| Tipos de `server/` y `client/` | `tsc` real con declaraciones `any` provisionales para express, socket.io, socket.io-client y pg | sin errores propios; los únicos avisos son parámetros implícitos de esas librerías sustituidas. **Pendiente:** `npm run typecheck` con los tipos reales |
| Compilación | `esbuild` real: servidor completo; cliente con socket.io-client marcado como externo | correcta |
| 57 pruebas unitarias | archivos de `tests/unit/` ejecutados con un sustituto mínimo de la API de Vitest (`describe/it/expect`) | 57/57 superadas → `reports/evidencias/pruebas-unitarias-local.txt`. **Pendiente:** ejecutarlas con Vitest real |
| SQL (migraciones, usuarios, sesiones, inserción por lotes con `unnest`, telemetría, estadísticas, clasificación, reset) | código real de `server/src/database` y `server/src/telemetry` contra **PostgreSQL 16**, con un adaptador `pg` basado en `psql` | todas las comprobaciones correctas; telemetría coherente (`consistency` a 0) |
| Tiempo SQL de la telemetría con 1000 partidas | `psql \timing` | consulta principal 7-13 ms, consulta por origen 3,6-5,2 ms → `reports/evidencias/sql-telemetria-tiempos.txt` |
| 2000 semillas de mapa | `validateMap` | 0 mapas inválidos, superficie transitable mínima 70 % |
| Pruebas de integración (HTTP + Socket.IO + BD) | — | **Pendiente** (necesitan Express, Socket.IO y pg reales) |
| 3 flujos E2E de Playwright | — | **Pendiente** (necesitan el servidor real) |
| Latencia ping/pong, FPS y tiempo HTTP de la API | scripts `bench:latency`, `bench:api` y flujo E2E 2 listos | **Pendiente de medir**: no se declara cumplido ningún objetivo sin medición |
| Despliegue público | `render.yaml`, `railway.json`, instrucciones | **Pendiente**: requiere tu cuenta |

Los sustitutos usados para estas comprobaciones **no forman parte del proyecto** y se eliminaron.
Con `npm install` todo se ejecuta con las librerías reales; GitHub Actions lo hace en cada push.

Leyenda de estado: **V** verificado aquí · **VP** verificado parcialmente aquí (lógica o SQL, sin
las librerías de red reales) · **P** implementado, pendiente de ejecutar en CI/local.

## 1. Concepto y diseño

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Arena 2D cenital con estética cyberpunk | `client/src/canvas/GameRenderer.ts`, `client/src/styles/main.css` | E2E 3 (contenido del Canvas) | P |
| Mapas procedurales | `shared/MapGenerator.ts` | `unit/mapGenerator.test.ts` | V |
| Unidades robóticas, obstáculos, coberturas y colisiones | `GameRenderer.ts`, `server/src/game/CollisionSystem.ts` | `unit/collision.test.ts` | V |
| Vida, daño, eliminación y reaparición controlada | `server/src/game/GameServer.ts`, `CombatSystem.ts` | `unit/gameServer.test.ts`, `unit/combat.test.ts` | V |
| Recolección de recursos (fragmentos) y objetivo (30, 40 o 50 puntos desde la 1.3) | `GameServer.ts` | `unit/gameServer.test.ts` (puntuación) | V |
| Marcador, clasificación, estadísticas | `GameClient.ts` (HUD), `ResultsScreen.ts`, `shared/stats.ts` | `unit/stats.test.ts` | V |
| Salas previas a la partida | `server/src/rooms/RoomManager.ts`, `LobbyScreen.ts`, `RoomScreen.ts` | `unit/roomManager.test.ts`, E2E 2 | VP |
| Indicadores de conexión, latencia y estado | `client/index.html` (barra superior, HUD), `main.ts` | E2E 2 | P |
| Pantallas inicio, acceso, registro, lobby, partida, resultados | `client/index.html`, `client/src/screens/*` | E2E 1-3 | P |
| Diseño adaptable | `main.css` (rejillas y consultas de medios), `Camera.ts` (zoom) | E2E 3 (móvil emulado) | P |

## 2-3. Arquitectura y autoridad del servidor

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Node + TypeScript + Express + Socket.IO + Zod + PostgreSQL | `server/src/app.ts`, `sockets/socketServer.ts`, `validation/schemas.ts`, `database/*` | integración | VP |
| Servidor decide posiciones y velocidad | `GameServer.ts` (`updatePlayer`, `normalizeIntent`) | `unit/gameServer.test.ts` (velocidad exacta, anti speed-hack) | V |
| Colisiones jugador-obstáculo y jugador-jugador | `CollisionSystem.ts` | `unit/collision.test.ts` | V |
| Daño, vida, eliminaciones, reapariciones | `GameServer.ts`, `CombatSystem.ts` | `unit/gameServer.test.ts`, `unit/combat.test.ts` | V |
| Inventario y recursos | `GameServer.ts` (`shards`, energía) | `unit/gameServer.test.ts` | V |
| Estado de salas y partidas, resultado y estadísticas | `RoomManager.ts`, `GameServer.finish` | `unit/roomManager.test.ts`, verificación SQL | V |
| El cliente solo envía intenciones | `shared/protocol.ts` (`InputIntent`), `GameClient.sendInput` | `unit/validation.test.ts` (rechaza `x`, `y`, `damage`) | V |
| Validación Zod de todos los mensajes | `validation/schemas.ts`, `socketServer.ts` (`handle`) | `unit/validation.test.ts`, `integration/sockets.test.ts` | VP |
| Límites de velocidad y de frecuencia, rechazo de eventos | `GameServer.ts`, `lib/RateLimiter.ts`, `socketServer.ts` | `unit/auth.test.ts`, `unit/gameServer.test.ts`, E2E 3 | VP |
| Interpolación en el cliente | `client/src/network/Interpolator.ts` | `unit/interpolation.test.ts` | V |
| Ping/pong medido y mostrado | `LatencyMonitor.ts`, `socketServer.ts` (`net:ping`) | `integration/sockets.test.ts`, E2E 2, `scripts/measure-latency.ts` | P |
| Objetivo < 100 ms | — | `reports/latency.json`, `reports/e2e-latency.json` (se generan en CI) | P (sin medir) |

## 4. Motor Canvas 2D y rendimiento

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| `requestAnimationFrame` + delta time, paso fijo | `client/src/canvas/GameLoop.ts` | `unit/gameLoop.test.ts` | V |
| Igual a 60/120/144 Hz y tolerante a variaciones | `GameLoop.planSteps`, `Camera.follow` | `unit/gameLoop.test.ts` | V |
| Límite de pasos tras pausas largas | `GameLoop.ts` (`MAX_FRAME_DT`, `MAX_STEPS`), `GameServer.update` | `unit/gameLoop.test.ts` | V |
| Colisiones eficientes | rejilla del mapa O(1) por cuerpo, DDA para proyectiles | `unit/collision.test.ts` | V |
| Mapa prerrenderizado, sprites de brillo, pool de partículas, sin objetos por fotograma | `GameRenderer.ts`, `ParticleSystem.ts`, `Interpolator.ts` | `unit/interpolation.test.ts` (reutiliza objetos) | VP |
| Canvas adaptado al tamaño y a `devicePixelRatio` | `GameRenderer.resize`, `ResizeObserver` en `GameClient.ts` | E2E 3 | P |
| Limpieza de eventos y temporizadores | `ui/dom.ts` (`Disposer`), `GameClient.stop`, `unmount` de pantallas | — | P |
| Indicador de FPS y latencia | HUD (`#hud-fps`, `#hud-ping`), barra superior | E2E 3 (FPS > 0) | P |
| Objetivo 60 FPS | — | E2E 3 registra FPS; medir en el navegador del evaluador | P (sin medir) |

## 5. Controles

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| WASD/flechas con keydown/keyup, ratón, clic, tecla secundaria | `client/src/controls/KeyboardControls.ts` | E2E 3 (entrada inyectada en el mismo estado) | P |
| Detección de dispositivo; sin controles táctiles en PC | `controls/device.ts`, `GameClient.start` | E2E 3 (oculto en escritorio) | P |
| Joystick abajo-izquierda, botón de acción abajo-derecha, diagonales | `controls/TouchControls.ts`, `main.css` | E2E 3 (móvil emulado, el joystick mueve al jugador) | P |
| Sin desplazamiento involuntario, cancelación de gestos, captura del puntero | `TouchControls.ts` (`touch-action`, `pointercancel`, `setPointerCapture`) | E2E 3 | P |

## 6. Autenticación y protección de salas

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Registro, inicio y cierre de sesión, validación | `server/src/auth/routes.ts`, `AuthScreen.ts` | `integration/auth.test.ts`, E2E 1 | VP (SQL verificado) |
| Hash seguro (scrypt) | `auth/password.ts` | `unit/auth.test.ts`, verificación SQL | V |
| Sesiones con protección (HttpOnly, SameSite, Secure, revocación, hash del token) | `auth/SessionService.ts`, `auth/routes.ts` | `unit/auth.test.ts`, `integration/auth.test.ts` | VP |
| Rutas privadas protegidas | `auth/middleware.ts`, `screens/types.ts` (`PROTECTED_SCREENS`) | `integration/auth.test.ts`, E2E 1 | P |
| Credenciales incorrectas | `auth/routes.ts` (hash ficticio, 401 uniforme) | `integration/auth.test.ts`, E2E 1 | P |
| Salas privadas protegidas (socket y REST) | `RoomManager.join`, `api/routes.ts` | `unit/roomManager.test.ts`, `integration/sockets.test.ts`, E2E 1 | VP |
| Autenticación también en WebSocket | `socketServer.ts` (`io.use`) | `integration/sockets.test.ts` | P |
| Desconexiones y reconexiones | `RoomManager.disconnect/reconnect`, `socketServer.ts`, `SocketClient.ts` | `unit/roomManager.test.ts` | VP |

## 7. Lobbies

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| ID, nombre, jugadores, capacidad, estados, creador | `RoomManager.state`, `shared/protocol.ts` | `unit/roomManager.test.ts` | V |
| Botón listo / cancelar listo | `RoomScreen.ts` | E2E 2 | P |
| Inicio al cumplirse las condiciones | `RoomManager.evaluateStart/startMatch` | `unit/roomManager.test.ts`, E2E 2 | VP |
| Actualización en tiempo real | `socketServer.ts` (`room:state`, `rooms:changed`) | E2E 2 | P |
| Eventos validados en el servidor | `socketServer.ts` + Zod | `unit/validation.test.ts`, `integration/sockets.test.ts` | VP |

## 8. Mapas, combate y estadísticas

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Generador con semilla reproducible | `shared/MapGenerator.ts`, `shared/random.ts` | `unit/mapGenerator.test.ts` | V |
| Posiciones iniciales válidas, mapa no bloqueado | `MapGenerator.validateMap` | `unit/mapGenerator.test.ts`, 2000 semillas | V |
| Cadencia, trayectoria, colisiones, alcance y daño en el servidor | `GameServer.fire/updateProjectiles`, `CombatSystem.ts` | `unit/gameServer.test.ts`, `unit/combat.test.ts` | V |
| Win Rate, KDR (sin división entre cero), supervivencia, partidas, victorias, derrotas, eliminaciones, muertes | `shared/stats.ts`, `database/repositories.ts`, `TelemetryService.ts` | `unit/stats.test.ts`, verificación SQL | V |
| Fórmulas documentadas y coherentes | README («Reglas y fórmulas»), campo `formulas` de la telemetría | verificación SQL (mismas fórmulas en partida y agregados) | V |

## 9. Endpoints de evaluación

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| `GET /api/test/telemetry` 200 con métricas agregadas, unidades y fórmulas | `telemetry/routes.ts`, `TelemetryService.ts` | `integration/telemetry.test.ts`; SQL real → `reports/evidencias/telemetria-ejemplo-500-partidas.json` | VP |
| Valores válidos sin partidas | `TelemetryService.ts` (`coalesce`) | verificación SQL (ceros) | V |
| Agregaciones en SQL | `TelemetryService.ts` | código revisado + verificación SQL | V |
| < 200 ms | — | SQL 7-13 ms aquí; `integration/telemetry.test.ts` (p95 HTTP), `bench:api` | VP (falta medir HTTP) |
| `POST /api/test/seed` con Zod, 100-1000, coherente, por lotes, 200 + resumen + tiempo | `telemetry/routes.ts`, `seedGenerator.ts`, `repositories.insertMatchesBulk` | `unit/validation.test.ts`, `unit/stats.test.ts`, verificación SQL, `integration/telemetry.test.ts` | VP |
| Sin duplicados accidentales | `seed_batches` + 409 | verificación SQL (rowCount 0) | VP |
| Errores HTTP apropiados | `api/middleware.ts` (`errorHandler`) | `integration/telemetry.test.ts` | P |
| Restringido a pruebas o protegido | `config.ts`, `telemetry/routes.ts` | `integration/telemetry.test.ts` (401/403/404) | P |
| Manejo centralizado de errores y tiempos de respuesta | `api/middleware.ts` | `integration/auth.test.ts` (`X-Response-Time`) | P |

## 10. Pruebas automatizadas

| Requisito | Archivos | Estado |
|---|---|---|
| ≥ 10 pruebas Vitest (57 unitarias + 16 de integración) | `tests/unit/*`, `tests/integration/*`, `vitest.config.ts` | VP (unitarias ejecutadas con sustituto) |
| Exactamente 3 flujos E2E | `tests/e2e/auth.spec.ts`, `lobby.spec.ts`, `canvas.spec.ts`, `playwright.config.ts` | P |
| Datos y usuarios aislados | usuarios únicos por prueba, `TEST_DATABASE_URL`, `globalSetup.ts` | P |

## 11-12. CI/CD y despliegue

| Requisito | Archivos | Estado |
|---|---|---|
| `.github/workflows/ci.yml` en PR y ramas principales | `.github/workflows/ci.yml` | P (se ejecuta al subir el repositorio) |
| Falla si una suite no se ejecuta o no pasa | `scripts/verify-test-reports.mjs` | P |
| Render / Railway, WebSockets persistentes, HTTPS/WSS | `render.yaml`, `railway.json`, README | P (requiere tu cuenta) |
| `.env.example`, secretos, migraciones, salud | `.env.example`, `database/migrations.ts`, `/api/health` | V (archivos) |

## 13-15. Diseño, estructura y documentación

| Requisito | Archivos | Estado |
|---|---|---|
| Interfaz cyberpunk legible, estados de botones, mensajes, responsive | `client/src/styles/main.css`, `client/index.html` | P (revisión visual pendiente) |
| Estructura modular | ver `docs/ARQUITECTURA.md` | V |
| README completo en español | `README.md` | V |

## Corrección 1.3.2 — reinicio entre partidas

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Estado inicial centralizado de cada jugador | `GameServer.createInitialPlayerState` | `unit/matchLifecycle.test.ts` (1, 2-8, 14) | V |
| Sobrecarga, rayo, satélites, dron, corrosión, sinergias y recargas no se heredan | `GameServer`, `RoomManager` | `unit/matchLifecycle.test.ts` (2-8) | V |
| Entidades y callbacks de la partida anterior sin efecto | `GameServer.dispose`, filtro de callbacks en `RoomManager` | `unit/matchLifecycle.test.ts` (9, 10) | V |
| Salas independientes | `RoomManager` | `unit/matchLifecycle.test.ts` (11) | V |
| Lobby y reconexión sin duplicados ni mejoras recuperadas | `RoomManager.activeGame`, `socketServer.ts` | `unit/matchLifecycle.test.ts` (12, 13), `integration/upgrades.test.ts` | VP |
| Interfaz reconstruida desde el estado del servidor | `GameClient.resetAbilityHud`, filtro por `matchId` | `interfaz-reinicio-partida.txt`, captura | VP |

## Puntuaciones 30 / 40 / 50 (25/10/2026)

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Puntuaciones 30/40/50 (30 por defecto), definidas en un único sitio | `shared/matchConfig.ts` | `unit/matchConfig.test.ts` (8) | V |
| Validación (Zod y sala), selector y textos generados desde la lista | `schemas.ts`, `RoomManager.ts`, `LobbyScreen.ts`, `HomeScreen.ts` | `unit/matchConfig.test.ts`, captura del selector | V |
| Base de datos: migración 3 sin perder partidas antiguas | `migrations.ts` | `reports/evidencias/sql-puntuaciones-30-40-50.txt` (PostgreSQL 16) | V |
| Integración y E2E actualizadas (40 puntos) | `tests/integration/returnToLobby.test.ts`, `tests/e2e/*` | — | P |

## Versión 1.3 — habilidades, armas y sinergias

Detalle completo en [ACTUALIZACION_1.3.md](ACTUALIZACION_1.3.md). «Sobrecarga» no existía antes: se creó una sola vez.

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Conservar las 10 mejoras originales, sin duplicados | `shared/upgrades.ts` | `unit/abilities.test.ts`, `unit/upgrades.test.ts` (1) | V |
| Bala rebotadora (rebotes físicos, límite, sin proyectiles extra) | `GameServer.updateProjectiles`, `CollisionSystem.raycastSolidHit` | `unit/abilities.test.ts` | V |
| Rayo perforante: sustituye al disparo, recarga propia, perforación sin duplicados, paredes | `GameServer.fireBeam` | `unit/abilities.test.ts` (3 pruebas) | V |
| Satélites protectores: bloqueo, rotura, recuperación, límite, diseño distinto del dron | `GameServer` (satélites), `GameRenderer.drawSatellites` | `unit/abilities.test.ts` (2), captura | V |
| Teletransporte: límites, paredes, recarga, mensajes manipulados | `Abilities.findTeleportDestination`, `GameServer.tryTeleport` | `unit/abilities.test.ts` (2) | V |
| Munición corrosiva: daño periódico limitado, renovación, fin y limpieza | `GameServer.updateCorrosion`, `Abilities.renewCorrosion` | `unit/abilities.test.ts` (2) | V |
| Sobrecarga con balas, triple, pesada y rayo; duración y recarga | `GameServer.tryOverload`, `damageBoost` | `unit/abilities.test.ts` (3) | V |
| Cadena eléctrica: límite de saltos, sin repetir, daño decreciente | `GameServer.runChain`, `Abilities.pickChainTarget` | `unit/abilities.test.ts` | V |
| Bala fragmentada: sin fragmentos infinitos, límite activo | `GameServer.spawnFragments` | `unit/abilities.test.ts` (2) | V |
| 10 sinergias centralizadas y funcionales | `shared/synergies.ts`, `computeLoadout`, `GameServer` | `unit/abilities.test.ts` (11) | V |
| Sin ciclos ni daño ilimitado | límites en `UPGRADE_LIMITS` | `unit/abilities.test.ts` (prueba de estrés) | V |
| Sincronización entre jugadores; lo privado no se difunde | `GameServer.snapshot`, `socketServer.ts` | `unit/abilities.test.ts`, `integration/upgrades.test.ts` (nuevo caso) | VP |
| Limpieza al terminar la partida | `GameServer.finish`, `clearTransient` | `unit/abilities.test.ts` | V |
| Dos opciones aleatorias y sin opciones inútiles | `canOfferUpgrade` | `unit/abilities.test.ts` | V |
| Interfaz: teclas E/Q, botones táctiles, recargas, efectos | cliente | capturas `captura-habilidades-*.png` (servidor simulado) | VP |
| Sin regresiones en salas, lobby y puntuación | — | 128/128 unitarias | VP (integración/E2E pendientes) |

## Versión 1.2 — mejoras de nave

Detalle completo en [ACTUALIZACION_1.2.md](ACTUALIZACION_1.2.md).

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Hito cada 10 puntos de progreso (independiente de la puntuación), una sola vez, en cola y sin elección tras el final | `server/src/game/UpgradeSystem.ts`, `GameServer.ts` | `unit/upgrades.test.ts` (3, 4, 5, «no abre elecciones…») | V |
| Catálogo centralizado de 10 mejoras con id, nombre, descripción, icono, categoría, rareza y parámetros | `shared/upgrades.ts` | `unit/upgrades.test.ts` (1) | V |
| Efectos reales en cadencia, proyectiles, daño, velocidad de bala, movimiento, escudo, dron e imán | `GameServer.ts`, `CombatSystem.ts`, `shared/upgrades.ts` | `unit/upgrades.test.ts` (7, 8, 9) | V |
| Equilibrio con límites explícitos y combinación determinista | `shared/upgrades.ts` (`UPGRADE_LIMITS`, `computeLoadout`) | `unit/upgrades.test.ts` (7, 9, límite global) | V |
| Dos opciones distintas generadas en el servidor; aleatorio controlable; sin repetir mejoras al máximo o incompatibles | `UpgradeSystem.ts` | `unit/upgrades.test.ts` (2) | V |
| Validación de hito y opción ofrecida, Zod, límite de frecuencia y prevención de duplicados | `UpgradeSystem.ts`, `validation/schemas.ts`, `socketServer.ts` | `unit/upgrades.test.ts` (3, 6), `integration/upgrades.test.ts`, E2E 3 (ampliado) | VP |
| Ventana «¡Mejora tu nave!», progreso e iconos en el HUD, PC y móvil, sin pausar la partida | `client/src/game/UpgradePanel.ts`, `client/index.html`, `main.css` | capturas `captura-mejora-*.png` (servidor simulado) | VP |
| Protección breve validada por el servidor, sin acumularse | `GameServer.grantChoiceGuard` | `unit/upgrades.test.ts` («la protección…») | V |
| Estado privado por jugador; los demás solo ven escudo, dron, proyectiles y si está eligiendo | `GameServer.snapshot`, `socketServer.ts` | `unit/upgrades.test.ts` (10), `integration/upgrades.test.ts` | VP |
| Reconexión sin duplicar mejoras y reinicio en la partida siguiente | `GameServer.startPayload`, `GameClient.ts` | `unit/upgrades.test.ts` (10), `integration/upgrades.test.ts` | VP |
| Compatible con 15/25/30, sin cambiar victoria, resultados ni estadísticas | `GameServer.ts` | `unit/upgrades.test.ts`, 82 pruebas anteriores sin cambios | V |

## Versión 1.1

Detalle completo en [ACTUALIZACION_1.1.md](ACTUALIZACION_1.1.md).

| Requisito | Archivos | Prueba / evidencia | Estado |
|---|---|---|---|
| Subida de imagen PNG/JPEG con vista previa, encuadre, guardar, cancelar y restablecer | `client/src/screens/ProfileScreen.ts`, `client/index.html` | E2E 1 (ampliado), captura `captura-personalizar-personaje.png` | VP |
| Validación de extensión, MIME, firma, decodificación, tamaño y dimensiones en el servidor | `server/src/profile/avatarProcessor.ts` | `unit/avatar.test.ts` (7, ejecutadas con sharp real) | V |
| Nombres generados por el servidor, sin rutas manipulables, limpieza de imágenes antiguas | `server/src/profile/routes.ts`, `repositories.ts` | `integration/profile.test.ts`, `sql-version-1.1.txt` | VP |
| Solo el propio usuario cambia su apariencia; persistencia entre sesiones | `profile/routes.ts`, `SessionService.ts` | `integration/profile.test.ts`, `sql-version-1.1.txt` | VP |
| Sincronización en sala y partida sin duplicar ni desconectar | `RoomManager.updateAppearance`, `socketServer.ts`, `GameClient.ts` | `integration/profile.test.ts` | P |
| Render con caché, aspecto por defecto mientras carga, sin cambiar hitbox | `client/src/canvas/AvatarCache.ts`, `GameRenderer.ts` | captura de partida, `unit/gameServer.test.ts` (la simulación no cambia) | VP |
| Puntuación 15/25/30, duración base intacta, fórmula progresiva centralizada | `shared/matchConfig.ts` | `unit/matchConfig.test.ts` | V |
| Validación y fijación en el servidor, misma configuración para todos | `validation/schemas.ts`, `RoomManager.ts`, `GameServer.ts` | `unit/matchConfig.test.ts`, `integration/returnToLobby.test.ts` | VP |
| Fin por objetivo o tiempo, desempate explícito, sin puntos tras el final, estadísticas con la configuración | `GameServer.ts`, `shared/stats.ts`, migración 2 | `unit/matchConfig.test.ts`, `sql-version-1.1.txt` | V |
| HUD: puntos / objetivo, tiempo restante y estado | `client/index.html`, `GameClient.ts` | E2E 2 (ampliado) | P |
| Regreso al lobby idempotente, mismo id, sin duplicados | `RoomManager.returnToRoom`, `socketServer.ts`, `ResultsScreen.ts`, `RoomScreen.ts`, `LobbyScreen.ts`, `main.ts` | `unit/returnToLobby.test.ts` (9), `integration/returnToLobby.test.ts`, E2E 2 | VP |
