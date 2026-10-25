# Evidencias de la verificación en el entorno de desarrollo

Generadas el 24/10/2026 en un entorno **sin acceso al registro de npm** (Express, Socket.IO,
Vitest y `pg` no se pudieron instalar). Lo que se ejecutó, con qué y su resultado:

| Archivo | Qué es |
|---|---|
| `pruebas-unitarias-local.txt` | Los 10 archivos de `tests/unit/` (57 pruebas) ejecutados con un sustituto mínimo de la API de Vitest y, para `auth.test.ts`, un adaptador `pg` sobre `psql`. 57/57 superadas. **No sustituye** a `npm run test:unit` con Vitest real. |
| `sql-telemetria-tiempos.txt` | Tiempo de las dos consultas SQL de la telemetría en PostgreSQL 16 con 1000 partidas y 4000 participaciones (`psql \timing`). No incluye el tiempo HTTP. |
| `telemetria-ejemplo-500-partidas.json` | Salida real de `TelemetryService.report()` sobre PostgreSQL 16 tras sembrar 500 partidas (semilla 2026). Su `queryTimeMs` incluye el arranque de `psql` del adaptador de verificación, por eso es alto; no es representativo del driver `pg`. |
| `captura-inicio.png` | Pantalla de inicio con la vista previa de un mapa real generado por semilla. |
| `captura-partida-escritorio.png`, `captura-partida-movil.png` | El renderizador Canvas real dibujando instantáneas de prueba (3 jugadores, proyectiles, fragmentos, HUD, marcador, controles táctiles en Pixel 7 emulado). El servidor se sustituyó por un socket simulado, por eso aparece «Reconectando con el servidor…». |

Además se comprobó (sin archivo): `tsc` real sobre `shared/`; `tsc` sobre `server/` y `client/`
con declaraciones provisionales de las librerías ausentes (sin errores propios); compilación con
esbuild del servidor y del cliente; 2000 semillas de mapa válidas.

**Pendiente de ejecutar con las dependencias reales** (lo hace GitHub Actions o `npm install` en
local): comprobación de tipos completa, Vitest real (unitarias + 16 de integración), los 3 flujos de
Playwright y las mediciones de latencia (`bench:latency`), API HTTP (`bench:api`) y FPS.

## Versión 1.1 (25/10/2026)

| Archivo | Qué es |
|---|---|
| `pruebas-unitarias-local.txt` | Actualizado: 81 pruebas unitarias (24 nuevas), 81/81 superadas con el sustituto de Vitest. Las de imágenes usan `sharp` 0.35 real. |
| `sql-version-1.1.txt` | Migración 2 aplicada sobre una base de la versión 1.0, almacenamiento y reemplazo de imágenes, objetivo guardado por partida y telemetría por objetivo, sobre PostgreSQL 16. |
| `captura-lobby-v1.1.png` | Selector de puntuación, aviso «Sigues en la sala» y sala marcada como «Tu sala» (servidor simulado). |
| `captura-personalizar-personaje.png` | Encuadre con guía hexagonal y vistas previas «Actual» / «Nueva». |

Pendiente con las dependencias reales: `npm run typecheck`, las 24 pruebas de integración y los 3
flujos E2E ampliados.
