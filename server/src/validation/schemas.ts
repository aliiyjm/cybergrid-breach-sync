import { z } from 'zod';
import { GAME } from '../../../shared/constants';
import { DEFAULT_SCORE_TARGET, SCORE_TARGET_ERROR, isScoreTarget, type ScoreTarget } from '../../../shared/matchConfig';
import { PROGRESSION, UPGRADE_IDS } from '../../../shared/upgrades';

/**
 * Esquemas Zod para TODO lo que llega desde el navegador (HTTP y WebSocket).
 * Todos son `.strict()`: cualquier campo desconocido provoca rechazo.
 */

/* Mensajes de error en español para los casos comunes de Zod. */
const spanishErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'Campo obligatorio' };
      return { message: `Tipo inválido: se esperaba ${issue.expected} y se recibió ${issue.received}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Campos no permitidos: ${issue.keys.join(', ')}` };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: `Debe tener al menos ${String(issue.minimum)} caracteres` };
      if (issue.type === 'number') return { message: `Debe ser mayor o igual que ${String(issue.minimum)}` };
      return { message: `Valor demasiado pequeño (mínimo ${String(issue.minimum)})` };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `Debe tener como máximo ${String(issue.maximum)} caracteres` };
      if (issue.type === 'number') return { message: `Debe ser menor o igual que ${String(issue.maximum)}` };
      return { message: `Valor demasiado grande (máximo ${String(issue.maximum)})` };
    case z.ZodIssueCode.invalid_string:
      return { message: 'Formato de texto inválido' };
    case z.ZodIssueCode.not_finite:
      return { message: 'Debe ser un número finito' };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor no permitido. Opciones: ${issue.options.join(', ')}` };
    default:
      return { message: ctx.defaultError };
  }
};
z.setErrorMap(spanishErrorMap);

/* ------------------------------ Autenticación ------------------------------ */

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9_]+$/, 'Solo letras sin tilde, números y guion bajo');

export const passwordSchema = z.string().min(8).max(72);

export const registerSchema = z.object({ username: usernameSchema, password: passwordSchema }).strict();

export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(20),
    password: z.string().min(1).max(72),
  })
  .strict();

/* --------------------------------- Salas --------------------------------- */

export const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,32}$/, 'Identificador de sala inválido');
export const accessCodeSchema = z.string().regex(/^[A-Za-z0-9]{4,12}$/, 'El código debe tener 4-12 letras o números');

/** Solo los valores de SCORE_TARGETS (shared/matchConfig.ts): número exacto, sin textos ni decimales. */
export const scoreTargetSchema = z.custom<ScoreTarget>((value) => isScoreTarget(value), { message: SCORE_TARGET_ERROR });

export const createRoomSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[\p{L}\p{N} _\-.#]+$/u, 'El nombre contiene caracteres no permitidos'),
    maxPlayers: z.number().int().min(GAME.MIN_PLAYERS_TO_START).max(GAME.MAX_ROOM_CAPACITY),
    isPrivate: z.boolean(),
    accessCode: accessCodeSchema.optional(),
    /** Uno de SCORE_TARGETS. Si se omite se usa DEFAULT_SCORE_TARGET (modo estándar). */
    scoreToWin: scoreTargetSchema.default(DEFAULT_SCORE_TARGET),
  })
  .strict()
  .refine((room) => !room.isPrivate || room.accessCode !== undefined, {
    message: 'Las salas privadas necesitan un código de acceso',
    path: ['accessCode'],
  });

export const joinRoomSchema = z
  .object({
    roomId: roomIdSchema,
    accessCode: accessCodeSchema.optional(),
  })
  .strict();

export const readySchema = z.object({ ready: z.boolean() }).strict();

/** Regreso a la sala original tras una partida (operación idempotente). */
export const returnToRoomSchema = z.object({ roomId: roomIdSchema }).strict();

/* ------------------------------ Mejoras de nave ------------------------------ */

/**
 * Elección de mejora: el hito (múltiplo de 10) y un identificador del catálogo.
 * El cliente nunca envía listas de mejoras ni efectos; el servidor comprueba
 * además que la mejora estaba entre las ofrecidas para ese hito.
 */
export const chooseUpgradeSchema = z
  .object({
    milestone: z
      .number()
      .int()
      .min(PROGRESSION.MILESTONE_STEP)
      .max(100_000)
      .refine((n) => n % PROGRESSION.MILESTONE_STEP === 0, 'El hito debe ser múltiplo de 10'),
    upgradeId: z.enum(UPGRADE_IDS),
  })
  .strict();

/* --------------------------- Apariencia (avatar) --------------------------- */

/**
 * Encuadre cuadrado elegido en la vista previa, en fracciones de la imagen
 * orientada: (x, y) esquina superior izquierda relativa al ancho/alto y
 * `size` relativo al lado menor. Se envía como parámetros de consulta.
 */
export const avatarCropSchema = z
  .object({
    x: z.coerce.number().finite().min(0).max(1).default(0),
    y: z.coerce.number().finite().min(0).max(1).default(0),
    size: z.coerce.number().finite().min(0.05).max(1).default(1),
  })
  .strict();

/* --------------------------------- Juego --------------------------------- */

const ANGLE_LIMIT = Math.PI + 1e-3;

/** Intenciones del cliente. Nunca contienen posiciones, vida ni daño. */
export const inputSchema = z
  .object({
    seq: z.number().int().min(0).max(2 ** 31 - 1),
    moveX: z.number().finite().min(-1).max(1),
    moveY: z.number().finite().min(-1).max(1),
    aim: z.number().finite().min(-ANGLE_LIMIT).max(ANGLE_LIMIT),
    fire: z.boolean(),
    dash: z.boolean(),
    // Habilidades activas: solo booleanos de intención (el servidor valida propiedad y recarga).
    tp: z.boolean().optional(),
    ov: z.boolean().optional(),
  })
  .strict();

export const pingSchema = z.object({ t: z.number().finite().nonnegative() }).strict();

/* ------------------------------ Telemetría ------------------------------ */

export const SEED_MIN_MATCHES = 100;
export const SEED_MAX_MATCHES = 1000;

export const seedPayloadSchema = z
  .object({
    /** Número de partidas a generar: entre 100 y 1000. */
    matches: z.number().int().min(SEED_MIN_MATCHES).max(SEED_MAX_MATCHES),
    playersPerMatch: z.number().int().min(2).max(GAME.MAX_ROOM_CAPACITY).default(4),
    /** Semilla del generador: la misma semilla produce los mismos datos. */
    seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
    /** Identificador del lote; enviar dos veces el mismo devuelve 409. */
    batchId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{3,64}$/, 'batchId: 3-64 caracteres alfanuméricos, guion o guion bajo')
      .optional(),
    /** Borra antes los lotes sembrados previamente (nunca las partidas reales). */
    reset: z.boolean().default(false),
    maxDurationS: z.number().int().min(30).max(1800).default(GAME.DEFAULT_MATCH_DURATION_S),
  })
  .strict();

export type SeedPayload = z.infer<typeof seedPayloadSchema>;
export type InputPayload = z.infer<typeof inputSchema>;
