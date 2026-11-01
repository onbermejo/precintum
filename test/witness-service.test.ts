import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishToRelays, WitnessWorker } from '../src/application/witness-service.ts';
import {
  checkPresence,
  deletionFilters,
  detectDeletions,
  keyDirectoryAddress,
} from '../src/application/witness-verifier.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlWitnessStore } from '../src/infra/db/sql-witness-store.ts';
import { RelayClient } from '../src/infra/relay/relay-client.ts';
import { AppendOnlyFile } from '../src/infra/witness/append-only-file.ts';
import { newIdentity, note } from './support/fixtures.ts';
import { MiniRelay } from './support/mini-relay.ts';

const agent = newIdentity();
const T0 = 1_700_000_000;

describe('capa de testigos: outbox, quórum, reintentos, verificación', () => {
  let db: PgliteSqlClient;
  let store: SqlWitnessStore;
  let relays: MiniRelay[] = [];
  let clients: RelayClient[] = [];
  let dir: string;
  let mode: string | null = null; // controla el relay "caprichoso"

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    store = new SqlWitnessStore(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    mode = null;
    dir = await mkdtemp(join(tmpdir(), 'acta-witness-'));
    await db.query('DELETE FROM witness_checks');
    await db.query('DELETE FROM witness_publications');
    await db.query('DELETE FROM witness_alerts');
    await db.query('DELETE FROM witness_outbox');
    relays = [
      new MiniRelay(), // bueno
      new MiniRelay({ reject: () => mode }), // caprichoso: rechaza según `mode`
      new MiniRelay({ reject: () => 'blocked: not in allowlist' }), // hostil
    ];
    const urls = await Promise.all(relays.map((r) => r.start()));
    clients = urls.map((u) => new RelayClient(u, { publishTimeoutMs: 500, eoseTimeoutMs: 500 }));
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    await Promise.all(relays.map((r) => r.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  function worker(
    quorum: number,
    extra: Partial<ConstructorParameters<typeof WitnessWorker>[0]> = {},
  ) {
    return new WitnessWorker({
      store,
      relays: clients,
      quorum,
      archive: new AppendOnlyFile(join(dir, 'archive.jsonl')),
      now: () => T0,
      random: () => 0.5,
      ...extra,
    });
  }

  it('publishToRelays devuelve un resultado por relay, clasificando los fallos', async () => {
    mode = 'rate-limited: slow down';
    const out = await publishToRelays(note(agent, 'x'), clients);
    expect(out.map((o) => o.ok)).toEqual([true, false, false]);
    expect(out[1]).toMatchObject({ code: 'rejected', failure: 'retry' });
    expect(out[2]).toMatchObject({ code: 'rejected', failure: 'final' });
  });

  it('quórum 2 de 3: dos aceptan, uno bloquea → publicado en el primer pase, con telemetría', async () => {
    const w = worker(2);
    const e = note(agent, 'lote 1');
    expect(await w.enqueue(e)).toBe(true);
    expect(await w.enqueue(e)).toBe(false); // idempotente
    const s = await w.runOnce(T0);
    expect(s).toEqual({ processed: 1, published: 1, pending: 0, failed: 0 });
    expect((await store.outbox.get(e.id))?.status).toBe('published');
    expect(await store.publications.acceptedRelays(e.id)).toHaveLength(2);
    const pubs = await store.publications.forEvent(e.id);
    expect(pubs.find((p) => !p.accepted)?.message).toContain('blocked: not in allowlist');
    // El archivo local tiene el evento una sola vez.
    const archive = new AppendOnlyFile(join(dir, 'archive.jsonl'));
    expect((await archive.readAll()).map((l) => l.event.id)).toEqual([e.id]);
  });

  it('quórum 3 de 3 con un relay transitorio: pendiente con backoff, luego publicado sin repetir envíos', async () => {
    mode = 'rate-limited: slow down';
    // El tercer relay bloquea siempre: con quórum 3 nunca se alcanzaría. Usamos solo dos.
    const w = new WitnessWorker({
      store,
      relays: clients.slice(0, 2),
      quorum: 2,
      now: () => T0,
      random: () => 0.5,
    });
    const e = note(agent, 'lote 2');
    await w.enqueue(e);
    expect(await w.runOnce(T0)).toMatchObject({ pending: 1 });
    const entry = await store.outbox.get(e.id);
    expect(entry?.status).toBe('pending');
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextAttemptAt).toBe(T0 + 60); // backoff(1) con jitter neutro
    // Antes de vencer no se toca:
    expect(await w.runOnce(T0 + 10)).toMatchObject({ processed: 0 });
    // El relay se recupera; en el siguiente pase solo se reenvía al que faltaba.
    mode = null;
    expect(await w.runOnce(T0 + 60)).toMatchObject({ published: 1 });
    expect(relays[0]?.events).toHaveLength(1); // no se reenvió al que ya había aceptado
    expect(relays[1]?.events).toHaveLength(1);
  });

  it('si todos los rechazos son definitivos, falla sin esperar y levanta alerta', async () => {
    const w = new WitnessWorker({
      store,
      relays: clients.slice(2), // solo el hostil
      quorum: 1,
      now: () => T0,
    });
    const e = note(agent, 'lote 3');
    await w.enqueue(e);
    expect(await w.runOnce(T0)).toMatchObject({ failed: 1 });
    expect((await store.outbox.get(e.id))?.status).toBe('failed');
    const alerts = await store.alerts.list(5);
    expect(alerts[0]).toMatchObject({ kind: 'publish_failed', detail: { eventId: e.id } });
  });

  it('se rinde tras maxAttempts aunque el fallo sea transitorio', async () => {
    mode = 'rate-limited: slow down';
    const w = new WitnessWorker({
      store,
      relays: clients.slice(1, 2),
      quorum: 1,
      now: () => T0,
      random: () => 0.5,
      maxAttempts: 2,
    });
    const e = note(agent, 'lote 4');
    await w.enqueue(e);
    expect(await w.runOnce(T0)).toMatchObject({ pending: 1 });
    expect(await w.runOnce(T0 + 100)).toMatchObject({ failed: 1 });
  });

  it('rechaza un quórum mayor que el número de relays', () => {
    expect(() => worker(4)).toThrow(/imposible/);
  });

  it('checkPresence distingue "conserva" de "lo había aceptado y ya no": alerta witness_lost', async () => {
    const w = worker(2);
    const e = note(agent, 'lote 5');
    await w.enqueue(e);
    await w.runOnce(T0);
    const before = await checkPresence(e.id, clients, store, T0 + 100);
    expect(before.map((r) => r.present)).toEqual([true, true, false]);
    expect(before.every((r) => !r.lost)).toBe(true);
    // El relay bueno "olvida" el evento (retención, borrado por el operador…).
    relays[0]?.events.splice(0);
    const after = await checkPresence(e.id, clients, store, T0 + 200);
    expect(after[0]).toMatchObject({ present: false, lost: true });
    const alerts = await store.alerts.list(5);
    expect(alerts[0]).toMatchObject({ kind: 'witness_lost', detail: { relay: clients[0]?.url } });
    const latest = await store.checks.latest(e.id);
    expect(latest.find((c) => c.relay === clients[0]?.url)).toMatchObject({
      present: false,
      at: T0 + 200,
    });
  });

  it('detectDeletions encuentra un kind 5 del agente y alerta una sola vez', async () => {
    const deletion = note(agent, 'borrar', { kind: 5, tags: [['e', '11'.repeat(32)]] });
    await clients[0]?.publish(deletion); // el relay bueno lo acepta (los públicos lo hacen)
    const found = await detectDeletions(agent.pubkey, clients, store, 0, T0);
    expect(found.map((e) => e.id)).toEqual([deletion.id]);
    await detectDeletions(agent.pubkey, clients, store, 0, T0 + 1);
    const alerts = (await store.alerts.list(10)).filter((a) => a.kind === 'deletion_request');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.detail).toMatchObject({
      deletionEventId: deletion.id,
      targets: ['11'.repeat(32)],
    });
  });

  it('checkPresence: un relay caído es "sin respuesta", no "ausente": ni check ni alerta', async () => {
    const w = worker(2);
    const e = note(agent, 'lote 6');
    await w.enqueue(e);
    await w.runOnce(T0);
    await relays[0]?.stop(); // el relay bueno, que lo había aceptado, se cae
    const results = await checkPresence(e.id, clients, store, T0 + 100);
    expect(results[0]).toMatchObject({ status: 'unreachable', present: false, lost: false });
    expect(results[1]).toMatchObject({ status: 'present', present: true, lost: false });
    expect(results[2]).toMatchObject({ status: 'absent', present: false, lost: false });
    const latest = await store.checks.latest(e.id);
    expect(latest.find((c) => c.relay === clients[0]?.url)).toBeUndefined();
    expect((await store.alerts.list(5)).filter((a) => a.kind === 'witness_lost')).toHaveLength(0);
  });

  it('deletionFilters pide los kind 5 de las claves vigiladas y los que apuntan al directorio', () => {
    expect(deletionFilters({ agentPubkey: 'aa' }, 5)).toEqual([
      { kinds: [5], authors: ['aa'], since: 5 },
    ]);
    expect(deletionFilters({ agentPubkey: 'aa', rootPubkey: 'bb' }, 5)).toEqual([
      { kinds: [5], authors: ['aa', 'bb'], since: 5 },
      { kinds: [5], '#a': ['37676:bb:precintum/keys'], since: 5 },
    ]);
  });

  it('detectDeletions vigila también la clave raíz y el directorio de claves (#a)', async () => {
    const root = newIdentity();
    const delAgent = note(agent, '', { kind: 5, tags: [['e', '22'.repeat(32)]] });
    const delRoot = note(root, '', {
      kind: 5,
      tags: [
        ['a', keyDirectoryAddress(root.pubkey)],
        ['k', '37676'],
      ],
    });
    const ajeno = note(newIdentity(), '', { kind: 5, tags: [['e', '33'.repeat(32)]] });
    await clients[0]?.publish(delAgent);
    await clients[0]?.publish(delRoot);
    await clients[0]?.publish(ajeno);
    // Sin raíz configurada solo se ven los del agente.
    const soloAgente = await detectDeletions(agent.pubkey, clients, store, 0, T0);
    expect(soloAgente.map((e) => e.id)).toEqual([delAgent.id]);
    const ambos = await detectDeletions(
      { agentPubkey: agent.pubkey, rootPubkey: root.pubkey },
      clients,
      store,
      0,
      T0 + 1,
    );
    expect(ambos.map((e) => e.id).sort()).toEqual([delAgent.id, delRoot.id].sort());
    const alerts = (await store.alerts.list(10)).filter((a) => a.kind === 'deletion_request');
    expect(alerts).toHaveLength(2);
    const rootAlert = alerts.find((a) => a.detail.deletionEventId === delRoot.id);
    expect(rootAlert?.detail).toMatchObject({
      author: root.pubkey,
      addresses: [keyDirectoryAddress(root.pubkey)],
      kinds: ['37676'],
      targets: [],
    });
  });
});
