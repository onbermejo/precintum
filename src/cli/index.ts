#!/usr/bin/env node
import { parseArgs } from 'node:util';
/**
 * CLI del Evidence Agent. Se ejecuta con Node >= 24 (type stripping nativo):
 *   pnpm precintum <comando>          (el script carga .env si existe)
 *
 * La lista de comandos, con una frase por comando, es HELP (más abajo): es lo que imprime
 * `pnpm precintum help`. En inglés porque es lo primero que ve quien llega al repositorio.
 */
import { redactUrl, redactUrlsInText } from '../shared/redact.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    result: { type: 'string' },
    policy: { type: 'string' },
    verifier: { type: 'string' },
    tx: { type: 'string' },
    at: { type: 'string' },
    last: { type: 'string' },
    desde: { type: 'string' },
    hasta: { type: 'string' },
    salida: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    port: { type: 'string' },
    host: { type: 'string' },
    'to-env': { type: 'string' },
    force: { type: 'boolean' },
  },
});
const [command, arg] = positionals;

const HELP = `Precintum evidence agent. Usage: pnpm precintum <command> [options]

Identity
  keygen [--to-env .env]      new identity (nsec, npub), deduplication key and ingest token;
                              with --to-env they are written to the file, never printed
  whoami                      agent npub and configuration, without secrets
  ping [wss://relay]          publish a test note to a relay and check that it is stored

Evidence
  db migrate                  create or update the database schema
  receipt add --result <over_18|under_18|error> [--policy p] [--verifier v] [--tx id] [--at unix]
                              record a verification by hand
  chain verify                re-verify the whole receipt chain
  chain show [--last n]       show the last receipts
  batch close                 close finished windows (empty ones too): root, signed event, anchors
  batch status                batches and their anchoring status
  proof <seq>                 inclusion proof of a receipt, verified, with its anchoring status
  anchor upgrade              collect the Bitcoin attestations of pending OpenTimestamps proofs
  export --from <date> --to <date> [--out file.json]
                              evidence package for a date range, for an auditor
                              (also --desde/--hasta/--salida; dates: 2026-10-17, 2026-10-17T14:00 or unix)

Witnesses
  witness run                 publish pending batch events to the relays (outbox)
  witness status              outbox and alerts
  witness check <event-id>    ask every relay whether it still serves an event
  witness deletions           look for deletion requests (NIP-09) signed with the agent's key
  relay init [--force]        write deploy/relay/ for the operator's private relay (nostr-rs-relay)

Processes
  run [--port 8787] [--host 127.0.0.1]
                              the agent: ingest (POST /receipts), scheduler, panel and /health
  serve [--port 8787] [--host 127.0.0.1]
                              read-only operations panel and /metrics

  help, --help, -h            this help
`;

async function main(): Promise<void> {
  if (values.help === true || command === 'help') {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'keygen': {
      const { cmdKeygen } = await import('./keygen-commands.ts');
      return cmdKeygen(asString(values['to-env']));
    }
    case 'whoami': {
      const [{ loadConfig }, { resolvePublicIdentity }, { tsaWarning }] = await Promise.all([
        import('../shared/config.ts'),
        import('./identity.ts'),
        import('./tsa-warning.ts'),
      ]);
      const cfg = loadConfig();
      const id = resolvePublicIdentity(cfg);
      console.log(`npub: ${id.npub}${id.canSign ? '' : ' (solo lectura: sin clave privada)'}`);
      console.log(`hex : ${id.pubkey}`);
      console.log(`relays: ${cfg.PRECINTUM_RELAYS.map(redactUrl).join(', ')}`);
      console.log(`base de datos: ${redactUrl(cfg.PRECINTUM_DATABASE_URL)}`);
      console.log(
        `deduplicación: ${cfg.PRECINTUM_DEDUP_KEY ? 'clave fija' : 'clave EFÍMERA (fija PRECINTUM_DEDUP_KEY)'}, TTL ${cfg.PRECINTUM_DEDUP_TTL_SECONDS}s`,
      );
      console.log(
        `TSA (RFC 3161): ${redactUrl(cfg.PRECINTUM_TSA_URL)}${cfg.PRECINTUM_TSA_USER ? ' (con credenciales)' : ''}`,
      );
      console.log(`OpenTimestamps: ${cfg.PRECINTUM_OTS_CALENDARS.map(redactUrl).join(', ')}`);
      const warning = tsaWarning(cfg);
      if (warning) console.error(warning);
      return;
    }
    case 'ping': {
      const [
        { loadConfig },
        { requireSigner },
        { nowSeconds, signEvent },
        { RelayClient },
        { logger },
      ] = await Promise.all([
        import('../shared/config.ts'),
        import('./identity.ts'),
        import('../domain/nostr/event.ts'),
        import('../infra/relay/relay-client.ts'),
        import('../shared/logger.ts'),
      ]);
      const cfg = loadConfig();
      const id = requireSigner(cfg);
      const url = arg ?? cfg.PRECINTUM_RELAYS[0];
      if (!url) throw new Error('no hay relay configurado');
      // Con identidad, el cliente contesta al AUTH (NIP-42) si el relay lo exige.
      const relay = new RelayClient(url, { logger, identity: id });
      const event = signEvent(
        {
          kind: 1,
          created_at: nowSeconds(),
          tags: [['client', 'precintum']],
          content: `precintum ping ${new Date().toISOString()}`,
        },
        id,
      );
      console.log(`publicando ${event.id} en ${redactUrl(url)} ...`);
      try {
        const receipt = await relay.publish(event);
        const when = new Date(receipt.receivedAt).toISOString();
        console.log(
          `OK del relay en ${when} (${redactUrlsInText(receipt.message) || 'sin mensaje'})`,
        );
        const found = await relay.query([{ ids: [event.id] }]);
        console.log(
          found.length === 1
            ? 'verificado: el relay devuelve el evento'
            : 'AVISO: el relay no devolvió el evento',
        );
      } finally {
        // Sin esto, un relay que no contesta deja el socket abierto y el proceso colgado.
        relay.close();
      }
      return;
    }
    case 'run': {
      const [{ loadConfig }, { cmdRun }] = await Promise.all([
        import('../shared/config.ts'),
        import('./run-commands.ts'),
      ]);
      const port = typeof values.port === 'string' ? values.port : undefined;
      const host = typeof values.host === 'string' ? values.host : undefined;
      await cmdRun(loadConfig(), port, host);
      return;
    }
    case 'db': {
      if (arg !== 'migrate') throw new Error(HELP);
      const [{ loadConfig }, { cmdDbMigrate }] = await Promise.all([
        import('../shared/config.ts'),
        import('./evidence-commands.ts'),
      ]);
      await cmdDbMigrate(loadConfig());
      return;
    }
    case 'relay': {
      if (arg !== 'init') throw new Error(HELP);
      const [{ loadConfig }, { cmdRelayInit }] = await Promise.all([
        import('../shared/config.ts'),
        import('./relay-commands.ts'),
      ]);
      await cmdRelayInit(loadConfig(), process.cwd(), { force: values.force === true });
      return;
    }
    case 'witness': {
      const [
        { loadConfig },
        { cmdWitnessRun, cmdWitnessStatus, cmdWitnessCheck, cmdWitnessDeletions },
      ] = await Promise.all([import('../shared/config.ts'), import('./witness-commands.ts')]);
      const cfg = loadConfig();
      if (arg === 'run') return cmdWitnessRun(cfg);
      if (arg === 'status') return cmdWitnessStatus(cfg);
      if (arg === 'check') return cmdWitnessCheck(cfg, positionals[2]);
      if (arg === 'deletions') return cmdWitnessDeletions(cfg);
      throw new Error(HELP);
    }
    case 'batch': {
      const [{ loadConfig }, { cmdBatchClose, cmdBatchStatus }] = await Promise.all([
        import('../shared/config.ts'),
        import('./batch-commands.ts'),
      ]);
      const cfg = loadConfig();
      if (arg === 'close') return cmdBatchClose(cfg);
      if (arg === 'status') return cmdBatchStatus(cfg);
      throw new Error(HELP);
    }
    case 'anchor': {
      if (arg !== 'upgrade') throw new Error(HELP);
      const [{ loadConfig }, { cmdAnchorUpgrade }] = await Promise.all([
        import('../shared/config.ts'),
        import('./batch-commands.ts'),
      ]);
      return cmdAnchorUpgrade(loadConfig());
    }
    case 'proof': {
      const [{ loadConfig }, { cmdProof }] = await Promise.all([
        import('../shared/config.ts'),
        import('./batch-commands.ts'),
      ]);
      return cmdProof(loadConfig(), arg);
    }
    case 'serve': {
      const [{ loadConfig }, { cmdServe }] = await Promise.all([
        import('../shared/config.ts'),
        import('./serve-commands.ts'),
      ]);
      return cmdServe(loadConfig(), asString(values.port), asString(values.host));
    }
    case 'export': {
      const [{ loadConfig }, { cmdExport }] = await Promise.all([
        import('../shared/config.ts'),
        import('./export-commands.ts'),
      ]);
      return cmdExport(
        loadConfig(),
        asString(values.from ?? values.desde),
        asString(values.to ?? values.hasta),
        asString(values.out ?? values.salida),
      );
    }
    case 'receipt': {
      if (arg !== 'add') throw new Error(HELP);
      const [{ loadConfig }, { cmdReceiptAdd }] = await Promise.all([
        import('../shared/config.ts'),
        import('./evidence-commands.ts'),
      ]);
      await cmdReceiptAdd(loadConfig(), {
        result: asString(values.result),
        policy: asString(values.policy),
        verifier: asString(values.verifier),
        tx: asString(values.tx),
        at: asString(values.at),
      });
      return;
    }
    case 'chain': {
      const [{ loadConfig }, { cmdChainShow, cmdChainVerify }] = await Promise.all([
        import('../shared/config.ts'),
        import('./evidence-commands.ts'),
      ]);
      const cfg = loadConfig();
      if (arg === 'verify') {
        const ok = await cmdChainVerify(cfg);
        if (!ok) process.exitCode = 1;
        return;
      }
      if (arg === 'show') {
        const last = values.last === undefined ? 10 : Number(values.last);
        if (!Number.isInteger(last) || last <= 0) throw new Error('--last debe ser un entero > 0');
        await cmdChainShow(cfg, last);
        return;
      }
      throw new Error(HELP);
    }
    default:
      // Sin comando o con uno desconocido: la ayuda va a stderr y la salida es 2 (uso incorrecto).
      console.error(HELP);
      process.exitCode = 2;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

main().catch((err: unknown) => {
  console.error(redactUrlsInText(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
