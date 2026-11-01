import type { Config } from '../shared/config.ts';

/** freetsa.org es un servicio gratuito de un particular: vale para desarrollar, no para producción. */
export const DEV_TSA_HOSTS = ['freetsa.org'];

/** Texto de aviso si la TSA configurada es de desarrollo (no cualificada), o null si no aplica. */
export function tsaWarning(cfg: Config): string | null {
  const host = new URL(cfg.PRECINTUM_TSA_URL).hostname;
  if (!DEV_TSA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return (
    `AVISO: PRECINTUM_TSA_URL apunta a ${host}, una TSA gratuita de DESARROLLO. No es prestador cualificado ` +
    'y no da la presunción de eIDAS. En producción usa la TSA del cliente o la de un QTSP.'
  );
}
