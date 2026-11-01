/**
 * Relay Nostr en memoria para tests: implementa el subconjunto de NIP-01 que usa nuestro
 * cliente (EVENT/REQ/CLOSE -> OK/EVENT/EOSE/CLOSED/NOTICE) y, opcionalmente, NIP-42 (AUTH).
 *
 * No es un relay de producción. Sirve para que la suite sea
 * determinista y no dependa de la red. Además nos deja simular comportamientos hostiles:
 * rechazar eventos, exigir autenticación, bloquear kinds, enviar basura, cortar la conexión.
 */
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { isValidEvent, type NostrEvent, nowSeconds } from '../../src/domain/nostr/event.ts';
import { type Filter, matchesAnyFilter } from '../../src/domain/nostr/protocol.ts';

export interface MiniRelayOptions {
  /** Devuelve un motivo para rechazar el evento, o null para aceptarlo. */
  reject?: (e: NostrEvent) => string | null;
  /** Si es true, el relay guarda el evento pero nunca contesta OK (simula relay lento). */
  swallowOk?: boolean;
  /** NIP-42: envía un challenge al conectar y rechaza EVENT hasta recibir un AUTH válido. */
  requireAuth?: boolean;
  /** Kinds que el relay rechaza con "blocked:" (p. ej. [5] para borrados NIP-09). */
  blockedKinds?: number[];
}

const AUTH_KIND = 22242;

export class MiniRelay {
  readonly events: NostrEvent[] = [];
  /** Eventos AUTH válidos recibidos (para inspección en tests). */
  readonly authEvents: NostrEvent[] = [];
  private wss!: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly subs = new Map<WebSocket, Map<string, Filter[]>>();
  private readonly challenges = new Map<WebSocket, string>();
  private readonly authed = new Map<WebSocket, Set<string>>();
  private readonly opts: MiniRelayOptions;
  private challengeCounter = 0;

  constructor(opts: MiniRelayOptions = {}) {
    this.opts = opts;
  }

  async start(): Promise<string> {
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((res) => this.wss.once('listening', res));
    this.wss.on('connection', (ws) => this.onConnection(ws));
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((res) => this.wss.close(() => res()));
  }

  /** Corta todas las conexiones sin avisar (simula caída del relay). */
  dropAllConnections(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  /** Envía un mensaje arbitrario a todos los clientes (para probar robustez del parser). */
  broadcastRaw(raw: string): void {
    for (const ws of this.sockets) ws.send(raw);
  }

  /** Igual que broadcastRaw pero como frame binario (algunos relays lo hacen). */
  broadcastBinary(raw: string): void {
    for (const ws of this.sockets) ws.send(Buffer.from(raw, 'utf8'), { binary: true });
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    this.subs.set(ws, new Map());
    this.authed.set(ws, new Set());
    if (this.opts.requireAuth) {
      const challenge = `challenge-${++this.challengeCounter}-${Math.random().toString(36).slice(2)}`;
      this.challenges.set(ws, challenge);
      ws.send(JSON.stringify(['AUTH', challenge]));
    }
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.subs.delete(ws);
      this.challenges.delete(ws);
      this.authed.delete(ws);
    });
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify(['NOTICE', 'invalid: not json']));
        return;
      }
      if (!Array.isArray(msg)) return;
      switch (msg[0]) {
        case 'EVENT':
          this.handleEvent(ws, msg[1]);
          break;
        case 'AUTH':
          this.handleAuth(ws, msg[1]);
          break;
        case 'REQ':
          this.handleReq(ws, msg[1], msg.slice(2) as Filter[]);
          break;
        case 'CLOSE':
          this.subs.get(ws)?.delete(msg[1]);
          break;
        default:
          ws.send(JSON.stringify(['NOTICE', `unknown message type ${String(msg[0])}`]));
      }
    });
  }

  private handleAuth(ws: WebSocket, e: unknown): void {
    if (!isValidEvent(e)) {
      ws.send(JSON.stringify(['OK', idOf(e), false, 'invalid: bad auth event']));
      return;
    }
    const challenge = this.challenges.get(ws);
    const tag = (n: string) => e.tags.find((t) => t[0] === n)?.[1];
    const ok =
      e.kind === AUTH_KIND &&
      challenge !== undefined &&
      tag('challenge') === challenge &&
      typeof tag('relay') === 'string' &&
      Math.abs(e.created_at - nowSeconds()) < 600;
    if (!ok) {
      ws.send(JSON.stringify(['OK', e.id, false, 'invalid: auth event does not match challenge']));
      return;
    }
    this.authed.get(ws)?.add(e.pubkey);
    this.authEvents.push(e);
    ws.send(JSON.stringify(['OK', e.id, true, '']));
  }

  private handleEvent(ws: WebSocket, e: unknown): void {
    if (!isValidEvent(e)) {
      ws.send(JSON.stringify(['OK', idOf(e), false, 'invalid: bad signature or id']));
      return;
    }
    if (this.opts.requireAuth && !this.authed.get(ws)?.has(e.pubkey)) {
      ws.send(JSON.stringify(['OK', e.id, false, 'auth-required: authenticate first']));
      return;
    }
    if (this.opts.blockedKinds?.includes(e.kind)) {
      ws.send(JSON.stringify(['OK', e.id, false, `blocked: kind ${e.kind} not allowed`]));
      return;
    }
    const reason = this.opts.reject?.(e) ?? null;
    if (reason) {
      ws.send(JSON.stringify(['OK', e.id, false, reason]));
      return;
    }
    const duplicate = this.events.some((x) => x.id === e.id);
    if (!duplicate) this.events.push(e);
    if (!this.opts.swallowOk) {
      ws.send(
        JSON.stringify(['OK', e.id, true, duplicate ? 'duplicate: already have this event' : '']),
      );
    }
    // Difundir a suscripciones activas que casen.
    for (const [sock, subs] of this.subs) {
      for (const [subId, filters] of subs) {
        if (matchesAnyFilter(e, filters)) sock.send(JSON.stringify(['EVENT', subId, e]));
      }
    }
  }

  private handleReq(ws: WebSocket, subId: string, filters: Filter[]): void {
    this.subs.get(ws)?.set(subId, filters);
    const stored = this.events.filter((e) => matchesAnyFilter(e, filters));
    // NIP-01: los eventos almacenados se devuelven del más nuevo al más antiguo
    // (desempate por id para que el orden sea determinista).
    stored.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    const limit = Math.min(...filters.map((f) => f.limit ?? Number.POSITIVE_INFINITY));
    for (const e of stored.slice(0, limit)) ws.send(JSON.stringify(['EVENT', subId, e]));
    ws.send(JSON.stringify(['EOSE', subId]));
  }
}

function idOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'id' in e ? String((e as { id: unknown }).id) : '';
}
