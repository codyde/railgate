import { describe, it, expect } from "vitest";
import { normalizeRelayUrl } from "./setup.js";
import { normalizeWildcardDomain } from "./domain.js";

describe("normalizeRelayUrl", () => {
  it("defaults remote hosts to secure schemes", () => {
    const { httpUrl, wsUrl, isLocal } = normalizeRelayUrl("relay.example.com");
    expect(httpUrl).toBe("https://relay.example.com");
    expect(wsUrl).toBe("wss://relay.example.com");
    expect(isLocal).toBe(false);
  });

  it("treats localhost as insecure", () => {
    const { httpUrl, wsUrl, isLocal } = normalizeRelayUrl("localhost:3000");
    expect(httpUrl).toBe("http://localhost:3000");
    expect(wsUrl).toBe("ws://localhost:3000");
    expect(isLocal).toBe(true);
  });

  it("strips scheme, path, and trailing slash", () => {
    const { httpUrl, wsUrl } = normalizeRelayUrl("wss://relay.example.com/path/");
    expect(httpUrl).toBe("https://relay.example.com");
    expect(wsUrl).toBe("wss://relay.example.com");
  });
});

describe("normalizeWildcardDomain", () => {
  it("prefixes a bare domain with a wildcard", () => {
    const result = normalizeWildcardDomain("tunnels.example.com");
    expect(result).toEqual({
      domain: "*.tunnels.example.com",
      baseDomain: "tunnels.example.com",
      prefixed: true,
    });
  });

  it("accepts an explicit wildcard without re-prefixing", () => {
    const result = normalizeWildcardDomain("*.tunnels.example.com");
    expect(result).toEqual({
      domain: "*.tunnels.example.com",
      baseDomain: "tunnels.example.com",
      prefixed: false,
    });
  });

  it("rejects a single-label domain", () => {
    expect(normalizeWildcardDomain("localhost")).toHaveProperty("error");
  });

  it("rejects a malformed wildcard", () => {
    expect(normalizeWildcardDomain("*foo")).toHaveProperty("error");
  });
});
