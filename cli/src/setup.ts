import {
  intro,
  outro,
  text,
  password,
  spinner,
  note,
  cancel,
  isCancel,
} from "@clack/prompts";
import { randomBytes } from "crypto";
import { WHOAMI_PATH } from "@railgate/shared";
import { openUrl } from "./util/open-url.js";
import { saveConfig, configPath, type RailgateConfig } from "./config.js";
import {
  deployRailgateRelay,
  RAILGATE_TEMPLATE_CODE,
} from "./railway/deploy.js";

const TEMPLATE_URL = `https://railway.com/deploy/${RAILGATE_TEMPLATE_CODE}`;

interface NormalizedUrl {
  httpUrl: string;
  wsUrl: string;
  isLocal: boolean;
}

/**
 * Accept any of: bare host, host:port, http(s)://..., ws(s)://..., with or
 * without trailing slash or path. Return both an http(s) form (for whoami)
 * and a ws(s) form (for the WebSocket connection). Default to secure unless
 * the input is clearly a localhost address.
 */
export function normalizeRelayUrl(input: string): NormalizedUrl {
  let raw = input.trim().replace(/\/+$/, "");
  let scheme = "";
  let rest = raw;
  const m = raw.match(/^(wss?|https?):\/\/(.+)$/);
  if (m) {
    scheme = m[1];
    rest = m[2];
  }
  const slashIdx = rest.indexOf("/");
  if (slashIdx > -1) rest = rest.slice(0, slashIdx);
  const hostname = rest.split(":")[0];
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const secure =
    scheme === "https" ||
    scheme === "wss" ||
    (scheme === "" && !isLocal);
  return {
    httpUrl: `${secure ? "https" : "http"}://${rest}`,
    wsUrl: `${secure ? "wss" : "ws"}://${rest}`,
    isLocal,
  };
}

interface WhoamiResponse {
  ok: boolean;
  baseDomain?: string;
  protocol?: "http" | "https";
  protocolVersion?: number;
  openMode?: boolean;
  error?: string;
}

/**
 * Hit `/_railgate/whoami` and return what the relay says about itself. Polls
 * for up to `maxWaitMs` since Railway deploys can take 30-60s to come up after
 * the template URL returns control. A 401 short-circuits the wait — that's a
 * token problem, not a readiness problem.
 */
export async function verifyRelay(
  httpUrl: string,
  token: string | undefined,
  maxWaitMs: number
): Promise<WhoamiResponse> {
  const deadline = Date.now() + maxWaitMs;
  let lastErr: string | null = null;
  while (Date.now() < deadline) {
    try {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${httpUrl}${WHOAMI_PATH}`, { headers });
      if (res.status === 401) {
        return { ok: false, error: "Token rejected by relay (401)" };
      }
      if (res.ok) {
        return (await res.json()) as WhoamiResponse;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, error: lastErr || "Verification timed out" };
}

function generateToken(): string {
  return "rg_" + randomBytes(24).toString("base64url");
}

async function exitIfCancel<T>(value: T | symbol): Promise<T> {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

export async function runSetup(opts: {
  manual?: boolean;
  browser?: boolean;
}): Promise<void> {
  if (opts.manual) {
    await runManualSetup();
  } else if (opts.browser) {
    await runBrowserSetup();
  } else {
    await runAutoSetup();
  }
}

/**
 * The default flow: OAuth into Railway, create a project, deploy the
 * railgate template, poll the workflow, capture the public domain, verify,
 * and save config. Zero manual paste steps.
 */
async function runAutoSetup(): Promise<void> {
  intro("Railgate setup");

  const token = generateToken();
  note(
    `${token}\n\nThis token will be set as RAILGATE_TOKEN on your relay and saved locally.\nTreat it like a password — anyone with it can register tunnels on your relay.`,
    "Generated token"
  );

  const projectNameInput = await exitIfCancel(
    await text({
      message: "Railway project name",
      placeholder: `railgate-${randomBytes(3).toString("hex")}`,
      initialValue: `railgate-${randomBytes(3).toString("hex")}`,
      validate: (v) => (!v ? "Project name is required" : undefined),
    })
  );

  let lastBrowserUrl: string | null = null;
  const s = spinner();
  s.start("Authenticating with Railway");

  try {
    const deployed = await deployRailgateRelay(token, projectNameInput, {
      onPhase: (msg) => s.message(msg),
      onPromptUrl: (url) => {
        lastBrowserUrl = url;
        // Pause the spinner long enough to surface the URL in case the
        // browser launch failed silently (SSH session, headless WSL, etc.).
        s.message(
          `Opening Railway to authorize...\n  If the browser didn't open, visit:\n  ${url}`
        );
      },
    });

    s.message(`Verifying relay at ${deployed.httpUrl}`);
    const whoami = await verifyRelay(deployed.httpUrl, token, 90_000);
    if (!whoami.ok) {
      s.stop("Verification failed");
      cancel(
        `The relay deployed but didn't respond to whoami: ${whoami.error}.\nIt may still be warming up — try \`npx railgate http <port>\` in a minute.`
      );
      process.exit(1);
    }
    s.stop(`Relay live at ${whoami.baseDomain}`);

    const cfg: RailgateConfig = {
      relayUrl: deployed.wsUrl,
      token,
      baseDomain: whoami.baseDomain,
      protocol: whoami.protocol,
      protocolVersion: whoami.protocolVersion,
    };
    saveConfig(cfg);

    outro(`Saved to ${configPath()}\n\nTry it: npx railgate http 3000`);
  } catch (err) {
    s.stop("Setup failed");
    const message = (err as Error).message ?? String(err);
    const hint = lastBrowserUrl
      ? `\nIf the Railway auth never opened, you can re-run setup or try \`railgate setup --browser\` for the manual deploy flow.`
      : `\nYou can fall back to \`railgate setup --browser\` for a manual deploy, or \`railgate setup --manual\` if you've already deployed a relay yourself.`;
    cancel(`${message}${hint}`);
    process.exit(1);
  }
}

/**
 * Legacy browser hand-off flow. Opens Railway's deploy URL, user pastes the
 * token in, deploys, pastes the URL back. Kept as `--browser` for headless
 * environments or as a fallback when the auto flow can't be used.
 */
async function runBrowserSetup(): Promise<void> {
  intro("Railgate setup");

  const token = generateToken();
  note(
    `${token}\n\nThis token will be set as RAILGATE_TOKEN on your relay and saved locally.\nTreat it like a password — anyone with it can register tunnels on your relay.`,
    "Generated token"
  );

  const templateUrl = `${TEMPLATE_URL}?envs=RAILGATE_TOKEN&RAILGATE_TOKENDefault=${encodeURIComponent(token)}`;
  note(
    `Opening Railway in your browser. Click "Deploy" and wait for the\nservice to come up, then copy its public URL.`,
    "Deploy the relay"
  );
  try {
    await openUrl(templateUrl);
  } catch {
    note(`Couldn't open your browser automatically. Open this URL manually:\n${templateUrl}`, "Browser");
  }

  const urlInput = await exitIfCancel(
    await text({
      message: "Paste your relay's URL from Railway",
      placeholder: "https://railgate-relay-production-abc123.up.railway.app",
      validate: (v) => (!v ? "URL is required" : undefined),
    })
  );

  const { httpUrl, wsUrl } = normalizeRelayUrl(urlInput);

  const s = spinner();
  s.start(`Verifying ${httpUrl} (this can take up to 60s while Railway warms up)`);
  const whoami = await verifyRelay(httpUrl, token, 60_000);
  if (!whoami.ok) {
    s.stop("Verification failed");
    cancel(
      `Couldn't verify the relay: ${whoami.error}.\nCheck that the deploy finished and the RAILGATE_TOKEN env var matches the one above, then re-run setup.`
    );
    process.exit(1);
  }
  s.stop(`Connected to ${whoami.baseDomain}`);

  const cfg: RailgateConfig = {
    relayUrl: wsUrl,
    token,
    baseDomain: whoami.baseDomain,
    protocol: whoami.protocol,
    protocolVersion: whoami.protocolVersion,
  };
  saveConfig(cfg);

  outro(
    `Saved to ${configPath()}\n\nTry it: npx railgate http 3000`
  );
}

async function runManualSetup(): Promise<void> {
  intro("Railgate setup (manual)");

  const urlInput = await exitIfCancel(
    await text({
      message: "Relay URL",
      placeholder: "https://relay.example.com  or  http://localhost:3000",
      validate: (v) => (!v ? "URL is required" : undefined),
    })
  );

  const tokenInput = await exitIfCancel(
    await password({
      message: "Relay token (press enter if the relay runs in open mode)",
    })
  );
  const token = tokenInput || undefined;

  const { httpUrl, wsUrl } = normalizeRelayUrl(urlInput);

  const s = spinner();
  s.start(`Verifying ${httpUrl}`);
  const whoami = await verifyRelay(httpUrl, token, 5_000);
  if (!whoami.ok) {
    s.stop("Verification failed");
    cancel(`Couldn't reach the relay: ${whoami.error}.`);
    process.exit(1);
  }
  s.stop(`Connected to ${whoami.baseDomain}`);

  const cfg: RailgateConfig = {
    relayUrl: wsUrl,
    token,
    baseDomain: whoami.baseDomain,
    protocol: whoami.protocol,
    protocolVersion: whoami.protocolVersion,
  };
  saveConfig(cfg);

  outro(`Saved to ${configPath()}\n\nTry it: npx railgate http 3000`);
}
