import { EventEmitter } from "node:events";
import * as pty from "node-pty";

export interface PtyShellOptions {
  cwd: string;                       // working directory (the sandbox / project root)
  shell?: string;                    // shell binary; default $SHELL or "bash"
  cols?: number;                     // initial columns; default 80
  rows?: number;                     // initial rows; default 24
  env?: NodeJS.ProcessEnv;           // environment; default process.env
  bufferBytes?: number;              // rolling replay buffer cap; default 64 KiB
}

/**
 * A single long-lived pseudo-terminal running an interactive shell. The host
 * owns one of these; its raw output is streamed to every attached client and
 * kept in a rolling buffer so a client that attaches late gets a snapshot to
 * repaint from. This class knows nothing about the network — the host wires its
 * "data"/"exit" events to the transport and feeds `write`/`resize` from clients.
 *
 * Events:
 *   "data" (chunk: string)  raw PTY output (UTF-8, control sequences intact)
 *   "exit" ({ exitCode, signal })
 */
export class PtyShellSession extends EventEmitter {
  private proc: pty.IPty;
  private readonly bufferCap: number;
  private buffer = "";
  private disposed = false;

  constructor(options: PtyShellOptions) {
    super();
    this.setMaxListeners(0);

    if (!options.cwd) throw new Error("PtyShellSession requires a cwd");
    const shell = options.shell || process.env.SHELL || "bash";
    const cols = options.cols && options.cols > 0 ? options.cols : 80;
    const rows = options.rows && options.rows > 0 ? options.rows : 24;
    this.bufferCap = options.bufferBytes && options.bufferBytes > 0 ? options.bufferBytes : 64 * 1024;

    this.proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols,
      rows,
      env: { ...(options.env ?? process.env), TERM: "xterm-256color" } as { [key: string]: string },
    });

    this.proc.onData((chunk) => {
      this.appendBuffer(chunk);
      this.emit("data", chunk);
    });
    this.proc.onExit(({ exitCode, signal }) => {
      this.emit("exit", { exitCode, signal });
    });
  }

  /** Feed raw input bytes (keystrokes) to the shell. */
  write(data: string): void {
    if (!this.disposed) this.proc.write(data);
  }

  /** Resize the PTY to the controlling terminal's dimensions. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols > 0 && rows > 0) {
      try {
        this.proc.resize(cols, rows);
      } catch {
        // The PTY may have exited between the check and the call — ignore.
      }
    }
  }

  /** Recent output, for repainting a client that attaches after startup. */
  snapshot(): string {
    return this.buffer;
  }

  /** Kill the shell and release the PTY. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }

  private appendBuffer(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.bufferCap) {
      this.buffer = this.buffer.slice(this.buffer.length - this.bufferCap);
    }
  }
}

export function newPtyShellSession(options: PtyShellOptions): PtyShellSession {
  return new PtyShellSession(options);
}
