import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { calendarSubmit, calendarUpgrade } from '../src/infra/ots/ots.ts';
import { calendarOtsClient } from '../src/infra/ots/ots-client.ts';
import { RelayClient, RelayError } from '../src/infra/relay/relay-client.ts';
import { requestTimestamp } from '../src/infra/tsa/rfc3161.ts';
import { type FetchLike, fetchWithTimeout } from '../src/shared/http.ts';
import { createLogger } from '../src/shared/logger.ts';

const ENDPOINT = 'https://operator:fixture-password@endpoint.example/api?key=fixture-token';
const DIGEST = new Uint8Array(32);

function expectRedacted(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const message = String(error);
  expect(message).not.toContain('fixture-password');
  expect(message).not.toContain('fixture-token');
  expect(message).toContain('endpoint.example');
}

describe('errores de endpoints sin divulgar sus credenciales', () => {
  it('censura el timeout sin cambiar la URL enviada al fetch', async () => {
    let seen = '';
    const timeout: FetchLike = async (url) => {
      seen = url;
      throw new DOMException('timeout de prueba', 'TimeoutError');
    };
    const error = await fetchWithTimeout(timeout, ENDPOINT).catch((e: unknown) => e);
    expectRedacted(error);
    expect(String(error)).toContain('sin respuesta');
    expect(seen).toBe(ENDPOINT);
  });

  it('censura una URL que el propio error de fetch haya incluido', async () => {
    const down: FetchLike = async (url) => {
      throw new TypeError(`falló la conexión a ${url}`);
    };
    expectRedacted(await fetchWithTimeout(down, ENDPOINT).catch((e: unknown) => e));
  });

  it.each([401, 503])('censura el error HTTP %i de una TSA', async (status) => {
    let seen = '';
    const fake: FetchLike = async (url) => {
      seen = url;
      return new Response(null, { status });
    };
    const error = await requestTimestamp(DIGEST, ENDPOINT, fake).catch((e: unknown) => e);
    expectRedacted(error);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(seen).toBe(ENDPOINT);
  });

  it.each(['submit', 'upgrade'] as const)(
    'censura el error HTTP del calendario: %s',
    async (mode) => {
      const calendar = 'https://endpoint.example/api';
      let seen = '';
      const fake: FetchLike = async (url) => {
        seen = url;
        return new Response(null, { status: 503 });
      };
      const error = await (mode === 'submit'
        ? calendarSubmit(calendar, DIGEST, fake)
        : calendarUpgrade(calendar, DIGEST, fake)
      ).catch((e: unknown) => e);
      expectRedacted(error);
      expect(seen).toContain(calendar);
    },
  );

  it('censura las URLs del error agregado de todos los calendarios', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error(`error de prueba en ${ENDPOINT}`);
    });
    try {
      const client = calendarOtsClient(['https://endpoint.example']);
      expectRedacted(await client.submit(DIGEST).catch((e: unknown) => e));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('censura RelayError y el binding del logger, conservando la identidad operativa del relay', () => {
    const url = ENDPOINT.replace('https:', 'wss:');
    const logger = createLogger({ level: 'silent' });
    const child = vi.spyOn(logger, 'child');
    try {
      const client = new RelayClient(url, { logger });
      const error = new RelayError(url, 'error de conexión', 'connect');
      expectRedacted(error);
      expect(JSON.stringify(child.mock.calls[0]?.[0])).not.toContain('fixture-token');
      expect(JSON.stringify(child.mock.calls[0]?.[0])).not.toContain('fixture-password');
      expect(client.url).toBe(url);
      expect(error.relay).toBe(url);
    } finally {
      child.mockRestore();
    }
  });

  it('censura NOTICE y frames inválidos completos antes de truncar el diagnóstico', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger({ level: 'info', destination });
    const client = new RelayClient('wss://relay.example', { logger });
    const receive = (raw: string) =>
      (client as unknown as { onMessage(raw: string): void }).onMessage(raw);
    const url = 'https://endpoint.example/api?key=fixture-"private-tail';
    receive(JSON.stringify(['NOTICE', `fallo en ${url}`]));
    receive(JSON.stringify(['UNSUPPORTED', `${'x'.repeat(120)} ${url}`]));
    receive(`not-json ${'x'.repeat(120)} ${url}`);
    const shown = lines.join('');
    expect(shown).not.toContain('private-tail');
    expect(shown).not.toContain('fixture-');
    expect(lines).toHaveLength(3);
  });
});
