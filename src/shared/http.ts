/**
 * `fetch` con plazo. Sin él, una TSA o un calendario OpenTimestamps que aceptan la conexión y
 * no contestan dejan el cierre de lotes colgado para siempre (el planificador de `precintum run`
 * no volvería a cerrar ventanas). El plazo por defecto es generoso: estas peticiones son pocas
 * y no urgentes, pero tienen que terminar.
 */
import { redactUrl, redactUrlsInText } from './redact.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      const plazo = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
      throw new Error(`${redactUrl(url)}: sin respuesta en ${plazo}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    const redacted = redactUrlsInText(message.split(url).join(redactUrl(url)));
    if (redacted !== message) {
      const safe = new Error(redacted);
      if (err instanceof Error) safe.name = err.name;
      throw safe;
    }
    throw err;
  }
}
