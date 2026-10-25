# Actualización 1.2 — Mejoras aleatorias de nave durante la partida

Se añade un sistema de mejoras sobre el proyecto existente, sin reconstruirlo y sin cambiar la
arquitectura, los controles, la puntuación, las salas, la autenticación, los endpoints oficiales
ni el estilo visual. El servidor sigue siendo la única autoridad: el cliente solo **solicita** una
elección (hito + identificador) y **muestra** el estado que recibe.

## 1. Progresión

- **El progreso de mejoras es un contador aparte de la puntuación competitiva.** Si usara los mismos
  puntos, en el modo de 15 solo se alcanzaría el hito 10, y no habría hitos 20, 30 o 40.
- Se gana con las mismas acciones que la puntuación, pero con valores propios:
  **+2 por fragmento** y **+4 por eliminación**. La puntuación competitiva sigue siendo +1 y +3.
- Hay un hito cada 10 puntos de progreso (10, 20, 30, 40…) hasta que termina la partida. Cada hito
  se alcanza **una sola vez**: el siguiente hito solo avanza, nunca se repite.
- Si se cruzan varios hitos antes de elegir, quedan **en cola** y se ofrecen de uno en uno.
- Si la partida termina en el mismo paso en que se alcanza un hito, **no se abre la elección**. Los
  hitos se procesan después de comprobar el final. Tras el final, cualquier elección se rechaza.
- Elegir una mejora **no da puntos competitivos** y no cambia la puntuación objetivo (15/25/30) ni
  las condiciones de victoria, los resultados o las estadísticas guardadas.
- Si ya no quedan al menos dos mejoras disponibles (todas al máximo o incompatibles), el hito se
  descarta sin elección para que siempre se muestren exactamente dos opciones. Con el catálogo
  actual esto solo pasaría a partir de unos 130 puntos de progreso.

## 2. Las diez mejoras

Todas cambian la lógica de la simulación en `server/src/game/GameServer.ts`. Ninguna es solo visual.

| Id estable | Nombre | Categoría · rareza | Niveles | Qué hace en el servidor |
|---|---|---|---|---|
| `doble_canon` | Doble cañón | Ataque · común | 1 | Cada disparo crea **2 proyectiles paralelos** separados 14 px, cada uno con el 60 % del daño. Incompatible con Triple disparo. |
| `triple_disparo` | Triple disparo | Ataque · rara | 1 | **3 proyectiles en abanico** (−12°, 0°, +12°), cada uno con el 50 % del daño. Incompatible con Doble cañón. |
| `municion_pesada` | Munición pesada | Ataque · común | 1 | Daño **×1,6** (32 a corta distancia) e intervalo entre disparos **×1,5** (375 ms). Proyectil marcado como pesado (`k: 'p'`). |
| `disparo_acelerado` | Disparo acelerado | Ataque · común | 2 | Intervalo **×0,85 por nivel** (250 → 213 → 181 ms), con un mínimo de 150 ms. |
| `proyectiles_veloces` | Proyectiles veloces | Ataque · común | 2 | Velocidad de bala **×1,2 por nivel** (700 → 840 → 1000 px/s, límite 1000). El alcance no cambia. |
| `escudo_energia` | Escudo de energía | Defensa · rara | 1 | **Absorbe 30** de daño antes que la vida. Tras **4 s sin impactos** se recarga a 15/s. Se rellena al reaparecer. |
| `propulsores` | Propulsores mejorados | Movilidad · común | 2 | Velocidad de movimiento **+10 % por nivel**, con un máximo de +20 % (220 → 264 px/s). Afecta también al impulso. |
| `canones_laterales` | Cañones laterales | Ataque · rara | 1 | Añade **2 disparos diagonales a ±45°** con el 40 % del daño cada uno. Se combina con los demás patrones. |
| `dron_apoyo` | Dron de apoyo | Utilidad · épica | 1 | Un dron orbita a 30 px y **dispara solo cada 1,2 s** al rival visible más cercano a menos de 380 px. Hace 8 de daño fijo, sin racha y sin caída por distancia. No dispara a jugadores protegidos ni a través de muros. |
| `iman_energia` | Imán de energía | Utilidad · común | 2 | Radio de recogida de fragmentos **+20 px por nivel** (26 → 46 → 66 px, límite 70). |

Cada mejora tiene en `shared/upgrades.ts` su identificador, nombre, descripción, icono (trazado
SVG), categoría, rareza, nivel máximo, incompatibilidades y parámetros.

## 3. Equilibrio: parámetros iniciales y límites

Todo está en `shared/upgrades.ts`, en `UPGRADE_CATALOG`, `PROGRESSION` y `UPGRADE_LIMITS`.

| Límite | Valor |
|---|---|
| Intervalo mínimo / máximo entre disparos | 150 ms / 600 ms |
| Multiplicador de daño máximo | ×2 |
| Velocidad máxima de proyectil | 1000 px/s |
| Velocidad de movimiento máxima | ×1,2 |
| Proyectiles por ráfaga | 5 como máximo |
| **Suma de factores de daño por ráfaga** | 2 como máximo (un disparo normal = 1) |
| Radio de recogida máximo | 70 px |
| Capacidad máxima del escudo | 40 |
| Intervalo mínimo del dron / daño máximo | 800 ms / 12 |
| Proyectiles vivos en toda la partida | 400 (protección contra bucles de disparo) |
| Protección al elegir | 2 s como máximo; una vez cada 10 s como mucho |

**Reglas de combinación** (`computeLoadout`):

- Cadencia = 250 × (1,5 si hay munición pesada) × 0,85^nivel de acelerado, limitada a [150, 600].
- Patrón frontal: simple, doble o triple. Doble y triple no se combinan y la incompatibilidad se
  aplica al generar opciones. Los laterales se suman a cualquier patrón.
- Si la suma de factores de daño de la ráfaga supera 2, todos se reescalan por igual. Por ejemplo,
  Triple + Laterales = 1,5 + 0,8 = 2,3, y pasa a 2,0.
- Niveles manipulados o fuera de rango se recortan al máximo del catálogo, y los valores no
  numéricos vuelven al valor por defecto. Sin mejoras, el resultado es **exactamente el juego
  original**, y hay una prueba que lo comprueba.

## 4. Generación aleatoria y validación

- Las opciones se generan **en el servidor** (`server/src/game/UpgradeSystem.ts`): dos mejoras
  **distintas**, ponderadas por rareza (común 3, rara 2, épica 1) y sin reemplazo. Nunca se ofrecen
  mejoras al máximo o incompatibles con el equipamiento actual.
- La fuente aleatoria por defecto es criptográfica, así que el cliente no puede predecirla a partir
  de la semilla del mapa. Es **inyectable** (`upgradeRandom`) para pruebas deterministas.
- El cliente solo envía `{ milestone, upgradeId }`. Zod rechaza cualquier otro campo (por ejemplo,
  una lista de mejoras), hitos que no sean múltiplos de 10 y los identificadores desconocidos. El
  servidor comprueba además que haya una elección pendiente, que el hito coincida y que la mejora
  esté entre las ofrecidas.
- **Idempotencia:** repetir la misma elección ya confirmada (doble clic, acuse perdido,
  reconexión) devuelve el estado actual sin aplicarla de nuevo. Elegir otra mejora para un hito ya
  resuelto devuelve `YA_ELEGIDA`.

## 5. Interfaz

- Ventana compacta **«¡Mejora tu nave!»**: muestra el hito (y cuántos quedan en cola) y dos
  tarjetas con icono, nombre, categoría, rareza, nivel y descripción.
- Se elige con clic, con toque o con las teclas **1 / 2**. Durante la confirmación se muestra un
  indicador de espera y las tarjetas se desactivan. Los errores aparecen en el pie. Sin conexión,
  avisa de que la elección se conservará al reconectar.
- **No pausa la partida** ni bloquea los controles. En PC va abajo en el centro; en táctil, por
  encima del joystick y los botones, sin tapar la nave. «Más tarde» (o `Esc`) la pliega en el botón
  **«Mejora disponible (M)»**, y `M` la vuelve a abrir.
- HUD: barra **Mejora** con el progreso hacia el siguiente hito (`12/20`) e iconos de las mejoras
  activas con su nivel.
- **Protección al elegir:** al abrirse una elección, el servidor protege al jugador como máximo
  2 s. No se acumula, no se renueva antes de 10 s y termina al elegir, disparar o desconectarse.
  Los demás ven el anillo de protección y el texto «eligiendo mejora».

## 6. Sincronización y eventos WebSocket

| Evento | Dirección | Contenido |
|---|---|---|
| `game:upgrade:choose` **(nuevo)** | cliente → servidor | `{ milestone, upgradeId }`; acuse `{ ok, data: PlayerUpgradeView }` o error (`VALIDACION`, `SIN_ELECCION_PENDIENTE`, `HITO_INCORRECTO`, `MEJORA_NO_OFRECIDA`, `YA_ELEGIDA`, `PARTIDA_TERMINADA`, `SIN_PARTIDA`, `DEMASIADAS_PETICIONES`) |
| `game:upgrades` **(nuevo)** | servidor → **solo ese jugador** | progreso, siguiente hito, mejoras activas, elección pendiente, hitos en cola y valores efectivos |
| `game:start` (ampliado) | servidor → jugador | campo opcional `upgrades` con el estado privado del destinatario: restaura la elección pendiente al reconectar |
| `game:snapshot` (ampliado) | servidor → sala | solo lo visible: `shield`/`shieldMax`, ángulo del `drone`, `choosing` y el tipo de proyectil `k` (`'p'` pesado, `'d'` dron). Son campos opcionales y no se envían si no aplican |
| `game:event` (ampliado) | servidor → sala | `hit.absorbed` (daño absorbido por el escudo) y `fire.source: 'dron'` |

- El progreso y las opciones de un jugador **no se envían a los demás**.
- La elección usa el límite de frecuencia general de eventos (10/s) y la validación Zod.
- **Desconexión durante una elección:** la elección se conserva. La protección termina y no se
  reactiva al volver. Al reconectar, `game:start` incluye el estado y una elección ya confirmada no
  se vuelve a aplicar.
- **Fin de partida:** el estado de mejoras vive dentro de la partida (`GameServer`) y desaparece con
  ella. La siguiente partida empieza con progreso 0 y sin mejoras, y el cliente también lo reinicia.

## 7. Archivos

**Nuevos**

- `shared/upgrades.ts`: catálogo, progresión, límites y `computeLoadout`.
- `server/src/game/UpgradeSystem.ts`: progreso, hitos, generación, validación, idempotencia y vista privada.
- `client/src/game/UpgradePanel.ts`: ventana de selección, progreso e iconos del HUD.
- `tests/unit/upgrades.test.ts` (14 pruebas) y `tests/integration/upgrades.test.ts`.
- `docs/ACTUALIZACION_1.2.md` y las capturas `reports/evidencias/captura-mejora-*.png`.

**Modificados**

- `shared/protocol.ts`: tipos y eventos nuevos, y campos opcionales en las instantáneas.
- `server/src/game/GameServer.ts`: cadencia, patrón de disparo, daño, velocidad de bala,
  movimiento, escudo, dron, imán, progreso, protección de elección e instantáneas.
- `server/src/game/CombatSystem.ts`: `absorbWithShield`.
- `server/src/rooms/RoomManager.ts`: `chooseUpgrade` y notificación privada.
- `server/src/sockets/socketServer.ts`: evento `game:upgrade:choose` y envío privado de `game:upgrades`.
- `server/src/validation/schemas.ts`: `chooseUpgradeSchema`.
- `client/index.html` y `client/src/styles/main.css`: ventana, barra de progreso, iconos y ajustes del HUD táctil.
- `client/src/game/GameClient.ts`, `client/src/canvas/GameRenderer.ts` y `client/src/network/Interpolator.ts`:
  escudo, dron, tipos de proyectil y texto «eligiendo mejora».
- `client/src/network/SocketClient.ts`: `chooseUpgrade`.
- `client/src/main.ts`: guarda el evento del último error (`data-last-server-error-event`) para las pruebas E2E.
- `tests/e2e/canvas.spec.ts`: flujo 3 ampliado, sin añadir flujos nuevos.
- `tests/unit/{matchConfig,roomManager,returnToLobby}.test.ts`: el notificador de prueba incluye `upgrades`.

## 8. Pruebas

| Prueba | Cómo se ejecutó | Resultado |
|---|---|---|
| 14 unitarias nuevas (`tests/unit/upgrades.test.ts`), que cubren los 10 puntos pedidos más el progreso independiente de la puntuación, la ausencia de elecciones tras el final, la protección limitada y el límite global de proyectiles | sustituto local de Vitest | **14/14** |
| Las 82 unitarias anteriores (regresión) | ídem | **82/82** → total **96/96** en `reports/evidencias/pruebas-unitarias-local.txt` |
| Control de la propia prueba: se introdujo a propósito un error en el patrón de disparo | ídem | 2 pruebas fallaron como se esperaba; se restauró el código |
| Tipos de `shared/`, `server/`, `client/` y pruebas | `tsc` real con declaraciones provisionales para express, socket.io y pg | sin errores |
| Compilación del servidor y del cliente | `esbuild` real | correcta |
| Interfaz (escritorio 1366×820 y Pixel 7) | cliente real con servidor simulado en Chromium | ventana, elección con tecla 2 y con toque, indicador de espera, cierre, iconos, escudo, dron y proyectil pesado; sin errores de página |
| Integración `tests/integration/upgrades.test.ts` (estado privado, validación, idempotencia, reconexión, reinicio) | — | **escrita, sin ejecutar aquí** (necesita Express, Socket.IO y pg reales): `npm run test:integration` |
| E2E ampliado (`canvas.spec.ts`) | — | **sin ejecutar aquí**: `npm run test:e2e` |

Los puntos 1-10 pedidos para las pruebas corresponden a las pruebas con el mismo número en `upgrades.test.ts`.

## 9. Probar a mano

1. Sustituye los archivos (conserva `.env`). No hay dependencias nuevas ni migraciones:
   `npm run dev`.
2. Abre dos navegadores (o uno normal y otro en incógnito), crea una sala de 25 o 30 puntos y
   empezad la partida.
3. Recoge 5 fragmentos o consigue eliminaciones hasta llenar la barra **Mejora** (`10/10`). Se abre
   «¡Mejora tu nave!» y en el otro navegador aparece «eligiendo mejora» sobre tu nave durante un
   máximo de 2 s.
4. Elige con clic o con `1`/`2`. Comprueba el efecto real:
   - **Doble / Triple / Laterales:** salen 2, 3 o +2 proyectiles por disparo.
   - **Munición pesada:** proyectiles más grandes, 32 de daño a corta distancia (mira la barra de
     vida del rival) y disparo más lento.
   - **Escudo:** aparece un anillo azul; los primeros impactos no bajan la vida y, tras 4 s sin
     recibir daño, se recarga.
   - **Propulsores:** te mueves más rápido. **Imán:** recoges fragmentos desde más lejos.
   - **Dron:** un rombo orbita tu nave y dispara solo a un rival cercano y visible.
5. Pulsa «Más tarde» o `M` para plegar y recuperar la ventana; la partida no se detiene.
6. Con una elección abierta, recarga la página: al volver sigue pendiente y las mejoras ya elegidas
   se conservan sin duplicarse.
7. Termina la partida y empieza otra: la barra vuelve a `0/10` y no queda ninguna mejora.
8. En la consola del navegador, una elección inventada se rechaza:
   `__cybergrid.test.rawEmit('game:upgrade:choose', { milestone: 10, upgradeId: 'dron_apoyo', options: ['todas'] })`
   (el servidor responde `EVENTO_INVALIDO`).

Para ajustar el equilibrio, cambia los valores de `shared/upgrades.ts` y reinicia el servidor.
