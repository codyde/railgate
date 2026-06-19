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

export class HttpError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Railway API returned HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
    this.status = status;
  }
  /** Gateway/availability errors that are worth retrying or recovering from. */
  get transient(): boolean {
    return [502, 503, 504, 521, 522, 524, 529].includes(this.status);
  }
}

/** Cloudflare error pages are full HTML documents — never show those raw. */
function cleanErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) return "(HTML error page from gateway)";
  return trimmed.length > 300 ? trimmed.slice(0, 300) + "…" : trimmed;
}

// Railway sometimes reports "Not Authorized" for a perfectly-authorized read
// right after a resource is created — the permission state hasn't propagated
// yet. A token refresh doesn't help (the token is fine), so for reads we retry
// a few times with backoff to ride out the lag.
const PROPAGATION_RETRY_ATTEMPTS = 3;
const PROPAGATION_RETRY_BASE_MS = 1000;

function hasAuthErrors(errors: GqlError[] | undefined): boolean {
  return !!errors?.some(
    (e) =>
      /not authorized|unauthorized/i.test(e.message) ||
      e.extensions?.code === "UNAUTHENTICATED"
  );
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
  // Queries are safe to retry on gateway errors; mutations are not (the
  // server may have executed them despite the failed response), so those
  // surface an HttpError for the caller to recover deliberately.
  const isMutation = query.trimStart().startsWith("mutation");
  const maxAttempts = isMutation ? 1 : 3;

  for (let attempt = 1; ; attempt++) {
    try {
      return await gqlOnce<T>(query, variables, opts);
    } catch (err) {
      const retryable =
        err instanceof HttpError && err.transient && attempt < maxAttempts;
      if (!retryable) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

async function readJsonOrThrow<T>(
  res: Response
): Promise<{ data?: T; errors?: GqlError[] }> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, cleanErrorBody(body));
  }
  return (await res.json()) as { data?: T; errors?: GqlError[] };
}

async function gqlOnce<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: GqlOptions
): Promise<T> {
  const isMutation = query.trimStart().startsWith("mutation");

  let token = await getAccessToken(opts);
  let res = await postGql(token, query, variables);
  if (res.status === 401) {
    // Stale cached token. Force a refresh and retry once.
    token = await refreshOrRelogin(opts);
    res = await postGql(token, query, variables);
  }
  let payload = await readJsonOrThrow<T>(res);

  // Some Railway endpoints return 200 with an auth error in the body.
  if (hasAuthErrors(payload.errors)) {
    token = await refreshOrRelogin(opts);
    res = await postGql(token, query, variables);
    payload = await readJsonOrThrow<T>(res);

    // The token is now fresh; a lingering "Not Authorized" on a read is
    // permission propagation, not a token problem. Retry with backoff.
    // Mutations are never looped — the server may have executed them.
    if (!isMutation) {
      for (
        let i = 0;
        hasAuthErrors(payload.errors) && i < PROPAGATION_RETRY_ATTEMPTS;
        i++
      ) {
        await new Promise((r) =>
          setTimeout(r, PROPAGATION_RETRY_BASE_MS * (i + 1))
        );
        res = await postGql(token, query, variables);
        payload = await readJsonOrThrow<T>(res);
      }
    }
  }

  if (payload.errors && payload.errors.length > 0) {
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
