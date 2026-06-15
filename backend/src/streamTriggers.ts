import WebSocket from 'ws';
import mqtt from 'mqtt';
import { ImapFlow } from 'imapflow';
import { getWorkflowById, getCredentialById } from './db.js';
import { executeWorkflowAndRecord, execStack } from './executor.js';
import { triggerContext } from './dataTableEvents.js';
import { assertSafeUrl } from './security.js';
import { resolveCredentialAuth } from './registry.js';

/**
 * Triggers de larga duración / streaming: mantienen una conexión persistente y disparan el
 * flujo en cada mensaje entrante. Cuatro transportes: SSE, WebSocket, MQTT e IMAP.
 *
 * La infraestructura es común: conectar → disparar-por-mensaje (detached, como el trigger de
 * tabla) → reconectar con backoff exponencial al caer → cerrar limpio al desactivar. Cada
 * transporte es un adaptador que llama `onMessage`/`onClosed`; el manager posee el backoff.
 */

export type StreamTransport = 'sse' | 'websocket' | 'mqtt' | 'imap';

export interface StreamTriggerConfig {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  transport: StreamTransport;
  url?: string;          // sse / websocket / mqtt
  topic?: string;        // mqtt
  mailbox?: string;      // imap (default INBOX)
  host?: string;         // imap
  port?: number;         // imap (default 993)
  secure?: boolean;      // imap (default true)
  credentialId?: string;
}

type OnMessage = (msg: any) => void;
type OnClosed = (err?: any) => void;
interface TransportHandle { close: () => void; }
type ConnectFn = (cfg: StreamTriggerConfig, onMessage: OnMessage, onClosed: OnClosed) => Promise<TransportHandle> | TransportHandle;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/** Intenta parsear JSON; si no es JSON devuelve el string tal cual. */
export function parseMaybeJson(text: string): any {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Parser de un bloque de evento SSE (campos separados por línea, bloques por línea en blanco).
 * Devuelve null si el bloque no contiene `data:`.
 */
export function parseSseEvent(raw: string): { event?: string; data: string } | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  let event: string | undefined;
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comentario
    const ci = line.indexOf(':');
    const field = ci === -1 ? line : line.slice(0, ci);
    let val = ci === -1 ? '' : line.slice(ci + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'data') data.push(val);
    else if (field === 'event') event = val;
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** Mapea el esquema a http/https para reutilizar el SSRF guard (assertSafeUrl). */
async function guardUrl(rawUrl: string): Promise<void> {
  const mapped = rawUrl
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/^mqtts:/i, 'https:')
    .replace(/^mqtt:/i, 'http:')
    .replace(/^tcp:/i, 'http:')
    .replace(/^tls:/i, 'https:');
  await assertSafeUrl(mapped);
}

/** Carga credenciales usuario/contraseña (basicAuth) para MQTT / IMAP. */
async function basicCreds(credentialId?: string): Promise<{ username?: string; password?: string }> {
  if (!credentialId) return {};
  const cred = await getCredentialById(credentialId);
  if (cred?.type === 'basicAuth' && cred.data) {
    return { username: cred.data.user, password: cred.data.password };
  }
  return {};
}

function appendQuery(url: string, query: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.append(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Adaptadores de transporte
// ---------------------------------------------------------------------------

/** SSE sobre fetch nativo (sin dependencias). Lee el stream y parsea eventos. */
const connectSse: ConnectFn = async (cfg, onMessage, onClosed) => {
  if (!cfg.url) throw new Error('SSE trigger requiere url');
  const { headers, query } = await resolveCredentialAuth(cfg.credentialId);
  const url = appendQuery(cfg.url, query);
  await guardUrl(url);

  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`Conexión SSE falló (${res.status})`);
  }

  (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evt = parseSseEvent(block);
          if (evt) onMessage({ event: evt.event, data: parseMaybeJson(evt.data) });
        }
      }
      onClosed(new Error('stream SSE terminado'));
    } catch (err) {
      if (!controller.signal.aborted) onClosed(err);
    }
  })();

  return { close: () => controller.abort() };
};

/** WebSocket (ws). */
const connectWebSocket: ConnectFn = async (cfg, onMessage, onClosed) => {
  if (!cfg.url) throw new Error('WebSocket trigger requiere url');
  const { headers, query } = await resolveCredentialAuth(cfg.credentialId);
  const url = appendQuery(cfg.url, query);
  await guardUrl(url);

  const ws = new WebSocket(url, { headers });
  let closed = false;
  ws.on('message', (data: any) => onMessage(parseMaybeJson(data.toString())));
  ws.on('close', () => { if (!closed) { closed = true; onClosed(); } });
  ws.on('error', (err: any) => { if (!closed) { closed = true; onClosed(err); } try { ws.terminate(); } catch { /* */ } });

  return { close: () => { closed = true; try { ws.close(); } catch { /* */ } } };
};

/** MQTT (mqtt). Suscribe a `topic` y dispara por mensaje. Reconexión la gestiona el manager. */
const connectMqtt: ConnectFn = async (cfg, onMessage, onClosed) => {
  if (!cfg.url) throw new Error('MQTT trigger requiere url');
  if (!cfg.topic) throw new Error('MQTT trigger requiere topic');
  await guardUrl(cfg.url);
  const { username, password } = await basicCreds(cfg.credentialId);

  // reconnectPeriod: 0 → desactiva la reconexión interna; el manager aplica su backoff.
  const client = mqtt.connect(cfg.url, { username, password, reconnectPeriod: 0, connectTimeout: 15000 });
  let closed = false;
  client.on('connect', () => client.subscribe(cfg.topic!, (err: any) => { if (err && !closed) { closed = true; onClosed(err); } }));
  client.on('message', (topic: string, payload: Buffer) => onMessage({ topic, message: parseMaybeJson(payload.toString()) }));
  client.on('error', (err: any) => { if (!closed) { closed = true; onClosed(err); } try { client.end(true); } catch { /* */ } });
  client.on('close', () => { if (!closed) { closed = true; onClosed(); } });

  return { close: () => { closed = true; try { client.end(true); } catch { /* */ } } };
};

/** IMAP (imapflow). Tras IDLE, dispara con el sobre del/los mensajes nuevos. */
const connectImap: ConnectFn = async (cfg, onMessage, onClosed) => {
  if (!cfg.host) throw new Error('IMAP trigger requiere host');
  await assertSafeUrl(`https://${cfg.host}`);
  const { username, password } = await basicCreds(cfg.credentialId);
  if (!username || !password) throw new Error('IMAP trigger requiere una credencial basicAuth (usuario/contraseña)');

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port || 993,
    secure: cfg.secure !== false,
    auth: { user: username, pass: password },
    logger: false,
  });
  let closed = false;
  let lastSeen = 0;

  const fail = (err?: any) => { if (!closed) { closed = true; onClosed(err); } };
  client.on('error', fail);
  client.on('close', () => fail());

  // 'exists' se emite durante IDLE cuando llegan mensajes nuevos.
  client.on('exists', async (data: any) => {
    try {
      const count = data?.count ?? 0;
      if (count <= lastSeen) { lastSeen = count; return; }
      for (let seq = lastSeen + 1; seq <= count; seq++) {
        const msg: any = await client.fetchOne(String(seq), { envelope: true, uid: true });
        if (msg) onMessage({ uid: msg.uid, envelope: msg.envelope });
      }
      lastSeen = count;
    } catch (err) {
      fail(err);
    }
  });

  (async () => {
    await client.connect();
    const mailbox: any = await client.mailboxOpen(cfg.mailbox || 'INBOX');
    lastSeen = mailbox?.exists ?? 0; // ignora los ya existentes; solo dispara con los nuevos
  })().catch(fail);

  return {
    close: () => {
      closed = true;
      client.logout().catch(() => { try { (client as any).close?.(); } catch { /* */ } });
    },
  };
};

const defaultTransports: Record<StreamTransport, ConnectFn> = {
  sse: connectSse,
  websocket: connectWebSocket,
  mqtt: connectMqtt,
  imap: connectImap,
};

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Dispara el flujo asociado a la conexión, detached (raíz nueva, como el trigger de tabla). */
async function defaultFire(cfg: StreamTriggerConfig, message: any): Promise<void> {
  const workflow = await getWorkflowById(cfg.workflowId);
  if (!workflow || !workflow.active) return;
  const payload = {
    source: 'stream',
    transport: cfg.transport,
    message,
    timestamp: new Date().toISOString(),
  };
  await execStack.run(new Set(), () =>
    triggerContext.run({ depth: 1 }, () => executeWorkflowAndRecord(workflow, payload))
  );
}

class StreamConnection {
  private handle?: TransportHandle;
  private stopped = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private cfg: StreamTriggerConfig,
    private connectFn: ConnectFn,
    private fire: (cfg: StreamTriggerConfig, msg: any) => Promise<void> | void,
    private backoff: Required<BackoffOptions>,
  ) {}

  start() { void this.open(); }

  private async open() {
    if (this.stopped) return;
    try {
      this.handle = await this.connectFn(
        this.cfg,
        (msg) => this.onMessage(msg),
        (err) => this.onClosed(err),
      );
    } catch (err) {
      this.onClosed(err);
    }
  }

  private onMessage(msg: any) {
    if (this.stopped) return;
    this.attempt = 0; // progreso real → resetea el backoff
    Promise.resolve(this.fire(this.cfg, msg)).catch((err) =>
      console.error(`[StreamTrigger] Error disparando "${this.cfg.workflowName}" (${this.cfg.workflowId}):`, err)
    );
  }

  private onClosed(err?: any) {
    if (this.stopped) return;
    this.handle = undefined;
    const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempt);
    this.attempt++;
    console.warn(`[StreamTrigger] ${this.cfg.transport} "${this.cfg.workflowName}" desconectado${err ? ` (${err.message || err})` : ''}; reintentando en ${delay}ms`);
    this.timer = setTimeout(() => void this.open(), delay);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.handle?.close(); } catch { /* */ }
    this.handle = undefined;
  }
}

export class StreamTriggerManager {
  private conns = new Map<string, StreamConnection[]>();
  private transports: Record<StreamTransport, ConnectFn>;
  private fire: (cfg: StreamTriggerConfig, msg: any) => Promise<void> | void;
  private backoff: Required<BackoffOptions>;

  constructor(opts?: {
    transports?: Partial<Record<StreamTransport, ConnectFn>>;
    fire?: (cfg: StreamTriggerConfig, msg: any) => Promise<void> | void;
    backoff?: BackoffOptions;
  }) {
    this.transports = { ...defaultTransports, ...(opts?.transports || {}) };
    this.fire = opts?.fire || defaultFire;
    this.backoff = { baseMs: opts?.backoff?.baseMs ?? 1000, maxMs: opts?.backoff?.maxMs ?? 30000 };
  }

  /** Abre una conexión de streaming para un nodo trigger. */
  start(cfg: StreamTriggerConfig) {
    const connectFn = this.transports[cfg.transport];
    if (!connectFn) {
      console.warn(`[StreamTrigger] Transporte desconocido "${cfg.transport}" en "${cfg.workflowName}". Ignorado.`);
      return;
    }
    const conn = new StreamConnection(cfg, connectFn, this.fire, this.backoff);
    const list = this.conns.get(cfg.workflowId) || [];
    list.push(conn);
    this.conns.set(cfg.workflowId, list);
    console.log(`[StreamTrigger] Conectando ${cfg.transport} para "${cfg.workflowName}" (${cfg.workflowId})`);
    conn.start();
  }

  /** Cierra todas las conexiones de streaming de un flujo. */
  stopWorkflow(workflowId: string) {
    const list = this.conns.get(workflowId);
    if (!list) return;
    for (const c of list) c.stop();
    this.conns.delete(workflowId);
  }

  /** Cierra todas las conexiones de streaming. */
  stopAll() {
    for (const list of this.conns.values()) for (const c of list) c.stop();
    this.conns.clear();
  }

  /** Nº de conexiones activas (para tests/diagnóstico). */
  activeCount(): number {
    let n = 0;
    for (const list of this.conns.values()) n += list.length;
    return n;
  }
}

export const streamTriggerManager = new StreamTriggerManager();
