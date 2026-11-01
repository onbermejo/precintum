/**
 * Configuración del proceso, validada con zod.
 *
 * Regla MVP: ninguna variable de entorno se lee "a mano" fuera de este fichero.
 * Así el arranque falla pronto y con un mensaje claro si falta algo,
 * en vez de fallar a mitad de una publicación.
 */
import { z } from 'zod';
import { isSupportedCalendarUrl } from './calendar-url.ts';
import { relayUrlKey } from './relay-url.ts';

// zod 4: z.url() sustituye al deprecado z.string().url(); protocol acota el esquema.
const relayUrl = z.url({
  protocol: /^wss?$/,
  error: 'un relay debe ser una URL ws:// o wss://',
});

const schema = z.object({
  PRECINTUM_NSEC: z
    .string()
    .regex(/^nsec1[02-9ac-hj-np-z]{58}$/, 'PRECINTUM_NSEC debe ser una clave nsec válida (NIP-19)')
    .optional(),
  // Clave pública del agente, para procesos de solo lectura (`serve`) que no deben tener el nsec.
  PRECINTUM_NPUB: z
    .string()
    .regex(/^npub1[02-9ac-hj-np-z]{58}$/, 'PRECINTUM_NPUB debe ser una clave npub válida (NIP-19)')
    .optional(),
  // Clave RAÍZ del operador (npub): la que firma el directorio de claves (kind 37676). Si está, la
  // búsqueda de borrados NIP-09 vigila también los kind 5 de la raíz y los que apuntan al directorio.
  PRECINTUM_ROOT_NPUB: z
    .string()
    .regex(
      /^npub1[02-9ac-hj-np-z]{58}$/,
      'PRECINTUM_ROOT_NPUB debe ser una clave npub válida (NIP-19)',
    )
    .optional(),
  // Mismo valor que .env.example. Revise disponibilidad y diversidad de testigos al desplegar.
  PRECINTUM_RELAYS: z
    .string()
    .default(
      'wss://nos.lol,wss://relay.primal.net,wss://relay.damus.io,wss://nostr-pub.wellorder.net',
    )
    .transform((s) =>
      s
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(relayUrl).min(1)),
  // Mismos niveles que pino. "silent" apaga el log (útil en tests y scripts).
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  // Base de datos de evidencia. Por defecto PGlite en disco (cero configuración); para
  // el PostgreSQL nativo: postgres://usuario:clave@localhost:5432/precintum
  PRECINTUM_DATABASE_URL: z
    .string()
    .default('pglite:./data/precintum')
    .refine((u) => /^(pglite:|postgres(ql)?:\/\/)/.test(u), {
      message: 'PRECINTUM_DATABASE_URL debe ser pglite:<ruta> | pglite:memory | postgres://…',
    }),
  // Clave HMAC (32 bytes hex) para las claves de deduplicación. Sin ella se genera una
  // efímera por proceso y los reintentos entre ejecuciones no se deduplican.
  PRECINTUM_DEDUP_KEY: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/,
      'PRECINTUM_DEDUP_KEY debe ser hex de 32 bytes (pnpm precintum keygen la sugiere)',
    )
    .optional(),
  // Cuánto vive la correlación transacción-del-verifier ↔ recibo (segundos). 24 h por defecto.
  PRECINTUM_DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  // Testigos que deben aceptar un evento para darlo por publicado (N de M).
  PRECINTUM_WITNESS_QUORUM: z.coerce.number().int().positive().default(2),
  // Archivo append-only local (tercer tipo de testigo).
  PRECINTUM_ARCHIVE_PATH: z.string().default('./data/witness/archive.jsonl'),
  // Lotes: tamaño de ventana, política vigente (hash hex o etiqueta que se hashea),
  // TSA RFC 3161, calendarios OpenTimestamps y gap máximo admisible entre fin de ventana y anclaje.
  PRECINTUM_BATCH_WINDOW_SECONDS: z.coerce.number().int().min(60).default(3_600),
  // Margen tras el fin de una ventana antes de cerrarla: entran los recibos que llegan con latencia.
  PRECINTUM_BATCH_GRACE_SECONDS: z.coerce.number().int().min(0).default(120),
  // Cuánto puede adelantarse al reloj del agente el instante que declara el adaptador.
  PRECINTUM_MAX_FUTURE_SKEW_SECONDS: z.coerce.number().int().min(0).default(300),
  PRECINTUM_POLICY: z.string().min(1).default('age_over_18/v1'),
  PRECINTUM_TSA_URL: z.url({ protocol: /^https?$/ }).default('https://freetsa.org/tsr'),
  // Credenciales de la TSA (autenticación HTTP básica), si el prestador las exige. Ambas o ninguna.
  PRECINTUM_TSA_USER: z.string().min(1).optional(),
  PRECINTUM_TSA_PASSWORD: z.string().min(1).optional(),
  PRECINTUM_OTS_CALENDARS: z
    .string()
    .default('https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org')
    .transform((s) =>
      s
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z.url({ protocol: /^https?$/ }).refine(isSupportedCalendarUrl, {
            message:
              'el calendario requiere HTTP(S) y letras, números o . _ : / -, sin credenciales, consulta ni fragmento',
          }),
        )
        .min(1),
    ),
  PRECINTUM_ANCHOR_MAX_GAP_SECONDS: z.coerce.number().int().positive().default(86_400),
  // Ingesta (ADR-0003): token compartido con el adaptador del verifier, y dónde escucha.
  PRECINTUM_INGEST_TOKEN: z
    .string()
    .min(16, 'PRECINTUM_INGEST_TOKEN debe tener al menos 16 caracteres')
    .optional(),
  PRECINTUM_INGEST_HOST: z.string().min(1).default('127.0.0.1'),
  PRECINTUM_INGEST_PORT: z.coerce.number().int().min(1).max(65_535).default(8_788),
  // Planificador de `precintum run` (ADR-0002): cadencias en segundos.
  PRECINTUM_RUN_TICK_SECONDS: z.coerce.number().int().min(5).default(30),
  PRECINTUM_RUN_ANCHOR_SECONDS: z.coerce.number().int().min(30).default(600),
  PRECINTUM_RUN_PRESENCE_SECONDS: z.coerce.number().int().min(60).default(21_600),
  PRECINTUM_RUN_DELETIONS_SECONDS: z.coerce.number().int().min(60).default(3_600),
});

const schemaWithRules = schema
  .refine(
    (c) => (c.PRECINTUM_TSA_USER === undefined) === (c.PRECINTUM_TSA_PASSWORD === undefined),
    {
      message: 'PRECINTUM_TSA_USER y PRECINTUM_TSA_PASSWORD van juntas: define ambas o ninguna',
      path: ['PRECINTUM_TSA_USER'],
    },
  )
  // La autenticación básica manda usuario y contraseña en claro dentro de la petición: solo sobre TLS.
  .refine((c) => c.PRECINTUM_TSA_USER === undefined || c.PRECINTUM_TSA_URL.startsWith('https://'), {
    message: 'con credenciales, PRECINTUM_TSA_URL debe ser https:// (irían en claro por http)',
    path: ['PRECINTUM_TSA_URL'],
  })
  .superRefine((c, ctx) => {
    let relayKeys: Set<string>;
    try {
      relayKeys = new Set(c.PRECINTUM_RELAYS.map(relayUrlKey));
    } catch {
      // Las URLs inválidas ya tienen su error de formato; no ocultarlo con una excepción.
      return;
    }
    if (relayKeys.size !== c.PRECINTUM_RELAYS.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'no se admiten direcciones de relay duplicadas o equivalentes',
        path: ['PRECINTUM_RELAYS'],
      });
    }
    if (c.PRECINTUM_WITNESS_QUORUM > relayKeys.size) {
      ctx.addIssue({
        code: 'custom',
        message: 'el quórum no puede superar el número de relays únicos',
        path: ['PRECINTUM_WITNESS_QUORUM'],
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Una variable vacía (`PRECINTUM_NSEC=` en .env, o `PRECINTUM_NSEC=""` en la shell) cuenta como
  // ausente: así se aplican los valores por defecto y el mensaje es "falta X", no "X inválida".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schemaWithRules.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${detail}`);
  }
  return parsed.data;
}
