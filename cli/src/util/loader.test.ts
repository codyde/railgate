import { describe, it, expect } from "vitest";
import { paintShimmer, SPINNER_FRAMES } from "./loader.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) =>
  s
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("");

describe("loader", () => {
  it("exposes a four-frame rotating square", () => {
    expect(SPINNER_FRAMES).toEqual(["◰", "◳", "◲", "◱"]);
  });

  it("shimmer preserves the underlying text and spaces", () => {
    const painted = paintShimmer("hello world", 3);
    expect(stripAnsi(painted)).toBe("hello world");
  });

  it("shimmer emits truecolor escapes for non-space characters", () => {
    const painted = paintShimmer("ab", 0);
    expect(painted).toContain("\x1b[38;2;");
    expect(painted.endsWith("\x1b[0m")).toBe(true);
  });

  it("brightens characters nearer the sweep head", () => {
    // Head at index 0: 'a' (dist 0) should be brighter than a far char.
    const near = paintShimmer("a", 0);
    const far = paintShimmer("a", 20);
    expect(near).not.toBe(far);
  });
});
