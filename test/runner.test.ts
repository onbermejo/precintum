/**
 * El planificador de `precintum run` (ADR-0002): cada tarea con su cadencia, en orden, sin
 * solaparse, y un fallo no bloquea a las demás ni se martillea.
 */
import { describe, expect, it } from 'vitest';
import { Runner, type RunnerTasks } from '../src/application/runner.ts';

function counters() {
  const calls: Record<keyof RunnerTasks, number[]> = {
    closeWindows: [],
    publish: [],
    anchors: [],
    presence: [],
    deletions: [],
  };
  const tasks: RunnerTasks = {
    closeWindows: async (now) => void calls.closeWindows.push(now),
    publish: async (now) => void calls.publish.push(now),
    anchors: async (now) => void calls.anchors.push(now),
    presence: async (now) => void calls.presence.push(now),
    deletions: async (now) => void calls.deletions.push(now),
  };
  return { calls, tasks };
}

describe('Runner: cadencias y orden', () => {
  it('en el primer pase corre todo, y después cada tarea espera su cadencia', async () => {
    const { calls, tasks } = counters();
    const r = new Runner({
      tasks,
      intervals: {
        closeWindows: 30,
        publish: 30,
        anchors: 600,
        presence: 21_600,
        deletions: 3_600,
      },
    });
    expect((await r.tick(1_000)).ran).toEqual([
      'closeWindows',
      'publish',
      'anchors',
      'presence',
      'deletions',
    ]);
    // 10 s después no toca nada.
    expect((await r.tick(1_010)).ran).toEqual([]);
    // A los 30 s tocan las dos rápidas.
    expect((await r.tick(1_030)).ran).toEqual(['closeWindows', 'publish']);
    // A los 600 s toca también el anclaje.
    expect((await r.tick(1_600)).ran).toEqual(['closeWindows', 'publish', 'anchors']);
    expect(calls.presence).toEqual([1_000]);
    expect(calls.deletions).toEqual([1_000]);
    // Los borrados vuelven a la hora; la presencia, a las seis horas.
    expect((await r.tick(1_000 + 3_600)).ran).toContain('deletions');
    expect((await r.tick(1_000 + 3_600)).ran).not.toContain('presence');
    expect((await r.tick(1_000 + 21_600)).ran).toContain('presence');
  });

  it('una tarea que falla no impide las demás y no se reintenta hasta su cadencia', async () => {
    const { calls, tasks } = counters();
    let fail = true;
    tasks.publish = async (now) => {
      calls.publish.push(now);
      if (fail) throw new Error('relays caídos');
    };
    const r = new Runner({ tasks, intervals: { closeWindows: 30, publish: 30 } });
    const first = await r.tick(1_000);
    expect(first.failed).toEqual(['publish']);
    expect(first.ran).toContain('anchors');
    // Falló, pero no se martillea: espera los 30 s.
    expect(calls.publish).toEqual([1_000]);
    await r.tick(1_010);
    expect(calls.publish).toEqual([1_000]);
    fail = false;
    expect((await r.tick(1_030)).ran).toContain('publish');
  });

  it('dos pases a la vez no se solapan', async () => {
    const { tasks } = counters();
    let release: (value?: unknown) => void = () => {};
    tasks.closeWindows = () => new Promise((res) => (release = res));
    const r = new Runner({ tasks });
    const slow = r.tick(1_000);
    const overlapping = await r.tick(1_000);
    expect(overlapping.ran).toEqual([]);
    release();
    expect((await slow).ran).toContain('closeWindows');
  });

  it.each([
    { intervals: undefined, grace: 90 },
    { intervals: { closeWindows: 20, publish: 10 }, grace: 30 },
  ])(
    'la gracia inicial caduca tras $grace segundos si el primer pase no termina',
    async ({ intervals, grace }) => {
      const { tasks } = counters();
      let now = 1_000;
      let release: () => void = () => {};
      tasks.closeWindows = () => new Promise<void>((resolve) => (release = resolve));
      const r = new Runner({
        tasks,
        ...(intervals ? { intervals } : {}),
        now: () => now,
      });
      const pending = r.tick();
      try {
        expect(r.healthy()).toBe(true);
        now += grace;
        expect(r.healthy()).toBe(true);
        now++;
        expect(r.healthy()).toBe(false);
      } finally {
        release();
        await pending;
      }
    },
  );

  it('la salud mide la antigüedad del último pase completo y se recupera al completar otro', async () => {
    const { tasks } = counters();
    let now = 1_000;
    const r = new Runner({
      tasks,
      intervals: { closeWindows: 30, publish: 30 },
      now: () => now,
    });
    expect(r.healthy()).toBe(true); // arrancando
    await r.tick();
    now = 1_090;
    expect(r.healthy()).toBe(true);
    now++;
    expect(r.healthy()).toBe(false); // más de tres cadencias sin pase
    await r.tick();
    expect(r.healthy()).toBe(true);
    now += 91;
    expect(r.healthy()).toBe(false);
  });
});
