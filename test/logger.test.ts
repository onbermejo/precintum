import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, resolveLevel } from '../src/shared/logger.ts';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe('logger', () => {
  it('un LOG_LEVEL inválido cae a info en vez de romper el arranque', () => {
    expect(resolveLevel('verbose')).toBe('info');
    expect(resolveLevel(undefined)).toBe('info');
    expect(resolveLevel('debug')).toBe('debug');
    expect(() => createLogger({ level: 'lo-que-sea' })).not.toThrow();
  });

  it('censura claves privadas en raíz, anidadas y en config/env', () => {
    const { stream, lines } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    const nsec = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
    log.info({ nsec, secretKey: 'abc', PRECINTUM_DEDUP_KEY: 'ff'.repeat(32) }, 'raíz');
    log.info({ identity: { nsec, secretKey: 'abc' } }, 'anidado');
    log.info({ config: { PRECINTUM_NSEC: nsec }, env: { PRECINTUM_NSEC: nsec } }, 'config y env');
    const out = lines.join('');
    expect(out).not.toContain(nsec);
    expect(out).not.toContain('"abc"');
    expect(out).not.toContain('ff'.repeat(32));
    expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(7);
    expect(out).toContain('"app":"precintum"');
  });

  it('censura el token de la ingesta y la cabecera de autorización', () => {
    const { stream, lines } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    const token = 'tok-0123456789abcdef-secreto';
    log.info({ PRECINTUM_INGEST_TOKEN: token }, 'raíz');
    log.info({ config: { PRECINTUM_INGEST_TOKEN: token } }, 'config');
    log.info({ authorization: `Bearer ${token}` }, 'cabecera');
    log.info({ req: { headers: { authorization: `Bearer ${token}` } } }, 'petición');
    expect(lines.join('')).not.toContain(token);
  });

  it('deja pasar lo que sí puede loguearse: ids, pubkeys, hashes', () => {
    const { stream, lines } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    log.info({ eventId: '11'.repeat(32), pubkey: '22'.repeat(32) }, 'ok');
    expect(lines.join('')).toContain('11'.repeat(32));
  });
});
