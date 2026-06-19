import { randomBytes } from "crypto";
import type { Readable } from "node:stream";

export * from "./rewrite.js";

// ── Protocol overview ──
//
// railgate v2 streams. Control metadata travels as JSON *text* frames; request
// and response bodies (and proxied WebSocket payloads) travel as *binary*
// frames so we avoid base64 overhead and never buffer a whole body in memory.
//
// A single HTTP exchange looks like:
//   relay → client:  request-head, [REQUEST_BODY frames...], request-end
//   client → relay:  response-head, [RESPONSE_BODY frames...], response-end
// Either side may emit request-abort / response-error to tear the exchange down.

type HeaderMap = Record<string, string | string[]>;

// ── Control messages (JSON text frames) ──

/** Client → relay: register a tunnel. */
export interface RegisterMessage {
  type: "register";
  subdomain?: string;
  protocolVersion: number;
}

/** Relay → client: tunnel registered. */
export interface RegisteredMessage {
  type: "registered";
  url: string;
  pathUrl?: string;
  subdomain: string;
}

/** Relay → client: start of an inbound HTTP request. */
export interface RequestHeadMessage {
  type: "request-head";
  id: string;
  method: string;
  path: string;
  headers: HeaderMap;
}

/** Relay → client: the inbound request body is complete. */
export interface RequestEndMessage {
  type: "request-end";
  id: string;
}

/** Relay → client: abandon an in-flight request (timeout, client gone, too large). */
export interface RequestAbortMessage {
  type: "request-abort";
  id: string;
  message?: string;
}

/** Client → relay: start of the response (status + headers). */
export interface ResponseHeadMessage {
  type: "response-head";
  id: string;
  status: number;
  headers: HeaderMap;
}

/** Client → relay: the response body is complete. */
export interface ResponseEndMessage {
  type: "response-end";
  id: string;
}

/** Client → relay: the local service failed before/while responding. */
export interface ResponseErrorMessage {
  type: "response-error";
  id: string;
  status?: number;
  message: string;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

/** Relay → client: a non-fatal advisory (e.g. requests escaping the path
 * prefix). The tunnel stays up; the client surfaces it to the user. */
export interface NoticeMessage {
  type: "notice";
  message: string;
  code?: string;
}

// ── WebSocket proxy control messages ──

export interface WsOpenMessage {
  type: "ws-open";
  id: string;
  path: string;
  headers: HeaderMap;
}

export interface WsOpenedMessage {
  type: "ws-opened";
  id: string;
}

export interface WsFailedMessage {
  type: "ws-failed";
  id: string;
  message: string;
}

export interface WsCloseMessage {
  type: "ws-close";
  id: string;
  code?: number;
  reason?: string;
}

/**
 * Coerce a WebSocket close code into one that is valid to *send*.
 *
 * Peers can close with reserved codes like 1005 (no status received) or 1006
 * (abnormal closure). These are valid to receive but throw if you try to send
 * them back through `ws`. We forward the peer's code across the tunnel, so the
 * other end must sanitize before calling `.close(code)` or the process crashes.
 * Mirrors `ws`'s own `isValidStatusCode`; anything invalid falls back to 1000.
 */
export function sanitizeCloseCode(code: number | undefined): number {
  if (
    typeof code === "number" &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  ) {
    return code;
  }
  return 1000;
}

export type ClientMessage =
  | RegisterMessage
  | ResponseHeadMessage
  | ResponseEndMessage
  | ResponseErrorMessage
  | PongMessage
  | WsOpenedMessage
  | WsFailedMessage
  | WsCloseMessage;

export type ServerMessage =
  | RegisteredMessage
  | RequestHeadMessage
  | RequestEndMessage
  | RequestAbortMessage
  | PingMessage
  | ErrorMessage
  | NoticeMessage
  | WsOpenMessage
  | WsCloseMessage;

export type ControlMessage = ClientMessage | ServerMessage;

// ── Binary body frames ──
//
// Layout: [opcode:1][idLen:1][id:idLen][payload...]
// ids are short ascii strings (request/connection IDs), so a single length
// byte is plenty.

export const FRAME_REQUEST_BODY = 0x01;
export const FRAME_RESPONSE_BODY = 0x02;
export const FRAME_WS_TEXT = 0x03;
export const FRAME_WS_BINARY = 0x04;

export interface DecodedFrame {
  opcode: number;
  id: string;
  payload: Buffer;
}

export function encodeBinaryFrame(
  opcode: number,
  id: string,
  payload: Buffer
): Buffer {
  const idBuf = Buffer.from(id, "ascii");
  if (idBuf.length > 255) throw new Error("frame id too long");
  const header = Buffer.allocUnsafe(2 + idBuf.length);
  header[0] = opcode;
  header[1] = idBuf.length;
  idBuf.copy(header, 2);
  return Buffer.concat([header, payload]);
}

export function decodeBinaryFrame(buf: Buffer): DecodedFrame {
  const opcode = buf[0];
  const idLen = buf[1];
  const id = buf.toString("ascii", 2, 2 + idLen);
  const payload = buf.subarray(2 + idLen);
  return { opcode, id, payload };
}

// ── Streaming helpers ──

/** Cap on a single binary frame's payload so large bodies interleave with
 * other traffic on the shared control socket instead of head-of-line blocking. */
export const BODY_CHUNK_SIZE = 64 * 1024;

/** Pause sources once the socket's outbound buffer passes this mark. */
export const DEFAULT_HIGH_WATER_MARK = 8 * 1024 * 1024;

/** ws.readyState value for OPEN (mirrors the `ws` library constant without
 * importing it into shared). */
export const WS_READY_OPEN = 1;

export function* chunkBuffer(
  buf: Buffer,
  size = BODY_CHUNK_SIZE
): Generator<Buffer> {
  if (buf.length <= size) {
    yield buf;
    return;
  }
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, i + size);
  }
}

/** Minimal view of a `ws` WebSocket used for sending binary frames. */
export interface FrameSink {
  send(data: Buffer | Uint8Array): void;
  bufferedAmount: number;
  readyState: number;
}

export interface StreamFramesOptions {
  highWaterMark?: number;
  /** Abort once the cumulative body size exceeds this many bytes. */
  maxBytes?: number;
  /** Called once if maxBytes is exceeded; the source is destroyed afterward. */
  onLimitExceeded?: () => void;
}

/**
 * Pipe a Readable body into chunked binary frames on `sink`, applying simple
 * backpressure (pause the source while the socket buffer is draining) and an
 * optional size limit. Calls `onEnd` when the source ends normally.
 */
export function streamBodyFrames(
  source: Readable,
  sink: FrameSink,
  opcode: number,
  id: string,
  onEnd: () => void,
  options: StreamFramesOptions = {}
): void {
  const hwm = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  let total = 0;
  let aborted = false;

  source.on("data", (chunk: Buffer) => {
    if (aborted) return;

    if (options.maxBytes !== undefined) {
      total += chunk.length;
      if (total > options.maxBytes) {
        aborted = true;
        options.onLimitExceeded?.();
        source.destroy();
        return;
      }
    }

    for (const piece of chunkBuffer(chunk)) {
      if (sink.readyState !== WS_READY_OPEN) return;
      sink.send(encodeBinaryFrame(opcode, id, piece));
    }

    if (sink.bufferedAmount > hwm) {
      source.pause();
      const timer = setInterval(() => {
        if (
          sink.readyState !== WS_READY_OPEN ||
          sink.bufferedAmount <= hwm
        ) {
          clearInterval(timer);
          source.resume();
        }
      }, 25);
    }
  });

  source.once("end", () => {
    if (!aborted) onEnd();
  });
}

// ── Header hygiene ──

/** Connection-specific headers that must not be forwarded by a proxy
 * (RFC 7230 §6.1). */
export const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

/**
 * Strip hop-by-hop headers from a header map in place, including any headers
 * explicitly listed in the `Connection` header. Mutates and returns the map.
 */
export function stripHopByHopHeaders(
  headers: Record<string, string | string[]>
): Record<string, string | string[]> {
  const connection = headers["connection"];
  if (connection) {
    const listed = (Array.isArray(connection) ? connection.join(",") : connection)
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    for (const name of listed) delete headers[name];
  }
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
  return headers;
}

// ── Helpers ──

export function generateSubdomain(): string {
  return randomBytes(4).toString("hex");
}

export function parseMessage(data: string): ControlMessage {
  return JSON.parse(data);
}

export function serializeMessage(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

export const CONTROL_PATH = "/_tunnel/connect";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const PROTOCOL_VERSION = 2;

export const WHOAMI_PATH = "/_railgate/whoami";
