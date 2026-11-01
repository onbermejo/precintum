/**
 * Planificador del proceso `precintum run` (ADR-0002): ejecuta cada tarea con su cadencia, una a
 * una y sin solaparse. Las tareas son funciones inyectadas: así el planificador se prueba con
 * contadores y la CLI lo cablea con los servicios reales.
 */
import type { Logger } from '../shared/logger.ts';

export interface RunnerTasks {
  /** Cierra ventanas terminadas (BatchService.closeDueWindows). */
  closeWindows: (now: number) => Promise<unknown>;
  /** Un pase de la outbox hacia los testigos (WitnessWorker.runOnce). */
  publish: (now: number) => Promise<unknown>;
  /** Sellos y anclajes pendientes (BatchService.anchorPending). */
  anchors: (now: number) => Promise<unknown>;
  /** ¿Los testigos siguen sirviendo los últimos lotes? (checkPresence). */
  presence: (now: number) => Promise<unknown>;
  /** Peticiones de borrado NIP-09 firmadas por el agente (detectDeletions). */
  deletions: (now: number) => Promise<unknown>;
}

export interface RunnerIntervals {
  closeWindows: number;
  publish: number;
  anchors: number;
  presence: number;
  deletions: number;
}

/** Cadencias por defecto (segundos), justificadas en ADR-0002. */
export const DEFAULT_INTERVALS: RunnerIntervals = {
  closeWindows: 30,
  publish: 30,
  anchors: 600,
  presence: 21_600,
  deletions: 3_600,
};

export interface RunnerDeps {
  tasks: RunnerTasks;
  intervals?: Partial<RunnerIntervals>;
  now?: () => number;
  log?: Logger;
}

export type TaskName = keyof RunnerTasks;

export interface TickSummary {
  ran: TaskName[];
  failed: TaskName[];
}

export class Runner {
  private readonly tasks: RunnerTasks;
  private readonly intervals: RunnerIntervals;
  private readonly clock: () => number;
  private readonly initializedAt: number;
  private readonly log: Logger | undefined;
  private readonly lastRun: Partial<Record<TaskName, number>> = {};
  private lastTickAt: number | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: RunnerDeps) {
    this.tasks = deps.tasks;
    this.intervals = { ...DEFAULT_INTERVALS, ...deps.intervals };
    this.clock = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.initializedAt = this.clock();
    this.log = deps.log;
  }

  /** Una tarea toca cuando nunca ha corrido o cuando ha pasado su cadencia desde la última vez. */
  private due(name: TaskName, now: number): boolean {
    const last = this.lastRun[name];
    return last === undefined || now - last >= this.intervals[name];
  }

  /** Un pase: ejecuta en orden las tareas que tocan. Nunca se solapa consigo mismo. */
  async tick(now: number = this.clock()): Promise<TickSummary> {
    const summary: TickSummary = { ran: [], failed: [] };
    if (this.running) return summary;
    this.running = true;
    try {
      const order: TaskName[] = ['closeWindows', 'publish', 'anchors', 'presence', 'deletions'];
      for (const name of order) {
        if (!this.due(name, now)) continue;
        try {
          await this.tasks[name](now);
          summary.ran.push(name);
        } catch (err) {
          summary.failed.push(name);
          this.log?.error({ task: name, err: String(err) }, 'tarea del planificador fallida');
        } finally {
          // Una tarea que falla también espera su cadencia: no se martillea un servicio caído.
          this.lastRun[name] = now;
        }
      }
      this.lastTickAt = now;
    } finally {
      this.running = false;
    }
    return summary;
  }

  /** Salud: tres cadencias desde la inicialización o el último pase completo. */
  healthy(now: number = this.clock()): boolean {
    return (
      now - (this.lastTickAt ?? this.initializedAt) <=
      3 * Math.min(this.intervals.closeWindows, this.intervals.publish)
    );
  }

  /** Arranca el bucle: un pase ahora y otro cada `everySeconds`. */
  start(everySeconds = Math.min(this.intervals.closeWindows, this.intervals.publish)): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everySeconds * 1000);
  }

  /** Para el bucle y espera a que termine el pase en curso. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }
}
