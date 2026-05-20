import { createHash, randomBytes } from "crypto";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import path from "path";
import { configDir } from "../config.js";
import { openUrl } from "../util/open-url.js";

/**
 * Public OAuth client (PKCE-only, no secret). Safe to embed in a published
 * package — there's no client_secret involved; PKCE replaces it. Override via
 * env var so the same binary can be retargeted at a dev OAuth app without
 * rebuilding.
 */
const DEFAULT_CLIENT_ID = "rlwy_oaci_Fbfd7mYeSDdzwKEjwq3iBZ0A";
export const RAILWAY_CLIENT_ID =
  process.env.RAILGATE_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;

const OAUTH_BASE = "https://backboard.railway.com/oauth";
const SCOPES =
  "openid email profile offline_access project:admin workspace:admin";

const CALLBACK_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Railgate</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0a0a; color: #eee; text-align: center; padding: 4rem 2rem; }
  .ok { color: #6cf; font-size: 1.5rem; font-weight: 600; }
  .msg { opacity: 0.7; margin-top: 0.5rem; }
</style></head><body>
<div class="ok">Connected to Railway</div>
<div class="msg">You can close this tab and return to your terminal.</div>
</body></html>`;

interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

function generatePkce(): PkceChallenge {
  const codeVerifier = randomBytes(64).toString("base64url").slice(0, 128);
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

function generateState(): string {
  return randomBytes(32).toString("base64url");
}

function buildAuthorizationUrl(
  redirectUri: string,
  pkce: PkceChallenge,
  state: string
): string {
  const url = new URL(`${OAUTH_BASE}/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", RAILWAY_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface RailwayAuth {
  accessToken: string;
  refreshToken?: string;
  /** Unix epoch seconds when accessToken expires. */
  expiresAt: number;
}

function tokenToAuth(token: TokenResponse): RailwayAuth {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
  };
}

function railwayAuthPath(): string {
  return path.join(configDir(), "railway-auth.json");
}

export function loadRailwayAuth(): RailwayAuth | null {
  try {
    const raw = fs.readFileSync(railwayAuthPath(), "utf8");
    return JSON.parse(raw) as RailwayAuth;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function saveRailwayAuth(auth: RailwayAuth): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(railwayAuthPath(), JSON.stringify(auth, null, 2), {
    mode: 0o600,
  });
}

export function clearRailwayAuth(): void {
  try {
    fs.unlinkSync(railwayAuthPath());
  } catch {
    // already gone
  }
}

async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: RAILWAY_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${body}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: RAILWAY_CLIENT_ID,
  });
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${body}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Bind a local HTTP listener on an ephemeral port and return both the port
 * (synchronous, needed to build the redirect URI) and a promise that resolves
 * when the OAuth callback arrives.
 *
 * Browser preconnects, favicon requests, and stray traffic to other paths get
 * 404'd without disturbing the wait. Stale callbacks with a mismatched state
 * are ignored so a previous aborted flow can't poison this one.
 */
async function bindCallbackListener(
  expectedState: string,
  timeoutMs: number
): Promise<{ port: number; codePromise: Promise<string> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  const codePromise = new Promise<string>((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      server.close();
      reject(
        new Error("OAuth flow timed out — no callback received after 5 minutes")
      );
    }, timeoutMs);

    const settle = (err: Error | null, code?: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else if (code) resolve(code);
    };

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      const codeParam = url.searchParams.get("code");
      const stateParam = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");

      // Render the close-this-tab page regardless so the browser shows
      // something useful even on error.
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(CALLBACK_HTML);

      if (errorParam) {
        settle(new Error(`OAuth error from Railway: ${errorParam}`));
        return;
      }
      if (stateParam !== expectedState) {
        // Stale callback — keep waiting for the real one.
        return;
      }
      if (!codeParam) {
        settle(new Error("OAuth callback was missing the authorization code"));
        return;
      }
      settle(null, codeParam);
    });
  });

  return { port, codePromise };
}

/**
 * Run the full browser-based OAuth PKCE flow and persist the resulting auth.
 *
 * onPromptUrl is called with the authorization URL so the caller can display
 * it to the user (useful for SSH sessions where `open` may not reach a real
 * browser, or when the browser launch silently fails).
 */
export async function loginWithBrowser(opts: {
  onPromptUrl?: (url: string) => void;
} = {}): Promise<RailwayAuth> {
  const pkce = generatePkce();
  const state = generateState();

  const { port, codePromise } = await bindCallbackListener(state, 5 * 60_000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl = buildAuthorizationUrl(redirectUri, pkce, state);

  opts.onPromptUrl?.(authUrl);

  // Open the browser. If it fails (headless, SSH), the user can paste the
  // URL the caller already printed.
  try {
    await openUrl(authUrl);
  } catch {
    // No-op — URL was already surfaced via onPromptUrl.
  }

  const code = await codePromise;
  const tokenResp = await exchangeCodeForToken(
    code,
    redirectUri,
    pkce.codeVerifier
  );
  const auth = tokenToAuth(tokenResp);
  saveRailwayAuth(auth);
  return auth;
}

/**
 * Return a valid access token, logging in or refreshing as needed.
 *
 * - No saved auth → run browser login.
 * - Saved auth still valid (>60s left) → return it.
 * - Saved auth expired but refresh token present → refresh; on failure, re-login.
 * - Saved auth expired with no refresh token → re-login.
 */
export async function getAccessToken(opts: {
  onPromptUrl?: (url: string) => void;
} = {}): Promise<string> {
  const existing = loadRailwayAuth();
  if (!existing) {
    const auth = await loginWithBrowser(opts);
    return auth.accessToken;
  }

  const now = Math.floor(Date.now() / 1000);
  if (existing.expiresAt - 60 > now) {
    return existing.accessToken;
  }

  if (!existing.refreshToken) {
    const auth = await loginWithBrowser(opts);
    return auth.accessToken;
  }

  try {
    const refreshed = await refreshAccessToken(existing.refreshToken);
    const next: RailwayAuth = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? existing.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + refreshed.expires_in,
    };
    saveRailwayAuth(next);
    return next.accessToken;
  } catch {
    const auth = await loginWithBrowser(opts);
    return auth.accessToken;
  }
}
