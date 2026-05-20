import {
  getAccessToken,
  loadRailwayAuth,
  saveRailwayAuth,
  loginWithBrowser,
  refreshAccessToken,
} from "./oauth.js";

const GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

export interface GqlError {
  message: string;
  path?: string[];
  extensions?: Record<string, unknown>;
}

export class GraphQLError extends Error {
  errors: GqlError[];
  constructor(errors: GqlError[]) {
    super(errors.map((e) => e.message).join("; ") || "GraphQL error");
    this.name = "GraphQLError";
    this.errors = errors;
  }
}

export interface GqlOptions {
  /** Surface the auth URL when a fresh login is required. */
  onPromptUrl?: (url: string) => void;
}

/**
 * Run a GraphQL operation against Railway's backboard with an auth header.
 *
 * Auto-recovers from a stale cached token: on a 401 (or "Not Authorized"
 * GraphQL error) we force a fresh token via the OAuth refresh / login path
 * and retry once.
 */
export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: GqlOptions = {}
): Promise<T> {
  let token = await getAccessToken(opts);
  let res = await postGql(token, query, variables);
  if (res.status === 401) {
    // Stale cached token. Force a refresh and retry once.
    token = await refreshOrRelogin(opts);
    res = await postGql(token, query, variables);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Railway GraphQL failed (HTTP ${res.status}): ${body}`);
  }
  const payload = (await res.json()) as { data?: T; errors?: GqlError[] };
  if (payload.errors && payload.errors.length > 0) {
    const isAuth = payload.errors.some(
      (e) => /not authorized|unauthorized/i.test(e.message) || e.extensions?.code === "UNAUTHENTICATED"
    );
    if (isAuth) {
      // Some Railway endpoints return 200 with an auth error in the body.
      const fresh = await refreshOrRelogin(opts);
      const retry = await postGql(fresh, query, variables);
      const retryPayload = (await retry.json()) as { data?: T; errors?: GqlError[] };
      if (retryPayload.errors && retryPayload.errors.length > 0) {
        throw new GraphQLError(retryPayload.errors);
      }
      if (!retryPayload.data) {
        throw new Error("Railway GraphQL returned no data");
      }
      return retryPayload.data;
    }
    throw new GraphQLError(payload.errors);
  }
  if (!payload.data) {
    throw new Error("Railway GraphQL returned no data");
  }
  return payload.data;
}

async function postGql(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Response> {
  return await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
}

/**
 * Force a fresh access token. Tries refresh first; falls back to interactive
 * re-login if refresh fails or there's no refresh token on file.
 */
async function refreshOrRelogin(opts: GqlOptions): Promise<string> {
  const existing = loadRailwayAuth();
  if (existing?.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(existing.refreshToken);
      const next = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? existing.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + refreshed.expires_in,
      };
      saveRailwayAuth(next);
      return next.accessToken;
    } catch {
      // Fall through to interactive login.
    }
  }
  const fresh = await loginWithBrowser({ onPromptUrl: opts.onPromptUrl });
  return fresh.accessToken;
}
