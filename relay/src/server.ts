import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  CONTROL_PATH,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  WHOAMI_PATH,
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  FRAME_WS_TEXT,
  FRAME_WS_BINARY,
  WS_READY_OPEN,
  generateSubdomain,
  parseMessage,
  serializeMessage,
  encodeBinaryFrame,
  decodeBinaryFrame,
  streamBodyFrames,
  rewriteLocation,
  rewriteSetCookieHeader,
  rewriteHtmlPaths,
  isHtmlContentType,
  isCompressed,
  sanitizeCloseCode,
  type ClientMessage,
  type ServerMessage,
  type WsOpenMessage,
  type WsCloseMessage,
} from "@railgate/shared";
import { randomUUID } from "crypto";
import { createHash, timingSafeEqual } from "crypto";

// ── Configuration ──

export interface RelayOptions {
  /** Shared auth token. When absent the relay runs in open mode. */
  token?: string;
  /** Public host tunnels are served under (e.g. "tunnels.example.com"). */
  baseDomain: string;
  /** Scheme of public tunnel URLs. */
  protocol: "http" | "https";
  /** Reject inbound request bodies larger than this. Default 100 MiB. */
  maxBodyBytes?: number;
  /** Time-to-first-byte budget for the local service. Default 30s. */
  requestTimeoutMs?: number;
}

export interface Relay {
  httpServer: Server;
  /** Number of currently-registered tunnels (handy for tests/metrics). */
  tunnelCount(): number;
  close(): Promise<void>;
}

// ── Tunnel registry ──

interface PendingResponse {
  res: ServerResponse;
  headTimer: ReturnType<typeof setTimeout> | null;
  headReceived: boolean;
  /** "/_t/<sub>" when this request is served under a path prefix, else null. */
  pathPrefix: string | null;
  /** Buffer the HTML body so root-absolute URLs can be rewritten on flush. */
  collectHtml: boolean;
  htmlChunks: Buffer[];
  htmlBytes: number;
}

/** Stop buffering HTML for rewriting past this size and pass it through. */
const HTML_REWRITE_CAP = 8 * 1024 * 1024;

interface Tunnel {
  subdomain: string;
  ws: WebSocket;
  pendingRequests: Map<string, PendingResponse>;
  wsConnections: Map<string, WebSocket>;
  /** Set once we've warned this client that requests are escaping the path
   * prefix, so the advisory is sent only once per session. */
  warnedPathLeak: boolean;
}

const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Constant-time token comparison (hash to a fixed length first so callers
 * can't learn the token length from timing). */
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Add standard reverse-proxy headers so the local service can recover the
 * original client IP, protocol, and host. Appends to an existing
 * X-Forwarded-For chain rather than overwriting it.
 */
function addForwardedHeaders(
  headers: Record<string, string | string[]>,
  req: IncomingMessage,
  protocol: "http" | "https"
): void {
  const clientIp = req.socket.remoteAddress;
  if (!clientIp) return;
  const originalHost = req.headers.host ?? "";

  const existing = headers["x-forwarded-for"];
  const prior = Array.isArray(existing) ? existing.join(", ") : existing;
  headers["x-forwarded-for"] = prior ? `${prior}, ${clientIp}` : clientIp;
  headers["x-forwarded-proto"] = protocol;
  if (originalHost) headers["x-forwarded-host"] = originalHost;

  // IPv6 literals must be bracketed and quoted in the Forwarded header.
  const forwardedFor = clientIp.includes(":") ? `"[${clientIp}]"` : clientIp;
  const hostPart = originalHost ? `;host=${originalHost}` : "";
  headers["forwarded"] = `for=${forwardedFor}${hostPart};proto=${protocol}`;
}

export function createRelay(options: RelayOptions): Relay {
  const { baseDomain, protocol } = options;
  const token = options.token;
  const openMode = !token;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /** subdomain → Tunnel */
  const tunnels = new Map<string, Tunnel>();

  function checkAuth(req: IncomingMessage): boolean {
    if (openMode) return true;
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return false;
    return tokensMatch(header.slice("Bearer ".length), token!);
  }

  function extractSubdomain(host: string): string | null {
    const hostname = host.split(":")[0];
    const base = baseDomain.split(":")[0];
    if (!hostname.endsWith(base)) return null;
    const prefix = hostname.slice(0, -(base.length + 1));
    if (!prefix || prefix.includes(".")) return null;
    return prefix;
  }

  function sendControl(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WS_READY_OPEN) ws.send(serializeMessage(msg));
  }

  /**
   * A request that resolves to no tunnel but whose Referer points at a
   * /_t/<sub> tunnel is a root-absolute URL built in JS (fetch/WebSocket) that
   * escaped the path prefix. Warn that tunnel's client once per session so the
   * user knows to move to a real subdomain.
   */
  function notifyPrefixEscape(req: IncomingMessage): void {
    const referer = req.headers.referer;
    if (!referer) return;
    let refPath: string;
    try {
      refPath = new URL(referer).pathname;
    } catch {
      return;
    }
    const match = refPath.match(/^\/_t\/([a-z0-9-]+)/);
    if (!match) return;
    const tunnel = tunnels.get(match[1]);
    if (!tunnel || tunnel.warnedPathLeak) return;
    tunnel.warnedPathLeak = true;
    sendControl(tunnel.ws, {
      type: "notice",
      code: "path-escape",
      message: `A request to "${req.url}" escaped the tunnel path prefix (likely a URL built in JavaScript, e.g. fetch() or WebSocket). Apps that construct absolute URLs in JS need a dedicated subdomain — run \`railgate domain add\`.`,
    });
  }

  // ── HTTP request handling ──

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host || "";
    const url = req.url || "/";

    if (url === WHOAMI_PATH) {
      if (!checkAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          baseDomain,
          protocol,
          protocolVersion: PROTOCOL_VERSION,
          openMode,
        })
      );
      return;
    }

    let subdomain = extractSubdomain(host);
    let forwardPath = url;
    let pathPrefix: string | null = null;
    if (!subdomain) {
      const pathMatch = url.match(/^\/_t\/([a-z0-9-]+)(\/.*)?$/);
      if (pathMatch) {
        subdomain = pathMatch[1];
        forwardPath = pathMatch[2] || "/";
        pathPrefix = `/_t/${subdomain}`;
      }
    }

    if (!subdomain) {
      notifyPrefixEscape(req);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("railgate relay server\n");
      return;
    }

    const tunnel = tunnels.get(subdomain);
    if (!tunnel) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`No tunnel found for subdomain: ${subdomain}\n`);
      return;
    }
    if (tunnel.ws.readyState !== WS_READY_OPEN) {
      tunnels.delete(subdomain);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Tunnel client disconnected\n");
      return;
    }

    const requestId = randomUUID();
    const flatHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) flatHeaders[key] = value;
    }
    addForwardedHeaders(flatHeaders, req, protocol);

    const headTimer = setTimeout(() => {
      const pending = tunnel.pendingRequests.get(requestId);
      if (!pending) return;
      tunnel.pendingRequests.delete(requestId);
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "text/plain" });
        res.end("Tunnel request timed out\n");
      } else {
        res.end();
      }
      sendControl(tunnel.ws, {
        type: "request-abort",
        id: requestId,
        message: "timeout",
      });
    }, requestTimeoutMs);

    tunnel.pendingRequests.set(requestId, {
      res,
      headTimer,
      headReceived: false,
      pathPrefix,
      collectHtml: false,
      htmlChunks: [],
      htmlBytes: 0,
    });

    // End-user hung up before the response finished — tell the client to stop.
    res.on("close", () => {
      const pending = tunnel.pendingRequests.get(requestId);
      if (pending && !res.writableEnded) {
        if (pending.headTimer) clearTimeout(pending.headTimer);
        tunnel.pendingRequests.delete(requestId);
        sendControl(tunnel.ws, {
          type: "request-abort",
          id: requestId,
          message: "client closed",
        });
      }
    });

    sendControl(tunnel.ws, {
      type: "request-head",
      id: requestId,
      method: req.method || "GET",
      path: forwardPath,
      headers: flatHeaders,
    });

    streamBodyFrames(
      req,
      tunnel.ws,
      FRAME_REQUEST_BODY,
      requestId,
      () => sendControl(tunnel.ws, { type: "request-end", id: requestId }),
      {
        maxBytes: maxBodyBytes,
        onLimitExceeded: () => {
          const pending = tunnel.pendingRequests.get(requestId);
          if (pending && pending.headTimer) clearTimeout(pending.headTimer);
          tunnel.pendingRequests.delete(requestId);
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("Request body too large\n");
          }
          sendControl(tunnel.ws, {
            type: "request-abort",
            id: requestId,
            message: "body too large",
          });
        },
      }
    );
  });

  // ── WebSocket upgrades ──

  const wss = new WebSocketServer({ noServer: true });
  const proxyWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const host = req.headers.host || "";

    if (url.pathname === CONTROL_PATH) {
      if (!checkAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    let subdomain = extractSubdomain(host);
    let forwardPath = url.pathname + url.search;
    if (!subdomain) {
      const pathMatch = (req.url || "").match(/^\/_t\/([a-z0-9-]+)(\/.*)?$/);
      if (pathMatch) {
        subdomain = pathMatch[1];
        forwardPath = pathMatch[2] || "/";
      }
    }

    if (!subdomain) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const tunnel = tunnels.get(subdomain);
    if (!tunnel || tunnel.ws.readyState !== WS_READY_OPEN) {
      if (tunnel) tunnels.delete(subdomain);
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
      return;
    }

    proxyWss.handleUpgrade(req, socket, head, (userWs) => {
      const connId = randomUUID();
      const flatHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) flatHeaders[key] = value;
      }

      tunnel.wsConnections.set(connId, userWs);

      const openMsg: WsOpenMessage = {
        type: "ws-open",
        id: connId,
        path: forwardPath,
        headers: flatHeaders,
      };
      sendControl(tunnel.ws, openMsg);

      userWs.on("message", (data, isBinary) => {
        if (tunnel.ws.readyState !== WS_READY_OPEN) return;
        tunnel.ws.send(
          encodeBinaryFrame(
            isBinary ? FRAME_WS_BINARY : FRAME_WS_TEXT,
            connId,
            Buffer.from(data as Buffer)
          )
        );
      });

      userWs.on("close", (code, reason) => {
        tunnel.wsConnections.delete(connId);
        const closeMsg: WsCloseMessage = {
          type: "ws-close",
          id: connId,
          code,
          reason: reason?.toString(),
        };
        sendControl(tunnel.ws, closeMsg);
      });

      userWs.on("error", () => {
        tunnel.wsConnections.delete(connId);
        userWs.close();
      });
    });
  });

  // ── Control channel ──

  wss.on("connection", (ws: WebSocket) => {
    let tunnel: Tunnel | null = null;
    let alive = true;

    const heartbeat = setInterval(() => {
      if (ws.readyState === WS_READY_OPEN) {
        ws.send(serializeMessage({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);

    const wsPing = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    ws.on("pong", () => {
      alive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!tunnel) return;
        const { opcode, id, payload } = decodeBinaryFrame(data as Buffer);
        if (opcode === FRAME_RESPONSE_BODY) {
          const pending = tunnel.pendingRequests.get(id);
          if (pending && pending.headReceived && !pending.res.writableEnded) {
            if (pending.collectHtml) {
              pending.htmlChunks.push(payload);
              pending.htmlBytes += payload.length;
              if (pending.htmlBytes > HTML_REWRITE_CAP) {
                // Too large to buffer — abandon rewriting and pass through.
                pending.collectHtml = false;
                for (const chunk of pending.htmlChunks) pending.res.write(chunk);
                pending.htmlChunks = [];
              }
            } else {
              pending.res.write(payload);
            }
          }
        } else if (opcode === FRAME_WS_TEXT || opcode === FRAME_WS_BINARY) {
          const conn = tunnel.wsConnections.get(id);
          if (conn && conn.readyState === WS_READY_OPEN) {
            conn.send(payload, { binary: opcode === FRAME_WS_BINARY });
          }
        }
        return;
      }

      let msg: ClientMessage;
      try {
        msg = parseMessage(data.toString()) as ClientMessage;
      } catch {
        ws.send(serializeMessage({ type: "error", message: "Invalid message" }));
        return;
      }

      switch (msg.type) {
        case "register": {
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            ws.send(
              serializeMessage({
                type: "error",
                message: `Protocol version mismatch (relay: ${PROTOCOL_VERSION}, client: ${msg.protocolVersion ?? "unknown"}). Run: npm install -g railgate@latest`,
              })
            );
            ws.close(1002, "Protocol version mismatch");
            return;
          }
          let subdomain = msg.subdomain?.toLowerCase().replace(/[^a-z0-9-]/g, "");
          if (subdomain && tunnels.has(subdomain)) {
            const existing = tunnels.get(subdomain)!;
            if (existing.ws.readyState !== WS_READY_OPEN) {
              tunnels.delete(subdomain);
            } else {
              ws.send(
                serializeMessage({
                  type: "error",
                  message: `Subdomain "${subdomain}" is already in use`,
                })
              );
              return;
            }
          }
          if (!subdomain) subdomain = generateSubdomain();

          tunnel = {
            subdomain,
            ws,
            pendingRequests: new Map(),
            wsConnections: new Map(),
            warnedPathLeak: false,
          };
          tunnels.set(subdomain, tunnel);

          const url = `${protocol}://${subdomain}.${baseDomain}`;
          const pathUrl = `${protocol}://${baseDomain}/_t/${subdomain}`;
          ws.send(
            serializeMessage({ type: "registered", url, pathUrl, subdomain })
          );
          break;
        }

        case "response-head": {
          if (!tunnel) return;
          const pending = tunnel.pendingRequests.get(msg.id);
          if (!pending) return;
          if (pending.headTimer) clearTimeout(pending.headTimer);
          pending.headReceived = true;
          if (!pending.res.headersSent) {
            const headers = { ...msg.headers };
            delete headers["transfer-encoding"];

            if (pending.pathPrefix) {
              const prefix = pending.pathPrefix;
              if (headers["location"]) {
                const loc = Array.isArray(headers["location"])
                  ? headers["location"][0]
                  : headers["location"];
                headers["location"] = rewriteLocation(loc, prefix);
              }
              if (headers["set-cookie"]) {
                headers["set-cookie"] = rewriteSetCookieHeader(
                  headers["set-cookie"],
                  prefix
                );
              }
              // Rewriting changes the body length, so buffer HTML and drop the
              // declared length (we re-emit with chunked encoding).
              if (
                isHtmlContentType(headers["content-type"]) &&
                !isCompressed(headers["content-encoding"])
              ) {
                pending.collectHtml = true;
                delete headers["content-length"];
              }
            }

            pending.res.writeHead(msg.status, headers);
          }
          break;
        }

        case "response-end": {
          if (!tunnel) return;
          const pending = tunnel.pendingRequests.get(msg.id);
          if (pending) {
            tunnel.pendingRequests.delete(msg.id);
            if (!pending.res.writableEnded) {
              if (pending.collectHtml && pending.pathPrefix) {
                const html = Buffer.concat(pending.htmlChunks);
                pending.res.write(rewriteHtmlPaths(html, pending.pathPrefix));
              }
              pending.res.end();
            }
          }
          break;
        }

        case "response-error": {
          if (!tunnel) return;
          const pending = tunnel.pendingRequests.get(msg.id);
          if (pending) {
            if (pending.headTimer) clearTimeout(pending.headTimer);
            tunnel.pendingRequests.delete(msg.id);
            if (!pending.res.headersSent) {
              pending.res.writeHead(msg.status ?? 502, {
                "Content-Type": "text/plain",
              });
              pending.res.end(msg.message);
            } else if (!pending.res.writableEnded) {
              pending.res.end();
            }
          }
          break;
        }

        case "pong":
          break;

        case "ws-opened":
          break;

        case "ws-failed": {
          if (!tunnel) return;
          const conn = tunnel.wsConnections.get(msg.id);
          if (conn) {
            conn.close(1011, msg.message);
            tunnel.wsConnections.delete(msg.id);
          }
          break;
        }

        case "ws-close": {
          if (!tunnel) return;
          const conn = tunnel.wsConnections.get(msg.id);
          if (conn) {
            conn.close(sanitizeCloseCode(msg.code), msg.reason);
            tunnel.wsConnections.delete(msg.id);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(wsPing);
      if (tunnel) {
        for (const [, pending] of tunnel.pendingRequests) {
          if (pending.headTimer) clearTimeout(pending.headTimer);
          if (!pending.res.headersSent) {
            pending.res.writeHead(502, { "Content-Type": "text/plain" });
            pending.res.end("Tunnel client disconnected\n");
          } else if (!pending.res.writableEnded) {
            pending.res.end();
          }
        }
        tunnel.pendingRequests.clear();
        for (const [, conn] of tunnel.wsConnections) {
          conn.close(1001, "Tunnel disconnected");
        }
        tunnel.wsConnections.clear();
        tunnels.delete(tunnel.subdomain);
      }
    });

    ws.on("error", () => {
      ws.close();
    });
  });

  function pendingCount(): number {
    let n = 0;
    for (const tunnel of tunnels.values()) n += tunnel.pendingRequests.size;
    return n;
  }

  /**
   * Stop accepting new connections, let in-flight requests finish for up to
   * `graceMs`, then force-close any remaining tunnels and proxied sockets.
   */
  async function close(graceMs = 5_000): Promise<void> {
    const fullyClosed = new Promise<void>((resolve) => server.close(() => resolve()));

    const deadline = Date.now() + graceMs;
    while (pendingCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    for (const tunnel of tunnels.values()) {
      for (const [, pending] of tunnel.pendingRequests) {
        if (pending.headTimer) clearTimeout(pending.headTimer);
        if (!pending.res.writableEnded) pending.res.end();
      }
      for (const [, conn] of tunnel.wsConnections) {
        conn.close(1001, "Relay shutting down");
      }
      tunnel.ws.close(1001, "Relay shutting down");
    }
    wss.close();
    proxyWss.close();
    await fullyClosed;
  }

  return {
    httpServer: server,
    tunnelCount: () => tunnels.size,
    close,
  };
}
