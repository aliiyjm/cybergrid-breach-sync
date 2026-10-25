# Arquitectura de CyberGrid: Breach & Sync (Fase 1)

## Visión general

```text
 Navegador (cliente)                                   Servidor Node.js 22 (autoridad única)
┌──────────────────────────────┐   HTTPS (REST)   ┌──────────────────────────────────────────┐
│ Pantallas (hash router)      │ ───────────────▶ │ Express 5                                 │
│ Canvas 2D + GameLoop (rAF,   │                  │  /api/auth  /api/rooms  /api/stats        │
│   delta time, paso fijo)     │                  │  /api/test/telemetry  /api/test/seed      │
│ Interpolador de instantáneas │   WSS (Socket.IO)│  /api/health                              │
│ Teclado/ratón · Táctil       │ ◀──────────────▶ │ Socket.IO                                 │
│ LatencyMonitor (ping/pong)   │  intenciones →   │  auth por cookie · Zod · límite de        │
└──────────────────────────────┘  ← instantáneas  │  frecuencia · RoomManager · GameServer    │
                                    (30 Hz)        │  (simulación a 30 Hz, colisiones, combate)│
                                                   └───────────────┬──────────────────────────┘
                                                                   │ pg (Pool)
                                                          ┌────────▼─────────┐
                                                          │ PostgreSQL 16    │
                                                          │ users, sessions, │
                                                          │ matches,         │
                                                          │ match_players,   │
                                                          │ seed_batches     │
                                                          └──────────────────┘
```

**Principio rector:** el cliente solo envía *intenciones* (`moveX`, `moveY` ∈ [-1, 1], ángulo de
apuntado, disparar, impulso). El servidor decide posiciones, colisiones, proyectiles, daño, vida,
eliminaciones, reapariciones, recursos, puntuación, fin de partida y estadísticas.

## Flujo de una partida

1. El usuario inicia sesión (cookie `cg_session` HttpOnly). El handshake de Socket.IO envía la
   misma cookie y el servidor rechaza el socket si la sesión no es válida.
2. Crea o se une a una sala (`room:create` / `room:join`, validados con Zod; las privadas exigen
   código). Todos los cambios se difunden con `room:state`.
3. Cuando hay ≥ 2 miembros y todos están «listos», empieza una cuenta atrás de 3 s y se crea un
   `GameServer` con una semilla aleatoria. Cada jugador recibe `game:start` con el mapa.
4. El cliente envía `game:input` a 30 Hz. El servidor simula a 30 Hz con paso fijo y emite
   `game:snapshot` (volátil) y `game:event` (disparos, impactos, eliminaciones…).
5. El cliente dibuja a los demás con 100 ms de retardo de interpolación entre instantáneas, y al
   jugador local suavizando hacia su última posición autoritativa (sin predicción).
6. Al terminar (tiempo, puntuación o abandono) se guarda la partida en PostgreSQL y se emite
   `game:end`. La sala vuelve al estado de espera.

## Dependencias

| Paquete | Uso | Dónde |
|---|---|---|
| express 5 | API REST, estáticos | servidor |
| socket.io 4.8 | tiempo real (servidor) | servidor |
| socket.io-client 4.8 | tiempo real (navegador, pruebas, mediciones) | cliente, pruebas |
| pg 8 | PostgreSQL | servidor |
| zod 3.25 | validación de todo lo que llega del navegador | servidor |
| esbuild | compilación de cliente y servidor | desarrollo |
| typescript 6 | comprobación de tipos | desarrollo |
| tsx | ejecutar TypeScript en desarrollo y scripts | desarrollo |
| vitest 3 | pruebas unitarias e integración | desarrollo |
| @playwright/test 1.63 | pruebas End-to-End | desarrollo |

Decisiones para reducir dependencias: contraseñas con `crypto.scrypt` de Node.js, sesiones opacas
con SHA-256 en base de datos, cabeceras de seguridad, CORS, límites de frecuencia y lectura de
cookies implementados en el propio proyecto (cada uno con pruebas).

## Estructura de carpetas

```text
cybergrid-breach-sync/
├── client/                    Cliente web (HTML5 + Canvas 2D + TypeScript + CSS)
│   ├── index.html             Todas las pantallas (inicio, acceso, lobby, sala, partida, resultados)
│   ├── public/favicon.svg
│   └── src/
│       ├── main.ts            Arranque, enrutado, eventos globales del socket, API de pruebas
│       ├── styles/main.css
│       ├── canvas/            GameLoop, GameRenderer, Camera, ParticleSystem, MapPreview
│       ├── controls/          InputState, KeyboardControls, TouchControls, device
│       ├── game/GameClient.ts Orquestación de la partida en el cliente
│       ├── network/           api (HTTP), SocketClient, LatencyMonitor, Interpolator
│       ├── screens/           Una clase por pantalla
│       └── ui/                Utilidades DOM y avisos
├── server/
│   └── src/
│       ├── index.ts           Arranque: migraciones, servidor HTTP, cierre ordenado
│       ├── app.ts             Composición de Express + Socket.IO
│       ├── config.ts          Variables de entorno validadas con Zod
│       ├── api/               Middleware (tiempos, seguridad, CORS, errores) y rutas
│       ├── auth/              Contraseñas, sesiones, middleware y rutas
│       ├── sockets/           Servidor Socket.IO (auth, Zod, límites, eventos)
│       ├── rooms/             RoomManager (salas, listo, cuenta atrás, reconexión)
│       ├── game/              GameServer, CollisionSystem, CombatSystem, matchRecord
│       ├── telemetry/         TelemetryService, seedGenerator, rutas /api/test
│       ├── database/          Pool, migraciones, repositorios
│       ├── validation/        Esquemas Zod
│       └── lib/               logger, errores HTTP, limitadores de frecuencia
├── shared/                    Código puro compartido: constantes, protocolo, matemáticas,
│                              PRNG con semilla, MapGenerator y fórmulas de estadísticas
├── tests/
│   ├── unit/                  Vitest: lógica pura
│   ├── integration/           Vitest: HTTP + Socket.IO + PostgreSQL reales
│   ├── e2e/                   Playwright: exactamente 3 flujos
│   └── helpers/
├── scripts/                   build, dev, mediciones, verificación de informes
├── docs/                      Arquitectura y matriz de requisitos
├── .github/workflows/ci.yml
├── render.yaml · railway.json
├── .env.example · .gitignore · package.json · README.md
```

**Ajuste respecto a la estructura propuesta:** `MapGenerator.ts` vive en `shared/` en lugar de
`server/src/game/`. Es código puro y determinista: el servidor lo usa como fuente de verdad del
mapa y el cliente lo reutiliza para la vista previa de la pantalla de inicio, sin duplicarlo. Se
añadió `shared/` para el protocolo tipado entre cliente y servidor por la misma razón.
