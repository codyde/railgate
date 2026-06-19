import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  generateSubdomain,
  parseMessage,
  serializeMessage,
  encodeBinaryFrame,
  decodeBinaryFrame,
  chunkBuffer,
  streamBodyFrames,
  stripHopByHopHeaders,
  sanitizeCloseCode,
  FRAME_RESPONSE_BODY,
  BODY_CHUNK_SIZE,
  WS_READY_OPEN,
  PROTOCOL_VERSION,
  type RegisterMessage,
  type RequestHeadMessage,
  type FrameSink,
} from "./index.js";

describe("serializeMessage / parseMessage", () => {
  it("round-trips a register message", () => {
    const msg: RegisterMessage = {
      type: "register",
      subdomain: "abc123",
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(parseMessage(serializeMessage(msg))).toEqual(msg);
  });

  it("round-trips a request-head with multi-value headers", () => {
    const msg: RequestHeadMessage = {
      type: "request-head",
      id: "req-1",
      method: "POST",
      path: "/submit",
      headers: { "set-cookie": ["a=1", "b=2"], "content-type": "text/plain" },
    };
    const parsed = parseMessage(serializeMessage(msg)) as RequestHeadMessage;
    expect(parsed).toEqual(msg);
    expect(parsed.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });
});

describe("binary frames", () => {
  it("round-trips opcode, id, and payload", () => {
    const payload = Buffer.from("the quick brown fox");
    const frame = encodeBinaryFrame(FRAME_RESPONSE_BODY, "conn-42", payload);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.opcode).toBe(FRAME_RESPONSE_BODY);
    expect(decoded.id).toBe("conn-42");
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it("handles binary payloads with embedded nulls", () => {
    const payload = Buffer.from([0, 1, 2, 0, 255, 0]);
    const decoded = decodeBinaryFrame(
      encodeBinaryFrame(0x04, "x", payload)
    );
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it("rejects ids longer than 255 bytes", () => {
    expect(() => encodeBinaryFrame(0x01, "a".repeat(256), Buffer.alloc(0))).toThrow();
  });
});

describe("chunkBuffer", () => {
  it("yields the whole buffer when under the cap", () => {
    const chunks = [...chunkBuffer(Buffer.from("small"), 64)];
    expect(chunks).toHaveLength(1);
  });

  it("splits a large buffer at the chunk size", () => {
    const buf = Buffer.alloc(BODY_CHUNK_SIZE * 2 + 10);
    const chunks = [...chunkBuffer(buf)];
    expect(chunks).toHaveLength(3);
    expect(Buffer.concat(chunks).length).toBe(buf.length);
  });
});

describe("streamBodyFrames", () => {
  function mockSink(): FrameSink & { frames: Buffer[] } {
    const frames: Buffer[] = [];
    return {
      frames,
      readyState: WS_READY_OPEN,
      bufferedAmount: 0,
      send(data) {
        frames.push(Buffer.from(data));
      },
    };
  }

  it("frames a body and signals completion, preserving bytes", async () => {
    const body = Buffer.alloc(BODY_CHUNK_SIZE + 100, 7);
    const sink = mockSink();
    const source = Readable.from([body.subarray(0, 100), body.subarray(100)]);

    await new Promise<void>((resolve) => {
      streamBodyFrames(source, sink, FRAME_RESPONSE_BODY, "id-1", resolve);
    });

    const reassembled = Buffer.concat(
      sink.frames.map((f) => decodeBinaryFrame(f).payload)
    );
    expect(reassembled.equals(body)).toBe(true);
  });

  it("aborts and skips onEnd when maxBytes is exceeded", async () => {
    const sink = mockSink();
    const source = Readable.from([Buffer.alloc(1000)]);
    let ended = false;
    let limitHit = false;

    await new Promise<void>((resolve) => {
      source.once("close", () => resolve());
      streamBodyFrames(
        source,
        sink,
        FRAME_RESPONSE_BODY,
        "id-2",
        () => {
          ended = true;
        },
        {
          maxBytes: 100,
          onLimitExceeded: () => {
            limitHit = true;
          },
        }
      );
    });

    expect(limitHit).toBe(true);
    expect(ended).toBe(false);
  });
});

describe("stripHopByHopHeaders", () => {
  it("removes standard hop-by-hop headers", () => {
    const headers = stripHopByHopHeaders({
      "transfer-encoding": "chunked",
      "keep-alive": "timeout=5",
      upgrade: "h2c",
      "content-type": "text/plain",
    });
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers["keep-alive"]).toBeUndefined();
    expect(headers["upgrade"]).toBeUndefined();
    expect(headers["content-type"]).toBe("text/plain");
  });

  it("removes headers named in the Connection header", () => {
    const headers = stripHopByHopHeaders({
      connection: "close, X-Custom-Hop",
      "x-custom-hop": "secret",
      "x-keep": "yes",
    });
    expect(headers["connection"]).toBeUndefined();
    expect(headers["x-custom-hop"]).toBeUndefined();
    expect(headers["x-keep"]).toBe("yes");
  });
});

describe("sanitizeCloseCode", () => {
  it("passes through valid sendable codes", () => {
    expect(sanitizeCloseCode(1000)).toBe(1000);
    expect(sanitizeCloseCode(1001)).toBe(1001);
    expect(sanitizeCloseCode(1011)).toBe(1011);
    expect(sanitizeCloseCode(3000)).toBe(3000);
    expect(sanitizeCloseCode(4999)).toBe(4999);
  });

  it("coerces reserved codes (1004/1005/1006/1015) to 1000", () => {
    expect(sanitizeCloseCode(1004)).toBe(1000);
    expect(sanitizeCloseCode(1005)).toBe(1000);
    expect(sanitizeCloseCode(1006)).toBe(1000);
    expect(sanitizeCloseCode(1015)).toBe(1000);
  });

  it("coerces out-of-range and missing codes to 1000", () => {
    expect(sanitizeCloseCode(undefined)).toBe(1000);
    expect(sanitizeCloseCode(0)).toBe(1000);
    expect(sanitizeCloseCode(999)).toBe(1000);
    expect(sanitizeCloseCode(2999)).toBe(1000);
    expect(sanitizeCloseCode(5000)).toBe(1000);
  });
});

describe("generateSubdomain", () => {
  it("produces a lowercase hex string", () => {
    expect(generateSubdomain()).toMatch(/^[0-9a-f]+$/);
  });
});
