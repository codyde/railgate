#!/usr/bin/env node

import { program } from "commander";
import { WebSocket } from "ws";
import http from "http";
import {
  CONTROL_PATH,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  parseMessage,
  serializeMessage,
  type ServerMessage,
  type ResponseMessage,
  type WsOpenedMessage,
  type WsFailedMessage,
  type WsDataMessage,
  type WsCloseMessage,
} from "@railgate/shared";
import { configPath, resolveConfig } from "./config.js";
import { runSetup } from "./setup.js";

// ── Spinner ──

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function createSpinner() {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentText = "";

  return {
    start(text: string) {
      currentText = text;
      frame = 0;
      process.stdout.write(`  ${SPINNER_FRAMES[frame]} ${currentText}`);
      timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        process.stdout.write(`\r  ${SPINNER_FRAMES[frame]} ${currentText}`);
      }, 80);
    },
    update(text: string) {
      currentText = text;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write("\r\x1b[K"); // clear the spinner line
    },
  };
}

// ── Timestamp ──

function timestamp(): string {
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0")
  );
}

// ── Session stats ──

let sessionRequestCount = 0;
let sessionStartTime = Date.now();

program
  .name("railgate")
  .description("Expose local services via a public URL through a railgate relay")
  .version("0.1.0");

program
  .command("http")
  .description("Expose a local HTTP server")
  .argument("<port>", "Local port to expose")
  .option("-r, --relay <url>", "Relay server URL (overrides saved config)")
  .option("-t, --token <value>", "Relay auth token (overrides saved config)")
  .option("-s, --subdomain <name>", "Request a specific subdomain")
  .action(async (port: string, opts: { relay?: string; token?: string; subdomain?: string }) => {
    const localPort = parseInt(port, 10);
    if (isNaN(localPort)) {
      console.error("Error: port must be a number");
      process.exit(1);
    }

    const cfg = resolveConfig({ relay: opts.relay, token: opts.token });
    if (!cfg) {
      console.error("");
      console.error("  No relay configured.");
      console.error(`  Run \x1b[1mnpx railgate setup\x1b[0m to deploy a relay,`);
      console.error(`  or pass \x1b[1m--relay <url>\x1b[0m to use one directly.`);
      console.error("");
      console.error(`  Looked for config at: ${configPath()}`);
      console.error("");
      process.exit(1);
    }

    await startTunnel(cfg.relayUrl, cfg.token, localPort, opts.subdomain);
  });

program
  .command("setup")
  .description("Configure railgate by deploying a relay or connecting to an existing one")
  .option("--manual", "Skip everything and enter a relay URL/token directly")
  .option("--browser", "Use the legacy browser-handoff flow instead of OAuth (paste-back)")
  .action(async (opts: { manual?: boolean; browser?: boolean }) => {
    await runSetup(opts);
  });

program.parse();

// ── Tunnel Client ──

async function startTunnel(
  relayUrl: string,
  token: string | undefined,
  localPort: number,
  subdomain?: string
): Promise<void> {
  const wsUrl = `${relayUrl}${CONTROL_PATH}`;
  const spinner = createSpinner();
  let reconnectAttempts = 0;
  let activeWs: WebSocket | null = null;

  /** Active local WebSocket connections keyed by connection ID */
  const localWsConnections = new Map<string, WebSocket>();

  // ── Graceful shutdown ──
  process.on("SIGINT", () => {
    spinner.stop();
    const uptime = Math.floor((Date.now() - sessionStartTime) / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    console.log("");
    console.log("");
    console.log(`  Tunnel closed. ${sessionRequestCount} requests served over ${duration}.`);
    console.log("");
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.close(1000, "Client disconnected");
    }
    process.exit(0);
  });

  spinner.start(`Connecting to relay at ${relayUrl}...`);

  const connect = () => {
    const ws = new WebSocket(
      wsUrl,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    );
    activeWs = ws;

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        spinner.stop();
        console.error("");
        console.error("  \x1b[31m✗ Authentication failed.\x1b[0m The relay rejected your token.");
        console.error("    Check RAILGATE_TOKEN matches the one configured on the relay.");
        console.error("");
        process.exit(1);
      }
    });

    ws.on("open", () => {
      spinner.update("Registering tunnel...");
      ws.send(
        serializeMessage({
          type: "register",
          subdomain,
          localPort,
          protocolVersion: PROTOCOL_VERSION,
        })
      );
    });

    ws.on("message", (data) => {
      let msg: ServerMessage;
      try {
        msg = parseMessage(data.toString()) as ServerMessage;
      } catch {
        console.error("Received invalid message from relay");
        return;
      }

      switch (msg.type) {
        case "registered": {
          spinner.stop();
          reconnectAttempts = 0;
          sessionStartTime = Date.now();
          sessionRequestCount = 0;

          // Railway's *.up.railway.app cert only covers one level of subdomain
          // (cert at `*.up.railway.app` matches `foo.up.railway.app` but not
          // `bar.foo.up.railway.app`). Our subdomain-form URL adds a second
          // level under the relay's auto-assigned domain — so it always trips
          // a TLS mismatch on Railway-default deploys. Prefer the path form
          // there. Users on a custom domain with their own wildcard cert get
          // the prettier subdomain URL as primary.
          const wildcardSafe = !/\.up\.railway\.app(?::|\/|$)/i.test(msg.url);
          const primary = wildcardSafe ? msg.url : (msg.pathUrl ?? msg.url);
          const secondary = wildcardSafe ? msg.pathUrl : msg.url;

          // Build the info box with the URL inside
          const publicLine = `→ ${primary}`;
          const pathLine =
            secondary && secondary !== primary
              ? `  ${secondary}${!wildcardSafe ? " (needs custom wildcard domain)" : ""}`
              : "";
          const fwdLine = `  forwarding to http://localhost:${localPort}`;
          const ctrlLine = `Press Ctrl+C to disconnect`;

          const contentLines = [publicLine];
          if (pathLine) contentLines.push(pathLine);
          contentLines.push(fwdLine);
          contentLines.push("");
          contentLines.push(ctrlLine);

          const maxLen = Math.max(...contentLines.map((l) => l.length));
          const boxWidth = maxLen + 4; // 2 padding each side

          const top = "  ┌" + "─".repeat(boxWidth) + "┐";
          const bot = "  └" + "─".repeat(boxWidth) + "┘";
          const titleText = "railgate tunnel active";
          const titlePad = boxWidth - titleText.length - 2;
          const title = `  │ \x1b[1;32m${titleText}\x1b[0m${" ".repeat(titlePad)} │`;

          console.log("");
          console.log(top);
          console.log(title);
          console.log(`  │${" ".repeat(boxWidth)}│`);
          for (const line of contentLines) {
            const pad = boxWidth - line.length - 2;
            console.log(`  │ ${line}${" ".repeat(pad)} │`);
          }
          console.log(bot);
          console.log("");
          break;
        }

        case "request":
          handleRequest(ws, msg.id, msg.method, msg.path, msg.headers, msg.body, localPort);
          break;

        case "ping":
          ws.send(serializeMessage({ type: "pong" }));
          break;

        case "ws-open":
          handleWsOpen(ws, msg.id, msg.path, msg.headers, localPort, localWsConnections);
          break;

        case "ws-data": {
          const localWs = localWsConnections.get(msg.id);
          if (localWs && localWs.readyState === WebSocket.OPEN) {
            const buf = Buffer.from(msg.data, "base64");
            localWs.send(buf, { binary: msg.binary });
          }
          break;
        }

        case "ws-close": {
          const localWs = localWsConnections.get(msg.id);
          if (localWs) {
            localWs.close(msg.code || 1000, msg.reason);
            localWsConnections.delete(msg.id);
          }
          break;
        }

        case "error":
          console.error(`Relay error: ${msg.message}`);
          break;
      }
    });

    ws.on("close", () => {
      // Close all local WebSocket connections
      for (const [, localWs] of localWsConnections) {
        localWs.close(1001, "Tunnel disconnected");
      }
      localWsConnections.clear();
      reconnectAttempts++;
      spinner.start(`Reconnecting to relay (attempt ${reconnectAttempts})...`);
      setTimeout(connect, 3000);
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error: ${err.message}`);
    });
  };

  connect();

  // Keep the process alive
  await new Promise(() => {});
}

// ── Forward request to local service ──

/** Track whether we've already warned about ECONNREFUSED to avoid log spam */
let localServiceDown = false;

function handleRequest(
  ws: WebSocket,
  requestId: string,
  method: string,
  path: string,
  headers: Record<string, string | string[]>,
  body: string | undefined,
  localPort: number
): void {
  sessionRequestCount++;
  const startTime = performance.now();

  const localHeaders = { ...headers };
  // Rewrite host to localhost
  localHeaders["host"] = `localhost:${localPort}`;

  const requestBody = body ? Buffer.from(body, "base64") : undefined;

  const statusTag = (status: number) => {
    if (status >= 500) return `\x1b[31m${status}\x1b[0m`;
    if (status >= 400) return `\x1b[33m${status}\x1b[0m`;
    if (status >= 300) return `\x1b[36m${status}\x1b[0m`;
    return `\x1b[32m${status}\x1b[0m`;
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const req = http.request(
    {
      hostname: "localhost",
      port: localPort,
      path,
      method,
      headers: localHeaders,
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const elapsed = performance.now() - startTime;
        const responseBody =
          chunks.length > 0 ? Buffer.concat(chunks).toString("base64") : undefined;

        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) {
            responseHeaders[key] = value;
          }
        }

        // Service is back up — clear the warning state
        if (localServiceDown) {
          localServiceDown = false;
          console.log(`  \x1b[32m✓\x1b[0m localhost:${localPort} is responding again`);
        }

        const status = res.statusCode || 200;
        console.log(
          `  ${timestamp()}  ${statusTag(status)} ${method} ${path}  \x1b[2m${formatDuration(elapsed)}\x1b[0m`
        );

        const responseMsg: ResponseMessage = {
          type: "response",
          id: requestId,
          status,
          headers: responseHeaders,
          body: responseBody,
        };
        ws.send(serializeMessage(responseMsg));
      });
    }
  );

  req.on("error", (err) => {
    const elapsed = performance.now() - startTime;
    const isConnRefused = (err as NodeJS.ErrnoException).code === "ECONNREFUSED";

    if (isConnRefused) {
      if (!localServiceDown) {
        localServiceDown = true;
        console.log("");
        console.log(
          `  \x1b[33m⚠  localhost:${localPort} is not responding — is your server running?\x1b[0m`
        );
        console.log("");
      }
      // Suppress repeated ECONNREFUSED log lines
    } else {
      console.error(
        `  ${timestamp()}  \x1b[31mERR\x1b[0m ${method} ${path} → ${err.message}  \x1b[2m${formatDuration(elapsed)}\x1b[0m`
      );
    }

    const responseMsg: ResponseMessage = {
      type: "response",
      id: requestId,
      status: 502,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`Failed to reach localhost:${localPort}: ${err.message}`).toString(
        "base64"
      ),
    };
    ws.send(serializeMessage(responseMsg));
  });

  if (requestBody) {
    req.write(requestBody);
  }
  req.end();
}

// ── Forward WebSocket connection to local service ──

function handleWsOpen(
  controlWs: WebSocket,
  connId: string,
  path: string,
  headers: Record<string, string | string[]>,
  localPort: number,
  wsMap: Map<string, WebSocket>
): void {
  const localUrl = `ws://localhost:${localPort}${path}`;
  const localHeaders = { ...headers };
  localHeaders["host"] = `localhost:${localPort}`;
  // Remove headers that shouldn't be forwarded to the local WS
  delete localHeaders["sec-websocket-key"];
  delete localHeaders["sec-websocket-version"];
  delete localHeaders["sec-websocket-extensions"];
  delete localHeaders["upgrade"];
  delete localHeaders["connection"];

  const localWs = new WebSocket(localUrl, { headers: localHeaders });

  localWs.on("open", () => {
    console.log(`  ${timestamp()}  \x1b[35mWS\x1b[0m  OPEN ${path}`);
    wsMap.set(connId, localWs);
    const openedMsg: WsOpenedMessage = { type: "ws-opened", id: connId };
    controlWs.send(serializeMessage(openedMsg));
  });

  localWs.on("message", (data, isBinary) => {
    const wsData: WsDataMessage = {
      type: "ws-data",
      id: connId,
      data: Buffer.from(data as Buffer).toString("base64"),
      binary: isBinary,
    };
    controlWs.send(serializeMessage(wsData));
  });

  localWs.on("close", (code, reason) => {
    console.log(`  ${timestamp()}  \x1b[35mWS\x1b[0m  CLOSE ${path}`);
    wsMap.delete(connId);
    const closeMsg: WsCloseMessage = {
      type: "ws-close",
      id: connId,
      code,
      reason: reason?.toString(),
    };
    if (controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(serializeMessage(closeMsg));
    }
  });

  localWs.on("error", (err) => {
    console.error(`  ${timestamp()}  \x1b[31mWS ERR\x1b[0m ${path} → ${err.message}`);
    wsMap.delete(connId);
    const failedMsg: WsFailedMessage = {
      type: "ws-failed",
      id: connId,
      message: err.message,
    };
    if (controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(serializeMessage(failedMsg));
    }
  });
}
