# CyberGrid: Breach & Sync

Arena multijugador cyberpunk en tiempo real para navegador. Vista cenital, mapas procedurales con
semilla, combate con proyectiles y un servidor que es la **única autoridad** sobre posiciones,
colisiones, daño, vida, recursos, puntuación y resultados.

- **Cliente:** HTML5, Canvas 2D, TypeScript y CSS, sin motor de videojuegos.
- **Servidor:** Node.js 22, TypeScript, Express 5, Socket.IO 4, Zod, PostgreSQL.
- **Pruebas:** Vitest (unitarias + integración) y Playwright (3 flujos E2E).
- **CI/CD:** GitHub Actions. **Despliegue:** Render (blueprint incluido) o Railway.

> **Versión 1.1:** personalización del personaje con imagen propia, puntuación para ganar de 15,
> 25 o 30 puntos y corrección del regreso al lobby. Detalle, causa del error y pruebas en
> **[docs/ACTUALIZACION_1.1.md](docs/ACTUALIZACION_1.1.md)**.

> **Versión 1.2:** mejoras aleatorias de nave durante la partida. Cada 10 puntos de progreso
> eliges una de dos mejoras generadas por el servidor, entre un catálogo de diez. Las
> mejoras, el equilibrio, los eventos, las pruebas y cómo probarlo están en
> **[docs/ACTUALIZACION_1.2.md](docs/ACTUALIZACION_1.2.md)**.

> **Versión 1.3:** ocho habilidades nuevas (Bala rebotadora, Rayo perforante, Satélites protectores,
> Teletransporte, Munición corrosiva, Sobrecarga, Cadena eléctrica y Bala fragmentada) y diez
> sinergias, sin quitar ninguna mejora anterior. Detalles, parámetros y pruebas en
> **[docs/ACTUALIZACION_1.3.md](docs/ACTUALIZACION_1.3.md)**.

> Estado de verificación: consulta [Estado de la entrega](#estado-de-la-entrega) y
> [docs/MATRIZ_REQUISITOS.md](docs/MATRIZ_REQUISITOS.md). Nada se marca como cumplido sin
> evidencia; lo que falta por ejecutar está indicado.

---

## Índice

1. [El juego](#el-juego)
2. [Tecnologías y arquitectura](#tecnologías-y-arquitectura)
3. [Requisitos previos](#requisitos-previos)
4. [Instalación](#instalación)
5. [Variables de entorno](#variables-de-entorno)
6. [Base de datos](#base-de-datos)
7. [Ejecutar en local](#ejecutar-en-local)
8. [Probar el multijugador](#probar-el-multijugador)
9. [Controles](#controles)
10. [Reglas y fórmulas](#reglas-y-fórmulas)
11. [API REST](#api-rest)
12. [Eventos WebSocket](#eventos-websocket)
13. [Seguridad](#seguridad)
14. [Pruebas](#pruebas)
15. [Mediciones de rendimiento](#mediciones-de-rendimiento)
16. [CI/CD con GitHub Actions](#cicd-con-github-actions)
17. [Despliegue público](#despliegue-público)
18. [Solución de errores frecuentes](#solución-de-errores-frecuentes)
19. [Lista de verificación para la evaluación](#lista-de-verificación-para-la-evaluación)
20. [Estado de la entrega](#estado-de-la-entrega)

---

## El juego

Cada jugador controla una unidad robótica hexagonal en una arena digital, con la imagen que haya
elegido en **Personalizar personaje**. El objetivo es llegar antes que nadie a la **puntuación para
ganar** de la sala o tener más puntos cuando se acaba el tiempo:

| Puntuación para ganar | Tipo | Tiempo máximo (base 180 s) |
|---|---|---|
| 30 puntos (por defecto) | Partida estándar | 6:00 |
| 40 puntos | Partida extendida | 8:00 |
| 50 puntos | Partida larga | 10:00 |

Fórmula: `duración = MATCH_DURATION_S × objetivo / 15`. Conserva el ritmo original de 15 puntos
cada 3 minutos.

**Cambiar las puntuaciones:** edita `SCORE_TARGETS`, `DEFAULT_SCORE_TARGET` y
`SCORE_TARGET_LABELS` en `shared/matchConfig.ts`. La validación, el selector de «Crear sala», los
mensajes y la portada se generan a partir de ahí. Además, añade una migración que permita los
valores nuevos en `matches.score_to_win`; la migración 3 de `server/src/database/migrations.ts`
sirve de ejemplo. Para partidas más cortas o más largas, cambia `PACE_REFERENCE_SCORE` (mismo
archivo) o `MATCH_DURATION_S`.

- **Eliminar** a otro jugador: +3 puntos.
- **Fragmento de datos** (recurso recolectable, rombo verde): +1 punto, +25 de energía, +10 de vida.
- **Impulso** (acción secundaria): gasta 35 de energía y multiplica la velocidad ×2,6 durante 180 ms.
- Tras ser eliminado reapareces a los 3 s en la posición inicial más alejada de tus rivales, con
  1 s de protección.
- Muros (azul) y coberturas (violeta con trama) bloquean el movimiento y los disparos.

Pantallas: inicio (con vista previa de una arena real generada por semilla), acceso y registro,
lobby (salas, creación, sala actual, historial y clasificación), personalizar personaje, sala
(miembros con su imagen, estados, listo, objetivo y tiempo), partida (Canvas + HUD con vida,
energía, fragmentos, `puntos / objetivo`, tiempo restante, estado, marcador, FPS, ping y tick) y
resultados (con «Volver al lobby de la sala» y «Salir al lobby general»).

## Tecnologías y arquitectura

Arquitectura cliente-servidor **server-authoritative**. El cliente envía solo *intenciones*
(`moveX`, `moveY` ∈ [-1, 1], ángulo, disparar, impulso) a 30 Hz; el servidor simula a 30 Hz con
paso fijo y emite instantáneas que el cliente interpola.

Detalle completo, diagrama, dependencias y estructura de carpetas en
**[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**.

```text
client/   Cliente (Canvas 2D, controles, pantallas, red)
server/   Express + Socket.IO + PostgreSQL (simulación autoritativa)
shared/   Protocolo tipado, constantes, generador de mapas, fórmulas
tests/    unit/ · integration/ · e2e/
scripts/  build, dev, mediciones y verificación de informes
```

## Requisitos previos

| Herramienta | Versión |
|---|---|
| Node.js | 22 o superior (incluye npm 10) |
| PostgreSQL | 14 o superior (probado con 16) |
| Git | cualquiera reciente |
| Navegador | Chrome, Edge, Firefox o Safari actuales |

Si no tienes PostgreSQL instalado puedes usar Docker (ver [Base de datos](#base-de-datos)).

## Instalación

```bash
git clone https://github.com/TU_USUARIO/cybergrid-breach-sync.git
cd cybergrid-breach-sync
npm install                 # instala todos los workspaces y genera package-lock.json
npx playwright install chromium   # navegador para las pruebas E2E
```

> **Importante:** sube `package-lock.json` al repositorio. GitHub Actions usa `npm ci`, que exige
> ese archivo para instalar exactamente las mismas versiones.

## Variables de entorno

```bash
cp .env.example .env
```

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `DATABASE_URL` | sí | — | Conexión a PostgreSQL |
| `NODE_ENV` | no | `development` | `development`, `test` o `production` |
| `PORT` / `HOST` | no | `3000` / `0.0.0.0` | Escucha HTTP + WebSocket |
| `DATABASE_SSL` | no | `false` | `true` si el proveedor exige SSL desde fuera de su red |
| `TEST_DATABASE_URL` | para pruebas | — | Base de datos aislada para Vitest y Playwright |
| `SESSION_TTL_HOURS` | no | `168` | Duración de la sesión |
| `CORS_ORIGINS` | no | vacío | Orígenes permitidos si el cliente está en otro dominio |
| `TRUST_PROXY` | no | `1` en producción | Saltos de proxy de confianza |
| `ENABLE_TEST_ENDPOINTS` | no | `true` fuera de producción | Activa `/api/test/*` |
| `TEST_API_KEY` | en producción | — | Clave para `POST /api/test/seed` (≥ 16 caracteres) |
| `MATCH_DURATION_S` | no | `180` | Ritmo: segundos por cada 15 puntos (30 pts → 6:00, 40 → 8:00, 50 → 10:00) |
| `AVATAR_MAX_BYTES` | no | `2097152` | Tamaño máximo de la imagen del personaje (2 MB) |
| `AVATAR_MAX_DIMENSION` | no | `4096` | Ancho/alto máximo de la imagen original (px) |
| `SERVE_CLIENT` | no | `true` | El servidor sirve `client/dist` |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `PUBLIC_SERVER_URL` | no | vacío | Solo al compilar el cliente para otro dominio |

La configuración se valida con Zod al arrancar: si falta algo, el servidor se detiene con un
mensaje claro.

## Base de datos

**Opción A — PostgreSQL instalado:**

```bash
psql -U postgres -c "CREATE USER cybergrid WITH PASSWORD 'cybergrid';"
psql -U postgres -c "CREATE DATABASE cybergrid OWNER cybergrid;"
psql -U postgres -c "CREATE DATABASE cybergrid_test OWNER cybergrid;"
```

**Opción B — Docker:**

```bash
docker run -d --name cybergrid-pg -p 5432:5432 \
  -e POSTGRES_USER=cybergrid -e POSTGRES_PASSWORD=cybergrid -e POSTGRES_DB=cybergrid postgres:16
docker exec cybergrid-pg psql -U cybergrid -c "CREATE DATABASE cybergrid_test;"
```

**Migraciones** (se aplican también automáticamente al arrancar el servidor; son idempotentes y
usan un bloqueo consultivo para que dos instancias no migren a la vez):

```bash
npm run db:migrate
```

Tablas: `users`, `sessions`, `matches` (incluye `score_to_win` y `time_limit_ms` desde la
migración 2), `match_players`, `seed_batches`, `user_avatars` (migración 2) y `schema_migrations`.
Si ya tenías la base de datos de la versión anterior, la migración 2 se aplica sola al arrancar;
las partidas antiguas quedan registradas con 15 puntos. La migración 3 permite 30, 40 y 50 (y
conserva 15 y 25 para las partidas ya guardadas).

## Ejecutar en local

**Desarrollo** (cliente en modo vigilancia + servidor con recarga):

```bash
npm run dev
# abre http://localhost:3000
```

**Producción en local:**

```bash
npm run build      # client/dist y server/dist
npm start          # node server/dist/index.js (lee .env si existe)
```

Comprobación rápida:

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","database":"ok","uptimeS":4,"activeRooms":0,"serverTime":1793...}
```

## Probar el multijugador

1. Abre `http://localhost:3000` en una ventana normal y otra **de incógnito** (o en dos
   navegadores): cada una tiene su propia sesión.
2. Crea una cuenta en cada ventana (**Crear cuenta**).
3. En la primera, **Crear sala** (marca «Sala privada» y escribe un código si quieres probar la
   protección).
4. En la segunda, la sala aparece en **Salas abiertas** sin recargar: pulsa **Unirse** (con código
   si es privada).
5. Pulsa **Estoy listo** en ambas. Tras 3 s empieza la partida.
6. Desde un móvil en la misma red: `http://IP-DE-TU-PC:3000` (verás los controles táctiles).

## Controles

| Acción | PC | Móvil / tableta |
|---|---|---|
| Moverse | `W A S D` o flechas | Joystick virtual (abajo a la izquierda), admite diagonales |
| Apuntar | Ratón | Dirección del joystick |
| Disparar | Clic izquierdo (mantener = disparo continuo) | Botón «Disparar» (abajo a la derecha) |
| Impulso | `Mayús` o `Espacio` | Botón «Impulso» |
| Elegir mejora | Clic en la tarjeta o teclas `1` / `2` | Toque en la tarjeta |
| Plegar / abrir la elección | «Más tarde», `Esc` / `M` | «Más tarde» / botón «Mejora disponible» |
| Teletransporte (si lo tienes) | `E` | Botón «Salto» |
| Sobrecarga (si la tienes) | `Q` | Botón «Carga» |

- En PC no se muestran los controles táctiles; en dispositivos táctiles sí (detección por
  `pointer: coarse`). Se puede forzar con `?touch=1` o `?touch=0` en la URL.
- El joystick captura el puntero: si el dedo sale de su área se conserva el control hasta
  levantarlo. `touch-action: none` evita el desplazamiento y el zoom de la página.
  `pointercancel` devuelve el joystick al centro.

## Reglas y fórmulas

Todas se calculan en el servidor (`server/src/game/`, `shared/stats.ts`).

**Movimiento.** Velocidad máxima 220 px/s. La intención se normaliza a magnitud ≤ 1 (la diagonal
no es más rápida). Colisión contra el mapa eje por eje (deslizamiento por las paredes) y
separación entre jugadores.

**Daño.**

```
daño = round( 20 × caída(d) × (1 + min(racha × 0,10 ; 0,30)) )
caída(d) = 1                                        si d ≤ 200 px
         = 1 − 0,5 × (d − 200) / (650 − 200)        si 200 < d ≤ 650 px (alcance máximo)
```

20 de daño a corta distancia, 10 en el alcance máximo y hasta 26 con una racha de 3 eliminaciones.
Cadencia mínima 250 ms; proyectiles a 700 px/s comprobados contra muros (recorrido DDA de la
rejilla) y jugadores (segmento contra círculo).

**Estadísticas** (idénticas en la partida y en la telemetría):

| Métrica | Fórmula | Unidad |
|---|---|---|
| Win Rate | `100 × victorias / participaciones` (0 si no hay) | % |
| KDR | `eliminaciones / max(muertes, 1)`; sin muertes, KDR = eliminaciones | razón |
| Supervivencia | tiempo vivo por jugador y partida (excluye la espera de reaparición) | ms |
| Tasa de supervivencia | `min(tiempo vivo / duración, 1) × 100` | % |
| Vida más larga | mayor intervalo continuo vivo | ms |

Clasificación: puntos, luego eliminaciones, menos muertes, más supervivencia y orden de ingreso.

**Mapas procedurales.** `shared/MapGenerator.ts` usa un PRNG con semilla (mulberry32): la misma
semilla genera siempre el mismo mapa. Garantías comprobadas en cada generación y en las pruebas:
borde sólido, todas las zonas transitables conectadas (las bolsas aisladas se rellenan),
≥ 55 % de superficie transitable, 8 posiciones iniciales con una celda libre alrededor y
separadas entre sí. Las estructuras son simétricas respecto al centro para que la arena sea justa.

## API REST

Base: `http://localhost:3000` (o tu URL pública). Errores siempre con la forma
`{ "error": { "code": "...", "message": "...", "details": [...] } }`. Cada respuesta incluye
`X-Response-Time` y `Server-Timing`.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/health` | — | Disponibilidad y estado de la base de datos |
| POST | `/api/auth/register` | — | Crea cuenta e inicia sesión (201) |
| POST | `/api/auth/login` | — | Inicia sesión (200 / 401) |
| POST | `/api/auth/logout` | cookie | Cierra sesión (204) |
| GET | `/api/auth/me` | cookie | Usuario actual (200 / 401) |
| GET | `/api/rooms` | cookie | Salas abiertas |
| GET | `/api/rooms/:id` | cookie | Detalle (403 si es privada y no eres miembro) |
| GET | `/api/stats/me` | cookie | Tu historial |
| GET | `/api/stats/leaderboard` | — | Clasificación |
| GET | `/api/profile` | cookie | Tu perfil, URL de tu imagen y límites de subida |
| POST | `/api/profile/avatar?x=&y=&size=` | cookie | Sube tu imagen (cuerpo binario PNG/JPEG, cabecera `X-File-Name`) |
| DELETE | `/api/profile/avatar` | cookie | Restablece la apariencia predeterminada |
| GET | `/api/avatars/<id>.png` | cookie | Imagen re-codificada por el servidor (128×128) |
| **GET** | **`/api/test/telemetry`** | — | **Métricas agregadas (obligatorio)** |
| **POST** | **`/api/test/seed`** | clave* | **Inyección de 100-1000 partidas (obligatorio)** |

\* `X-Test-Api-Key` obligatoria si `TEST_API_KEY` está definida (siempre en producción).

### Autenticación con curl

```bash
# Registro (guarda la cookie de sesión en cookies.txt)
curl -i -c cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"neo_01","password":"matrix-1999"}' \
  http://localhost:3000/api/auth/register

# Usuario actual
curl -b cookies.txt http://localhost:3000/api/auth/me
# {"user":{"id":"6f1c…","username":"neo_01"}}

# Credenciales incorrectas
curl -s -H "Content-Type: application/json" -d '{"username":"neo_01","password":"mala"}' \
  http://localhost:3000/api/auth/login
# {"error":{"code":"CREDENCIALES_INVALIDAS","message":"Usuario o contraseña incorrectos"}}

# Ruta privada sin sesión → 401
curl -i http://localhost:3000/api/rooms
```

### POST /api/test/seed

Payload validado con Zod (campos desconocidos → 400):

| Campo | Tipo | Regla | Por defecto |
|---|---|---|---|
| `matches` | entero | **100 – 1000** | obligatorio |
| `playersPerMatch` | entero | 2 – 8 | 4 |
| `seed` | entero | 0 – 4294967295 (misma semilla ⇒ mismos datos) | aleatoria |
| `batchId` | texto | 3-64 `[A-Za-z0-9_-]`; repetido ⇒ **409** | generado |
| `reset` | booleano | borra antes los lotes sembrados (nunca partidas reales) | `false` |
| `maxDurationS` | entero | 30 – 1800 | 180 |

```bash
curl -s -X POST http://localhost:3000/api/test/seed \
  -H "Content-Type: application/json" \
  -H "X-Test-Api-Key: $TEST_API_KEY" \
  -d '{"matches":500,"playersPerMatch":4,"seed":2026,"batchId":"demo-500","reset":true}'
```

Respuesta 200. Los totales son los reales para la semilla 2026; los valores de `timing` son
ilustrativos (dependen de la máquina y se miden en cada petición):

```json
{
  "ok": true,
  "batchId": "demo-500",
  "rngSeed": 2026,
  "reset": true,
  "deletedMatches": 0,
  "inserted": { "matches": 500, "playerRows": 2000, "playersPerMatch": 4 },
  "totals": { "kills": 3746, "deaths": 3746, "wins": 500 },
  "timing": { "generationMs": 6.4, "insertMs": 48.1, "processingMs": 54.5 }
}
```

Errores: `400 VALIDACION` (payload inválido, con `details`), `400 JSON_INVALIDO`,
`401 CLAVE_REQUERIDA`, `403 CLAVE_INVALIDA`, `404` si los endpoints de prueba están desactivados,
`409 LOTE_DUPLICADO`, `413` si el cuerpo supera 32 KB.

Los datos son coherentes con las reglas: cada eliminación se genera como un par asesino → víctima
(Σ eliminaciones = Σ muertes por partida), un único ganador por partida según la regla de
clasificación del servidor, supervivencia ≤ duración − muertes × reaparición. La inserción usa dos
sentencias `INSERT … SELECT unnest(...)` por bloque de 1000 partidas, dentro de una transacción.

### GET /api/test/telemetry

Agregados calculados en PostgreSQL (`COUNT`, `SUM`, `AVG`, `percentile_cont`); no se cargan filas en
memoria. Con la base vacía devuelve ceros, nunca `null` ni `NaN`.

```bash
curl -s http://localhost:3000/api/test/telemetry
```

Respuesta real obtenida tras sembrar las 500 partidas anteriores (abreviada; `units` y `formulas`
completos en la respuesta):

```json
{
  "generatedAt": "2026-10-24T18:31:26.519Z",
  "queryTimeMs": 13.1,
  "totals": {
    "matches": 500, "liveMatches": 0, "seededMatches": 500,
    "participations": 2000, "distinctPlayers": 2000,
    "wins": 500, "losses": 1500, "kills": 3746, "deaths": 3746, "shards": 5867
  },
  "metrics": {
    "winRatePct": 25,
    "kdr": 1,
    "avgParticipationKdr": 1.06,
    "avgKillsPerParticipation": 1.87,
    "avgMatchDurationMs": 104809,
    "survival": {
      "avgMs": 98200, "medianMs": 98466, "p95Ms": 165062, "maxMs": 178888,
      "avgLongestLifeMs": 56136, "avgRatePct": 92.24
    }
  },
  "bySource": [
    { "source": "seed", "matches": 500, "participations": 2000, "winRatePct": 25, "kdr": 1, "avgSurvivalMs": 98200 }
  ],
  "consistency": { "killsMinusDeaths": 0, "matchesWithoutSingleWinner": 0, "survivalExceedsDuration": 0 }
}
```

`queryTimeMs` en este ejemplo es la suma de los tiempos de las dos consultas SQL medidos con
`psql` sobre PostgreSQL 16 en el entorno de desarrollo (≈ 9,4 ms + 3,7 ms, ver
`reports/evidencias/sql-telemetria-tiempos.txt`); el resto de valores es la salida real del servicio.

Cómo leerla:

- `winRatePct` = 100 × 500 victorias / 2000 participaciones = **25 %** (4 jugadores por partida).
- `kdr` global ≈ 1 por definición: cada eliminación es la muerte de otro jugador.
  `avgParticipationKdr` (media del KDR de cada jugador en cada partida) es la métrica individual.
- `consistency` permite verificar los datos: los tres contadores deben ser 0.
- `queryTimeMs` es el tiempo de las consultas SQL; el tiempo total de la petición está en la
  cabecera `X-Response-Time`.

## Eventos WebSocket

Socket.IO en `/socket.io`. El handshake se autentica con la cookie de sesión (o `auth.token`); sin
sesión válida la conexión se rechaza con `NO_AUTENTICADO`. Todo lo que envía el cliente se valida
con Zod y se limita en frecuencia (entradas: 60/s; resto: 10/s). Más de 50 mensajes inválidos
desconectan el socket.

| Cliente → servidor | Payload | Respuesta (acuse) |
|---|---|---|
| `room:list` | — | `{ ok, data: { version, rooms } }` |
| `room:current` | — | `{ ok, data: RoomState \| null }` (sala actual según el servidor) |
| `room:return` | `{ roomId }` | `{ ok, data: RoomState }` o `SALA_NO_EXISTE` / `NO_ERES_MIEMBRO` (idempotente) |
| `room:create` | `{ name, maxPlayers, isPrivate, accessCode?, scoreToWin? }` (30, 40 o 50) | `{ ok, data: RoomState }` |
| `room:join` | `{ roomId, accessCode? }` | `{ ok, data }` o `ACCESO_DENEGADO`, `SALA_LLENA`… |
| `room:leave` | — | `{ ok }` |
| `room:ready` | `{ ready }` | `{ ok, data: RoomState }` |
| `game:input` | `{ seq, moveX, moveY, aim, fire, dash, tp?, ov? }` (`tp`/`ov`: habilidades activas) | — (intención) |
| `game:upgrade:choose` | `{ milestone, upgradeId }` (solo eso; Zod rechaza el resto) | `{ ok, data: PlayerUpgradeView }` o `MEJORA_NO_OFRECIDA`, `HITO_INCORRECTO`, `YA_ELEGIDA`… (idempotente) |
| `net:ping` | `{ t }` | `{ t, serverTime }` (ping/pong) |

| Servidor → cliente | Contenido |
|---|---|
| `session:ready` | usuario y sala actual (reconexión) |
| `rooms:changed` | `{ version, rooms }`: lista de salas versionada (solo se emite si cambió) |
| `room:state` | miembros, estados (`conectado`, `listo`, `desconectado`), creador, cuenta atrás |
| `game:start` | mapa, jugadores, duración, hora del servidor |
| `game:snapshot` | estado autoritativo a 30 Hz |
| `game:event` | disparo, impacto, eliminación, recogida, reaparición; desde la 1.3 también rayo, cadena, rebote, teletransporte, sobrecarga, bloqueo y estado de satélites, y fragmentación |
| `game:end` | clasificación, objetivo, límite de tiempo, criterio de desempate y estadísticas guardadas |
| `player:appearance` | un jugador cambió su imagen durante la partida |
| `game:upgrades` | **solo al jugador afectado**: progreso de mejoras, elección pendiente, mejoras activas, sinergias y recargas |
| `error:event` | evento rechazado |

**Desconexiones:** el miembro pasa a `desconectado` y su unidad se queda quieta. Tiene 30 s para
volver (al reconectar recibe de nuevo la sala y, si hay partida, `game:start`). Pasado ese
tiempo se le retira; si en la partida queda un solo jugador, termina por abandono y gana quien
sigue. Si el creador sale, la sala pasa al miembro más antiguo; una sala vacía se cierra.

## Seguridad

- Contraseñas con **scrypt** (N=16384, r=8, p=1, sal aleatoria de 16 bytes); comparación en tiempo
  constante. Con usuario inexistente se verifica contra un hash ficticio (no revela qué usuarios
  existen).
- Sesiones opacas de 256 bits en cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción; en la
  base de datos solo se guarda su SHA-256. Cerrar sesión revoca el token y desconecta el socket.
- CSRF: las peticiones que modifican estado deben ser JSON y, si traen `Origin`, coincidir con el
  host o con `CORS_ORIGINS`.
- Límite de intentos de inicio de sesión (10 cada 5 min por IP y usuario) y de registro.
- Cabeceras: CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS en producción.
- Salas privadas: el código se guarda como hash y se compara en tiempo constante; tampoco se puede
  leer la sala por REST sin ser miembro.
- Ninguna credencial real en el código: todo se configura con variables de entorno.

## Pruebas

```bash
# Unitarias (no necesitan base de datos)
npm run test:unit

# Integración: HTTP + Socket.IO + PostgreSQL reales
export TEST_DATABASE_URL=postgres://cybergrid:cybergrid@localhost:5432/cybergrid_test
npm run test:integration

# Ambas (como en CI, con informe JUnit en reports/)
npm run test:ci

# End-to-End (compila y arranca el servidor en el puerto 4173)
npm run test:e2e
npx playwright show-report reports/playwright-html
```

La suite de integración **falla** (no se omite) si no hay `TEST_DATABASE_URL`, para que nunca
aparezca en verde sin haberse ejecutado.

### Vitest — 128 pruebas unitarias y 27 de integración

| Archivo | Cubre |
|---|---|
| `unit/mapGenerator.test.ts` | generación, reproducibilidad por semilla, 500 semillas válidas, conectividad, detección de mapas bloqueados |
| `unit/combat.test.ts` | fórmula de daño, caída por distancia, escalado por racha, protección, cadencia |
| `unit/validation.test.ts` | esquemas Zod válidos y rechazo de payloads inválidos (velocidad, NaN, posiciones inyectadas, seed fuera de 100-1000) |
| `unit/interpolation.test.ts` | interpolación lineal, ángulos, sin extrapolación, teletransporte, reutilización de objetos |
| `unit/collision.test.ts` | muros, deslizamiento, anti-túnel, límites del mapa, separación de jugadores, raycast |
| `unit/gameServer.test.ts` | velocidad autoritativa, anti speed-hack, orden de entradas, cadencia, impactos, eliminación, reaparición, fin por puntuación/tiempo/abandono |
| `unit/stats.test.ts` | KDR sin división entre cero, Win Rate, coherencia y determinismo del generador de seed |
| `unit/gameLoop.test.ts` | misma lógica a 60/120/144 Hz, tolerancia a variaciones, límite tras pausas |
| `unit/roomManager.test.ts` | salas privadas, capacidad, propietario, listo y cuenta atrás, desconexión y reconexión |
| `unit/auth.test.ts` | scrypt, tokens de sesión, cookies, cubo de fichas, ventana fija |
| `unit/matchConfig.test.ts` | 30/40/50 puntos en un único sitio, ritmo de duración, fórmula progresiva, validación, fin por objetivo variable, sin puntos tras el final, desempates |
| `unit/returnToLobby.test.ts` | regresión del regreso al lobby: mismo id, sin duplicados, idempotencia, difusiones únicas, sala eliminada, varios jugadores, lista versionada |
| `unit/upgrades.test.ts` | catálogo de 10 mejoras, dos opciones distintas, hitos únicos y en orden, nada antes de 10, rechazo de opciones no ofrecidas, número de proyectiles, munición pesada, límites de velocidad/escudo/imán/dron, reconexión y reinicio, sin elecciones tras el final, protección limitada, límite global de proyectiles |
| `unit/abilities.test.ts` | catálogo ampliado sin perder las originales ni duplicar, rayo que sustituye al disparo con recarga propia y sin impactos duplicados, satélites distintos del dron, límites del teletransporte, fin de la corrosión, sobrecarga con distintas armas, límite de saltos de la cadena, fragmentos sin recursión, rebotes, las 10 sinergias, ausencia de ciclos y daño ilimitado, sincronización y limpieza |
| `unit/avatar.test.ts` | extensión, MIME, firma real, GIF/WebP/SVG/EXE renombrados, HTML disfrazado, corruptos, tamaño, dimensiones, recorte |
| `integration/returnToLobby.test.ts` | objetivo fijado por el servidor, doble clic real por Socket.IO, una sola suscripción por socket, salida al lobby general, sala eliminada |
| `integration/upgrades.test.ts` | estado privado por jugador, validación Zod y de opción ofrecida, idempotencia, restauración al reconectar, rechazo tras el final y reinicio en la partida siguiente |
| `integration/profile.test.ts` | subida, entrega, reemplazo, restablecimiento, rechazos 413/415/422/400, solo la propia imagen, sincronización con la sala |
| `integration/telemetry.test.ts` | telemetría vacía, seed inválido (400), 1000 partidas, 409 por duplicado, coherencia, **p95 < 200 ms**, reset, clave y desactivación |
| `integration/auth.test.ts` | registro, login, /me, logout, credenciales incorrectas, hash en BD, rutas protegidas, CSRF |
| `integration/sockets.test.ts` | handshake sin sesión, **ping/pong < 100 ms**, sala privada, listo en tiempo real, inicio, movimiento autoritativo, rechazo de intención manipulada |

### Playwright — exactamente 3 flujos

| Flujo | Qué comprueba |
|---|---|
| `e2e/auth.spec.ts` | (además) GIF rechazado en «Personalizar personaje», PNG guardado y restablecido; ruta privada redirige al acceso; credenciales inválidas muestran error; validación del registro; registro, cierre e inicio de sesión; API de salas con 401 sin sesión; sala privada con código incorrecto rechazada en la interfaz, por URL directa y por REST (403); entrada con el código correcto |
| `e2e/lobby.spec.ts` | sala de 40 puntos y HUD `/ 40` en ambos jugadores; fin por abandono; doble clic en «Volver al lobby de la sala» → mismo id, un solo miembro, una sola sala en el lobby del otro jugador; dos usuarios; transporte `websocket` real; crear sala; el segundo la ve y se une; ambos aparecen en ambas pantallas; listo y cancelar listo en tiempo real; ping/pong medido y guardado en `reports/e2e-latency.json`; cuenta atrás e inicio de partida |
| `e2e/canvas.spec.ts` | Canvas con contenido; FPS > 0; controles táctiles ocultos en escritorio y visibles en móvil emulado (Pixel 7); entrada inyectada con `window.__cybergrid.test.injectMove`; cambio en `data-player-x`/`data-player-y`; desplazamiento ≤ velocidad máxima del servidor; el **otro navegador** ve la misma posición; intención manipulada rechazada; el joystick táctil mueve al jugador móvil |

`window.__cybergrid.test` solo inyecta **intenciones** que el servidor valida igual que las del
teclado; no permite fijar posiciones ni daño.

## Mediciones de rendimiento

Los objetivos (ping < 100 ms, 60 FPS, API < 200 ms) se **miden**; los informes quedan en
`reports/`.

```bash
npm run build && npm start      # en otra terminal
npm run bench:api -- --url http://localhost:3000 --out reports/api-benchmark.json
npm run bench:latency -- --url http://localhost:3000 --clients 4 --pings 200 --out reports/latency.json
```

- `bench:api`: siembra 1000 partidas y hace 50 peticiones de telemetría (p50, p95, máx.; tiempo de
  cliente, cabecera `X-Response-Time` y tiempo SQL). Contra un despliegue con clave:
  `TEST_API_KEY=... npm run bench:api -- --url https://tu-app.onrender.com`.
- `bench:latency`: 4 clientes Socket.IO simultáneos por WebSocket, 200 pings cada uno; media, p95,
  p99 y % por debajo de 100 ms.
- En el juego: el HUD muestra FPS, ping y tick; la barra superior muestra el ping con media y p95
  al pasar el ratón; `window.__cybergrid.net.stats()` devuelve las estadísticas.

Las mediciones dependen de la red y la máquina: en local el ping suele ser de 1-3 ms; en un
despliegue gratuito de Render depende de la distancia a la región elegida.

## CI/CD con GitHub Actions

Archivo: [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Se ejecuta en cada Pull Request y en
los push a `main`, `master` y `develop`.

Pasos: descargar el código → comprobar `package-lock.json` → Node 22 → `npm ci` → `npm run
typecheck` → `npm run build` → migraciones → Vitest con informe JUnit → instalar Chromium →
Playwright → `verify:reports` (falla si Vitest ejecutó menos de 10 pruebas, si Playwright no
ejecutó exactamente 3 flujos o si hubo fallos u omisiones) → mediciones de API y latencia →
resumen en la página de la ejecución → artefacto `informes-de-pruebas` con todos los informes.
PostgreSQL 16 se levanta como servicio del job.

**Conectar el repositorio:**

```bash
git init
git add .
git commit -m "CyberGrid: Breach & Sync"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/cybergrid-breach-sync.git
git push -u origin main
```

**Ver los resultados:** pestaña **Actions** del repositorio → ejecución «CI» → el resumen muestra
la tabla de pruebas; los informes HTML/JUnit/JSON se descargan desde **Artifacts**. En cada Pull
Request el resultado aparece como comprobación obligatoria si activas *Branch protection* →
*Require status checks* → «Tipos, Vitest y Playwright».

## Despliegue público

Plataforma recomendada: **Render**, con un único servicio web que sirve la API, los WebSockets y el
cliente desde el mismo origen (sin CORS ni cookies de terceros) y una base PostgreSQL gestionada.
Render y Railway admiten conexiones WebSocket persistentes y terminan HTTPS/WSS por ti.

> Estas acciones requieren **tu cuenta** en GitHub y Render (o Railway). El proyecto no está
> desplegado hasta que las completes.

### Render (blueprint incluido)

1. Sube el repositorio a GitHub (sección anterior), con `package-lock.json`.
2. En [dashboard.render.com](https://dashboard.render.com): **New → Blueprint** y elige el
   repositorio. Render lee `render.yaml` y crea:
   - `cybergrid-db`: PostgreSQL.
   - `cybergrid`: servicio web Node con `npm ci --include=dev && npm run build` y
     `node server/dist/index.js`, comprobación de salud en `/api/health`.
   - Variables: `NODE_ENV=production`, `DATABASE_URL` enlazada a la base,
     `ENABLE_TEST_ENDPOINTS=true` y `TEST_API_KEY` **generada automáticamente** (secreta).
3. Espera a que el despliegue termine (las migraciones se aplican al arrancar).
4. Copia el valor de `TEST_API_KEY` desde **Environment** del servicio para usar `/api/test/seed`.

### Railway (alternativa)

1. **New Project → Deploy from GitHub repo**. `railway.json` define build, arranque y salud.
2. **New → Database → PostgreSQL** y añade al servicio la variable
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Variables: `NODE_ENV=production`, `ENABLE_TEST_ENDPOINTS=true`, `TEST_API_KEY=<clave larga>`.
4. **Settings → Networking → Generate Domain**.

### Frontend y backend en dominios distintos (opcional)

Si alojas el cliente aparte (p. ej. un sitio estático): compílalo con
`PUBLIC_SERVER_URL=https://tu-api.onrender.com npm run build:client`, publica `client/dist` y en el
backend define `CORS_ORIGINS=https://tu-frontend.example`. Ten en cuenta que algunos navegadores
bloquean cookies de terceros; el despliegue en un solo servicio evita ese problema.

### Verificar la URL pública, SSL y WSS

```bash
URL=https://cybergrid.onrender.com          # tu URL

curl -s $URL/api/health                       # {"status":"ok","database":"ok",...}
curl -sI $URL | grep -i strict-transport      # HSTS activo
curl -s $URL/api/test/telemetry | head -c 300

# Certificado SSL: emisor, fechas y nombre
echo | openssl s_client -connect cybergrid.onrender.com:443 -servername cybergrid.onrender.com 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates

# Seed protegido
curl -s -X POST $URL/api/test/seed -H "Content-Type: application/json" \
  -H "X-Test-Api-Key: $TEST_API_KEY" -d '{"matches":100,"reset":true}'

# Latencia real por WSS y rendimiento de la API contra el despliegue
npm run bench:latency -- --url $URL --out reports/latency-produccion.json
TEST_API_KEY=... npm run bench:api -- --url $URL --out reports/api-produccion.json
```

En el navegador: candado de la barra de direcciones → certificado válido; DevTools → **Network → WS**
debe mostrar `wss://…/socket.io/?EIO=4&transport=websocket` con estado 101.

**Nota sobre los planes gratuitos:** suelen suspender el servicio tras un periodo de inactividad
(la primera petición tarda en despertarlo) y limitan la duración de la base de datos gratuita.
Revisa los límites vigentes de Render o Railway antes de la evaluación.

## Solución de errores frecuentes

| Síntoma | Causa y solución |
|---|---|
| `Configuración inválida: DATABASE_URL…` | Falta `.env` o la variable. Copia `.env.example`. |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL no está en marcha o el puerto es otro. |
| `password authentication failed` | Usuario o contraseña de `DATABASE_URL` incorrectos. |
| `No se encontró el cliente compilado` | Ejecuta `npm run build:client` (o `npm run build`). |
| La barra superior muestra «Sin conexión» | Sesión caducada o servidor caído: vuelve a iniciar sesión y revisa `/api/health`. |
| WebSocket no conecta tras un proxy propio | El proxy debe reenviar `Upgrade`/`Connection`. En Render/Railway funciona sin configuración. |
| `Las pruebas de integración necesitan PostgreSQL` | Define `TEST_DATABASE_URL` y crea la base `cybergrid_test`. |
| Playwright: `Executable doesn't exist` | `npx playwright install chromium` (en Linux: `--with-deps`). |
| Playwright: puerto 4173 ocupado | Libéralo o usa `E2E_PORT=4180 npm run test:e2e`. |
| CI falla en «Comprobar que existe package-lock.json» | Ejecuta `npm install` y sube `package-lock.json`. |
| `403 ORIGEN_INVALIDO` | Petición desde otro dominio: añádelo a `CORS_ORIGINS`. |
| `429 DEMASIADOS_INTENTOS` | Límite de inicio de sesión: espera unos minutos. |
| `/api/test/*` responde 404 en producción | Define `ENABLE_TEST_ENDPOINTS=true` y `TEST_API_KEY`. |
| El móvil no muestra controles táctiles | Abre la URL con `?touch=1` para forzarlos. |

## Lista de verificación para la evaluación

- [ ] `npm install && npm run build && npm start` arranca sin errores y `/api/health` responde `ok`.
- [ ] Registro, inicio de sesión con error visible para credenciales incorrectas y cierre de sesión.
- [ ] `#/lobby` sin sesión redirige al acceso; `GET /api/rooms` sin cookie → 401.
- [ ] Sala privada: código incorrecto rechazado; `GET /api/rooms/:id` de no miembro → 403.
- [ ] Dos navegadores en la misma sala; los estados de listo cambian en tiempo real.
- [ ] La partida empieza cuando todos están listos; el Canvas se ve fluido y el HUD muestra FPS y ping.
- [ ] Teclado y ratón funcionan; en móvil aparecen joystick y botones y funcionan.
- [ ] El marcador, la eliminación, la reaparición y los fragmentos funcionan; aparece la pantalla de resultados.
- [ ] `POST /api/test/seed` con 100 y 1000 partidas → 200; con 99, 1001 o tipos erróneos → 400; mismo `batchId` → 409.
- [ ] `GET /api/test/telemetry` → 200 con `consistency` a 0 y `X-Response-Time` < 200 ms.
- [ ] Al crear una sala se puede elegir 30, 40 o 50 puntos; el HUD muestra `puntos / objetivo` y el tiempo restante.
- [ ] Tras una partida, «Volver al lobby de la sala» (incluso con doble clic) vuelve a la MISMA sala, sin duplicarla.
- [ ] «Personalizar personaje»: un GIF se rechaza, un PNG/JPEG se guarda y otro jugador lo ve en la sala y en la partida.
- [ ] `npm run test:ci` ≥ 10 pruebas verdes; `npm run test:e2e` 3 flujos verdes.
- [ ] GitHub Actions en verde con artefacto `informes-de-pruebas`.
- [ ] URL pública con HTTPS válido y WebSocket `wss://` (estado 101).
- [ ] Informes de medición en `reports/` (`latency.json`, `api-benchmark.json`, `e2e-latency.json`).

## Estado de la entrega

El código está completo para todos los requisitos. La matriz detallada requisito → archivo →
evidencia está en **[docs/MATRIZ_REQUISITOS.md](docs/MATRIZ_REQUISITOS.md)**.

El entorno donde se desarrolló **no tenía acceso al registro de npm**, por lo que Express,
Socket.IO, Vitest y el driver `pg` no pudieron instalarse allí. Lo que sí se ejecutó y su evidencia
está en [`reports/evidencias/`](reports/evidencias/); lo que queda por ejecutar con las
dependencias reales (Vitest real, integración, Playwright, comprobación de tipos completa,
mediciones de latencia y despliegue) se ejecuta con `npm install` en tu máquina o automáticamente en
GitHub Actions.
