/**
 * Clave de comparación: normaliza host, puerto por defecto y raíz; conserva ruta y query.
 * No identifica operadores independientes ni sustituye la URL usada para conectar/autenticar.
 */
export function relayUrlKey(url: string): string {
  return new URL(url).href;
}
