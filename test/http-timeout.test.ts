import { describe, expect, it } from 'vitest';
import { type FetchLike, fetchWithTimeout } from '../src/shared/http.ts';

/** Un fetch que nunca contesta pero sí obedece a la señal de aborto, como el de Node. */
const hangs: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

describe('fetch con plazo (TSA y calendarios OpenTimestamps)', () => {
  it('aborta la petición que no contesta y dice cuánto esperó', async () => {
    await expect(fetchWithTimeout(hangs, 'https://tsa.example/tsr', {}, 20)).rejects.toThrow(
      'https://tsa.example/tsr: sin respuesta en 20 ms',
    );
    await expect(fetchWithTimeout(hangs, 'https://cal.example', {}, 1_000)).rejects.toThrow(
      /sin respuesta en 1 s/,
    );
  });

  it('pasa una señal de aborto al fetch y conserva el resto de opciones', async () => {
    let seen: RequestInit | undefined;
    const spy: FetchLike = async (_url, init) => {
      seen = init;
      return new Response('ok');
    };
    const res = await fetchWithTimeout(spy, 'https://x.example', {
      method: 'POST',
      headers: { Accept: 'application/timestamp-reply' },
    });
    expect(await res.text()).toBe('ok');
    expect(seen?.method).toBe('POST');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal?.aborted).toBe(false);
  });

  it('los demás errores (red, DNS) pasan tal cual', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(fetchWithTimeout(down, 'https://x.example')).rejects.toThrow('fetch failed');
  });
});
