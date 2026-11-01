/** La dirección del calendario se conserva en las pruebas OTS que se entregan al auditor. */
export function isSupportedCalendarUrl(value: string): boolean {
  // Es la misma gramática de las URI pending del lector de pruebas OTS.
  if (!/^https?:\/\/[A-Za-z0-9._\-:/]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
}

export function assertCalendarUrl(value: string): void {
  if (!isSupportedCalendarUrl(value)) {
    throw new Error(
      'OTS: calendario no compatible; usa una URL HTTP(S) válida con letras, números y . _ : / -, sin credenciales, consulta ni fragmento',
    );
  }
}
