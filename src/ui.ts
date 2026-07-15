import pc from "picocolors";
import { createElement } from "react";
import { render, type Instance } from "ink";
import { App } from "./ui/App.js";
import { UiStore } from "./ui/store.js";
import type { FsNode } from "./protocol.js";

interface TerminalUIOptions {
  userName: string;
  role: "host" | "guest";
}

/**
 * Terminal UI backed by an Ink render tree. Pre-session output (welcome banner,
 * connection status, the P2P answer-code prompt) is plain console output; once
 * `startInputLoop()` mounts Ink, all subsequent output routes through a reactive
 * store that drives the split-pane layout (chat + filesystem panel).
 */
export class TerminalUI {
  private options: TerminalUIOptions;
  private store: UiStore;
  private ink?: Instance;

  private inputHandler?: (text: string) => void;
  private keystrokeHandler?: () => void;
  private approvalHandler?: (promptId: string, approved: boolean) => void;
  private openFileHandler?: (relPath: string) => void;

  constructor(options: TerminalUIOptions) {
    this.options = options;
    this.store = new UiStore(options.role, options.userName);
  }

  private get mounted(): boolean {
    return !!this.ink;
  }

  /** Test/introspection accessor for the current UI state. */
  getState() {
    return this.store.state;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.store.state.messages.length}-${Date.now() % 100000}`;
  }

  // ---- Handler registration (called by host.ts / join.ts) ----

  onInput(handler: (text: string) => void): void {
    this.inputHandler = handler;
  }

  onKeystroke(handler: () => void): void {
    this.keystrokeHandler = handler;
  }

  onApproval(handler: (promptId: string, approved: boolean) => void): void {
    this.approvalHandler = handler;
  }

  onOpenFile(handler: (relPath: string) => void): void {
    this.openFileHandler = handler;
  }

  // ---- Lifecycle ----

  startInputLoop(): void {
    if (this.ink) return;
    this.ink = render(
      createElement(App, {
        store: this.store,
        onInput: (text: string) => this.inputHandler?.(text),
        onKeystroke: () => this.keystrokeHandler?.(),
        onApproval: (id: string, ok: boolean) => {
          this.store.set({ approval: undefined });
          this.approvalHandler?.(id, ok);
        },
        onOpenFile: (rel: string) => this.openFileHandler?.(rel),
        onQuit: () => {
          try {
            process.kill(process.pid, "SIGINT");
          } catch {
            process.exit(0);
          }
        },
      }),
      { exitOnCtrlC: false },
    );
  }

  applySessionBackground(): void {
    // Clear the scrollback so the session starts on a clean screen. (The Ink
    // frame mounts on startInputLoop; a persistent tint would fight it, so we
    // just clear rather than recolor.)
    if (!this.mounted) process.stdout.write("\x1b[2J\x1b[H");
  }

  close(): void {
    this.ink?.unmount();
    this.ink = undefined;
  }

  // ---- Test helpers ----

  simulateInput(text: string): void {
    this.inputHandler?.(text);
  }

  simulateApproval(promptId: string, approved: boolean): void {
    this.approvalHandler?.(promptId, approved);
  }

  // ---- Filesystem panel ----

  // Set the display names for the two participants (used by the guest, which
  // otherwise wouldn't know the host's name or show its own).
  setParticipants(host?: string, guest?: string): void {
    const patch: Record<string, unknown> = {};
    if (host) patch.hostUser = host;
    if (guest) patch.guestUser = guest;
    this.store.set(patch);
  }

  // Pin a browser (ttyd) link in the host banner so the interviewer can hand it
  // to the candidate. Set when a browser bridge is serving the join client.
  setWebLink(url?: string): void {
    this.store.set({ webLink: url });
  }

  // The basic-auth username for the browser link (the candidate's name).
  setWebUser(user?: string): void {
    this.store.set({ webUser: user });
  }

  setFsRoot(root: string): void {
    this.store.set({ fsRoot: root });
  }

  setFsTree(tree: FsNode): void {
    const patch: Partial<typeof this.store.state> = { fsTree: tree };
    // Default the selection to the first entry so the panel isn't empty.
    if (!this.store.state.fsSelected && tree.children && tree.children.length > 0) {
      patch.fsSelected = tree.children[0].path;
    }
    this.store.set(patch);
  }

  setFileContent(path: string, content: string, truncated: boolean, error?: string): void {
    this.store.set({
      fsFilePath: path,
      fsFileContent: error ? undefined : content,
      fsFileTruncated: truncated,
      fsFileError: error,
      fsViewOffset: 0,
    });
  }

  // ---- Welcome / setup-phase output (pre-mount, plain console) ----

  showWelcome(sessionCode: string, password: string, connectUrl?: string, joinCmd?: string): void {
    // Pin the join info so it stays visible in the TUI (not just this one-time banner).
    this.store.set({ sessionCode, password, joinUrl: connectUrl });
    this.applySessionBackground();
    const violet = (s: string) => pc.magenta(s);
    const dim = (s: string) => pc.dim(s);
    const bar = violet("  │");

    console.log("");
    console.log(violet("  ┌" + "─".repeat(45) + "┐"));
    console.log(`${bar}  ${pc.bold(pc.cyan("✦"))} ${pc.bold(pc.white("claude-duet"))} ${dim("session started")}${" ".repeat(13)}${violet("│")}`);
    console.log(violet("  └" + "─".repeat(45) + "┘"));
    console.log("");

    if (joinCmd) {
      console.log(`  ${dim("Send your partner this command to join:")}`);
      console.log("");
      console.log(`  ${pc.green("▶")} ${pc.bold(pc.green(joinCmd))}`);
    } else if (connectUrl) {
      const cmd = `npx claude-duet join ${sessionCode} --password ${password} --url ${connectUrl}`;
      console.log(`  ${dim("Send your partner this command to join:")}`);
      console.log("");
      console.log(`  ${pc.green("▶")} ${pc.bold(pc.green(cmd))}`);
    } else {
      console.log(`  ${pc.cyan("●")} Session code  ${pc.bold(pc.white(sessionCode))}`);
      console.log(`  ${pc.cyan("●")} Password      ${pc.bold(pc.white(password))}`);
      console.log("");
      console.log(`  ${dim("Share these with your partner to join.")}`);
    }
    console.log("");
    console.log(dim("  " + "─".repeat(45)));
    console.log("");
  }

  // ---- Output (routes to the store once mounted; console before that) ----

  showSystem(message: string): void {
    this.store.addMessage({ id: this.nextId("sys"), type: "system", text: message, timestamp: 0 });
    if (!this.mounted) console.log(pc.dim(`  ${message}`)); // visible during connection setup
  }

  showError(message: string): void {
    this.store.addMessage({ id: this.nextId("err"), type: "error", text: message, timestamp: 0 });
    if (!this.mounted) console.error(pc.red(`  Error: ${message}`));
  }

  showHint(text: string): void {
    this.store.set({ hint: text });
  }

  showUserPrompt(user: string, text: string, role: "host" | "guest", _mode: "chat" | "claude" = "chat"): void {
    this.store.endStream();
    this.store.addMessage({
      id: this.nextId("prompt"),
      type: "prompt",
      user,
      isHost: role === "host",
      text,
      timestamp: 0,
    });
  }

  showClaudeThinking(): void {
    this.store.set({ claudeProcessing: true });
  }

  showStreamChunk(text: string): void {
    if (this.store.state.claudeProcessing) this.store.set({ claudeProcessing: false });
    this.store.appendStream(text);
  }

  showToolUse(tool: string, input: Record<string, unknown>): void {
    this.store.endStream();
    this.store.addMessage({ id: this.nextId("tool"), type: "tool", text: tool, timestamp: 0 });
    // Mirror activity into the terminal pane: Bash as a shell command, others as a tagged line.
    if (tool.toLowerCase() === "bash" && typeof input.command === "string") {
      this.store.addTerminal([`$ ${input.command as string}`]);
    } else {
      const detail = (input.file_path || input.path || input.pattern || input.query || "") as string;
      this.store.addTerminal([`[${tool}]${detail ? " " + detail : ""}`]);
    }
  }

  showToolResult(tool: string, output: string): void {
    this.store.endStream();
    const trimmed = output.length > 120 ? output.slice(0, 117) + "…" : output;
    this.store.addMessage({ id: this.nextId("toolres"), type: "tool", text: `${tool}: ${trimmed}`, timestamp: 0 });
    const lines = String(output).replace(/\s+$/, "").split("\n").slice(0, 300);
    this.store.addTerminal(lines);
  }

  showTurnComplete(cost: number, durationMs: number): void {
    this.store.endStream();
    this.store.set({ cost, claudeProcessing: false });
    this.store.addMessage({
      id: this.nextId("turn"),
      type: "system",
      text: `✦ $${cost.toFixed(4)} · ${(durationMs / 1000).toFixed(1)}s`,
      timestamp: 0,
    });
  }

  showPartnerJoined(user: string): void {
    this.store.set({ guestUser: this.options.role === "host" ? user : this.store.state.guestUser });
    this.store.addMessage({ id: this.nextId("evt"), type: "session_event", text: `${user} joined the session`, timestamp: 0 });
  }

  showPartnerLeft(user: string): void {
    if (this.options.role === "host") this.store.set({ guestUser: undefined });
    this.store.addMessage({ id: this.nextId("evt"), type: "session_event", text: `${user} left the session`, timestamp: 0 });
  }

  showApprovalRequest(promptId: string, user: string, text: string): void {
    this.store.set({ approval: { promptId, user, text } });
  }

  showApprovalStatus(status: "pending" | "approved" | "rejected"): void {
    if (status !== "pending") this.store.set({ approval: undefined });
    this.store.addMessage({ id: this.nextId("appr"), type: "system", text: `Prompt ${status}.`, timestamp: 0 });
  }

  showTypingIndicator(user: string, isTyping: boolean): void {
    this.store.set({ typingUser: isTyping ? user : undefined });
  }

  clearTypingIndicator(): void {
    this.store.set({ typingUser: undefined });
  }

  showSessionSummary(summary: { duration: string; messageCount: number; cost?: number }): void {
    this.close();
    console.log("");
    console.log(pc.dim("  " + "─".repeat(45)));
    console.log(`  ${pc.bold(pc.cyan("✦"))} ${pc.bold("Session ended")}`);
    console.log(pc.dim(`  Duration: ${summary.duration}   Messages: ${summary.messageCount}${summary.cost !== undefined ? `   Cost: $${summary.cost.toFixed(4)}` : ""}`));
    console.log("");
  }
}
