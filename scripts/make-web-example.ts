/**
 * Genera el paquete de evidencia de ejemplo que el verificador web trae incrustado, para que la
 * página abra mostrando un caso real en lugar de un formulario vacío.
 *
 *   node scripts/make-web-example.ts
 *
 * La clave del agente se genera al azar en cada ejecución y no se guarda en ninguna parte: al
 * fichero solo van la clave pública y las firmas, que son públicas por definición. El paquete
 * resultante es válido y verificable. Los sellos tienen el formato real (RFC 3161, .ots) con una
 * firma CMS de prueba y una atestación Bitcoin ficticia: es lo que el verificador no puede
 * comprobar sin DSS ni un nodo, y lo dice en sus notas. Se regenera con `pnpm example:web`, que
 * escribe también `examples/package.json` y `examples/package-tampered.json` para el evaluador.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { BatchService } from '../src/application/batch-service.ts';
import { ExportService, verifyPackage } from '../src/application/export-service.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import { generateSecretKey, identityFromSecretKey } from '../src/domain/identity/keys.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { bytesToHex } from '../src/shared/hex.ts';
import { fakeOts, fakeTsa } from '../test/support/fake-anchors.ts';

const WINDOW = 3600;
/** Jueves 3 de septiembre de 2026, 12:00 UTC = 14:00 en Madrid: la hora del caso de Nora. */
const T0 = Math.floor(Date.UTC(2026, 8, 3, 12, 0) / 1000);
const POLICY = bytesToHex(sha256(utf8ToBytes('age_over_18/v1')));
const VERIFIER = bytesToHex(sha256(utf8ToBytes('umbral/eudi-srv-verifier-endpoint/prod-01')));

// Sellos y .ots con el formato real: el verificador lee el imprint y la hora del DER y la
// atestación del .ots. La firma CMS es de prueba (DSS la rechazaría) y el bloque es ficticio.
const SEAL_TIME = new Date((T0 + 3 * WINDOW + 7) * 1000);
const tsa = fakeTsa({ genTime: () => SEAL_TIME });
const ots = fakeOts({ completeOnUpgrade: () => true });

const db = await PgliteSqlClient.open();
await migrate(db);
const evidence = new SqlEvidenceStore(db);
const batches = new SqlBatchStore(db);
const identity = identityFromSecretKey(generateSecretKey());

// Ventana 0 (14:00-15:00): cuatro verificaciones, una de ellas un menor y otra un error.
// Ventana 1 (15:00-16:00): ninguna, así que su lote es un latido con la raíz del árbol vacío.
// Ventana 2 (16:00-17:00): una más.
const times: Array<[number, 'over_18' | 'under_18' | 'error']> = [
  [T0 + 4 * 60, 'over_18'],
  [T0 + 17 * 60, 'under_18'],
  [T0 + 32 * 60, 'over_18'],
  [T0 + 41 * 60, 'error'],
  [T0 + 2 * WINDOW + 12 * 60, 'over_18'],
];
let prev = null as Awaited<ReturnType<typeof nextReceipt>> | null;
for (const [at, result] of times) {
  prev = nextReceipt(prev, { policy: POLICY, verifier: VERIFIER, result, at });
  await evidence.receipts.append(prev);
}

const now = T0 + 3 * WINDOW + 5;
const service = new BatchService({
  evidence,
  batches,
  tx: evidenceUnitOfWork(db),
  identity,
  policy: POLICY,
  windowSeconds: WINDOW,
  tsa,
  ots,
  now: () => now,
});
await service.closeDueWindows(now);
await service.anchorPending();

const pkg = await new ExportService({
  evidence,
  batches,
  windowSeconds: WINDOW,
  agentPubkey: identity.pubkey,
}).exportRange(T0, T0 + 3 * WINDOW);
const verdict = verifyPackage(pkg);
if (!verdict.ok) {
  console.error('el paquete de ejemplo no se verifica:', verdict.problems);
  process.exit(1);
}

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'web',
  'verify',
  'src',
  '13-example.js',
);
writeFileSync(
  out,
  `/* Paquete de evidencia de ejemplo, generado por precintum/scripts/make-web-example.ts.
   Es un paquete real y válido: hashes, cadena, árbol, compromisos de recuento, ids y firmas
   Schnorr son auténticos. Los tokens RFC 3161 y los ficheros .ots tienen el formato real, con
   una firma CMS de prueba y una atestación Bitcoin ficticia: es justo lo que el verificador no
   puede comprobar sin DSS ni un nodo, y lo dice en sus notas. */
globalThis.PRECINTUM_EXAMPLE = ${JSON.stringify(pkg)};
`,
  'utf8',
);
// Los mismos datos, como ficheros para el evaluador (REVIEWERS.md): el paquete bueno y el mismo con un
// recibo retocado (el del menor pasa a mayor de edad), que el verificador tiene que marcar en rojo.
const examples = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
mkdirSync(examples, { recursive: true });
writeFileSync(
  join(examples, 'package.json'),
  `${JSON.stringify(pkg, null, 2)}
`,
  'utf8',
);
const tampered = structuredClone(pkg);
for (const b of tampered.batches) {
  for (const r of b.receipts) if (r.result === 'under_18') r.result = 'over_18';
}
if (verifyPackage(tampered).ok) {
  console.error('el paquete trucado de ejemplo se verifica: algo va mal');
  process.exit(1);
}
writeFileSync(
  join(examples, 'package-tampered.json'),
  `${JSON.stringify(tampered, null, 2)}
`,
  'utf8',
);
await db.close();
console.log(`escrito ${out}`);
console.log(`escritos ${join(examples, 'package.json')} y package-tampered.json`);
console.log(
  `lotes: ${pkg.totals.batches}, recibos: ${pkg.totals.receipts}, avisos: ${verdict.warnings.length}`,
);
