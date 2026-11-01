/**
 * Cliente mínimo de relay Nostr sobre el WebSocket global de Node (>= 22).
 *
 * ¿Por qué no usar directamente SimplePool de nostr-tools?
 * Porque en una capa de evidencia necesitamos el detalle de cada relay:
 *  - el ["OK", id, true, ...] de *ese* relay, con nuestra hora de recepción, como
 *    telemetría del testigo (no es prueba para terceros: el OK no va firmado),
 *  - timeouts explícitos y errores tipados por relay para decidir reintentos,
 *  - y poder verificar después, con un REQ por id, que el evento sigue ahí.
 * nostr-tools lo usamos como oráculo en los tests (cross-check), no en producción.
 *
 * NIP-42: si el relay pide autenticación (`AUTH` challenge y rechazos `auth-required:`),
 * el cliente puede firmar el evento efímero `kind 22242` con la identidad configurada y
 * reintentar la publicación una vez. El relay propio del operador lo exige.
 */
import type { Identity } from '../../domain/identity/keys.ts';
import type { NostrEvent } from '../../domain/nostr/event.ts';
import { nowSeconds, signEvent, verifyEvent } from '../../domain/nostr/event.ts';
import {
  type ClientMessage,
  type Filter,
  matchesAnyFilter,
  okPrefix,
  type RelayMessage,
  relayMessageSchema,
} from '../../domain/nostr/protocol.ts';
import type { Logger } from '../../shared/logger.ts';
import { redactUrl, redactUrlsInText } from '../../shared/redact.ts';

export const AUTH_KIND = 22242;

export type RelayErrorCode =
  | 'timeout'
  | 'rejected'
  | 'auth-required'
  | 'restricted'
  | 'closed'
  | 'connect'
  | 'protocol';

export class RelayError extends Error {
  readonly relay: string;
  readonly code: RelayErrorCode;
  /** Mensaje literal del relay (el texto del OK o del CLOSED), sin adornos. Vacío si no aplica. */
  readonly detail: string;

  constructor(relay: string, message: string, code: RelayErrorCode, detail = '') {
    super(`[${redactUrl(relay)}] ${redactUrlsInText(message)}`);
    this.name = 'RelayError';
    this.relay = relay;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Lo que el relay contestó a nuestro EVENT. Es telemetría del operador, útil para el
 * panel de continuidad; NO es evidencia para terceros (el OK no lleva firma ni hora
 * del relay). La evidencia verificable es el evento firmado + un query en vivo + OTS.
 */
export interface PublishReceipt {
  relay: string;
  eventId: string;
  accepted: true;
  message: string;
  /** Cuándo recibimos el OK, en ms epoch, según nuestro reloj. */
  receivedAt: number;
}

export interface Subscription {
  readonly id: string;
  /** Resuelve al recibir EOSE (fin de eventos almacenados). */
  readonly eose: Promise<void>;
  close(): void;
}

export interface SubscribeOptions {
  /** Se invoca si el relay cierra la suscripción o cae la conexión, también tras EOSE. */
  onClosed?: (reason: string) => void;
}

export interface QueryOptions {
  /** Tope de eventos acumulados en memoria. Por encima se cierra la suscripción. */
  maxEvents?: number;
}

export interface RelayClientOptions {
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  eoseTimeoutMs?: number;
  logger?: Logger;
  /** Identidad con la que contestar a un AUTH (NIP-42). Sin ella, `auth-required:` es un error final. */
  identity?: Identity;
}

type SubHandlers = {
  filters: Filter[];
  onEvent: (e: NostrEvent) => void;
  onEose: () => void;
  onClosed: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingOk = { resolve: (r: PublishReceipt) => void; reject: (e: Error) => void };

export class RelayClient {
  readonly url: string;
  private ws: WebSocket | null = null;
  private pendingWs: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly subs = new Map<string, SubHandlers>();
  /** Varias publicaciones simultáneas del mismo evento comparten el mismo OK. */
  private readonly pendingOk = new Map<string, PendingOk[]>();
  private subCounter = 0;
  private lastAuthChallenge: string | null = null;
  private authenticatedPubkey: string | null = null;
  private readonly identity: Identity | undefined;
  private readonly opts: Required<Omit<RelayClientOptions, 'logger' | 'identity'>>;
  private readonly log: Logger | undefined;

  constructor(url: string, opts: RelayClientOptions = {}) {
    this.url = url;
    this.opts = {
      connectTimeoutMs: opts.connectTimeoutMs ?? 5_000,
      publishTimeoutMs: opts.publishTimeoutMs ?? 8_000,
      eoseTimeoutMs: opts.eoseTimeoutMs ?? 8_000,
    };
    this.identity = opts.identity;
    this.log = opts.logger?.child({ relay: redactUrl(url) });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Último challenge NIP-42 recibido del relay, si lo hubo. */
  get authChallenge(): string | null {
    return this.lastAuthChallenge;
  }

  /** Pubkey con la que esta conexión está autenticada, o null. */
  get authenticatedAs(): string | null {
    return this.authenticatedPubkey;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.pendingWs = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new RelayError(this.url, 'timeout conectando', 'connect'));
      }, this.opts.connectTimeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.pendingWs = null;
        this.ws = ws;
        this.log?.debug('conectado');
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new RelayError(this.url, 'error de conexión', 'connect'));
      });
      ws.addEventListener('message', (ev) => {
        void this.handleData(ev.data);
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        if (this.pendingWs === ws) this.pendingWs = null;
        reject(new RelayError(this.url, 'conexión cerrada antes de abrir', 'connect'));
        this.onClose(ws);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Cierra la conexión, también si aún estaba abriéndose. */
  close(): void {
    this.pendingWs?.close();
    this.pendingWs = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /**
   * Publica y espera el OK del relay. Si el relay contesta `auth-required:` y hay identidad
   * configurada, se autentica (NIP-42) y reintenta una vez.
   */
  async publish(event: NostrEvent): Promise<PublishReceipt> {
    await this.connect();
    try {
      return await this.awaitOk(event.id, () => this.send(['EVENT', event]));
    } catch (err) {
      const needsAuth =
        err instanceof RelayError && err.code === 'auth-required' && this.identity !== undefined;
      if (!needsAuth) throw err;
      await this.authenticate(this.identity as Identity);
      return this.awaitOk(event.id, () => this.send(['EVENT', event]));
    }
  }

  /**
   * NIP-42: firma el evento efímero `kind 22242` con el challenge vigente y lo envía.
   * El relay contesta con un OK igual que a un EVENT. Requiere haber recibido AUTH.
   */
  async authenticate(identity: Identity): Promise<PublishReceipt> {
    await this.connect();
    const challenge = this.lastAuthChallenge;
    if (!challenge) {
      throw new RelayError(this.url, 'el relay no ha enviado ningún challenge AUTH', 'protocol');
    }
    const event = signEvent(
      {
        kind: AUTH_KIND,
        created_at: nowSeconds(),
        tags: [
          ['relay', this.url],
          ['challenge', challenge],
        ],
        content: '',
      },
      identity,
    );
    const receipt = await this.awaitOk(event.id, () => this.send(['AUTH', event]));
    this.authenticatedPubkey = identity.pubkey;
    this.log?.debug('autenticado (NIP-42)');
    return receipt;
  }

  /**
   * Abre una suscripción. Los eventos llegan por `onEvent` ya verificados
   * (firma + id); los inválidos se descartan y se loguean.
   */
  async subscribe(
    filters: Filter[],
    onEvent: (e: NostrEvent) => void,
    options: SubscribeOptions = {},
  ): Promise<Subscription> {
    await this.connect();
    const id = `s${++this.subCounter}-${Math.random().toString(36).slice(2, 8)}`;
    let eoseResolve: () => void = () => {};
    let eoseReject: (e: Error) => void = () => {};
    const eose = new Promise<void>((res, rej) => {
      eoseResolve = res;
      eoseReject = rej;
    });
    // Evita "unhandled rejection" si el llamante no espera a eose.
    eose.catch(() => {});
    const timer = setTimeout(
      () =>
        eoseReject(new RelayError(this.url, `sin EOSE en ${this.opts.eoseTimeoutMs}ms`, 'timeout')),
      this.opts.eoseTimeoutMs,
    );
    const handlers: SubHandlers = {
      filters,
      onEvent,
      timer,
      onEose: () => {
        clearTimeout(timer);
        eoseResolve();
      },
      onClosed: (reason) => {
        clearTimeout(timer);
        const code: RelayErrorCode =
          okPrefix(reason) === 'auth-required' ? 'auth-required' : 'closed';
        eoseReject(new RelayError(this.url, `suscripción cerrada: ${reason}`, code, reason));
        options.onClosed?.(reason);
      },
    };
    this.subs.set(id, handlers);
    try {
      this.send(['REQ', id, ...filters]);
    } catch (err) {
      this.subs.delete(id);
      clearTimeout(timer);
      throw err;
    }
    return {
      id,
      eose,
      close: () => {
        const h = this.subs.get(id);
        if (!h) return;
        clearTimeout(h.timer);
        this.subs.delete(id);
        // Si aún no había llegado EOSE, nadie debe quedarse esperándolo.
        eoseReject(new RelayError(this.url, 'suscripción cerrada por el cliente', 'closed'));
        if (this.connected) this.send(['CLOSE', id]);
      },
    };
  }

  /** Consulta puntual: abre, recoge hasta EOSE, cierra. Ideal para "¿está el evento X?". */
  async query(filters: Filter[], options: QueryOptions = {}): Promise<NostrEvent[]> {
    const max = options.maxEvents ?? 10_000;
    const out: NostrEvent[] = [];
    let sub: Subscription | null = null;
    sub = await this.subscribe(filters, (e) => {
      if (out.length < max) out.push(e);
      if (out.length >= max) {
        this.log?.warn({ max }, 'query alcanzó el tope de eventos; se cierra la suscripción');
        sub?.close();
      }
    });
    try {
      await sub.eose;
    } catch (err) {
      // Si cerramos nosotros por tope, el EOSE ya no llegará: no es un fallo.
      if (out.length < max) throw err;
    } finally {
      sub.close();
    }
    return out;
  }

  // ---------- internos ----------

  /** Registra la espera del OK de `eventId` y ejecuta el envío. */
  private awaitOk(eventId: string, doSend: () => void): Promise<PublishReceipt> {
    return new Promise<PublishReceipt>((resolve, reject) => {
      const entry: PendingOk = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.removePending(eventId, entry);
        reject(new RelayError(this.url, `sin OK en ${this.opts.publishTimeoutMs}ms`, 'timeout'));
      }, this.opts.publishTimeoutMs);
      const list = this.pendingOk.get(eventId);
      if (list) list.push(entry);
      else this.pendingOk.set(eventId, [entry]);
      try {
        // Si ya había un envío en vuelo del mismo evento, el relay contestará una vez
        // (o con "duplicate:"): no reenviamos.
        if (!list) doSend();
      } catch (err) {
        this.removePending(eventId, entry);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new RelayError(this.url, 'socket no abierto', 'closed');
    }
    this.ws.send(JSON.stringify(msg));
  }

  private removePending(eventId: string, entry: PendingOk): void {
    const list = this.pendingOk.get(eventId);
    if (!list) return;
    const rest = list.filter((p) => p !== entry);
    if (rest.length) this.pendingOk.set(eventId, rest);
    else this.pendingOk.delete(eventId);
  }

  /** El WebSocket global entrega string para frames de texto y Blob/ArrayBuffer para binarios. */
  private async handleData(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof Blob) text = await data.text();
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    } else {
      this.log?.warn('frame de tipo desconocido descartado');
      return;
    }
    this.onMessage(text);
  }

  private onMessage(raw: string): void {
    let parsed: RelayMessage;
    try {
      const json: unknown = JSON.parse(raw);
      const r = relayMessageSchema.safeParse(json);
      if (!r.success) {
        this.log?.warn(
          { raw: redactUrlsInText(raw).slice(0, 200) },
          'mensaje de relay no reconocido',
        );
        return;
      }
      parsed = r.data;
    } catch {
      this.log?.warn({ raw: redactUrlsInText(raw).slice(0, 200) }, 'mensaje de relay no es JSON');
      return;
    }

    switch (parsed[0]) {
      case 'OK': {
        const [, eventId, accepted, message] = parsed;
        const list = this.pendingOk.get(eventId);
        if (!list) return;
        this.pendingOk.delete(eventId);
        if (accepted) {
          const receipt: PublishReceipt = {
            relay: this.url,
            eventId,
            accepted: true,
            message,
            receivedAt: Date.now(),
          };
          for (const p of list) p.resolve(receipt);
        } else {
          const prefix = okPrefix(message);
          const code: RelayErrorCode =
            prefix === 'auth-required'
              ? 'auth-required'
              : prefix === 'restricted'
                ? 'restricted'
                : 'rejected';
          for (const p of list) {
            p.reject(new RelayError(this.url, `rechazado: ${message}`, code, message));
          }
        }
        return;
      }
      case 'EVENT': {
        const [, subId, event] = parsed;
        const sub = this.subs.get(subId);
        if (!sub) return;
        const v = verifyEvent(event);
        if (!v.ok) {
          this.log?.warn({ eventId: event.id, reason: v.reason }, 'evento inválido descartado');
          return;
        }
        if (!matchesAnyFilter(event, sub.filters)) {
          this.log?.warn({ eventId: event.id }, 'relay envió evento fuera de filtro; descartado');
          return;
        }
        sub.onEvent(event);
        return;
      }
      case 'EOSE':
        this.subs.get(parsed[1])?.onEose();
        return;
      case 'CLOSED': {
        const [, subId, reason] = parsed;
        const sub = this.subs.get(subId);
        this.subs.delete(subId);
        sub?.onClosed(reason);
        return;
      }
      case 'NOTICE':
        this.log?.info({ notice: redactUrlsInText(parsed[1]) }, 'NOTICE del relay');
        return;
      case 'AUTH':
        // NIP-42: el relay pide autenticación. Guardamos el challenge; se contesta en
        // `authenticate()` (automáticamente desde `publish` si hay identidad configurada).
        this.lastAuthChallenge = parsed[1];
        this.log?.debug('AUTH challenge recibido');
        return;
      case 'COUNT':
        // NIP-45: respuesta a un COUNT que este cliente aún no envía. Se ignora.
        return;
    }
  }

  private onClose(ws: WebSocket): void {
    // Ignora cierres de sockets antiguos (p. ej. tras una reconexión).
    if (this.ws !== null && this.ws !== ws) return;
    this.log?.debug('desconectado');
    this.ws = null;
    this.authenticatedPubkey = null;
    this.lastAuthChallenge = null;
    for (const [id, list] of this.pendingOk) {
      for (const p of list) {
        p.reject(new RelayError(this.url, 'conexión cerrada antes del OK', 'closed'));
      }
      this.pendingOk.delete(id);
    }
    for (const [id, s] of this.subs) {
      this.subs.delete(id);
      s.onClosed('conexión cerrada');
    }
  }
}
