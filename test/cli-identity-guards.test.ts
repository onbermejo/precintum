import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import type { EvidencePackage } from '../src/application/export-service.ts';
import { cmdBatchClose } from '../src/cli/batch-commands.ts';
import { cmdExport } from '../src/cli/export-commands.ts';
import { cmdRun } from '../src/cli/run-commands.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import { identityFromSecretKey, npubEncode, nsecDecode } from '../src/domain/identity/keys.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import type { SqlClient } from '../src/infra/db/sql-client.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { type Config, loadConfig } from '../src/shared/config.ts';
import { fakeOts, fakeTsa } from './support/fake-anchors.ts';

const dbGuard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/infra/db/open.ts', () => ({ openSqlClient: dbGuard.open }));
const realDb =
  await vi.importActual<typeof import('../src/infra/db/open.ts')>('../src/infra/db/open.ts');

const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
const AGENT = identityFromSecretKey(nsecDecode(NSEC));
const NPUB = npubEncode(AGENT.pubkey);
const OTHER = identityFromSecretKey(
  nsecDecode('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'),
);
const OTHER_NPUB = npubEncode(OTHER.pubkey);
const T0 = 1_700_000_400;
const WINDOW = 600;
const HASH = 'ab'.repeat(32);
const DB_SENTINEL = new Error('se alcanzó la apertura de la base de datos');

function config(keys: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    PRECINTUM_DATABASE_URL: 'pglite:memory',
    PRECINTUM_INGEST_TOKEN: 'token-de-prueba-suficientemente-largo',
    PRECINTUM_DEDUP_KEY: '03'.repeat(32),
    PRECINTUM_TSA_URL: 'https://tsa.example/tsr',
    PRECINTUM_BATCH_WINDOW_SECONDS: String(WINDOW),
    ...keys,
  });
}

const commands = [
  { name: 'run', invoke: (cfg: Config) => cmdRun(cfg, undefined, undefined) },
  { name: 'batch close', invoke: (cfg: Config) => cmdBatchClose(cfg) },
  {
    name: 'export',
    invoke: (cfg: Config) => cmdExport(cfg, String(T0), String(T0 + WINDOW), undefined),
  },
];

describe('identidad configurada en los comandos', () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    dbGuard.open.mockReset().mockRejectedValue(DB_SENTINEL);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it.each(commands)(
    '$name rechaza NPUB ajena antes de abrir la base de datos',
    async ({ invoke }) => {
      await expect(
        invoke(config({ PRECINTUM_NSEC: NSEC, PRECINTUM_NPUB: OTHER_NPUB })),
      ).rejects.toThrow(/no corresponde/);
      expect(dbGuard.open).not.toHaveBeenCalled();
    },
  );

  it.each(commands.slice(0, 2))(
    '$name con claves coherentes alcanza la base de datos',
    async ({ invoke }) => {
      await expect(invoke(config({ PRECINTUM_NSEC: NSEC, PRECINTUM_NPUB: NPUB }))).rejects.toBe(
        DB_SENTINEL,
      );
      expect(dbGuard.open).toHaveBeenCalledExactlyOnceWith('pglite:memory');
    },
  );

  describe('exportación real en memoria', () => {
    let db: SqlClient | undefined;
    let closed = false;

    beforeEach(async () => {
      db = undefined;
      closed = false;
      const client = await realDb.openSqlClient('pglite:memory');
      db = client;
      const close = client.close.bind(client);
      client.close = async () => {
        closed = true;
        await close();
      };
      await migrate(client);
      dbGuard.open.mockResolvedValue(client);
    }, 60_000);

    afterEach(async () => {
      if (db && !closed) await db.close();
    });

    async function exported(cfg: Config): Promise<EvidencePackage> {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await cmdExport(cfg, String(T0), String(T0 + WINDOW), undefined);
      expect(log).toHaveBeenCalledTimes(1);
      expect(closed).toBe(true);
      return JSON.parse(String(log.mock.calls[0]?.[0])) as EvidencePackage;
    }

    it.each([
      { name: 'NPUB sola', keys: { PRECINTUM_NPUB: NPUB }, expected: AGENT.pubkey },
      { name: 'NSEC sola', keys: { PRECINTUM_NSEC: NSEC }, expected: AGENT.pubkey },
      {
        name: 'par coherente',
        keys: { PRECINTUM_NSEC: NSEC, PRECINTUM_NPUB: NPUB },
        expected: AGENT.pubkey,
      },
      { name: 'sin claves', keys: {}, expected: null },
    ])('conserva la identidad de $name en un paquete vacío', async ({ keys, expected }) => {
      const pkg = await exported(config(keys));
      expect(pkg.batches).toEqual([]);
      expect(pkg.agentPubkey).toBe(expected);
      expect(process.exitCode).toBeUndefined();
    });

    it('con NPUB ajena conserva esa identidad y falla al verificar el lote firmado', async () => {
      if (!db) throw new Error('base de datos no preparada');
      const evidence = new SqlEvidenceStore(db);
      const batches = new SqlBatchStore(db);
      await evidence.receipts.append(
        nextReceipt(null, { policy: HASH, verifier: HASH, result: 'over_18', at: T0 + 60 }),
      );
      const service = new BatchService({
        evidence,
        batches,
        tx: evidenceUnitOfWork(db),
        identity: AGENT,
        policy: HASH,
        windowSeconds: WINDOW,
        tsa: fakeTsa({ genTime: () => new Date((T0 + WINDOW + 10) * 1000) }),
        ots: fakeOts({ completeOnUpgrade: () => true }),
      });
      await service.closeDueWindows(T0 + WINDOW + 10);
      await service.anchorPending();

      const pkg = await exported(config({ PRECINTUM_NPUB: OTHER_NPUB }));
      expect(pkg.agentPubkey).toBe(OTHER.pubkey);
      expect(pkg.batches[0]?.event.pubkey).toBe(AGENT.pubkey);
      expect(process.exitCode).toBe(1);
    });
  });
});
