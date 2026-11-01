import { describe, expect, it } from 'vitest';
import { redactDetail, redactUrl, redactUrlsInText } from '../src/shared/redact.ts';

describe('ocultar la contraseña de la URL de la base de datos', () => {
  it('sustituye la contraseña y conserva usuario, host, puerto y base', () => {
    expect(redactUrl('postgres://precintum:s3cret@db.example:5432/precintum')).toBe(
      'postgres://precintum:***@db.example:5432/precintum',
    );
    expect(redactUrl('postgresql://u:p%40ss@localhost/db?sslmode=require')).toBe(
      'postgresql://u:***@localhost/db?sslmode=require',
    );
  });

  it('deja intactas las URL sin contraseña y las rutas de PGlite', () => {
    expect(redactUrl('postgres://precintum@db.example/precintum')).toBe(
      'postgres://precintum@db.example/precintum',
    );
    expect(redactUrl('pglite:./data/precintum')).toBe('pglite:./data/precintum');
    expect(redactUrl('pglite:memory')).toBe('pglite:memory');
  });

  it('oculta credenciales y valores de consulta y fragmento en endpoints HTTP y WebSocket', () => {
    expect(
      redactUrl(
        'https://operator:fixture-password@tsa.example/tsr?api_key=fixture-key&mode=dev#fixture-token',
      ),
    ).toBe('https://***:***@tsa.example/tsr?api_key=***&mode=***#***');
    expect(redactUrl('wss://fixture-token@relay.example/feed?auth=fixture-auth')).toBe(
      'wss://***@relay.example/feed?auth=***',
    );
  });

  it('oculta una contraseña PostgreSQL en parámetros conservando opciones de conexión', () => {
    expect(
      redactUrl('postgres://operator@db.example/db?password=fixture-password&sslmode=require'),
    ).toBe('postgres://operator@db.example/db?password=***&sslmode=require');
  });

  it('no imprime datos de una URL malformada que no se puede analizar', () => {
    const redacted = redactUrl('https://operator:fixture-password@[broken?key=fixture-token');
    expect(redacted).not.toContain('fixture-password');
    expect(redacted).not.toContain('fixture-token');
  });

  it('conserva las URLs de endpoints sin credenciales ni consulta', () => {
    for (const url of [
      'https://tsa.example/tsr',
      'wss://relay.example',
      'WSS://relay.example:443/',
    ]) {
      expect(redactUrl(url)).toBe(url);
    }
  });

  it.each(['fixture-"private-tail', "fixture-'private-tail", 'fixture-<private-tail>'])(
    'no deja visible la cola de un token con delimitadores dentro de la URL: %s',
    (token) => {
      const redacted = redactUrlsInText(`error en https://endpoint.example/api?key=${token}`);
      expect(redacted).toContain('endpoint.example');
      expect(redacted).not.toContain('private-tail');
    },
  );

  it('censura una alerta antes de serializarla sin cambiar tipos ni el objeto original', () => {
    const detail = {
      eventId: 'ab'.repeat(32),
      accepted: false,
      attempts: 2,
      optional: null,
      outcomes: [{ message: 'error en https://endpoint.example/api?key=fixture-"private-tail' }],
    };
    const before = JSON.stringify(detail);
    const shown = JSON.stringify(redactDetail(detail));
    expect(shown).not.toContain('private-tail');
    expect(JSON.parse(shown)).toMatchObject({
      eventId: detail.eventId,
      accepted: false,
      attempts: 2,
      optional: null,
      outcomes: [{ message: expect.stringContaining('endpoint.example') }],
    });
    expect(JSON.stringify(detail)).toBe(before);
  });
});
