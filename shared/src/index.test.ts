import { describe, it, expect } from "vitest";
import {
  generateSubdomain,
  parseMessage,
  serializeMessage,
  PROTOCOL_VERSION,
  type RegisterMessage,
  type RequestMessage,
} from "./index.js";

describe("serializeMessage / parseMessage", () => {
  it("round-trips a register message", () => {
    const msg: RegisterMessage = {
      type: "register",
      subdomain: "abc123",
      localPort: 3000,
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(parseMessage(serializeMessage(msg))).toEqual(msg);
  });

  it("round-trips a request message with a base64 body", () => {
    const msg: RequestMessage = {
      type: "request",
      id: "req-1",
      method: "POST",
      path: "/submit",
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"hi":true}').toString("base64"),
    };
    const parsed = parseMessage(serializeMessage(msg)) as RequestMessage;
    expect(parsed).toEqual(msg);
    expect(Buffer.from(parsed.body!, "base64").toString()).toBe('{"hi":true}');
  });

  it("preserves multi-value headers", () => {
    const msg: RequestMessage = {
      type: "request",
      id: "req-2",
      method: "GET",
      path: "/",
      headers: { "set-cookie": ["a=1", "b=2"] },
    };
    const parsed = parseMessage(serializeMessage(msg)) as RequestMessage;
    expect(parsed.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });
});

describe("generateSubdomain", () => {
  it("produces a lowercase hex string", () => {
    expect(generateSubdomain()).toMatch(/^[0-9a-f]+$/);
  });

  it("is reasonably unique across calls", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateSubdomain()));
    expect(set.size).toBe(100);
  });
});
