import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/shared/config.ts';

const NSEC_OK = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';

describe('configuración (zod)', () => {
  it('con entorno vacío aplica los valores por defecto: cuatro relays y nivel info', () => {
    const cfg = loadConfig({});
    expect(cfg.PRECINTUM_RELAYS).toEqual([
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://relay.damus.io',
      'wss://nostr-pub.wellorder.net',
    ]);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.PRECINTUM_NSEC).toBeUndefined();
  });

  it('acepta un nsec bien formado y lo deja tal cual', () => {
    expect(loadConfig({ PRECINTUM_NSEC: NSEC_OK }).PRECINTUM_NSEC).toBe(NSEC_OK);
  });

  it('rechaza un nsec mal formado con un mensaje que nombra la variable', () => {
    expect(() => loadConfig({ PRECINTUM_NSEC: NSEC_OK.slice(0, -1) })).toThrow(/PRECINTUM_NSEC/);
    expect(() => loadConfig({ PRECINTUM_NSEC: 'npub1abc' })).toThrow(/nsec válida/);
  });

  it('parsea PRECINTUM_RELAYS con espacios y entradas vacías, y exige ws:// o wss://', () => {
    const cfg = loadConfig({ PRECINTUM_RELAYS: ' wss://a.example ,, ws://127.0.0.1:7777 ' });
    expect(cfg.PRECINTUM_RELAYS).toEqual(['wss://a.example', 'ws://127.0.0.1:7777']);
    expect(() => loadConfig({ PRECINTUM_RELAYS: 'https://a.example' })).toThrow(
      /ws:\/\/ o wss:\/\//,
    );
    expect(() => loadConfig({ PRECINTUM_RELAYS: '  ,  ' })).toThrow(/PRECINTUM_RELAYS/);
  });

  it.each([
    { name: 'exactos', urls: 'wss://relay.example,wss://relay.example' },
    { name: 'equivalentes', urls: 'WSS://RELAY.EXAMPLE:443/,wss://relay.example' },
  ])('rechaza relays duplicados $name aunque el quórum sea uno', ({ urls }) => {
    expect(() => loadConfig({ PRECINTUM_RELAYS: urls, PRECINTUM_WITNESS_QUORUM: '1' })).toThrow(
      /PRECINTUM_RELAYS/,
    );
  });

  it('rechaza un quórum de tres cuando solo hay dos direcciones únicas', () => {
    expect(() =>
      loadConfig({
        PRECINTUM_RELAYS: 'wss://a.example,wss://b.example',
        PRECINTUM_WITNESS_QUORUM: '3',
      }),
    ).toThrow(/PRECINTUM_WITNESS_QUORUM/);
  });

  it('conserva las URLs originales y distingue rutas y parámetros de consulta', () => {
    const urls = [
      'WSS://RELAY.EXAMPLE:443/feed?mode=a',
      'wss://relay.example/feed?mode=b',
      'wss://relay.example/other?mode=a',
    ];
    const cfg = loadConfig({
      PRECINTUM_RELAYS: urls.join(','),
      PRECINTUM_WITNESS_QUORUM: '3',
    });
    expect(cfg.PRECINTUM_RELAYS).toEqual(urls);
  });

  it('una URL inválida produce el error de configuración y no una excepción de URL', () => {
    expect(() => loadConfig({ PRECINTUM_RELAYS: 'no-es-url' })).toThrow(
      /Configuración inválida:[\s\S]*PRECINTUM_RELAYS[\s\S]*ws:\/\/ o wss:\/\//,
    );
  });

  it('rechaza un LOG_LEVEL desconocido y acepta los de pino', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(loadConfig({ LOG_LEVEL: 'silent' }).LOG_LEVEL).toBe('silent');
  });

  it('las credenciales de la TSA van juntas o ninguna', () => {
    expect(
      loadConfig({ PRECINTUM_TSA_USER: 'u', PRECINTUM_TSA_PASSWORD: 'p' }).PRECINTUM_TSA_USER,
    ).toBe('u');
    expect(loadConfig({}).PRECINTUM_TSA_USER).toBeUndefined();
    expect(() => loadConfig({ PRECINTUM_TSA_USER: 'u' })).toThrow(/van juntas/);
    expect(() => loadConfig({ PRECINTUM_TSA_PASSWORD: 'p' })).toThrow(/van juntas/);
  });

  it('PRECINTUM_NPUB acepta un npub bien formado y rechaza otra cosa', () => {
    const npub = 'npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9';
    expect(loadConfig({ PRECINTUM_NPUB: npub }).PRECINTUM_NPUB).toBe(npub);
    expect(() => loadConfig({ PRECINTUM_NPUB: NSEC_OK })).toThrow(/npub válida/);
    expect(loadConfig({ PRECINTUM_ROOT_NPUB: npub }).PRECINTUM_ROOT_NPUB).toBe(npub);
    expect(() => loadConfig({ PRECINTUM_ROOT_NPUB: 'x' })).toThrow(/PRECINTUM_ROOT_NPUB/);
  });

  it('con credenciales, la TSA tiene que ser https (irían en claro por http)', () => {
    const creds = { PRECINTUM_TSA_USER: 'u', PRECINTUM_TSA_PASSWORD: 'p' };
    expect(() => loadConfig({ ...creds, PRECINTUM_TSA_URL: 'http://tsa.example/tsr' })).toThrow(
      /https/,
    );
    expect(
      loadConfig({ ...creds, PRECINTUM_TSA_URL: 'https://tsa.example/tsr' }).PRECINTUM_TSA_URL,
    ).toBe('https://tsa.example/tsr');
    // Sin credenciales, http sigue valiendo (una TSA interna de laboratorio).
    expect(loadConfig({ PRECINTUM_TSA_URL: 'http://tsa.lab/tsr' }).PRECINTUM_TSA_URL).toBe(
      'http://tsa.lab/tsr',
    );
  });

  it('una variable vacía cuenta como ausente (caso `PRECINTUM_NSEC=` en .env)', () => {
    const cfg = loadConfig({
      PRECINTUM_NSEC: '',
      PRECINTUM_RELAYS: '',
      LOG_LEVEL: '',
      PRECINTUM_DEDUP_KEY: '',
    });
    expect(cfg.PRECINTUM_NSEC).toBeUndefined();
    expect(cfg.PRECINTUM_RELAYS).toHaveLength(4);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.PRECINTUM_DEDUP_KEY).toBeUndefined();
  });
});
