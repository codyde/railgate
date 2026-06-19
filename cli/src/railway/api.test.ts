import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The OAuth layer is mocked so the API client never touches the network for
// tokens; refreshOrRelogin resolves purely from these fakes.
vi.mock("./oauth.js", () => ({
  getAccessToken: vi.fn(async () => "tok-initial"),
  loadRailwayAuth: vi.fn(() => ({
    accessToken: "tok-initial",
    refreshToken: "refresh",
    expiresAt: 0,
  })),
  saveRailwayAuth: vi.fn(),
  loginWithBrowser: vi.fn(async () => ({
    accessToken: "tok-login",
    refreshToken: "refresh",
    expiresAt: 0,
  })),
  refreshAccessToken: vi.fn(async () => ({
    access_token: "tok-refreshed",
    refresh_token: "refresh2",
    expires_in: 3600,
  })),
}));

import { gql, GraphQLError } from "./api.js";

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => "",
  } as unknown as Response;
}

function authErrorResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ errors: [{ message: "Not Authorized" }] }),
    text: async () => "",
  } as unknown as Response;
}

describe("railway gql client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns data without refreshing when authorized", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse({ id: "1" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(gql<{ id: string }>("query { me { id } }")).resolves.toEqual({
      id: "1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rides out a propagation-lag Not Authorized on a read", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authErrorResponse()) // initial
      .mockResolvedValueOnce(authErrorResponse()) // after token refresh
      .mockResolvedValueOnce(okResponse({ ok: true })); // propagation retry
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = gql<{ ok: boolean }>("query { project { id } }");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not loop on Not Authorized for mutations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authErrorResponse()) // initial
      .mockResolvedValueOnce(authErrorResponse()); // after token refresh, then give up
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      gql("mutation { projectCreate { id } }")
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
