import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import {
  CONTROL_PATH,
  PROTOCOL_VERSION,
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  parseMessage,
  serializeMessage,
  encodeBinaryFrame,
  decodeBinaryFrame,
  chunkBuffer,
  type ServerMessage,
} from "@railgate/shared";
import { createRelay, type Relay } from "./server.js";

const TOKEN = "test-token";

/**
 * A minimal v2 tunnel client used as the test fixture. It echoes request
 * bodies back for paths containing "/echo", otherwise streams a canned body
 * in two frames — exercising both directions of the streaming protocol.
 */
function startMockClient(port: number, subdomain: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CONTROL_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  const inflight = new Map<string, { path: string; chunks: Buffer[] }>();

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const { opcode, id, payload } = decodeBinaryFrame(data as Buffer);
      if (opcode === FRAME_REQUEST_BODY) {
        inflight.get(id)?.chunks.push(payload);
      }
      return;
    }
    const msg = parseMessage(data.toString()) as ServerMessage;
    if (msg.type === "request-head") {
      inflight.set(msg.id, { path: msg.path, chunks: [] });
    } else if (msg.type === "request-end") {
      const entry = inflight.get(msg.id);
      if (!entry) return;
      inflight.delete(msg.id);

      const body = entry.path.includes("/echo")
        ? Buffer.concat(entry.chunks)
        : Buffer.from("hello world");

      ws.send(
        serializeMessage({
          type: "response-head",
          id: msg.id,
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })
      );
      if (entry.path.includes("/echo")) {
        for (const piece of chunkBuffer(body)) {
          ws.send(encodeBinaryFrame(FRAME_RESPONSE_BODY, msg.id, piece));
        }
      } else {
        ws.send(encodeBinaryFrame(FRAME_RESPONSE_BODY, msg.id, Buffer.from("hello ")));
        ws.send(encodeBinaryFrame(FRAME_RESPONSE_BODY, msg.id, Buffer.from("world")));
      }
      ws.send(serializeMessage({ type: "response-end", id: msg.id }));
    } else if (msg.type === "ping") {
      ws.send(serializeMessage({ type: "pong" }));
    }
  });

  return new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(serializeMessage({ type: "register", subdomain, protocolVersion: PROTOCOL_VERSION }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = parseMessage(data.toString()) as ServerMessage;
      if (msg.type === "registered") resolve(ws);
    });
  });
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; body?: Buffer } = {}
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: options.method ?? "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("relay streaming proxy (protocol v2)", () => {
  let relay: Relay;
  let port: number;
  let client: WebSocket;

  beforeAll(async () => {
    relay = createRelay({ token: TOKEN, baseDomain: "127.0.0.1", protocol: "http" });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (relay.httpServer.address() as AddressInfo).port;
    client = await startMockClient(port, "test");
  });

  afterAll(async () => {
    client.close();
    await relay.close();
  });

  it("registers the tunnel", () => {
    expect(relay.tunnelCount()).toBe(1);
  });

  it("proxies a GET and streams a multi-frame response body", async () => {
    const res = await httpRequest(port, "/_t/test/");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello world");
  });

  it("rejects an unknown subdomain with 502", async () => {
    const res = await httpRequest(port, "/_t/nope/");
    expect(res.status).toBe(502);
  });

  it("streams a request body through and back (echo)", async () => {
    const payload = Buffer.from("a".repeat(5000));
    const res = await httpRequest(port, "/_t/test/echo", {
      method: "POST",
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.body.equals(payload)).toBe(true);
  });

  it("round-trips a body larger than the chunk size without corruption", async () => {
    const payload = Buffer.alloc(300 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const res = await httpRequest(port, "/_t/test/echo", {
      method: "POST",
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(payload.length);
    expect(res.body.equals(payload)).toBe(true);
  });
});
