#!/usr/bin/env node

import { program } from "commander";
import { WebSocket } from "ws";
import http from "http";
import {
  CONTROL_PATH,
  PROTOCOL_VERSION,
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  FRAME_WS_TEXT,
  FRAME_WS_BINARY,
  WS_READY_OPEN,
  parseMessage,
  serializeMessage,
  encodeBinaryFrame,
  decodeBinaryFrame,
  streamBodyFrames,
  type ServerMessage,
  type WsOpenedMessage,
  type WsFailedMessage,
  type WsCloseMessage,
} from "@railgate/shared";
import { clearConfig, configPath, loadConfig, resolveConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { runDomainAdd, runDomainStatus, runDomainRemove } from "./domain.js";
import { clearRailwayAuth } from "./railway/oauth.js";

// Injected at bundle time by build.mjs (esbuild `define`). Undefined under
// `tsx` dev runs, where `typeof` keeps the reference from throwing.
declare const __RAILGATE_VERSION__: string;
const VERSION =
  typeof __RAILGATE_VERSION__ !== "undefined" ? __RAILGATE_VERSION__ : "0.0.0-dev";

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
  .version(VERSION);

program
  .command("http")
  .description("Expose a local HTTP server")
  .argument("<port>", "Local port to expose")
  .option("-r, --relay <url>", "Relay server URL (overrides saved config)")
  .option("-t, --token <value>", "Relay auth token (overrides saved config)")
  .option("-s, --subdomain <name>", "Request a specific subdomain")
  .action(
    async (
      port: string,
      opts: { relay?: string; token?: string; subdomain?: string }
    ) => {
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
    }
  );

program
  .command("setup")
  .description("Configure railgate by deploying a relay or connecting to an existing one")
  .option("--manual", "Skip everything and enter a relay URL/token directly")
  .option("--browser", "Use the legacy browser-handoff flow instead of OAuth (paste-back)")
  .action(async (opts: { manual?: boolean; browser?: boolean }) => {
    await runSetup(opts);
  });

program
  .command("reset")
  .description("Clear saved Railway auth and relay configuration")
  .action(() => {
    const cfg = loadConfig();
    clearRailwayAuth();
    clearConfig();
    console.log("");
    console.log("  Cleared Railway auth and relay config.");
    if (cfg?.railway) {
      console.log("");
      console.log("  \x1b[33mNote:\x1b[0m the relay deployed on Railway is still running.");
      console.log("  Delete the project in the Railway dashboard if you no longer need it:");
      console.log(`  https://railway.com/project/${cfg.railway.projectId}`);
    }
    console.log("");
    console.log("  Run \x1b[1mnpx railgate setup\x1b[0m to start fresh.");
    console.log("");
  });

const domain = program
  .command("domain")
  .description("Bind a custom wildcard domain to your relay");

domain
  .command("add")
  .description("Register a wildcard domain (e.g. *.tunnels.example.com) and bind it to the relay")
  .argument("[domain]", "Wildcard domain to bind")
  .action(async (domainArg?: string) => {
    await runDomainAdd(domainArg);
  });

domain
  .command("status")
  .description("Check DNS/certificate progress and finish binding the domain")
  .action(async () => {
    await runDomainStatus();
  });

domain
  .command("remove")
  .description("Remove the custom domain and fall back to the Railway domain")
  .action(async () => {
    await runDomainRemove();
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
  /** In-flight outbound HTTP requests to the local service, keyed by request ID */
  const outboundRequests = new Map<string, OutboundRequest>();

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
          protocolVersion: PROTOCOL_VERSION,
        })
      );
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const { opcode, id, payload } = decodeBinaryFrame(data as Buffer);
        if (opcode === FRAME_REQUEST_BODY) {
          const ob = outboundRequests.get(id);
          if (ob && !ob.req.destroyed) ob.req.write(payload);
        } else if (opcode === FRAME_WS_TEXT || opcode === FRAME_WS_BINARY) {
          const localWs = localWsConnections.get(id);
          if (localWs && localWs.readyState === WS_READY_OPEN) {
            localWs.send(payload, { binary: opcode === FRAME_WS_BINARY });
          }
        }
        return;
      }

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
          const pathLine = secondary && secondary !== primary
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

        case "request-head":
          handleRequestHead(
            ws,
            msg.id,
            msg.method,
            msg.path,
            msg.headers,
            localPort,
            outboundRequests
          );
          break;

        case "request-end": {
          const ob = outboundRequests.get(msg.id);
          if (ob && !ob.req.destroyed) ob.req.end();
          break;
        }

        case "request-abort": {
          const ob = outboundRequests.get(msg.id);
          if (ob) {
            ob.req.destroy();
            outboundRequests.delete(msg.id);
          }
          break;
        }

        case "ping":
          ws.send(serializeMessage({ type: "pong" }));
          break;

        case "ws-open":
          handleWsOpen(ws, msg.id, msg.path, msg.headers, localPort, localWsConnections);
          break;

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

interface OutboundRequest {
  req: http.ClientRequest;
  start: number;
}

/** Track whether we've already warned about ECONNREFUSED to avoid log spam */
let localServiceDown = false;

function statusTag(status: number): string {
  if (status >= 500) return `\x1b[31m${status}\x1b[0m`;
  if (status >= 400) return `\x1b[33m${status}\x1b[0m`;
  if (status >= 300) return `\x1b[36m${status}\x1b[0m`;
  return `\x1b[32m${status}\x1b[0m`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Open a streaming request to the local service. The request body arrives as
 * subsequent FRAME_REQUEST_BODY frames (written via the message handler) and
 * is finished by `request-end`; the response is streamed back as
 * `response-head` + FRAME_RESPONSE_BODY frames + `response-end`.
 */
function handleRequestHead(
  ws: WebSocket,
  requestId: string,
  method: string,
  path: string,
  headers: Record<string, string | string[]>,
  localPort: number,
  outbound: Map<string, OutboundRequest>
): void {
  sessionRequestCount++;
  const start = performance.now();

  const localHeaders = { ...headers };
  localHeaders["host"] = `localhost:${localPort}`;
  // We re-frame the body ourselves, so drop the inbound framing header.
  delete localHeaders["transfer-encoding"];

  const req = http.request(
    { hostname: "localhost", port: localPort, path, method, headers: localHeaders },
    (res) => {
      if (localServiceDown) {
        localServiceDown = false;
        console.log(`  \x1b[32m✓\x1b[0m localhost:${localPort} is responding again`);
      }

      const status = res.statusCode || 200;
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders[key] = value;
      }

      console.log(
        `  ${timestamp()}  ${statusTag(status)} ${method} ${path}  \x1b[2m${formatDuration(performance.now() - start)}\x1b[0m`
      );

      if (ws.readyState === WS_READY_OPEN) {
        ws.send(
          serializeMessage({
            type: "response-head",
            id: requestId,
            status,
            headers: responseHeaders,
          })
        );
      }

      streamBodyFrames(res, ws, FRAME_RESPONSE_BODY, requestId, () => {
        outbound.delete(requestId);
        if (ws.readyState === WS_READY_OPEN) {
          ws.send(serializeMessage({ type: "response-end", id: requestId }));
        }
      });

      res.on("error", () => {
        outbound.delete(requestId);
        if (ws.readyState === WS_READY_OPEN) {
          ws.send(serializeMessage({ type: "response-end", id: requestId }));
        }
      });
    }
  );

  req.on("error", (err) => {
    outbound.delete(requestId);
    const isConnRefused = (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
    if (isConnRefused) {
      if (!localServiceDown) {
        localServiceDown = true;
        console.log("");
        console.log(`  \x1b[33m⚠  localhost:${localPort} is not responding — is your server running?\x1b[0m`);
        console.log("");
      }
    } else {
      console.error(
        `  ${timestamp()}  \x1b[31mERR\x1b[0m ${method} ${path} → ${err.message}  \x1b[2m${formatDuration(performance.now() - start)}\x1b[0m`
      );
    }

    if (ws.readyState === WS_READY_OPEN) {
      ws.send(
        serializeMessage({
          type: "response-error",
          id: requestId,
          status: 502,
          message: `Failed to reach localhost:${localPort}: ${err.message}`,
        })
      );
    }
  });

  outbound.set(requestId, { req, start });
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
  // Subprotocols must go through the ws client API, not raw headers —
  // otherwise the client rejects the server's echoed subprotocol.
  const rawProtocols = localHeaders["sec-websocket-protocol"];
  delete localHeaders["sec-websocket-protocol"];
  const subprotocols = rawProtocols
    ? String(rawProtocols).split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  const localWs = new WebSocket(localUrl, subprotocols, { headers: localHeaders });

  localWs.on("open", () => {
    console.log(`  ${timestamp()}  \x1b[35mWS\x1b[0m  OPEN ${path}`);
    wsMap.set(connId, localWs);
    const openedMsg: WsOpenedMessage = { type: "ws-opened", id: connId };
    controlWs.send(serializeMessage(openedMsg));
  });

  localWs.on("message", (data, isBinary) => {
    if (controlWs.readyState === WS_READY_OPEN) {
      controlWs.send(
        encodeBinaryFrame(
          isBinary ? FRAME_WS_BINARY : FRAME_WS_TEXT,
          connId,
          Buffer.from(data as Buffer)
        )
      );
    }
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
