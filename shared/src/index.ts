import { randomBytes } from "crypto";

// ── WebSocket Protocol Messages ──

/** Client sends this to register a new tunnel */
export interface RegisterMessage {
  type: "register";
  subdomain?: string;
  localPort: number;
  protocolVersion: number;
}

/** Server confirms tunnel registration */
export interface RegisteredMessage {
  type: "registered";
  url: string;
  pathUrl?: string;
  subdomain: string;
}

/** Server forwards an HTTP request to the client */
export interface RequestMessage {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  body?: string;
}

/** Client sends back the HTTP response */
export interface ResponseMessage {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string | string[]>;
  body?: string;
}

/** Heartbeat ping/pong */
export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

/** Error from the server */
export interface ErrorMessage {
  type: "error";
  message: string;
}

// ── WebSocket Proxy Messages ──

/** Server → Client: a new end-user WebSocket wants to connect through the tunnel */
export interface WsOpenMessage {
  type: "ws-open";
  id: string;
  path: string;
  headers: Record<string, string | string[]>;
}

/** Client → Server: local WebSocket connection established successfully */
export interface WsOpenedMessage {
  type: "ws-opened";
  id: string;
}

/** Client → Server: local WebSocket connection failed */
export interface WsFailedMessage {
  type: "ws-failed";
  id: string;
  message: string;
}

/** Bidirectional: forward a WebSocket data frame */
export interface WsDataMessage {
  type: "ws-data";
  id: string;
  data: string; // base64 encoded
  binary: boolean;
}

/** Bidirectional: close a proxied WebSocket connection */
export interface WsCloseMessage {
  type: "ws-close";
  id: string;
  code?: number;
  reason?: string;
}

export type ClientMessage =
  | RegisterMessage
  | ResponseMessage
  | PongMessage
  | WsOpenedMessage
  | WsFailedMessage
  | WsDataMessage
  | WsCloseMessage;
export type ServerMessage =
  | RegisteredMessage
  | RequestMessage
  | PingMessage
  | ErrorMessage
  | WsOpenMessage
  | WsDataMessage
  | WsCloseMessage;

// ── Helpers ──

export function generateSubdomain(): string {
  return randomBytes(4).toString("hex");
}

export function parseMessage(data: string): ClientMessage | ServerMessage {
  return JSON.parse(data);
}

export function serializeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export const CONTROL_PATH = "/_tunnel/connect";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const PROTOCOL_VERSION = 1;

export const WHOAMI_PATH = "/_railgate/whoami";
