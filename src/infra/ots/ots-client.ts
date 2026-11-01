import type { OtsClient } from '../../application/batch-service.ts';
import { assertCalendarUrl } from '../../shared/calendar-url.ts';
import { redactUrl, redactUrlsInText } from '../../shared/redact.ts';
import {
  calendarSubmit,
  deserializeDetached,
  isComplete,
  mergeTimestamp,
  newTimestamp,
  serializeDetached,
  type Timestamp,
  upgrade,
} from './ots.ts';

/**
 * Adaptador del puerto OtsClient sobre calendarios públicos. Envía el digest a todos; basta
 * con que uno responda. El .ots resultante lleva una rama "pending" por calendario que aceptó.
 */
export function calendarOtsClient(calendars: readonly string[]): OtsClient {
  if (calendars.length === 0) throw new Error('hace falta al menos un calendario OpenTimestamps');
  for (const calendar of calendars) assertCalendarUrl(calendar);
  return {
    async submit(digest) {
      const merged: Timestamp = newTimestamp(digest);
      const errors: string[] = [];
      const results = await Promise.allSettled(calendars.map((c) => calendarSubmit(c, digest)));
      for (const [i, r] of results.entries()) {
        if (r.status === 'fulfilled') mergeTimestamp(merged, r.value);
        else errors.push(`${redactUrl(calendars[i] ?? '')}: ${redactUrlsInText(String(r.reason))}`);
      }
      if (merged.ops.length === 0 && merged.attestations.length === 0) {
        throw new Error(`ningún calendario aceptó el digest: ${errors.join(' | ')}`);
      }
      return serializeDetached(merged);
    },
    async upgrade(ots) {
      const ts = deserializeDetached(ots);
      await upgrade(ts);
      return { ots: serializeDetached(ts), complete: isComplete(ts) };
    },
  };
}
