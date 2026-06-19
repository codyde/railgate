import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { rmSync } from "fs";
import { createStore } from "./store.js";

const tempFiles: string[] = [];
function tempDbPath(): string {
  const p = join(tmpdir(), `railgate-test-${randomUUID()}.sqlite`);
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(p + suffix);
      } catch {
        /* ignore */
      }
    }
  }
});

describe("tunnel store", () => {
  it("reports in-memory databases as non-durable", () => {
    const store = createStore(":memory:");
    expect(store.durable).toBe(false);
    store.dispose();
  });

  it("reports file databases as durable", () => {
    const store = createStore(tempDbPath());
    expect(store.durable).toBe(true);
    store.dispose();
  });

  it("only returns closed tunnels in history, newest first", () => {
    const store = createStore(":memory:");
    const a = store.open({ subdomain: "a", clientIp: "1.1.1.1", openedAt: 1000 });
    const b = store.open({ subdomain: "b", clientIp: "2.2.2.2", openedAt: 2000 });
    store.open({ subdomain: "c", clientIp: null, openedAt: 3000 }); // stays open

    store.markClosed(a, { closedAt: 5000, requestCount: 7, reason: "disconnected" });
    store.markClosed(b, { closedAt: 6000, requestCount: 3 });

    const history = store.recentClosed(10);
    expect(history.map((r) => r.subdomain)).toEqual(["b", "a"]);
    expect(history[1]).toMatchObject({
      subdomain: "a",
      clientIp: "1.1.1.1",
      requestCount: 7,
      closeReason: "disconnected",
      closedAt: 5000,
    });
    store.dispose();
  });

  it("honours the history limit", () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 5; i++) {
      const id = store.open({ subdomain: `s${i}`, clientIp: null, openedAt: i });
      store.markClosed(id, { closedAt: 100 + i, requestCount: 0 });
    }
    expect(store.recentClosed(2)).toHaveLength(2);
    store.dispose();
  });

  it("closes orphaned open tunnels left by a previous process on reopen", () => {
    const path = tempDbPath();
    const first = createStore(path);
    first.open({ subdomain: "orphan", clientIp: "9.9.9.9", openedAt: 1000 });
    first.dispose();

    const second = createStore(path);
    const history = second.recentClosed(10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      subdomain: "orphan",
      closeReason: "relay restart",
    });
    expect(history[0].closedAt).toBeTypeOf("number");
    second.dispose();
  });

  it("no-ops writes after disposal", () => {
    const store = createStore(":memory:");
    store.dispose();
    expect(store.open({ subdomain: "x", clientIp: null, openedAt: 1 })).toBe(-1);
    expect(() =>
      store.markClosed(1, { closedAt: 2, requestCount: 0 })
    ).not.toThrow();
    expect(store.recentClosed(10)).toEqual([]);
  });
});
