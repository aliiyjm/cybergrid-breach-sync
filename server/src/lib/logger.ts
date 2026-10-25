/** Registro estructurado mínimo (JSON por línea en producción, legible en desarrollo). */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let currentLevel: Level = 'info';
let jsonOutput = false;

export function configureLogger(level: Level, json: boolean): void {
  currentLevel = level;
  jsonOutput = json;
}

function write(level: Exclude<Level, 'silent'>, message: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (jsonOutput) {
    stream.write(JSON.stringify({ time: new Date().toISOString(), level, message, ...meta }) + '\n');
  } else {
    const extra = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    stream.write(`[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}${extra}\n`);
  }
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => write('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => write('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write('error', m, meta),
};
