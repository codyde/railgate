import { CONTROL_PATH, PROTOCOL_VERSION } from "@railgate/shared";
import { createRelay } from "./server.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

// The public base domain for tunnel URLs. On Railway this is provided
// automatically; locally it falls back to localhost.
const baseDomain =
  process.env.BASE_DOMAIN ||
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  `localhost:${PORT}`;

const protocol: "http" | "https" =
  process.env.PROTOCOL === "http"
    ? "http"
    : process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_DOMAIN
      ? "https"
      : "http";

const token = process.env.RAILGATE_TOKEN;

const relay = createRelay({
  token,
  baseDomain,
  protocol,
  maxBodyBytes: process.env.RAILGATE_MAX_BODY_BYTES
    ? parseInt(process.env.RAILGATE_MAX_BODY_BYTES, 10)
    : undefined,
  requestTimeoutMs: process.env.RAILGATE_REQUEST_TIMEOUT_MS
    ? parseInt(process.env.RAILGATE_REQUEST_TIMEOUT_MS, 10)
    : undefined,
});

relay.httpServer.listen(PORT, () => {
  console.log(`[railgate] relay server listening on port ${PORT}`);
  console.log(`[railgate] base domain: ${baseDomain}`);
  console.log(`[railgate] protocol version: ${PROTOCOL_VERSION}`);
  if (!token) {
    console.warn(
      `[railgate] WARNING: RAILGATE_TOKEN not set — relay is in OPEN MODE. Anyone who can reach this URL can register tunnels.`
    );
  } else {
    console.log(`[railgate] auth: token required`);
  }
  console.log(
    `[railgate] tunnel control: ${protocol === "https" ? "wss" : "ws"}://${baseDomain}${CONTROL_PATH}`
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[railgate] ${signal} received — shutting down`);
    relay.close().then(() => process.exit(0));
  });
}
