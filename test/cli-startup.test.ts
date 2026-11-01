import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdRun } from '../src/cli/run-commands.ts';
import { cmdServe } from '../src/cli/serve-commands.ts';
import { loadConfig } from '../src/shared/config.ts';

const handles = vi.hoisted(() => ({
  open: vi.fn(),
  migrate: vi.fn(),
  createRelays: vi.fn(),
  closeRelays: vi.fn(),
  ingest: vi.fn(),
  panel: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  head: vi.fn(),
  range: vi.fn(),
  checkPresence: vi.fn(),
  warn: vi.fn(),
  presence: undefined as ((now: number) => Promise<void>) | undefined,
}));
vi.mock('../src/infra/db/open.ts', () => ({ openSqlClient: handles.open }));
vi.mock('../src/infra/db/migrations.ts', () => ({ migrate: handles.migrate }));
vi.mock('../src/infra/db/sql-batch-store.ts', () => ({
  SqlBatchStore: class {
    head = handles.head;
    range = handles.range;
  },
}));
vi.mock('../src/application/witness-verifier.ts', () => ({
  checkPresence: handles.checkPresence,
  detectDeletions: vi.fn(),
}));
vi.mock('../src/shared/logger.ts', () => ({ logger: { warn: handles.warn } }));
vi.mock('../src/infra/relay/relay-pool.ts', () => ({
  createRelayClients: handles.createRelays,
  closeAll: handles.closeRelays,
}));
vi.mock('../src/infra/http/ingest-server.ts', () => ({ startIngest: handles.ingest }));
vi.mock('../src/infra/http/panel-server.ts', () => ({
  startPanel: handles.panel,
  isLoopback: (host: string) => host === '127.0.0.1',
}));
vi.mock('../src/application/runner.ts', () => ({
  Runner: class {
    constructor(deps: { tasks: { presence: (now: number) => Promise<void> } }) {
      handles.presence = deps.tasks.presence;
    }
    start = handles.start;
    stop = handles.stop;
    healthy = () => true;
  },
}));

const config = () =>
  loadConfig({
    PRECINTUM_NSEC: 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen',
    PRECINTUM_DATABASE_URL: 'pglite:memory',
    PRECINTUM_DEDUP_KEY: '03'.repeat(32),
    PRECINTUM_INGEST_TOKEN: 'synthetic-startup-test-token',
    PRECINTUM_TSA_URL: 'https://tsa.example/tsr',
  });

describe('CLI: liberación de recursos si el arranque falla', () => {
  const order: string[] = [];
  const dbClose = vi.fn();
  const ingestClose = vi.fn();
  const panelClose = vi.fn();
  let signals: Map<string, () => void>;

  beforeEach(() => {
    vi.resetAllMocks();
    order.length = 0;
    signals = new Map();
    handles.presence = undefined;
    dbClose.mockImplementation(async () => {
      order.push('db');
    });
    ingestClose.mockImplementation(async () => {
      order.push('ingest');
    });
    panelClose.mockImplementation(async () => {
      order.push('panel');
    });
    handles.open.mockResolvedValue({ close: dbClose });
    handles.migrate.mockResolvedValue(undefined);
    handles.createRelays.mockReturnValue([
      { url: 'wss://one.example' },
      { url: 'wss://two.example' },
    ]);
    handles.closeRelays.mockImplementation(() => {
      order.push('relays');
    });
    handles.ingest.mockResolvedValue({ port: 8788, close: ingestClose });
    handles.panel.mockResolvedValue({ port: 8787, close: panelClose });
    handles.stop.mockResolvedValue(undefined);
    handles.head.mockResolvedValue(null);
    handles.range.mockResolvedValue([]);
    handles.checkPresence.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT' || event === 'SIGTERM') signals.set(event, listener as () => void);
      return process;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('rechaza un puerto de panel inválido antes de abrir la base o la ingesta', async () => {
    await expect(cmdRun(config(), 'nope', undefined)).rejects.toThrow('--port');
    expect(handles.open).not.toHaveBeenCalled();
    expect(handles.ingest).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'run', invoke: () => cmdRun(config(), undefined, undefined) },
    { name: 'serve', invoke: () => cmdServe(config(), undefined, undefined) },
  ])('$name cierra la base si una migración falla', async ({ invoke }) => {
    const failure = new Error('synthetic migration failure');
    handles.migrate.mockRejectedValue(failure);
    await expect(invoke()).rejects.toBe(failure);
    expect(dbClose).toHaveBeenCalledOnce();
    expect(handles.panel).not.toHaveBeenCalled();
  });

  it('run libera relays y base si no puede abrir la ingesta', async () => {
    const failure = new Error('synthetic ingest bind failure');
    handles.ingest.mockRejectedValue(failure);
    await expect(cmdRun(config(), undefined, undefined)).rejects.toBe(failure);
    expect(handles.closeRelays).toHaveBeenCalledOnce();
    expect(dbClose).toHaveBeenCalledOnce();
    expect(handles.start).not.toHaveBeenCalled();
  });

  it('run cierra la ingesta antes de cerrar la base si el panel no puede escuchar', async () => {
    const failure = new Error('synthetic panel EADDRINUSE');
    handles.panel.mockRejectedValue(failure);
    await expect(cmdRun(config(), undefined, undefined)).rejects.toBe(failure);
    expect(ingestClose).toHaveBeenCalledOnce();
    expect(dbClose).toHaveBeenCalledOnce();
    expect(order.indexOf('ingest')).toBeLessThan(order.indexOf('db'));
    expect(handles.start).not.toHaveBeenCalled();
    expect(signals.size).toBe(0);
  });

  it('intenta liberar los demás recursos y conserva el error original aunque un cierre falle', async () => {
    const failure = new Error('synthetic panel bind failure');
    handles.panel.mockRejectedValue(failure);
    ingestClose.mockRejectedValue(new Error('synthetic close failure'));
    await expect(cmdRun(config(), undefined, undefined)).rejects.toBe(failure);
    expect(handles.closeRelays).toHaveBeenCalledOnce();
    expect(dbClose).toHaveBeenCalledOnce();
  });

  it('serve libera la base si no puede abrir el panel', async () => {
    const failure = new Error('synthetic panel bind failure');
    handles.panel.mockRejectedValue(failure);
    await expect(cmdServe(config(), undefined, undefined)).rejects.toBe(failure);
    expect(dbClose).toHaveBeenCalledOnce();
  });

  it('run oculta credenciales de las URLs al registrar un testigo sin respuesta', async () => {
    const endpoint = 'wss://reader:synthetic-password@relay.example/ws?token=synthetic-token';
    const cfg = config();
    cfg.PRECINTUM_RELAYS = [endpoint];
    cfg.PRECINTUM_WITNESS_QUORUM = 1;
    handles.head.mockResolvedValue({ seq: 1 });
    handles.range.mockResolvedValue([{ eventId: 'ab'.repeat(32) }]);
    handles.checkPresence.mockResolvedValue([{ relay: endpoint, status: 'unreachable' }]);
    await cmdRun(cfg, undefined, undefined);
    await handles.presence?.(1_700_000_000);
    expect(handles.warn).toHaveBeenCalledOnce();
    const printed = JSON.stringify(handles.warn.mock.calls);
    expect(printed).toContain('relay.example');
    expect(printed).not.toContain('synthetic-password');
    expect(printed).not.toContain('synthetic-token');
    expect(cfg.PRECINTUM_RELAYS).toEqual([endpoint]);
  });

  it('un arranque correcto mantiene recursos abiertos hasta recibir la señal de parada', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await cmdRun(config(), undefined, undefined);
    expect(dbClose).not.toHaveBeenCalled();
    expect(ingestClose).not.toHaveBeenCalled();
    expect(handles.start).toHaveBeenCalledOnce();
    expect(signals.has('SIGTERM')).toBe(true);
    signals.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(handles.stop).toHaveBeenCalledOnce();
    expect(ingestClose).toHaveBeenCalledOnce();
    expect(panelClose).toHaveBeenCalledOnce();
    expect(dbClose).toHaveBeenCalledOnce();
  });
});
