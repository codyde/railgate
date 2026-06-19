// An animated terminal loader: a rotating square glyph followed by status text
// with a bright gradient highlight that sweeps from the front of the text to
// the end. Falls back to plain line printing when stdout isn't a TTY.
//
// The public surface (start / message / stop) mirrors @clack/prompts' spinner
// so it can be dropped into the existing setup flow.

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GUTTER = `\x1b[90m│${RESET}  `;

/** Rotating square — the filled quadrant walks clockwise. */
export const SPINNER_FRAMES = ["◰", "◳", "◲", "◱"];

const BASE: [number, number, number] = [110, 118, 140]; // dim base text
const PEAK: [number, number, number] = [180, 225, 255]; // bright sweep head
const BAND = 7; // half-width of the highlight, in characters

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Color `text` with a triangular highlight centered at `head` (a character
 * index, may be fractional and outside the string so the band can enter and
 * exit). Spaces are left uncolored. Pure and synchronous for easy testing.
 */
export function paintShimmer(text: string, head: number, band = BAND): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      out += " ";
      continue;
    }
    const dist = Math.abs(i - head);
    const t = dist >= band ? 0 : 1 - dist / band;
    const r = lerp(BASE[0], PEAK[0], t);
    const g = lerp(BASE[1], PEAK[1], t);
    const b = lerp(BASE[2], PEAK[2], t);
    out += `\x1b[38;2;${r};${g};${b}m${ch}`;
  }
  return out + RESET;
}

export interface Loader {
  start(message?: string): void;
  message(message: string): void;
  stop(message?: string, code?: number): void;
}

export function createLoader(): Loader {
  const out = process.stdout;
  const isTty = Boolean(out.isTTY);

  let timer: ReturnType<typeof setInterval> | null = null;
  let text = "";
  let frame = 0;
  let head = -BAND;
  let prevLineCount = 0;
  let lastPlain = "";

  const PEAK_COLOR = `\x1b[38;2;${PEAK[0]};${PEAK[1]};${PEAK[2]}m`;

  function clearRendered(): void {
    for (let i = prevLineCount - 1; i > 0; i--) {
      out.write("\x1b[2K\x1b[1A");
    }
    out.write("\x1b[2K\r");
    prevLineCount = 0;
  }

  function render(): void {
    const lines = text.split("\n");
    const spinner = `${PEAK_COLOR}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${RESET}`;
    const first = `${GUTTER}${spinner} ${paintShimmer(lines[0] ?? "", head)}`;
    const rest = lines.slice(1).map((l) => `${GUTTER}${DIM}${l}${RESET}`);
    const composed = [first, ...rest].join("\n");

    clearRendered();
    out.write(composed);
    prevLineCount = lines.length;

    frame++;
    head += 0.85;
    const span = (lines[0] ?? "").length + BAND;
    if (head > span) head = -BAND;
  }

  function start(message = ""): void {
    text = message;
    if (!isTty) {
      if (message) {
        lastPlain = message;
        out.write(`${GUTTER}${message}\n`);
      }
      return;
    }
    out.write("\x1b[?25l"); // hide cursor
    frame = 0;
    head = -BAND;
    prevLineCount = 0;
    render();
    timer = setInterval(render, 90);
    timer.unref?.();
  }

  function message(next: string): void {
    text = next;
    if (!isTty) {
      if (next && next !== lastPlain) {
        lastPlain = next;
        out.write(`${GUTTER}${next}\n`);
      }
    }
  }

  function stop(message?: string, code = 0): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const final = message ?? text;
    if (!isTty) {
      if (final) out.write(`${GUTTER}${final}\n`);
      return;
    }
    clearRendered();
    const symbol =
      code === 0 ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    out.write(`${GUTTER}${symbol} ${final}\n`);
    out.write("\x1b[?25h"); // show cursor
  }

  return { start, message, stop };
}

// Make sure a crash mid-spin never leaves the user's cursor hidden.
let cursorGuardInstalled = false;
function installCursorGuard(): void {
  if (cursorGuardInstalled) return;
  cursorGuardInstalled = true;
  process.on("exit", () => {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
  });
}
installCursorGuard();
