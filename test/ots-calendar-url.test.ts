import { describe, expect, it } from 'vitest';
import {
  calendarSubmit,
  calendarUpgrade,
  newTimestamp,
  serializeTimestamp,
  upgrade,
} from '../src/infra/ots/ots.ts';
import { calendarOtsClient } from '../src/infra/ots/ots-client.ts';
import { loadConfig } from '../src/shared/config.ts';

const CALENDAR = 'https://calendar.example';
const DIGEST = new Uint8Array(32);
const UNSUPPORTED = [
  'https://operator:fixture-password@calendar.example',
  'https://calendar.example?key=fixture-token',
  'https://calendar.example#fixture-token',
  'ftp://calendar.example',
  'https://[::1]:1234',
  'https://calendar.example/path%20encoded',
  'http://calendar.example:99999',
  'http://',
];

describe('las URLs de calendario no transportan secretos en las pruebas OTS', () => {
  it.each(UNSUPPORTED)(
    'la configuración y el cliente rechazan el calendario no compatible: %s',
    (url) => {
      expect(() => loadConfig({ PRECINTUM_OTS_CALENDARS: url })).toThrow(/PRECINTUM_OTS_CALENDARS/);
      expect(() => calendarOtsClient([url])).toThrow(/calendario.*compatible/);
    },
  );

  it.each(UNSUPPORTED)('no envía peticiones a un calendario no compatible: %s', async (url) => {
    let calls = 0;
    const fake = async () => {
      calls++;
      return new Response(null, { status: 503 });
    };
    for (const request of [calendarSubmit, calendarUpgrade]) {
      await expect(request(url, DIGEST, fake)).rejects.toThrow(/calendario.*compatible/);
    }
    const pending = newTimestamp(DIGEST);
    pending.attestations.push({ type: 'pending', uri: url });
    await expect(upgrade(pending, fake)).rejects.toThrow(/calendario.*compatible/);
    expect(calls).toBe(0);
  });

  it.each(UNSUPPORTED)(
    'rechaza una URI pending no compatible recibida del calendario: %s',
    async (url) => {
      const response = newTimestamp(DIGEST);
      response.attestations.push({ type: 'pending', uri: url });
      const fake = async () => new Response(serializeTimestamp(response));
      const error = await calendarSubmit(CALENDAR, DIGEST, fake).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('fixture-password');
      expect(String(error)).not.toContain('fixture-token');
    },
  );

  it('mantiene intactas las URLs y los bytes pending de calendarios compatibles', async () => {
    expect(loadConfig({ PRECINTUM_OTS_CALENDARS: CALENDAR }).PRECINTUM_OTS_CALENDARS).toEqual([
      CALENDAR,
    ]);
    const response = newTimestamp(DIGEST);
    response.attestations.push({ type: 'pending', uri: CALENDAR });
    const bytes = serializeTimestamp(response);
    let target = '';
    const fake = async (url: string) => {
      target = url;
      return new Response(bytes);
    };
    const accepted = await calendarSubmit(CALENDAR, DIGEST, fake);
    expect(target).toBe(`${CALENDAR}/digest`);
    expect(serializeTimestamp(accepted)).toEqual(bytes);
  });
});
