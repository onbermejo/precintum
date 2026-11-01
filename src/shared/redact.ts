/**
 * Ocultar secretos en lo que se imprime, sin modificar las URLs de las conexiones.
 * Los endpoints HTTP/WebSocket pueden llevar credenciales en userinfo, consulta o fragmento.
 * PostgreSQL conserva el usuario y las opciones de conexión que no sean credenciales.
 */
const ENDPOINT_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const SECRET_PARAMETER =
  /pass(?:word)?|pwd|token|secret|credential|authorization|api[-_]?key|access[-_]?key/i;

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const endpoint = ENDPOINT_PROTOCOLS.has(u.protocol);
    let changed = false;
    if (endpoint && u.username) {
      u.username = '***';
      changed = true;
    }
    if (u.password) {
      u.password = '***';
      changed = true;
    }
    for (const name of new Set(u.searchParams.keys())) {
      if (endpoint || SECRET_PARAMETER.test(name)) {
        u.searchParams.set(name, '***');
        changed = true;
      }
    }
    if (u.hash) {
      u.hash = '***';
      changed = true;
    }
    return changed ? u.toString() : url;
  } catch {
    // Una URL malformada no permite separar con seguridad sus credenciales. Las rutas locales
    // sin esquema se conservan; una supuesta URL se oculta entera.
    return /:\/\/|^\/\//.test(url) ? '[URL inválida censurada]' : url;
  }
}

/** Para detalles de error que mezclan texto y URLs; nunca para conexiones o eventos firmados. */
export function redactUrlsInText(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (url) => redactUrl(url));
}

/** Censura campos de texto antes de serializar alertas, conservando sus tipos y estructura. */
export function redactDetail(value: unknown): unknown {
  if (typeof value === 'string') return redactUrlsInText(value);
  if (Array.isArray(value)) return value.map(redactDetail);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDetail(item)]),
    );
  }
  return value;
}
