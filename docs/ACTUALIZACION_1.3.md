# Actualización 1.3 — Habilidades, armas y sinergias

Amplía el sistema de mejoras de la versión 1.2 **sin eliminar, renombrar ni cambiar** ninguna de
las diez mejoras originales. Las ocho habilidades nuevas se añaden al mismo catálogo y usan el
mismo sistema de hitos y de dos opciones aleatorias. El servidor sigue siendo la única autoridad.

## 0. Lo que se encontró al revisar el código

| Punto del enunciado | Estado previo | Decisión |
|---|---|---|
| Catálogo de mejoras | 10 mejoras en `shared/upgrades.ts` | Se conservan tal cual; se añaden 8 entradas. |
| Aplicación de efectos | `computeLoadout()` (compartido) + `GameServer` | Se amplía `computeLoadout` y el daño se centraliza en `GameServer.dealDamage`. |
| Disparos, proyectiles, colisiones, daño y escudos | `GameServer`, `CollisionSystem`, `CombatSystem` | Se reutilizan. Nuevo `raycastSolidHit` (con normal de pared) para los rebotes. |
| Dos opciones aleatorias | `UpgradeSystem.rollUpgradeOptions` | Sin cambios; solo se amplía la regla de qué se puede ofrecer. |
| Sincronización | `game:upgrades` privado + `game:snapshot`/`game:event` | Se amplían con campos y eventos opcionales. |
| **Sistema de Sobrecarga** | **No existía** (ni código ni catálogo) | Se crea **una sola vez** como mejora nueva. No hay duplicados. |
| Habilidades activas | No existían | Se integran en el canal de entradas existente (`game:input`), igual que el impulso. |
| Sistema de sonido | No existe | No se añaden sonidos; los efectos son visuales. |

## 1. Habilidades nuevas

| Id | Nombre | Tipo | Efecto real en el servidor |
|---|---|---|---|
| `bala_rebotadora` | Bala rebotadora | Pasiva | La bala **central** (ángulo 0) rebota hasta **2 veces**, reflejándose según la normal de la pared. Un rebote por contacto: el proyectil se detiene ese paso justo fuera de la pared. Conserva su alcance total (650 px) y no crea balas nuevas. |
| `rayo_perforante` | Rayo perforante | **Arma** | **Sustituye al disparo normal** (ver §2). |
| `satelites` | Satélites protectores | Pasiva | **2 satélites** (nivel 2: 3; máximo 3) orbitan a 36 px en sentido contrario al dron. Interceptan balas, fragmentos, disparos del dron y rayos enemigos. Cada uno bloquea **20 de daño**; al agotarse se rompe y se recupera en **8 s** (o al reaparecer). El proyectil desaparece al bloquearse, así que no puede bloquearse dos veces. La hitbox de la nave no cambia. |
| `teletransporte` | Teletransporte corto | **Activa (E)** | Salto instantáneo de hasta **160 px** hacia donde apuntas. Recarga de **5 s**. No atraviesa paredes ni termina dentro de obstáculos o fuera del mapa: se detiene en la posición segura justo antes del obstáculo y, si avanzaría menos de 24 px, se cancela sin gastar la recarga. |
| `municion_corrosiva` | Munición corrosiva | Pasiva | Tras el daño del impacto: **3 de daño cada 0,5 s durante 3 s** (máximo 18 por aplicación). Un nuevo impacto **renueva la duración** sin sumar daño. Termina con su duración, al morir el objetivo o al acabar la partida. No se aplica al rayo (no es compatible). |
| `sobrecarga` | Sobrecarga | **Activa (Q)** | **+30 % de daño** del arma equipada durante **4 s**. Recarga de **15 s** desde la activación. No se acumula ni se reactiva mientras está en recarga. Termina al morir. |
| `cadena_electrica` | Cadena eléctrica | Pasiva | Al impactar, un arco salta al enemigo visible más cercano (radio 170 px) y desde él a otro: **2 saltos** con **50 % y 30 %** del daño inicial. Nunca repite objetivo ni vuelve al atacante. Como mucho 12 cadenas por paso en toda la partida. |
| `bala_fragmentada` | Bala fragmentada | Pasiva | Al impactar, la bala se divide en **3 fragmentos** (−30°, 0°, +30°) con el **35 %** del daño, alcance de **160 px** y daño fijo. No golpean al objetivo original, **no se vuelven a dividir** y no rebotan. Máximo 90 fragmentos activos. |

Mejoras exclusivas de las balas (las seis de disparo originales, Rebotadora, Fragmentada y
Corrosiva): **no se ofrecen con el rayo equipado**, porque serían opciones inútiles. Las que ya se
tenían se conservan.

## 2. Rayo perforante

- **Arma alternativa:** mientras está equipado, la nave **no dispara balas**. Mantener el clic (o
  «Disparar») lanza un rayo instantáneo de **520 px** que se detiene en la primera pared.
- **Atraviesa** hasta **4 enemigos**. Cada uno recibe daño **una sola vez por disparo** (lista
  ordenada por distancia, sin repeticiones).
- **Daño 30** (con la racha de eliminaciones, máximo 48 en total), sin caída por distancia.
- **Recarga propia de 0,5 s**, validada en el servidor. Disparo acelerado, Munición pesada y
  Proyectiles veloces **no la modifican**. Doble cañón, Triple disparo y Cañones laterales no crean
  balas mientras el rayo está activo.
- **El arma de balas no se borra:** su configuración sigue calculada en el equipamiento. Las
  mejoras de una partida duran toda la partida, así que el rayo sigue equipado hasta el final y en
  la siguiente vuelves a empezar con balas.
- Un satélite del objetivo situado en la trayectoria absorbe el rayo destinado a él.
- **Visual:** haz luminoso con núcleo blanco, más ancho y dorado con Rayo sobrecargado. La nave
  muestra un emisor alargado. **Indicador de recarga** «Rayo» en la barra de habilidades (y sobre
  el botón «Disparar» en táctil).
- **Sobrecarga:** daño ×1,3, o ×1,4 con la sinergia (los dos se poseen a la vez, así que siempre
  aplica). No lo convierte en proyectiles.

## 3. Sinergias

Catálogo central en `shared/synergies.ts`: id, nombre, descripción, mejoras requeridas, condición,
efecto, parámetros y efecto visual. Se activan solas al tener las dos mejoras: no añaden ninguna
elección y no dan puntos.

| # | Sinergia | Requiere | Condición | Efecto real |
|---|---|---|---|---|
| 1 | Tormenta de rebotes | Rebotadora + Triple | siempre | Rebotan las 3 balas del abanico, cada una con su contador (sin la sinergia, solo la central). |
| 2 | Rayo sobrecargado | Rayo + Sobrecarga | Sobrecarga activa | Rayo ×1,4 (en vez de ×1,3), con el máximo de 48; haz dorado más intenso. |
| 3 | Defensa orbital | Satélites + Escudo | escudo con carga | +6 de capacidad por satélite (26). Lo que bloquea un satélite no llega al escudo. |
| 4 | Cañón corrosivo | Corrosiva + Pesada | siempre | La munición pesada corroe con 4 por pulso (máx. 5) y mantiene su cadencia de 375 ms. |
| 5 | Cadena de fragmentos | Fragmentada + Cadena | siempre | Cada fragmento encadena 1 salto; los fragmentos de una bala comparten un límite de 2 saltos. |
| 6 | Cadena perforante | Rayo + Cadena | siempre | **Una** cadena por disparo desde el primer enemigo dañado, sin volver a dañar a los atravesados. |
| 7 | Cazador de energía | Teletransporte + Sobrecarga | tras teletransportarse | +10 % de daño durante 1,5 s, solo si la Sobrecarga está lista. No toca su duración ni su recarga. |
| 8 | Fragmentación eléctrica | Fragmentada + Sobrecarga | Sobrecarga activa | Los fragmentos heredan **una vez** la Sobrecarga de su bala (9 en vez de 7) y se ven eléctricos. |
| 9 | Escudo reactivo | Satélites + Teletransporte | tras teletransportarse | La órbita pasa de 36 a 50 px durante 1,2 s. No crea satélites ni da invulnerabilidad. |
| 10 | Reacción corrosiva | Corrosiva + Cadena | objetivo con corrosión | El salto desde un enemigo con corrosión primaria contagia una corrosión de 2 por pulso durante 1,5 s, a 2 objetivos por cadena como máximo. La contagiada **no se vuelve a contagiar**. |

**Sin ciclos:**
- Los fragmentos no se dividen.
- Las cadenas no lanzan otras cadenas.
- La corrosión contagiada no se propaga.
- Los multiplicadores de daño se aplican una sola vez, en el momento del disparo.
- Hay límites globales de proyectiles (400), fragmentos (90) y cadenas por paso (12).

El cliente recibe la lista de sinergias en su estado privado, y los efectos visibles por la
instantánea.

## 4. Parámetros iniciales y límites

Todo está en `shared/upgrades.ts` (`UPGRADE_CATALOG`, `UPGRADE_LIMITS`) y en `shared/synergies.ts`.

| Parámetro | Valor inicial | Límite |
|---|---|---|
| Rebotes | 2 | 3 |
| Rayo: daño / recarga / alcance / objetivos | 30 / 500 ms / 520 px / 4 | 48 / ≥400 ms / 650 px / 4 |
| Satélites: número / capacidad / recuperación | 2 (3 en nivel 2) / 20 / 8 s | 3 / 40 |
| Teletransporte: distancia / recarga | 160 px / 5 s | 220 px / ≥3 s |
| Corrosión: pulso / cada / duración | 3 / 500 ms / 3 s | 5 / ≥250 ms / 4 s |
| Sobrecarga: daño / duración / recarga | ×1,3 / 4 s / 15 s | ×1,5 / 6 s / ≥8 s |
| Cadena: saltos / radio / factores | 2 / 170 px / 50 % y 30 % | 3 saltos; 12 cadenas por paso |
| Fragmentos: número / daño / alcance | 3 / 35 % / 160 px | 5 por división; 90 activos |
| Daño de bala con todos los multiplicadores | — | ×2 sobre el daño base (40), antes de la racha |

## 5. Interfaz

- **Teclas:** `E` para el teletransporte y `Q` para la sobrecarga. En táctil aparecen los botones
  «Salto» y «Carga» encima de «Disparar», solo si tienes esas habilidades.
- **Barra de habilidades** (abajo en el centro, en PC): Rayo, Teletransporte y Sobrecarga, con
  recarga o «Activa x s». En táctil, el progreso se dibuja sobre cada botón.
- **Tarjetas de mejora:** etiqueta «Activa · E/Q» o «Arma», y aviso «⚡ Sinergia: …» si esa opción
  completaría una sinergia.
- **HUD:** chips con las sinergias activas (en móvil, un chip compacto «⚡ n» con los nombres en la
  ayuda) y aviso «Sinergia activada: …».
- **Efectos:**
  - Haz del rayo y arcos eléctricos quebrados (verdes si contagian corrosión).
  - Burbujas ácidas verdes sobre la nave corroída.
  - Anillo dorado pulsante con Sobrecarga.
  - Anillos y partículas al teletransportarse.
  - Chispas al rebotar.
  - Fragmentos pequeños (amarillos si son eléctricos).
  - Satélites como **placas blindadas** con contorno luminoso azul, que se ven discontinuas
    mientras están rotos. Es un dibujo distinto del rombo relleno del dron.
- Los efectos son solo visuales y tienen un máximo de 48 por tipo, así que no se acumulan.

## 6. Protocolo

- `game:input`: campos opcionales `tp` y `ov` (booleanos, validados con Zod). Se activan en el
  flanco de subida y el servidor comprueba propiedad y recarga.
- `game:snapshot` (todos):
  - `wpn`: rayo equipado.
  - `ov`, `hunt`: Sobrecarga y Cazador de energía.
  - `cor`: corrosión.
  - `sats`, `satA`, `satR`: carga de cada satélite, ángulo y radio de la órbita.
  - `tp`: contador de saltos; el cliente no interpola entre posiciones de saltos distintos.
  - `k` del proyectil: `f`, `e`, `c` o `b`.
- `game:event` (todos): `beam`, `chain`, `bounce`, `teleport`, `overload`, `block`, `satellite`,
  `fragment`; `hit.dot` marca el daño de corrosión.
- `game:upgrades` (privado): `synergies` y `abilities` (recargas y duración en hora del servidor).
  Las recargas no se difunden a los demás.

## 7. Archivos

**Nuevos:**
- `shared/synergies.ts`
- `server/src/game/Abilities.ts` (teletransporte, selección de cadena, órbitas, corrosión)
- `tests/unit/abilities.test.ts` (32 pruebas)
- `docs/ACTUALIZACION_1.3.md`
- Capturas `reports/evidencias/captura-habilidades-*.png`

**Modificados:**
- `shared/upgrades.ts`: 8 entradas, tipos, límites y equipamiento ampliado. Las 10 originales solo
  ganan los campos `type` y `requiresWeapon`.
- `shared/protocol.ts`
- `server/src/game/GameServer.ts`: rayo, rebotes, satélites, habilidades activas, corrosión,
  cadena, fragmentos, daño centralizado y limpieza.
- `server/src/game/CollisionSystem.ts`: `raycastSolidHit`; `raycastSolid` mantiene su contrato.
- `server/src/game/UpgradeSystem.ts`
- `server/src/validation/schemas.ts`
- Cliente: `client/src/controls/{InputState,KeyboardControls,TouchControls}.ts`,
  `client/src/game/{GameClient,UpgradePanel}.ts`, `client/src/canvas/GameRenderer.ts`,
  `client/src/network/Interpolator.ts`, `client/index.html` y `client/src/styles/main.css`.
- `tests/unit/upgrades.test.ts`: la prueba 1 ahora comprueba que siguen las 10 originales
  dentro de las 18.
- `tests/integration/upgrades.test.ts`: caso nuevo de sincronización y validación.

En `client/index.html` el párrafo de la portada se igualó al texto que tienes en tu copia, con el
botón «Iniciar sesión», para que al sustituir el archivo no pierdas esos cambios.

## 8. Pruebas

| Prueba | Cómo | Resultado |
|---|---|---|
| 32 unitarias nuevas (`abilities.test.ts`): los 17 puntos pedidos, con una prueba por sinergia | sustituto local de Vitest | **32/32** |
| Todas las unitarias (regresión de salas, lobby, puntuación, mejoras 1.2, avatares…) | ídem | **128/128** en 15 archivos → `reports/evidencias/pruebas-unitarias-local.txt` |
| Control de las propias pruebas: se introdujeron tres errores a propósito (fragmentos que se dividen, cadena que repite objetivo, rayo sin recarga) | ídem | fallaron 1, 2 y 2 pruebas respectivamente; código restaurado |
| Tipos de servidor, cliente y pruebas | `tsc` real con declaraciones provisionales para express, socket.io y pg | sin errores |
| Compilación | `esbuild` real (servidor y cliente) | correcta |
| Interfaz (1366×820 y Pixel 7) | cliente real con servidor simulado | sin errores de página; capturas en `reports/evidencias/` |
| Integración: caso nuevo de sincronización entre jugadores y rechazo de entradas manipuladas | — | **escrita, sin ejecutar aquí** (`npm run test:integration`) |
| E2E | — | sin ejecutar aquí (`npm run test:e2e`) |

## 9. Probar cada habilidad en una partida multijugador

Prepara dos navegadores (o uno normal y otro en incógnito), crea una sala de 30 puntos y
empezad. Llena la barra **Mejora** recogiendo fragmentos o eliminando, y elige la habilidad
cuando aparezca. Las opciones son aleatorias: si no sale, sigue avanzando hitos.

| Habilidad | Qué hacer y qué comprobar |
|---|---|
| Bala rebotadora | Dispara en diagonal contra una pared: la bala rebota 2 veces con una chispa y luego desaparece. |
| Rayo perforante | Mantén el clic: ya no salen balas; aparece un haz cada 0,5 s («Rayo» en la barra). Coloca a dos rivales en línea: ambos pierden vida con un solo disparo. |
| Satélites | Dos placas azules giran alrededor de tu nave. Que el otro jugador te dispare: algunas balas se detienen en ellas; tras 20 de daño una se rompe (contorno discontinuo) y vuelve a los 8 s. |
| Teletransporte | Pulsa `E` (o «Salto»): apareces 160 px más allá sin recorrer el camino; contra una pared te quedas justo delante. Recarga de 5 s en la barra. El otro navegador ve el salto. |
| Munición corrosiva | Acierta una bala: el rival muestra burbujas verdes y pierde 3 de vida cada medio segundo durante 3 s. |
| Sobrecarga | Pulsa `Q` (o «Carga»): anillo dorado, «Activa 4,0 s» y +30 % de daño; luego 15 s de recarga. |
| Cadena eléctrica | Con dos o tres rivales cerca entre sí, acierta a uno: un arco salta a los demás con menos daño. |
| Bala fragmentada | Acierta a un rival: la bala se divide en tres fragmentos que pueden alcanzar a otro detrás. |
| Sinergias | Al reunir dos mejoras compatibles aparece «Sinergia activada: …» y el chip en el HUD. Las tarjetas avisan antes de elegir («⚡ Sinergia: …»). |

Para ajustar el equilibrio, cambia los valores de `shared/upgrades.ts` o de `shared/synergies.ts` y
reinicia el servidor.

## 10. Corrección 1.3.2 — reinicio completo entre partidas

**Síntoma:** al empezar una partida nueva seguían en pantalla las habilidades de la anterior (por
ejemplo «Rayo» y «Sobrecarga 8.9 s» con «Mejora 0/10» y sin iconos de mejoras).

### Causa raíz (verificada)

1. **Cliente (lo que se veía).** Al empezar una partida, la barra de habilidades se «reiniciaba»
   con la clave vacía `''`. Si la partida nueva no tenía habilidades, la clave calculada también
   era `''`, así que el código creía que nada había cambiado y conservaba en el DOM los elementos
   de la partida anterior, congelados. También quedaban visibles los botones táctiles «Salto» y
   «Carga». Se reprodujo con el cliente de la v1.3.1: la barra seguía mostrando Rayo,
   Teletransporte y Sobrecarga.
2. **Cliente (latente).** Un estado privado (`game:upgrades`) que llegara tarde de la partida
   anterior se aplicaba a la nueva. Con el cliente v1.3.1 volvían a aparecer 6 mejoras y «82/90».
3. **Servidor (ventana real).** Mientras se guarda el resultado en la base de datos, la partida
   terminada seguía enlazada a la sala. Una reconexión, un regreso o una unión en ese intervalo
   recibía `game:start` de la partida **terminada**, con sus mejoras.

Lo que **no** estaba mal: el estado de juego del servidor ya se creaba de cero en cada partida
(un `GameServer` nuevo), y las habilidades no usan temporizadores propios, sino el reloj de
simulación de cada partida. Aun así se reforzó, como se describe abajo.

### Qué es permanente y qué es de la partida

- **Permanente** (cuenta del jugador): id, nombre, imagen personalizada y estadísticas guardadas.
- **De la partida** (se crea de cero cada vez):
  - Estado de la nave: vida, energía, posición, protección y estadísticas de la partida.
  - Mejoras: progreso e hitos, mejoras y niveles, sinergias.
  - Equipamiento: arma, cadencia, daño, velocidad, rebotes, fragmentación y munición especial.
  - Defensa: escudo, satélites y dron.
  - Habilidades y efectos: teletransporte y su recarga, rayo y su recarga, Sobrecarga y su
    recarga, Cazador de energía, Escudo reactivo y corrosión.
  - Entidades: proyectiles y fragmentos.
- **No existen en el proyecto** (no hay nada que reiniciar): cuchillas orbitales, pulso de
  repulsión, reparación gradual, señuelos holográficos y campos de energía.

### Cambios

| Archivo | Cambio |
|---|---|
| `server/src/game/GameServer.ts` | `createInitialPlayerState()`: **función única** que fija explícitamente todos los valores iniciales de la tabla anterior. `dispose()`: detiene el bucle y elimina proyectiles, fragmentos, satélites, corrosión, Sobrecarga, Cazador, protección y entradas; después la partida no acepta entradas, elecciones ni pasos. `matchId` en instantáneas y estado privado. |
| `server/src/rooms/RoomManager.ts` | Los callbacks de una partida solo emiten si es **la partida actual de su sala** (los de una partida anterior u otra sala se descartan). La partida se libera (`dispose`) al terminar, al cerrarse la sala y al apagar el servidor. Nunca hay dos partidas por sala. Nuevo `activeGame(room)`: devuelve null si la partida ya terminó, aunque se esté guardando. |
| `server/src/sockets/socketServer.ts` | Reconexión, `room:return` y `room:join` usan `activeGame`: nunca reenvían una partida terminada. |
| `shared/protocol.ts` | `matchId` opcional en `GameSnapshot` y `PlayerUpgradeView`. |
| `client/src/game/GameClient.ts` | `resetAbilityHud()`: vacía de verdad la barra de habilidades (DOM y estado), oculta «Salto» y «Carga» y quita la recarga del botón «Disparar», al empezar y al terminar cada partida. Descarta instantáneas y estados privados de otra partida. Limpia también los efectos visuales al terminar. |

### Pruebas

- `tests/unit/matchLifecycle.test.ts`: 8 pruebas con el gestor de salas y partidas reales que
  cubren los 14 escenarios pedidos. Los escenarios 2 a 8 se agrupan en una sola partida
  «cargada» (rayo, Sobrecarga activa, satélites, dron, escudo, teletransporte en recarga,
  sinergias, corrosión activa y proyectiles en vuelo).
  - Resultado: **8/8**.
  - Control de las propias pruebas: se quitó a propósito cada protección por separado (reenviar
    la partida terminada, aceptar callbacks antiguos, no liberar la partida) y fallaron 1, 1 y 2
    pruebas.
- Suite unitaria completa: **136/136** en 16 archivos (`reports/evidencias/pruebas-unitarias-local.txt`).
- Interfaz (`reports/evidencias/interfaz-reinicio-partida.txt`): cliente real con servidor
  simulado, en escritorio y Pixel 7. Partida 1 con Rayo, Teletransporte y Sobrecarga → fin →
  partida 2: barra vacía y oculta, botones táctiles ocultos, 0 iconos, «0/10». Un estado tardío
  de la partida 1 se ignora.
- Integración (`tests/integration/upgrades.test.ts`, caso «ciclo de vida»): reconectar tras el
  final no recibe la partida terminada, y la siguiente empieza de cero. **Escrita, sin ejecutar
  aquí**: `npm run test:integration`.
