// An animated terminal loader: a rotating square glyph followed by status text
// with a bright gradient highlight that sweeps from the front of the text to
// the end. Falls back to plain line printing when stdout isn't a TTY.
//
// The animated line is always a SINGLE line, redrawn in place with a carriage
// return + clear-line. Long/static content (e.g. an auth URL that would wrap)
// is printed once above the spinner via note(), never animated — repainting
// wrapping lines is what corrupts the terminal.
//
// The public surface mirrors @clack/prompts' spinner so it drops into setup.

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GUTTER = `\x1b[90m│${RESET}  `;
/** A blank gutter line, matching clack's spacer between sections. */
const BAR = `\x1b[90m│${RESET}`;
const CHECK = "\x1b[32m✔\x1b[0m";

/** Rotating square — the filled quadrant walks clockwise. */
export const SPINNER_FRAMES = ["◰", "◳", "◲", "◱"];

const BASE: [number, number, number] = [110, 118, 140]; // dim base text
const PEAK: [number, number, number] = [180, 225, 255]; // bright sweep head
const BAND = 7; // half-width of the highlight, in characters
const PEAK_COLOR = `\x1b[38;2;${PEAK[0]};${PEAK[1]};${PEAK[2]}m`;

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
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
  /** Print a static block above the spinner (for long/wrapping content). */
  note(block: string): void;
  /** Print a permanent success line above the spinner and keep spinning. */
  success(message: string): void;
  stop(message?: string, code?: number): void;
}

export function createLoader(): Loader {
  const out = process.stdout;
  const isTty = Boolean(out.isTTY);

  let timer: ReturnType<typeof setInterval> | null = null;
  let text = "";
  let frame = 0;
  let head = -BAND;

  function render(): void {
    const line = firstLine(text);
    const glyph = `${PEAK_COLOR}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${RESET}`;
    out.write(`\r\x1b[2K${GUTTER}${glyph} ${paintShimmer(line, head)}`);

    frame++;
    // Sweep speed of the gradient highlight (chars per frame).
    head += 1.275;
    if (head > line.length + BAND) head = -BAND;
  }

  function start(message = ""): void {
    text = message;
    if (!isTty) {
      if (message) out.write(`${GUTTER}${message}\n`);
      return;
    }
    out.write("\x1b[?25l"); // hide cursor
    out.write(`${BAR}\n`); // spacer so the block isn't flush with the prompt above
    frame = 0;
    head = -BAND;
    render();
    timer = setInterval(render, 90);
    timer.unref?.();
  }

  function message(next: string): void {
    text = next;
    if (!isTty && next) out.write(`${GUTTER}${next}\n`);
  }

  function note(block: string): void {
    const lines = block
      .split("\n")
      .map((l) => `${GUTTER}${DIM}${l}${RESET}`)
      .join("\n");
    if (!isTty) {
      out.write(`${lines}\n`);
      return;
    }
    out.write("\r\x1b[2K"); // drop the current spinner line
    out.write(`${lines}\n`); // print the static block permanently
    render(); // redraw the spinner on the fresh line below
  }

  function success(message: string): void {
    const line = `${GUTTER}${CHECK} ${firstLine(message)}`;
    if (!isTty) {
      out.write(`${line}\n`);
      return;
    }
    out.write("\r\x1b[2K"); // drop the current spinner line
    out.write(`${line}\n`); // print the acknowledgment permanently
    render(); // redraw the spinner on the fresh line below
  }

  function stop(message?: string, code = 0): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const final = message ?? text;
    if (!isTty) {
      if (final) out.write(`${GUTTER}${firstLine(final)}\n`);
      return;
    }
    out.write("\r\x1b[2K");
    const symbol = code === 0 ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    out.write(`${GUTTER}${symbol} ${firstLine(final)}\n`);
    out.write("\x1b[?25h"); // show cursor
  }

  return { start, message, note, success, stop };
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
