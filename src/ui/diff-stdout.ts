import { Writable } from "node:stream";

/**
 * A stdout shim that sits between Ink and the real terminal.
 *
 * Ink repaints the entire frame on every render — each write is
 * `eraseLines(prevN) + frame + "\n"` (see ink/log-update). Over a web terminal
 * (ttyd/xterm through a tunnel) rewriting the whole screen per keystroke is slow
 * and janky. This shim keeps the last frame, diffs the new frame line-by-line,
 * and rewrites ONLY the changed lines using absolute cursor positioning — so
 * typing a character sends one line instead of the whole screen.
 *
 * The frame is anchored at row 1 (Ink's TUI clears + homes before mounting and
 * is kept shorter than the terminal), so line `k` lives at absolute row `k+1`.
 * Cursor visibility is handled by Ink via cli-cursor on stderr, so we leave it
 * alone. Anything that isn't a frame (a bare erase on unmount, stray control) is
 * passed straight through.
 */
export function createDiffStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  let prev: string[] = [];
  let started = false;

  const handle = (chunk: string): void => {
    // Consume the leading run of non-SGR CSI control (eraseLines preamble:
    // \x1b[2K \x1b[1A \x1b[G — and clearTerminal's \x1b[2J/\x1b[3J/\x1b[H).
    let i = 0;
    let reset = false;
    while (i < chunk.length && chunk[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(chunk.slice(i));
      if (!m) break;
      const seq = m[0];
      if (seq[seq.length - 1] === "m") break; // SGR — frame content begins here
      if (seq.includes("2J")) reset = true;
      i += seq.length;
    }
    const body = chunk.slice(i);
    if (body === "") {
      real.write(chunk); // pure control (unmount erase, etc.) — pass through
      return;
    }
    if (reset) {
      prev = [];
      started = false;
    }

    const lines = body.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing "\n" log-update adds

    const parts: string[] = [];
    if (!started) parts.push("\x1b[2J\x1b[H"); // establish the row-1 anchor on the first frame
    const n = Math.max(prev.length, lines.length);
    for (let k = 0; k < n; k++) {
      const nl = lines[k];
      if (nl === undefined) {
        parts.push(`\x1b[${k + 1};1H\x1b[2K`); // line removed — clear it
      } else if (!started || nl !== prev[k]) {
        parts.push(`\x1b[${k + 1};1H\x1b[2K${nl}`); // changed — rewrite just this line
      }
    }
    // Park the (hidden) cursor just below the frame.
    parts.push(`\x1b[${lines.length + 1};1H`);
    prev = lines;
    started = true;
    if (parts.length > 0) real.write(parts.join(""));
  };

  const shim = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      try {
        handle(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      } catch {
        try {
          real.write(chunk);
        } catch {
          /* ignore */
        }
      }
      cb();
    },
  }) as unknown as NodeJS.WriteStream;

  // Ink reads these off the stdout it's given.
  Object.defineProperty(shim, "columns", { get: () => real.columns });
  Object.defineProperty(shim, "rows", { get: () => real.rows });
  Object.defineProperty(shim, "isTTY", { get: () => true });

  // Ink subscribes to "resize" on this stdout — forward to the real one.
  const rawOn = shim.on.bind(shim);
  (shim as unknown as { on: NodeJS.WriteStream["on"] }).on = (event: string, listener: (...a: unknown[]) => void) => {
    if (event === "resize") real.on("resize", listener);
    return rawOn(event, listener as never);
  };
  const rawOff = (shim.off ?? shim.removeListener).bind(shim);
  (shim as unknown as { off: NodeJS.WriteStream["off"] }).off = (event: string, listener: (...a: unknown[]) => void) => {
    if (event === "resize") real.off?.("resize", listener);
    return rawOff(event, listener as never);
  };

  return shim;
}
