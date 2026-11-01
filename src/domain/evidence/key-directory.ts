/**
 * Directorio de claves del operador: qué pubkeys de agente eran válidas en qué ventanas.
 *
 * Resuelve la rotación de claves sin NIP mergeado (NIP-41 sigue en PR): una clave RAÍZ del
 * cliente, custodiada fuera de línea, firma este directorio; las claves de AGENTE (las que
 * firman lotes) se listan con ventanas de validez. El verificador acepta un lote solo si su
 * pubkey estaba vigente en el `created_at` del lote.
 *
 *   kind 37676  addressable (30000-39999): el relay conserva la última versión por
 *               (pubkey, d). Publicar un directorio nuevo supersede al anterior.
 *   ["d","precintum/keys"]
 *   content     JSON {"v":1,"keys":[{"pubkey":…,"from":…,"to":…|null}, …]}
 *
 * Revocar = publicar una versión nueva con `to` fijado. La publicación y el anclaje del directorio
 * están previstos para dar una prueba de tiempo a la vigencia de las claves.
 */
import { z } from 'zod';
import type { Identity } from '../identity/keys.ts';
import { type NostrEvent, signEvent } from '../nostr/event.ts';

export const KEY_DIRECTORY_KIND = 37676;
export const KEY_DIRECTORY_D = 'precintum/keys';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const keyWindowSchema = z
  .strictObject({
    pubkey: hex64,
    /** Inicio de validez, segundos unix, inclusivo. */
    from: z.number().int().nonnegative(),
    /** Fin de validez, exclusivo; null = vigente. */
    to: z.number().int().nonnegative().nullable(),
  })
  .refine((w) => w.to === null || w.to > w.from, { message: 'to debe ser posterior a from' });

export const keyDirectorySchema = z.strictObject({
  v: z.literal(1),
  keys: z.array(keyWindowSchema).min(1),
});

export type KeyWindow = z.infer<typeof keyWindowSchema>;
export type KeyDirectory = z.infer<typeof keyDirectorySchema>;

export function buildKeyDirectoryEvent(
  directory: KeyDirectory,
  root: Identity,
  createdAt: number,
): NostrEvent {
  const dir = keyDirectorySchema.parse(directory);
  // Orden de campos fijo por construcción: el JSON es reproducible.
  const content = JSON.stringify({
    v: dir.v,
    keys: dir.keys.map((k) => ({ pubkey: k.pubkey, from: k.from, to: k.to })),
  });
  return signEvent(
    { kind: KEY_DIRECTORY_KIND, created_at: createdAt, tags: [['d', KEY_DIRECTORY_D]], content },
    root,
  );
}

export type KeyDirectoryParse =
  | { ok: true; directory: KeyDirectory }
  | { ok: false; reason: string };

export function parseKeyDirectoryEvent(event: NostrEvent): KeyDirectoryParse {
  if (event.kind !== KEY_DIRECTORY_KIND) {
    return { ok: false, reason: `kind ${event.kind}, se esperaba ${KEY_DIRECTORY_KIND}` };
  }
  if (!event.tags.some((t) => t[0] === 'd' && t[1] === KEY_DIRECTORY_D)) {
    return { ok: false, reason: `falta la tag ["d","${KEY_DIRECTORY_D}"]` };
  }
  let json: unknown;
  try {
    json = JSON.parse(event.content);
  } catch {
    return { ok: false, reason: 'content no es JSON' };
  }
  const parsed = keyDirectorySchema.safeParse(json);
  if (!parsed.success)
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'directorio inválido' };
  return { ok: true, directory: parsed.data };
}

/** ¿Estaba `pubkey` autorizada a firmar lotes en el instante `at`? */
export function isKeyValidAt(directory: KeyDirectory, pubkey: string, at: number): boolean {
  return directory.keys.some(
    (k) => k.pubkey === pubkey && k.from <= at && (k.to === null || at < k.to),
  );
}
