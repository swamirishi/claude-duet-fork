import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createDiffStdout } from "../ui/diff-stdout.js";

// Simulate ink/log-update's eraseLines preamble for `count` previously-written lines.
function eraseLines(count: number): string {
  if (!count) return "";
  let s = "";
  for (let i = 0; i < count; i++) s += "\x1b[2K" + (i < count - 1 ? "\x1b[1A" : "");
  return s + "\x1b[G";
}
const stripSGR = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// A tiny screen model that applies exactly the control the differ emits
// (CUP, erase-line, erase-screen) so we can compare the resulting screen.
function makeScreen(rows: number, cols: number) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let r = 0, c = 0;
  const apply = (raw: string) => {
    const data = stripSGR(raw);
    let i = 0;
    while (i < data.length) {
      const m = data[i] === "\x1b" ? /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i)) : null;
      if (m) {
        const p = m[1], f = m[2];
        if (f === "H") { const a = p ? p.split(";").map(Number) : [1, 1]; r = (a[0] || 1) - 1; c = (a[1] || 1) - 1; }
        else if (f === "J") { if (p === "2" || p === "3") for (const row of grid) row.fill(" "); }
        else if (f === "K") { if (p === "" || p === "0") for (let x = c; x < cols; x++) grid[r][x] = " "; else if (p === "2") grid[r].fill(" "); }
        else if (f === "G") { c = 0; }
        i += m[0].length;
        continue;
      }
      const ch = data[i++];
      if (ch === "\n") { r++; c = 0; }
      else if (ch === "\r") { c = 0; }
      else if (r < rows && c < cols) { grid[r][c] = ch; c++; }
    }
  };
  const text = () => grid.map((row) => row.join("").replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
  return { apply, text };
}

// Build the "intended" screen by placing each frame line at its row.
function expectedScreen(lines: string[], rows: number, cols: number): string {
  const s = makeScreen(rows, cols);
  s.apply("\x1b[2J\x1b[H");
  lines.forEach((l, k) => s.apply(`\x1b[${k + 1};1H\x1b[2K` + l));
  return s.text();
}

describe("diff-stdout (line-diff renderer)", () => {
  it("reproduces the exact screen and rewrites only changed lines", () => {
    const captured: string[] = [];
    const real = new Writable({ write(ch, _e, cb) { captured.push(ch.toString()); cb(); } }) as unknown as NodeJS.WriteStream;
    Object.defineProperty(real, "columns", { get: () => 40 });
    Object.defineProperty(real, "rows", { get: () => 6 });
    const diff = createDiffStdout(real);
    const screen = makeScreen(6, 40);

    const f1 = ["\x1b[1mAda\x1b[0m: hi", "the answer is 42", "", "> "];
    const f2 = ["\x1b[1mAda\x1b[0m: hi", "the answer is 42", "", "> h"]; // only last line changes

    // Ink writes eraseLines(prevN) + frame + "\n"
    diff.write(eraseLines(0) + f1.join("\n") + "\n");
    captured.length = 0; // isolate the keystroke render
    diff.write(eraseLines(f1.length + 1) + f2.join("\n") + "\n");

    const keyOut = captured.join("");
    // replay the full history (both writes) into a screen model
    const all: string[] = [];
    const real2 = new Writable({ write(ch, _e, cb) { all.push(ch.toString()); cb(); } }) as unknown as NodeJS.WriteStream;
    Object.defineProperty(real2, "columns", { get: () => 40 });
    Object.defineProperty(real2, "rows", { get: () => 6 });
    const diff2 = createDiffStdout(real2);
    diff2.write(eraseLines(0) + f1.join("\n") + "\n");
    diff2.write(eraseLines(f1.length + 1) + f2.join("\n") + "\n");
    const s2 = makeScreen(6, 40);
    all.forEach((c) => s2.apply(c));

    // 1. the rendered screen equals the intended frame
    expect(s2.text()).toBe(expectedScreen(f2, 6, 40));
    // 2. the keystroke render touched ONLY the changed line (row 4), not rows 1–3
    expect(keyOut).toContain("\x1b[4;1H");
    expect(keyOut).not.toContain("\x1b[1;1H");
    expect(keyOut).not.toContain("\x1b[2;1H");
    expect(keyOut).not.toContain("\x1b[3;1H");
    // 3. it stayed small (one line, not the whole frame)
    expect(keyOut.length).toBeLessThan(80);
  });

  it("clears lines that disappear when the frame shrinks", () => {
    const out: string[] = [];
    const real = new Writable({ write(ch, _e, cb) { out.push(ch.toString()); cb(); } }) as unknown as NodeJS.WriteStream;
    Object.defineProperty(real, "columns", { get: () => 40 });
    Object.defineProperty(real, "rows", { get: () => 6 });
    const diff = createDiffStdout(real);
    const screen = makeScreen(6, 40);
    diff.write(eraseLines(0) + ["a", "b", "c"].join("\n") + "\n");
    diff.write(eraseLines(4) + ["a"].join("\n") + "\n"); // b, c disappear
    out.forEach((c) => screen.apply(c));
    expect(screen.text()).toBe("a");
  });
});
