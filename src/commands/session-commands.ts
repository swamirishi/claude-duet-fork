import type { TerminalUI } from "../ui.js";

export interface CommandContext {
  ui: TerminalUI;
  role: "host" | "guest";
  sessionCode?: string;
  partnerName?: string;
  startTime?: number;
  onLeave: () => void;
  onTrustChange?: (enabled: boolean) => void;
  onKick?: () => void;
  onEffort?: (level: string) => void;
  onShell?: () => void;
  onWatch?: () => void;
  questionText?: string;
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Handle a slash command. Returns true if the input was a recognized command,
 * false if it's not a slash command (should be processed normally).
 */
export function handleSlashCommand(input: string, ctx: CommandContext): boolean {
  if (!input.startsWith("/")) return false;

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "help":
      showHelp(ctx);
      return true;

    case "leave":
    case "quit":
    case "exit":
      ctx.ui.showSystem("Leaving session...");
      ctx.onLeave();
      return true;

    case "status":
      showStatus(ctx);
      return true;

    case "clear":
      // Clear screen but keep background
      process.stdout.write("\x1b[2J\x1b[H");
      return true;

    case "shell":
    case "terminal":
      if (!ctx.onShell) {
        ctx.ui.showSystem("The shared shell isn't enabled for this session.");
        return true;
      }
      // Works everywhere (Ctrl-T is a browser shortcut, so the candidate needs this).
      // Host: opens your private interviewer shell. Guest: your candidate shell.
      ctx.onShell();
      return true;

    case "question":
    case "q":
      if (!ctx.questionText) {
        ctx.ui.showSystem("No interview question was loaded for this session.");
        return true;
      }
      ctx.ui.showSystem("");
      ctx.ui.showSystem("── Interview question ──");
      for (const line of ctx.questionText.split("\n")) ctx.ui.showSystem(line || " ");
      ctx.ui.showSystem("────────────────────────");
      return true;

    case "watch":
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can watch the candidate's shell.");
        return true;
      }
      if (!ctx.onWatch) {
        ctx.ui.showSystem("The shared shell isn't enabled for this session.");
        return true;
      }
      ctx.onWatch();
      return true;

    case "trust":
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can change trust mode.");
        return true;
      }
      ctx.onTrustChange?.(true);
      ctx.ui.showSystem("Switched to trust mode — partner prompts execute without approval.");
      return true;

    case "approval":
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can change approval mode.");
        return true;
      }
      ctx.onTrustChange?.(false);
      ctx.ui.showSystem("Switched to approval mode — you'll review partner prompts.");
      return true;

    case "effort": {
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can change Claude's effort.");
        return true;
      }
      const level = parts[1]?.toLowerCase();
      if (!level || !EFFORT_LEVELS.includes(level)) {
        ctx.ui.showSystem(`Usage: /effort <${EFFORT_LEVELS.join("|")}>  (lower = faster turns)`);
        return true;
      }
      ctx.onEffort?.(level);
      return true;
    }

    case "kick":
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can kick a guest.");
        return true;
      }
      if (!ctx.partnerName) {
        ctx.ui.showSystem("No guest connected.");
        return true;
      }
      ctx.ui.showSystem(`Disconnecting ${ctx.partnerName}...`);
      ctx.onKick?.();
      return true;

    default:
      ctx.ui.showSystem(`Unknown command: /${cmd}. Type /help for available commands.`);
      return true;
  }
}

function showHelp(ctx: CommandContext): void {
  const ui = ctx.ui;
  ui.showSystem("");
  ui.showSystem("Available commands:");
  ui.showSystem("  /help        — Show this help");
  ui.showSystem("  /status      — Show session info");
  ui.showSystem("  /clear       — Clear the terminal");
  if (ctx.questionText) {
    ui.showSystem("  /question    — Print the full interview question");
  }
  if (ctx.onShell) {
    ui.showSystem(
      ctx.role === "host"
        ? "  /shell       — Open YOUR private shell (Ctrl-T; Ctrl-\\ to return)"
        : "  /shell       — Open the shell (Ctrl-\\ to return; type to request control)",
    );
  }
  if (ctx.onWatch) {
    ui.showSystem("  /watch       — Watch the candidate's shell, read-only");
  }
  ui.showSystem("  /leave       — Leave the session");
  if (ctx.role === "host") {
    ui.showSystem("");
    ui.showSystem("Host commands:");
    ui.showSystem("  /trust       — Disable approval (trust partner)");
    ui.showSystem("  /approval    — Enable approval mode");
    ui.showSystem("  /effort <level> — Set Claude effort (low|medium|high|xhigh|max)");
    ui.showSystem("  /kick        — Disconnect the guest");
  }
  ui.showSystem("");
  ui.showSystem("Message prefixes:");
  ui.showSystem("  @claude <msg>  — Send prompt to Claude");
  ui.showSystem("  (no prefix)    — Chat with your partner");
  ui.showSystem("");
}

function showStatus(ctx: CommandContext): void {
  const ui = ctx.ui;
  ui.showSystem("");
  ui.showSystem("Session status:");
  if (ctx.sessionCode) {
    ui.showSystem(`  Session: ${ctx.sessionCode}`);
  }
  ui.showSystem(`  Role: ${ctx.role}`);
  if (ctx.partnerName) {
    ui.showSystem(`  Partner: ${ctx.partnerName}`);
  } else {
    ui.showSystem("  Partner: (not connected)");
  }
  if (ctx.startTime) {
    const elapsed = Date.now() - ctx.startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSystem(`  Duration: ${minutes}m ${seconds}s`);
  }
  ui.showSystem("");
}
