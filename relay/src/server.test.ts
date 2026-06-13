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
interface MockClient {
  ws: WebSocket;
  notices: ServerMessage[];
}

function startMockClient(port: number, subdomain: string): Promise<MockClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CONTROL_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  const inflight = new Map<
    string,
    { path: string; headers: Record<string, string | string[]>; chunks: Buffer[] }
  >();
  const notices: ServerMessage[] = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const { opcode, id, payload } = decodeBinaryFrame(data as Buffer);
      if (opcode === FRAME_REQUEST_BODY) {
        inflight.get(id)?.chunks.push(payload);
      }
      return;
    }
    const msg = parseMessage(data.toString()) as ServerMessage;
    if (msg.type === "notice") {
      notices.push(msg);
    } else if (msg.type === "request-head") {
      inflight.set(msg.id, { path: msg.path, headers: msg.headers, chunks: [] });
    } else if (msg.type === "request-end") {
      const entry = inflight.get(msg.id);
      if (!entry) return;
      inflight.delete(msg.id);

      let status = 200;
      let headers: Record<string, string | string[]> = {
        "content-type": "application/octet-stream",
      };
      let body: Buffer;

      if (entry.path.includes("/html")) {
        headers = { "content-type": "text/html; charset=utf-8" };
        body = Buffer.from(`<head></head><link href="/style.css">`);
      } else if (entry.path.includes("/redirect")) {
        status = 302;
        headers = { location: "/login" };
        body = Buffer.alloc(0);
      } else if (entry.path.includes("/headers")) {
        body = Buffer.from(JSON.stringify(entry.headers));
      } else if (entry.path.includes("/echo")) {
        body = Buffer.concat(entry.chunks);
      } else {
        body = Buffer.from("hello world");
      }

      ws.send(serializeMessage({ type: "response-head", id: msg.id, status, headers }));
      for (const piece of chunkBuffer(body)) {
        ws.send(encodeBinaryFrame(FRAME_RESPONSE_BODY, msg.id, piece));
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
      if (msg.type === "registered") resolve({ ws, notices });
    });
  });
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; body?: Buffer; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          })
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
  let client: MockClient;

  beforeAll(async () => {
    relay = createRelay({ token: TOKEN, baseDomain: "127.0.0.1", protocol: "http" });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (relay.httpServer.address() as AddressInfo).port;
    client = await startMockClient(port, "test");
  });

  afterAll(async () => {
    client.ws.close();
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

  it("injects X-Forwarded-* headers toward the local service", async () => {
    const res = await httpRequest(port, "/_t/test/headers");
    expect(res.status).toBe(200);
    const headers = JSON.parse(res.body.toString());
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-forwarded-for"]).toBeTruthy();
    expect(headers["x-forwarded-host"]).toBeTruthy();
    expect(headers["forwarded"]).toMatch(/proto=http/);
  });

  it("rewrites root-absolute URLs in HTML under the path prefix", async () => {
    const res = await httpRequest(port, "/_t/test/html");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('href="/_t/test/style.css"');
    // Body changed, so the declared length must be dropped.
    expect(res.headers["content-length"]).toBeUndefined();
  });

  it("rewrites root-absolute redirect Location headers", async () => {
    const res = await httpRequest(port, "/_t/test/redirect");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/_t/test/login");
  });

  it("warns the client once when a request escapes the path prefix", async () => {
    client.notices.length = 0;
    const referer = { referer: `http://127.0.0.1:${port}/_t/test/page` };
    await httpRequest(port, "/api/data", { headers: referer });
    await httpRequest(port, "/api/more", { headers: referer });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.notices).toHaveLength(1);
    expect(client.notices[0]).toMatchObject({ type: "notice", code: "path-escape" });
  });

  it("does not warn for unmatched requests without a tunnel referer", async () => {
    client.notices.length = 0;
    await httpRequest(port, "/favicon.ico");
    await new Promise((r) => setTimeout(r, 50));
    expect(client.notices).toHaveLength(0);
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
