import { describe, expect, it, vi } from 'vitest';
import { publishToRelays, WitnessWorker } from '../src/application/witness-service.ts';
import { checkPresence } from '../src/application/witness-verifier.ts';
import type { NostrEvent } from '../src/domain/nostr/event.ts';
import type {
  PublicationRecord,
  WitnessRelay,
  WitnessStore,
} from '../src/domain/witness/witness-store.ts';

const T0 = 1_700_000_000;
const A = 'wss://relay.example';
const A_ALIAS = 'WSS://RELAY.EXAMPLE:443/';
const B = 'wss://second.example';
// El worker publica el evento; su validación criptográfica se prueba en la capa de Nostr.
const EVENT: NostrEvent = {
  id: '11'.repeat(32),
  pubkey: '22'.repeat(32),
  sig: '33'.repeat(64),
  created_at: T0,
  kind: 7676,
  tags: [],
  content: 'lote de prueba',
};

function relay(url: string, retry = false) {
  const publish = vi.fn<(event: NostrEvent) => Promise<{ message: string }>>();
  if (retry) {
    publish.mockRejectedValue({ code: 'rejected', detail: 'rate-limited: slow down' });
  } else {
    publish.mockResolvedValue({ message: 'saved' });
  }
  return { url, publish, query: vi.fn().mockResolvedValue([]) } satisfies WitnessRelay;
}

function setup(relays: readonly WitnessRelay[], quorum: number, accepted: string[] = []) {
  const record = vi
    .fn<(publication: PublicationRecord) => Promise<void>>()
    .mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const store = {
    outbox: {
      due: vi.fn().mockResolvedValue([
        {
          eventId: EVENT.id,
          event: EVENT,
          enqueuedAt: T0,
          attempts: 0,
          nextAttemptAt: T0,
          status: 'pending',
        },
      ]),
      update,
    },
    publications: {
      acceptedRelays: vi.fn().mockResolvedValue(accepted),
      record,
    },
    alerts: { raise: vi.fn().mockResolvedValue(undefined) },
  } as unknown as WitnessStore;
  const worker = new WitnessWorker({ store, relays, quorum, random: () => 0.5 });
  return { worker, record, update };
}

describe('testigos: cada dirección de relay cuenta una sola vez', () => {
  it.each([
    { name: 'exacta', alias: A },
    { name: 'equivalente', alias: A_ALIAS },
  ])('rechaza quórum dos con una única dirección repetida $name', ({ alias }) => {
    expect(() => setup([relay(A), relay(alias)], 2)).toThrow(/imposible/);
  });

  it('deduplica una copia, publica una vez y conserva la URL original en la telemetría', async () => {
    const first = relay(A_ALIAS);
    const duplicate = relay(A);
    const relays = [first, duplicate];
    const { worker, record } = setup(relays, 1);
    expect(relays).toEqual([first, duplicate]);
    // La lista que conserva el worker tampoco depende de cambios posteriores del llamador.
    const later = relay(B);
    relays.push(later);

    expect(await worker.runOnce(T0)).toEqual({
      processed: 1,
      published: 1,
      pending: 0,
      failed: 0,
    });
    expect(first.publish).toHaveBeenCalledExactlyOnceWith(EVENT);
    expect(duplicate.publish).not.toHaveBeenCalled();
    expect(later.publish).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith({
      eventId: EVENT.id,
      relay: A_ALIAS,
      accepted: true,
      code: 'ok',
      message: 'saved',
      at: T0,
    });
  });

  it('dos alias aceptantes no completan quórum dos si el otro relay pide reintento', async () => {
    const a = relay(A);
    const alias = relay(A_ALIAS);
    const b = relay(B, true);
    const { worker, record, update } = setup([a, alias, b], 2);

    expect(await worker.runOnce(T0)).toMatchObject({ published: 0, pending: 1 });
    expect(a.publish).toHaveBeenCalledOnce();
    expect(alias.publish).not.toHaveBeenCalled();
    expect(b.publish).toHaveBeenCalledOnce();
    expect(record.mock.calls.map(([publication]) => publication.relay)).toEqual([A, B]);
    expect(update).toHaveBeenCalledWith(
      EVENT.id,
      expect.objectContaining({ status: 'pending', attempts: 1 }),
    );
  });

  it('una aceptación previa con barra evita reenviar y no completa el quórum si B falla', async () => {
    const a = relay(A);
    const b = relay(B, true);
    const { worker, record } = setup([a, b], 2, [`${A}/`]);

    expect(await worker.runOnce(T0)).toMatchObject({ published: 0, pending: 1 });
    expect(a.publish).not.toHaveBeenCalled();
    expect(b.publish).toHaveBeenCalledOnce();
    expect(record.mock.calls.map(([publication]) => publication.relay)).toEqual([B]);
  });

  it('aceptaciones históricas A y A/ cuentan una vez', async () => {
    const a = relay(A);
    const b = relay(B, true);
    const { worker } = setup([a, b], 2, [A, `${A}/`]);

    expect(await worker.runOnce(T0)).toMatchObject({ published: 0, pending: 1 });
    expect(a.publish).not.toHaveBeenCalled();
    expect(b.publish).toHaveBeenCalledOnce();
  });

  it('ignora aceptaciones ajenas a la lista actual y URLs históricas inválidas', async () => {
    const a = relay(A);
    const b = relay(B, true);
    const { worker } = setup([a, b], 2, [
      'wss://old.example',
      'no-es-url',
      'https://relay.example',
    ]);

    expect(await worker.runOnce(T0)).toMatchObject({ published: 0, pending: 1 });
    expect(a.publish).toHaveBeenCalledOnce();
    expect(b.publish).toHaveBeenCalledOnce();
  });

  it('dos direcciones distintas sí completan el quórum con sus dos registros', async () => {
    const a = relay(A_ALIAS);
    const b = relay(B);
    const { worker, record } = setup([a, b], 2);

    expect(await worker.runOnce(T0)).toEqual({
      processed: 1,
      published: 1,
      pending: 0,
      failed: 0,
    });
    expect(a.publish).toHaveBeenCalledExactlyOnceWith(EVENT);
    expect(b.publish).toHaveBeenCalledExactlyOnceWith(EVENT);
    expect(record.mock.calls.map(([publication]) => publication.relay)).toEqual([A_ALIAS, B]);
  });

  it('publishToRelays deduplica alias y devuelve las URLs originales de los primeros', async () => {
    const a = relay(A_ALIAS);
    const alias = relay(A);
    const b = relay(B);
    const result = await publishToRelays(EVENT, [a, alias, b]);

    expect(a.publish).toHaveBeenCalledExactlyOnceWith(EVENT);
    expect(alias.publish).not.toHaveBeenCalled();
    expect(b.publish).toHaveBeenCalledExactlyOnceWith(EVENT);
    expect(result).toEqual([
      { relay: A_ALIAS, ok: true, code: 'ok', message: 'saved' },
      { relay: B, ok: true, code: 'ok', message: 'saved' },
    ]);
  });

  it('conserva la alerta de pérdida si la aceptación previa usa un alias de la URL actual', async () => {
    const a = relay(A);
    const record = vi.fn().mockResolvedValue(undefined);
    const raise = vi.fn().mockResolvedValue(undefined);
    const store = {
      publications: {
        acceptedRelays: vi.fn().mockResolvedValue([A_ALIAS, `${A}/`, 'no-es-url']),
      },
      checks: { record },
      alerts: { raise },
    } as unknown as WitnessStore;

    expect(await checkPresence(EVENT.id, [a], store, T0)).toEqual([
      { relay: A, status: 'absent', present: false, lost: true },
    ]);
    expect(a.query).toHaveBeenCalledExactlyOnceWith([{ ids: [EVENT.id] }]);
    expect(record).toHaveBeenCalledExactlyOnceWith({
      eventId: EVENT.id,
      relay: A,
      present: false,
      at: T0,
    });
    expect(raise).toHaveBeenCalledExactlyOnceWith(
      'witness_lost',
      { eventId: EVENT.id, relay: A },
      T0,
    );
  });
});
