import pino, { type DestinationStream } from 'pino';

/**
 * Logger único del proceso. En desarrollo se puede hacer legible con:
 *   node src/cli/index.ts ... | pnpm exec pino-pretty
 * Nunca se loguean claves privadas ni datos de usuario: solo ids, pubkeys y hashes.
 *
 * LOG_LEVEL se valida aquí a mano (y también en config.ts) porque el logger se importa
 * antes de que la configuración se haya cargado: un valor inválido no debe tirar el
 * proceso con un stack trace de pino, sino caer a "info".
 */
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

/** Rutas que pino censura antes de escribir. Cubren la clave en raíz, anidada un nivel y en config/env. */
export const REDACT_PATHS = [
  'nsec',
  'secretKey',
  'PRECINTUM_NSEC',
  'PRECINTUM_DEDUP_KEY',
  'PRECINTUM_TSA_PASSWORD',
  'PRECINTUM_INGEST_TOKEN',
  'password',
  'authorization',
  '*.nsec',
  '*.secretKey',
  '*.PRECINTUM_NSEC',
  '*.PRECINTUM_DEDUP_KEY',
  '*.PRECINTUM_TSA_PASSWORD',
  '*.PRECINTUM_INGEST_TOKEN',
  '*.password',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'env.PRECINTUM_NSEC',
  'config.PRECINTUM_NSEC',
];

export function resolveLevel(requested: string | undefined): string {
  return requested && LEVELS.has(requested) ? requested : 'info';
}

export interface CreateLoggerOptions {
  level?: string | undefined;
  /** Destino alternativo (tests). Por defecto, stdout. */
  destination?: DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions = {}) {
  const options = {
    level: resolveLevel(opts.level),
    base: { app: 'precintum' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export const logger = createLogger({ level: process.env.LOG_LEVEL });

export type Logger = typeof logger;
