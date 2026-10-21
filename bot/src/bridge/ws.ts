// Minimal RFC 6455 WebSocket server on node:http (text and binary frames, fragmentation, ping/pong,
// close). No extensions (permessage-deflate is not negotiated), no subprotocols. Enough for the RL
// bridge's one JSON message per frame; avoids a runtime dependency (the `ws` package is not a
// dependency of the bot). Listens on loopback by default.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest accepted message (all fragments together). */
export const MAX_MESSAGE = 16 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encodes one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Incremental frame decoder (client frames must be masked). */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0]! & 0x80) !== 0;
      if ((b[0]! & 0x70) !== 0) throw new Error('reserved bits set (no extensions negotiated)');
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error(`frame too large: ${big}`);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MESSAGE) throw new Error(`frame too large: ${len}`);
      if (!masked) throw new Error('client frame not masked');
      if (b.length < off + 4 + len) break;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      out.push({ fin, opcode, payload });
      this.buf = b.subarray(off + 4 + len);
    }
    return out;
  }
}

export class WsConnection {
  readonly remote: string;
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private fragments: Buffer[] = [];
  private fragmentOp = 0;
  private fragmentLen = 0;
  private closed = false;
  private readonly messageFns = new Set<(text: string) => void>();
  private readonly closeFns = new Set<(code: number, reason: string) => void>();

  constructor(socket: Socket, head?: Buffer) {
    this.socket = socket;
    this.remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    // Bytes that arrived with the upgrade request: handle them once listeners are attached.
    if (head?.length) setImmediate(() => this.onData(head));
    socket.on('close', () => this.finish(1006, 'socket closed'));
    socket.on('error', () => this.finish(1006, 'socket error'));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  onMessage(fn: (text: string) => void): () => void {
    this.messageFns.add(fn);
    return () => this.messageFns.delete(fn);
  }

  onClose(fn: (code: number, reason: string) => void): () => void {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  send(text: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const r = Buffer.from(reason.slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.socket.write(encodeFrame(OP_CLOSE, p));
    this.socket.end();
    this.finish(code, reason);
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (e) {
      this.close(1002, e instanceof Error ? e.message : 'protocol error');
      return;
    }
    for (const f of frames) this.onFrame(f);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of [...this.closeFns]) fn(code, reason);
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  private onFrame(f: Frame): void {
    if (this.closed) return;
    switch (f.opcode) {
      case OP_PING:
        this.socket.write(encodeFrame(OP_PONG, f.payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 ? 1000 : code, f.payload.subarray(2).toString('utf8'));
        return;
      }
      case OP_TEXT:
      case OP_BIN:
        if (this.fragments.length) {
          this.close(1002, 'new message inside a fragmented one');
          return;
        }
        if (f.fin) {
          this.deliver(f.payload);
          return;
        }
        this.fragmentOp = f.opcode;
        this.fragments = [f.payload];
        this.fragmentLen = f.payload.length;
        return;
      case OP_CONT:
        if (!this.fragments.length || this.fragmentOp === 0) {
          this.close(1002, 'continuation without a start');
          return;
        }
        this.fragments.push(f.payload);
        this.fragmentLen += f.payload.length;
        if (this.fragmentLen > MAX_MESSAGE) {
          this.close(1009, 'message too large');
          return;
        }
        if (f.fin) {
          const all = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOp = 0;
          this.fragmentLen = 0;
          this.deliver(all);
        }
        return;
      default:
        this.close(1002, `unknown opcode ${f.opcode}`);
    }
  }

  private deliver(payload: Buffer): void {
    const text = payload.toString('utf8');
    for (const fn of [...this.messageFns]) fn(text);
  }
}

export class WsServer {
  private readonly http: Server;
  private readonly connectionFns = new Set<(c: WsConnection, req: IncomingMessage) => void>();
  private readonly conns = new Set<WsConnection>();

  constructor() {
    this.http = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket' });
      res.end('WebSocket only\n');
    });
    this.http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const key = req.headers['sec-websocket-key'];
      const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
      if (upgrade !== 'websocket' || typeof key !== 'string' || key.length === 0) {
        socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
        return;
      }
      socket.write(
        ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
      );
      const c = new WsConnection(socket, head);
      this.conns.add(c);
      c.onClose(() => this.conns.delete(c));
      for (const fn of [...this.connectionFns]) fn(c, req);
    });
  }

  onConnection(fn: (c: WsConnection, req: IncomingMessage) => void): () => void {
    this.connectionFns.add(fn);
    return () => this.connectionFns.delete(fn);
  }

  /** Starts listening; resolves with the bound port (0 = pick a free one). */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        resolve((this.http.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    for (const c of [...this.conns]) c.close(1001, 'server closing');
    return new Promise((resolve) => this.http.close(() => resolve()));
  }
}
