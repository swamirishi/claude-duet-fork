import { ClaudeDuetClient } from "../client.js";
import { TerminalUI } from "../ui.js";
import { handleSlashCommand, type CommandContext } from "./session-commands.js";
import { createAnswer } from "../peer.js";
import { decodeSDP } from "../sdp-codec.js";
import { copyToClipboard } from "../clipboard.js";

interface JoinOptions {
  name: string;
  password?: string;
  url?: string;
}

export async function joinCommand(sessionCodeOrOffer: string, options: JoinOptions): Promise<void> {
  const ui = new TerminalUI({ userName: options.name, role: "guest" });

  const client = new ClaudeDuetClient();
  let result: Awaited<ReturnType<typeof client.connect>>;
  let peerCleanup: (() => void) | undefined;

  // Detect if the argument is an offer code (base64url) or a session code (cd-xxx)
  const isOfferCode = !sessionCodeOrOffer.startsWith("cd-");

  if (isOfferCode) {
    // P2P mode — decode offer code and create answer
    if (!options.password) {
      ui.showError("--password is required");
      process.exit(1);
    }

    ui.showSystem("Decoding offer code...");

    let sessionCode: string;
    try {
      const decoded = decodeSDP(sessionCodeOrOffer);
      sessionCode = decoded.sessionCode;
    } catch {
      ui.showError("Invalid offer code. Check that you copied it correctly.");
      process.exit(1);
    }

    ui.showSystem("Creating P2P answer...");

    try {
      const answer = await createAnswer(sessionCodeOrOffer);
      peerCleanup = answer.cleanup;

      console.log("");
      console.log(`  Send this answer code to your partner:`);
      console.log("");
      console.log(`  ${answer.answerCode}`);
      console.log("");

      if (copyToClipboard(answer.answerCode)) {
        ui.showSystem("Copied answer code to clipboard!");
      }

      ui.showSystem("Waiting for P2P connection...");

      const transport = await Promise.race([
        answer.transport,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("P2P connection timed out (30s)")), 30000),
        ),
      ]);

      ui.showSystem("P2P connected! Joining session...");

      result = await client.connectTransport(
        transport,
        options.name,
        options.password,
        sessionCode,
      );
    } catch (err) {
      ui.showError(`P2P connection failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    // WebSocket mode — classic session code + URL
    if (!options.password) {
      ui.showError("--password is required");
      process.exit(1);
    }

    const serverUrl = options.url || await resolveSessionUrl(sessionCodeOrOffer);

    ui.showSystem(`Connecting to ${serverUrl}...`);

    try {
      result = await client.connect(serverUrl, options.name, options.password, sessionCodeOrOffer);
    } catch (err) {
      ui.showError(`Failed to join: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  ui.applySessionBackground();
  // Show both people by name in the status bar (host name from the join result,
  // guest name = this candidate).
  ui.setParticipants(result.hostUser, options.name);
  ui.showSystem(`Connected! You're in a duet session with ${result.hostUser}.`);
  if (result.approvalMode) {
    ui.showSystem("Approval mode is ON — host will review your prompts.");
  }
  if (result.shellEnabled) {
    ui.setShellEnabled(true);
    ui.showSystem("Shared shell: type /shell to open it (in a browser use /shell, not Ctrl-T). Then just type to request control.");
  }
  console.log("");
  ui.startInputLoop();
  ui.showHint(
    `chat · @claude <prompt> · Tab: chat/tree/viewer · ↑↓ scroll${result.shellEnabled ? " · Ctrl-T or /shell: shell" : ""} · /help`,
  );

  let messageCount = 0;
  const sessionStartTime = Date.now();
  let hasShellControl = false;
  let controlRequested = false;

  // Ask the host for shell control (once until answered). Called explicitly via
  // Ctrl-] and implicitly when a read-only guest starts typing.
  const requestShellControl = () => {
    if (hasShellControl || controlRequested) return;
    controlRequested = true;
    try {
      client.sendShellControlRequest();
      ui.writeShell("\r\n\x1b[33m[you don't have control yet — asking the host…]\x1b[0m\r\n");
    } catch {
      controlRequested = false; // not connected — let them retry
    }
  };

  const cmdCtx: CommandContext = {
    ui,
    role: "guest",
    partnerName: result.hostUser,
    startTime: sessionStartTime,
    onShell: result.shellEnabled ? () => openShell() : undefined,
    onLeave: async () => {
      const elapsed = Date.now() - sessionStartTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      ui.showSessionSummary({
        duration: `${minutes}m ${seconds}s`,
        messageCount,
      });
      peerCleanup?.();
      await client.disconnect();
      ui.close();
      process.exit(0);
    },
  };

  client.on("message", (msg) => {
    switch (msg.type) {
      case "history_replay": {
        const replay = msg as any;
        ui.showSystem(`Catching up on ${replay.messages.length} messages...`);
        for (const histMsg of replay.messages) {
          if (histMsg.role === "user") {
            const isHostMsg = histMsg.user?.includes("(host)") || histMsg.user === result.hostUser;
            ui.showUserPrompt(histMsg.user || "user", histMsg.text, isHostMsg ? "host" : "guest", "claude");
          } else if (histMsg.role === "assistant") {
            ui.showStreamChunk(histMsg.text);
          } else if (histMsg.role === "tool") {
            ui.showSystem(`  [${histMsg.toolName || "tool"}] ${histMsg.text.slice(0, 100)}`);
          }
        }
        ui.showSystem("Caught up! You're live.");
        break;
      }
      case "chat_received":
        // Skip own chat messages (already shown locally) — use source field to avoid same-name collisions
        if (msg.source === "guest") break;
        ui.showUserPrompt(msg.user, msg.text, msg.source === "host" ? "host" : "guest", "chat");
        break;
      case "prompt_received":
        // Skip own messages (already shown locally when typed) — use source field
        if (msg.source === "guest") break;
        ui.showUserPrompt(msg.user, msg.text, msg.source === "host" ? "host" : "guest", "claude");
        break;
      case "approval_status":
        ui.showApprovalStatus((msg as any).status);
        break;
      case "stream_chunk":
        ui.showStreamChunk(msg.text);
        break;
      case "tool_use":
        ui.showToolUse(msg.tool, msg.input);
        break;
      case "tool_result":
        ui.showToolResult(msg.tool, msg.output);
        break;
      case "turn_complete":
        ui.showTurnComplete(msg.cost, msg.durationMs);
        break;
      case "typing_indicator":
        if ((msg as any).user !== options.name) {
          ui.showTypingIndicator((msg as any).user, (msg as any).isTyping);
        }
        break;
      case "notice":
        ui.showSystem(msg.message);
        break;
      case "error":
        ui.showError(msg.message);
        break;
      case "fs_tree":
        ui.setFsRoot((msg as any).root);
        ui.setFsTree((msg as any).tree);
        break;
      case "fs_file":
        ui.setFileContent((msg as any).path, (msg as any).content, (msg as any).truncated, (msg as any).error);
        break;
      case "shell_data":
        ui.writeShell((msg as any).data);
        break;
      case "question":
        ui.setQuestion((msg as any).text);
        cmdCtx.questionText = (msg as any).text;
        break;
      case "ide":
        ui.setIdeLink((msg as any).url);
        cmdCtx.ideLink = (msg as any).url;
        break;
      case "shell_control_grant":
        hasShellControl = (msg as any).granted === true;
        controlRequested = false; // answered — allow future requests
        if (ui.isShellActive()) {
          ui.writeShell(
            hasShellControl
              ? "\r\n\x1b[32m[you have control — type freely; Ctrl-\\ to release]\x1b[0m\r\n"
              : "\r\n\x1b[33m[control is with the host — press Ctrl-] or type to request]\x1b[0m\r\n",
          );
        }
        break;
    }
  });

  // Open the shared shell. Triggered by Ctrl-T (host terminals) and by the
  // /shell command (the reliable path in a browser, where Ctrl-T opens a tab).
  // The guest watches read-only until granted control; typing requests it.
  const openShell = () => {
    if (ui.isShellActive()) return;
    hasShellControl = false;
    controlRequested = false;
    const size = ui.terminalSize();
    ui.enterShell({
      readOnly: false, // gated locally by hasShellControl below
      header: "watching · type (or Ctrl-]) to request control",
      onData: (data) => {
        if (hasShellControl) {
          try {
            client.sendShellInput(data);
          } catch {
            /* not connected — ignore */
          }
          return;
        }
        // Read-only: typing implicitly asks for control instead of vanishing.
        requestShellControl();
      },
      onControlKey: () => requestShellControl(),
      onDetach: () => {
        hasShellControl = false;
        try {
          client.sendShellDetach();
        } catch {
          /* not connected — ignore */
        }
        ui.exitShell();
      },
      onResize: (cols, rows) => {
        try {
          client.sendShellResize(cols, rows);
        } catch {
          /* ignore */
        }
      },
    });
    try {
      client.sendShellAttach(size.cols, size.rows);
    } catch {
      /* not connected — ignore */
    }
  };
  ui.onShellEnter(openShell);

  // Opening a file from the shared tree asks the host to serve its contents.
  ui.onOpenFile((rel) => {
    try {
      client.sendFsOpen(rel);
    } catch {
      /* not connected — ignore */
    }
  });

  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let isTyping = false;

  ui.onKeystroke(() => {
    if (!isTyping) {
      isTyping = true;
      client.sendTyping(true);
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTyping = false;
      client.sendTyping(false);
    }, 2000);
  });

  ui.onInput((text) => {
    if (typingTimeout) clearTimeout(typingTimeout);
    if (isTyping) {
      isTyping = false;
      client.sendTyping(false);
    }

    messageCount++;

    // Slash commands
    if (handleSlashCommand(text, cmdCtx)) return;

    if (text.toLowerCase().startsWith("@claude ")) {
      // Claude prompt — send to host via sendPrompt
      const prompt = text.slice(8);
      ui.showUserPrompt(options.name, prompt, "guest", "claude");
      client.sendPrompt(prompt);
    } else {
      // Chat message
      ui.showUserPrompt(options.name, text, "guest", "chat");
      client.sendChat(text);
    }
  });

  client.on("disconnected", () => {
    const elapsed = Date.now() - sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSessionSummary({
      duration: `${minutes}m ${seconds}s`,
      messageCount,
    });
    ui.showSystem("The host has ended the session.");
    ui.showHint("Tip: Resume this Claude Code session solo with: claude --continue");
    peerCleanup?.();
    ui.close();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    const elapsed = Date.now() - sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSessionSummary({
      duration: `${minutes}m ${seconds}s`,
      messageCount,
    });
    peerCleanup?.();
    await client.disconnect();
    ui.close();
    process.exit(0);
  });
}

async function resolveSessionUrl(sessionCode: string): Promise<string> {
  throw new Error(
    `Session discovery not available — use --url to connect directly.\n` +
    `  Ask the host for the join command, or run:\n` +
    `  claude-duet join ${sessionCode} --password <password> --url ws://<host-ip>:<port>`
  );
}
