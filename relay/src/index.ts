import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  CONTROL_PATH,
  HEARTBEAT_INTERVAL_MS,
  generateSubdomain,
  parseMessage,
  serializeMessage,
  type ClientMessage,
  type RequestMessage,
  type ServerMessage,
  type WsOpenMessage,
  type WsDataMessage,
  type WsCloseMessage,
} from "@railgate/shared";
import { randomUUID } from "crypto";

// ── Tunnel Registry ──

interface Tunnel {
  subdomain: string;
  ws: WebSocket;
  pendingRequests: Map<
    string,
    {
      resolve: (msg: { status: number; headers: Record<string, string | string[]>; body?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  /** Active end-user WebSocket connections proxied through this tunnel */
  wsConnections: Map<string, WebSocket>;
}

/** subdomain → Tunnel */
const tunnels = new Map<string, Tunnel>();

const REQUEST_TIMEOUT_MS = 30_000;
const PORT = parseInt(process.env.PORT || "3000", 10);

// The base domain for tunnel URLs. In production this would be your wildcard domain.
// e.g., "tunnels.yourdomain.com" so tunnels are "abc123.tunnels.yourdomain.com"
const BASE_DOMAIN = process.env.BASE_DOMAIN || `localhost:${PORT}`;
const PROTOCOL = process.env.PROTOCOL || "http";

// ── HTTP Server ──

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const host = req.headers.host || "";
  const url = req.url || "/";

  // Try subdomain routing first (requires wildcard custom domain),
  // then fall back to path-based routing: /_t/<subdomain>/rest/of/path
  let subdomain = extractSubdomain(host);
  let forwardPath = url;

  if (!subdomain) {
    const pathMatch = url.match(/^\/_t\/([a-z0-9-]+)(\/.*)?$/);
    if (pathMatch) {
      subdomain = pathMatch[1];
      forwardPath = pathMatch[2] || "/";
    }
  }

  if (!subdomain) {
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

  if (tunnel.ws.readyState !== WebSocket.OPEN) {
    tunnels.delete(subdomain);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Tunnel client disconnected\n");
    return;
  }

  // Collect the request body
  const body = await collectBody(req);

  // Build the request message
  const requestId = randomUUID();
  const flatHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      flatHeaders[key] = value;
    }
  }

  const requestMsg: RequestMessage = {
    type: "request",
    id: requestId,
    method: req.method || "GET",
    path: forwardPath,
    headers: flatHeaders,
    body: body || undefined,
  };

  // Send to tunnel client and wait for response
  try {
    const response = await sendRequestToTunnel(tunnel, requestMsg);
    const responseHeaders: Record<string, string | string[]> = { ...response.headers };
    // Remove hop-by-hop headers
    delete responseHeaders["transfer-encoding"];

    res.writeHead(response.status, responseHeaders);
    if (response.body) {
      res.end(Buffer.from(response.body, "base64"));
    } else {
      res.end();
    }
  } catch (err) {
    res.writeHead(504, { "Content-Type": "text/plain" });
    res.end("Tunnel request timed out\n");
  }
});

// ── WebSocket Server (tunnel control channel) ──

const wss = new WebSocketServer({ noServer: true });

// WebSocket server for proxied end-user connections
const proxyWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const host = req.headers.host || "";

  // Control channel connections go to the main WSS
  if (url.pathname === CONTROL_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }

  // For all other upgrades, try to route to a tunnel
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
  if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) {
    if (tunnel) tunnels.delete(subdomain);
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }

  // Upgrade the end-user connection, then tell the tunnel client to open a local WS
  proxyWss.handleUpgrade(req, socket, head, (userWs) => {
    const connId = randomUUID();

    // Collect headers to forward
    const flatHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) flatHeaders[key] = value;
    }

    // Store this connection
    tunnel.wsConnections.set(connId, userWs);

    // Tell tunnel client to open a WebSocket to the local service
    const openMsg: WsOpenMessage = {
      type: "ws-open",
      id: connId,
      path: forwardPath,
      headers: flatHeaders,
    };
    tunnel.ws.send(serializeMessage(openMsg));

    // Forward data from end-user → tunnel client
    userWs.on("message", (data, isBinary) => {
      const wsData: WsDataMessage = {
        type: "ws-data",
        id: connId,
        data: Buffer.from(data as Buffer).toString("base64"),
        binary: isBinary,
      };
      tunnel.ws.send(serializeMessage(wsData));
    });

    // Forward close from end-user → tunnel client
    userWs.on("close", (code, reason) => {
      tunnel.wsConnections.delete(connId);
      const closeMsg: WsCloseMessage = {
        type: "ws-close",
        id: connId,
        code,
        reason: reason?.toString(),
      };
      if (tunnel.ws.readyState === WebSocket.OPEN) {
        tunnel.ws.send(serializeMessage(closeMsg));
      }
    });

    userWs.on("error", () => {
      tunnel.wsConnections.delete(connId);
      userWs.close();
    });
  });
});

wss.on("connection", (ws: WebSocket) => {
  let tunnel: Tunnel | null = null;
  let alive = true;

  // App-level heartbeat
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeMessage({ type: "ping" } as ServerMessage));
    }
  }, HEARTBEAT_INTERVAL_MS);

  // WebSocket-level ping to detect dead connections
  const wsPing = setInterval(() => {
    if (!alive) {
      console.log(`[tunnel] no pong received, terminating connection`);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  ws.on("pong", () => {
    alive = true;
  });

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = parseMessage(data.toString()) as ClientMessage;
    } catch {
      ws.send(serializeMessage({ type: "error", message: "Invalid message" }));
      return;
    }

    switch (msg.type) {
      case "register": {
        // Assign or validate subdomain
        let subdomain = msg.subdomain?.toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (subdomain && tunnels.has(subdomain)) {
          const existing = tunnels.get(subdomain)!;
          if (existing.ws.readyState !== WebSocket.OPEN) {
            // Stale tunnel — clean it up and allow re-registration
            console.log(`[tunnel] evicting stale tunnel: ${subdomain}`);
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
        if (!subdomain) {
          subdomain = generateSubdomain();
        }

        tunnel = {
          subdomain,
          ws,
          pendingRequests: new Map(),
          wsConnections: new Map(),
        };
        tunnels.set(subdomain, tunnel);

        const url = `${PROTOCOL}://${subdomain}.${BASE_DOMAIN}`;
        const pathUrl = `${PROTOCOL}://${BASE_DOMAIN}/_t/${subdomain}`;
        console.log(`[tunnel] registered: ${subdomain} (path: /_t/${subdomain})`);
        ws.send(serializeMessage({ type: "registered", url, pathUrl, subdomain }));
        break;
      }

      case "response": {
        if (!tunnel) return;
        const pending = tunnel.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          tunnel.pendingRequests.delete(msg.id);
          pending.resolve({
            status: msg.status,
            headers: msg.headers,
            body: msg.body,
          });
        }
        break;
      }

      case "pong":
        // Heartbeat ack — nothing to do
        break;

      case "ws-opened": {
        // Local WS connection established — nothing to do, data will flow
        break;
      }

      case "ws-failed": {
        // Local WS connection failed — close the end-user connection
        if (!tunnel) return;
        const failedConn = tunnel.wsConnections.get(msg.id);
        if (failedConn) {
          failedConn.close(1011, msg.message);
          tunnel.wsConnections.delete(msg.id);
        }
        break;
      }

      case "ws-data": {
        // Forward data from tunnel client → end-user
        if (!tunnel) return;
        const dataConn = tunnel.wsConnections.get(msg.id);
        if (dataConn && dataConn.readyState === WebSocket.OPEN) {
          const buf = Buffer.from(msg.data, "base64");
          dataConn.send(buf, { binary: msg.binary });
        }
        break;
      }

      case "ws-close": {
        // Forward close from tunnel client → end-user
        if (!tunnel) return;
        const closeConn = tunnel.wsConnections.get(msg.id);
        if (closeConn) {
          closeConn.close(msg.code || 1000, msg.reason);
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
      console.log(`[tunnel] disconnected: ${tunnel.subdomain}`);
      // Reject all pending requests
      for (const [, pending] of tunnel.pendingRequests) {
        clearTimeout(pending.timer);
        pending.resolve({ status: 502, headers: {}, body: undefined });
      }
      // Close all proxied WebSocket connections
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

// ── Helpers ──

function extractSubdomain(host: string): string | null {
  // Remove port if present
  const hostname = host.split(":")[0];
  const baseDomain = BASE_DOMAIN.split(":")[0];

  if (!hostname.endsWith(baseDomain)) return null;

  const prefix = hostname.slice(0, -(baseDomain.length + 1)); // +1 for the dot
  if (!prefix || prefix.includes(".")) return null;

  return prefix;
}

function collectBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks).toString("base64"));
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendRequestToTunnel(
  tunnel: Tunnel,
  msg: RequestMessage
): Promise<{ status: number; headers: Record<string, string | string[]>; body?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnel.pendingRequests.delete(msg.id);
      reject(new Error("Tunnel request timed out"));
    }, REQUEST_TIMEOUT_MS);

    tunnel.pendingRequests.set(msg.id, { resolve, timer });
    tunnel.ws.send(serializeMessage(msg));
  });
}

// ── Start ──

server.listen(PORT, () => {
  console.log(`[railgate] relay server listening on port ${PORT}`);
  console.log(`[railgate] base domain: ${BASE_DOMAIN}`);
  console.log(`[railgate] tunnel control: ws://${BASE_DOMAIN}${CONTROL_PATH}`);
});
