/**
 * Política de reintentos y quórum. Funciones puras, sin IO, para que se puedan probar
 * exhaustivamente y para que la decisión "¿reintento o me rindo?" esté en un solo sitio.
 */

export type FailureClass = 'retry' | 'final';

/** Prefijos estandarizados de OK/CLOSED que indican un rechazo definitivo. */
const FINAL_PREFIXES = new Set(['blocked', 'invalid', 'pow', 'restricted', 'mute']);
/** Prefijos que indican un problema transitorio del relay. */
const RETRY_PREFIXES = new Set(['rate-limited', 'error']);

/**
 * Clasifica un fallo de publicación a partir del código tipado del cliente y del mensaje
 * del relay. Regla: solo se reintenta lo que puede cambiar solo (red, saturación, error del
 * servidor). Un rechazo por política no cambia por insistir.
 */
export function classifyFailure(code: string, message: string): FailureClass {
  switch (code) {
    case 'timeout':
    case 'closed':
    case 'connect':
      return 'retry';
    case 'restricted':
    case 'auth-required':
      // Si llega aquí es que el cliente no pudo autenticarse (sin identidad o rechazado).
      return 'final';
    case 'rejected': {
      const prefix = /^([a-z][a-z-]*):/.exec(message)?.[1];
      if (prefix && RETRY_PREFIXES.has(prefix)) return 'retry';
      if (prefix && FINAL_PREFIXES.has(prefix)) return 'final';
      // Sin prefijo estandarizado no sabemos: un reintento es barato, la pérdida no.
      return 'retry';
    }
    default:
      return 'retry';
  }
}

export const DEFAULT_BACKOFF = { baseSeconds: 30, capSeconds: 3_600, maxAttempts: 20 } as const;

/**
 * Backoff exponencial con jitter (±20 %) y tope. `attempts` es el número de intentos ya
 * hechos. `random` se inyecta para que los tests sean deterministas.
 */
export function backoffSeconds(
  attempts: number,
  random: () => number = Math.random,
  opts: { baseSeconds?: number; capSeconds?: number } = {},
): number {
  const base = opts.baseSeconds ?? DEFAULT_BACKOFF.baseSeconds;
  const cap = opts.capSeconds ?? DEFAULT_BACKOFF.capSeconds;
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempts));
  const jitter = 0.8 + 0.4 * random();
  return Math.max(1, Math.round(raw * jitter));
}

/** N de M: ¿han aceptado al menos `quorum` testigos? */
export function quorumMet(acceptedCount: number, quorum: number): boolean {
  if (!Number.isInteger(quorum) || quorum < 1) throw new Error('el quórum debe ser un entero >= 1');
  return acceptedCount >= quorum;
}
