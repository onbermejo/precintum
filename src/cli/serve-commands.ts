/**
 * `precintum serve [--port N] [--host H]`: panel de operación de solo lectura y `/metrics`.
 *
 * No hay autenticación, así que por defecto escucha solo en 127.0.0.1. Exponerlo en otra
 * dirección exige pasar `--host` a conciencia y poner delante un proxy inverso que autentique;
 * el comando avisa por stderr cuando la dirección no es de loopback.
 */
import { migrate } from '../infra/db/migrations.ts';
import { openSqlClient } from '../infra/db/open.ts';
import { SqlBatchStore } from '../infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../infra/db/sql-evidence-store.ts';
import { SqlWitnessStore } from '../infra/db/sql-witness-store.ts';
import { isLoopback, startPanel } from '../infra/http/panel-server.ts';
import type { Config } from '../shared/config.ts';
import { resolvePublicIdentity } from './identity.ts';

export const DEFAULT_PANEL_PORT = 8787;

export function parsePort(input: string | undefined): number {
  if (input === undefined) return DEFAULT_PANEL_PORT;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 65_535)
    throw new Error('--port debe ser un puerto entre 1 y 65535');
  return n;
}

export async function cmdServe(
  cfg: Config,
  portArg: string | undefined,
  hostArg: string | undefined,
): Promise<void> {
  // El panel es de solo lectura: basta PRECINTUM_NPUB, y así la máquina del panel no guarda el nsec.
  const id = resolvePublicIdentity(cfg);
  const port = parsePort(portArg);
  const host = hostArg ?? '127.0.0.1';

  const db = await openSqlClient(cfg.PRECINTUM_DATABASE_URL);
  const release: Array<() => void | Promise<void>> = [() => db.close()];
  try {
    await migrate(db);
    const panel = await startPanel(
      {
        evidence: new SqlEvidenceStore(db),
        batches: new SqlBatchStore(db),
        witness: new SqlWitnessStore(db),
        config: cfg,
        identity: { npub: id.npub, pubkey: id.pubkey },
      },
      port,
      host,
    );

    release.push(() => panel.close());
    if (!isLoopback(host)) {
      console.error(
        `AVISO: el panel escucha en ${host}, no solo en esta máquina, y NO tiene autenticación. ` +
          'Quien alcance el puerto verá el estado del agente y su configuración. Pon delante un ' +
          'proxy inverso que autentique, o usa 127.0.0.1 y un túnel SSH.',
      );
    }
    console.log(`panel de operación (solo lectura) en http://${host}:${panel.port}/`);
    console.log(`métricas Prometheus en   http://${host}:${panel.port}/metrics`);
    if (!id.canSign) console.log('modo solo lectura: este proceso no tiene la clave privada.');
    console.log('Ctrl+C para parar.');

    const stop = async () => {
      await panel.close();
      await db.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  } catch (error) {
    for (const close of release.reverse()) {
      try {
        await close();
      } catch {
        // Conservar el error de arranque y seguir liberando los demás recursos.
      }
    }
    throw error;
  }
}
