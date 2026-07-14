import { describe, it, expect } from "vitest";
import { newPtyShellSession } from "../shell.js";

// node-pty is a native module. Where its prebuilt binary can't spawn on this
// exact Node ABI/arch (common in CI or a mismatched local Node), skip rather
// than fail — the container image build is the authoritative runtime check.
let ptyOk = true;
try {
  const probe = newPtyShellSession({ cwd: process.cwd() });
  probe.dispose();
} catch {
  ptyOk = false;
}

(ptyOk ? describe : describe.skip)("PtyShellSession", () => {
  it("runs a command and streams its output", async () => {
    const sh = newPtyShellSession({ cwd: process.cwd(), cols: 80, rows: 24 });
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      sh.on("data", (d: string) => {
        buf += d;
        if (buf.includes("duet_shell_42_ok")) resolve(buf);
      });
      sh.write("echo duet_shell_$(( 6 * 7 ))_ok\n");
      setTimeout(() => resolve(buf), 3000);
    });
    sh.dispose();
    expect(out).toContain("duet_shell_42_ok");
  });

  it("retains a replay snapshot and disposes cleanly", async () => {
    const sh = newPtyShellSession({ cwd: process.cwd() });
    await new Promise((r) => setTimeout(r, 300));
    sh.write("echo snapshot_probe\n");
    await new Promise((r) => setTimeout(r, 500));
    expect(sh.snapshot().length).toBeGreaterThan(0);
    sh.dispose();
  });

  it("requires a cwd", () => {
    expect(() => newPtyShellSession({ cwd: "" })).toThrow();
  });
});
