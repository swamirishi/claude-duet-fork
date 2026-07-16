import { ClaudeDuetServer } from "../server.js";
import { ClaudeBridge, type PermissionMode } from "../claude.js";
import { PromptRouter } from "../router.js";
import { TerminalUI } from "../ui.js";
import { getLocalIP, formatConnectionInfo, startCloudflareTunnel, startLocaltunnel, type ConnectionInfo } from "../connection.js";
import { SessionManager } from "../session.js";
import { handleSlashCommand, type CommandContext } from "./session-commands.js";
import { parseSessionHistory, getProjectSessionDir } from "../history.js";
import { createOffer } from "../peer.js";
import { copyToClipboard } from "../clipboard.js";
import { FsWatcher } from "../fswatch.js";
import { newPtyShellSession, type PtyShellSession } from "../shell.js";
import type { FsNode } from "../protocol.js";
import { join } from "node:path";
import { createWriteStream, type WriteStream } from "node:fs";
import * as readline from "node:readline";

interface HostOptions {
  name: string;
  noApproval: boolean;
  tunnel?: "localtunnel" | "cloudflare";
  relay?: string;
  port: number;
  continueSession?: boolean;
  resumeSession?: string;
  permissionMode?: PermissionMode;
  effort?: string;
  webLink?: string;
  webUser?: string;
  approveLink?: string;
  allowShell?: boolean;
  runAsUid?: number;   // sandbox Claude + the candidate shell as this uid
  runAsGid?: number;
  recordFile?: string; // append the full transcript (prompts/responses/tools) here
  interviewerUid?: number; // the interviewer's private shell runs as this uid (default: host's)
  interviewerGid?: number;
  interviewerHome?: string; // HOME for the interviewer's private shell
  interviewerRoot?: string; // extra dir shown ONLY in the host's file tree (e.g. /records)
  question?: string;        // interview question (markdown) shown in the pinned box
}

export async function hostCommand(options: HostOptions): Promise<void> {
  const sessionManager = new SessionManager();
  const session = sessionManager.create(options.name);
  const approvalMode = !options.noApproval;

  const ui = new TerminalUI({ userName: options.name, role: "host" });

  // Append-only transcript recorder. The host process (privileged) writes it to
  // a directory the candidate has no access to, so it can't be read or tampered.
  let recordStream: WriteStream | undefined;
  if (options.recordFile) {
    try {
      recordStream = createWriteStream(options.recordFile, { flags: "a" });
    } catch {
      /* recording is best-effort — never block the session on it */
    }
  }
  const record = (entry: Record<string, unknown>) => {
    if (recordStream) recordStream.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  };

  if (options.webLink) ui.setWebLink(options.webLink);
  if (options.webUser) ui.setWebUser(options.webUser);
  if (options.approveLink) ui.setApproveLink(options.approveLink);
  if (options.question) ui.setQuestion(options.question);

  // Create server first so event handler can reference it
  const server = new ClaudeDuetServer({
    hostUser: options.name,
    password: session.password,
    sessionCode: session.code,
    approvalMode,
    shellEnabled: options.allowShell || false,
  });

  const claude = new ClaudeBridge({
    continue: options.continueSession,
    resume: options.resumeSession,
    permissionMode: options.permissionMode ?? "auto",
    effort: options.effort,
    uid: options.runAsUid,
    gid: options.runAsGid,
  });

  // Register event handler BEFORE start() to catch early errors
  claude.on("event", (event) => {
    switch (event.type) {
      case "stream_chunk":
        ui.showStreamChunk(event.text);
        server.broadcast({ ...event, timestamp: Date.now() });
        record({ kind: "assistant", text: event.text });
        break;
      case "tool_use":
        ui.showToolUse(event.tool, event.input);
        server.broadcast({ ...event, timestamp: Date.now() });
        record({ kind: "tool_use", tool: event.tool, input: event.input });
        break;
      case "tool_result":
        ui.showToolResult(event.tool, event.output);
        server.broadcast({ ...event, timestamp: Date.now() });
        record({ kind: "tool_result", tool: event.tool, output: event.output });
        break;
      case "turn_complete":
        ui.showTurnComplete(event.cost, event.durationMs);
        server.broadcast({ ...event, timestamp: Date.now() });
        record({ kind: "turn_complete", cost: event.cost, durationMs: event.durationMs });
        break;
      case "notice":
        ui.showSystem(event.message);
        server.broadcast({ type: "notice", message: event.message, timestamp: Date.now() });
        break;
      case "error":
        ui.showError(event.message);
        server.broadcast({ type: "error", message: event.message, timestamp: Date.now() });
        break;
    }
  });

  await claude.start();

  let connInfo: ConnectionInfo | undefined;
  let peerCleanup: (() => void) | undefined;

  // Determine connection mode
  const useTunnel = options.tunnel || options.relay;

  if (useTunnel) {
    // WebSocket mode (tunnel / relay / LAN)
    const port = await server.start(options.port || 0);

    if (options.tunnel === "cloudflare") {
      try {
        ui.showSystem("Starting Cloudflare tunnel...");
        connInfo = await startCloudflareTunnel(port);
        ui.showSystem(`Tunnel ready: ${connInfo.displayUrl}`);
      } catch (err) {
        ui.showError(String(err));
        const localIP = getLocalIP();
        connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
      }
    } else if (options.tunnel === "localtunnel") {
      ui.showSystem("Starting localtunnel...");
      const tunnelInfo = await startLocaltunnel(port);
      if (tunnelInfo) {
        connInfo = tunnelInfo;
        ui.showSystem(`Tunnel ready: ${connInfo.displayUrl}`);
      } else {
        ui.showError("localtunnel failed — falling back to LAN.");
        const localIP = getLocalIP();
        connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
      }
    } else if (options.relay) {
      connInfo = formatConnectionInfo({ mode: "relay", host: options.relay, port: 0 });
      ui.showSystem(`Using relay: ${options.relay}`);
    } else {
      const localIP = getLocalIP();
      connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
    }

    ui.showWelcome(session.code, session.password, connInfo.displayUrl);
  } else {
    // P2P mode (default)
    ui.showSystem("Setting up P2P connection...");

    try {
      const offer = await createOffer(session.code);
      peerCleanup = offer.cleanup;

      const joinCmd = `npx claude-duet join ${offer.offerCode} --password ${session.password}`;
      ui.showWelcome(session.code, session.password, undefined, joinCmd);

      if (copyToClipboard(joinCmd)) {
        ui.showSystem("Copied join command to clipboard!");
      }

      ui.showSystem("Waiting for your partner's answer code...");

      const answerCode = await promptForAnswerCode();

      ui.showSystem("Connecting to partner...");
      offer.acceptAnswer(answerCode);

      const transport = await Promise.race([
        offer.transport,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("P2P connection timed out (30s)")), 30000),
        ),
      ]);

      server.attachTransport(transport);
      ui.showSystem("P2P connection established!");
    } catch (err) {
      ui.showError(`P2P setup failed: ${err instanceof Error ? err.message : err}`);
      ui.showSystem("Falling back to LAN mode...");

      const port = await server.start(options.port || 0);
      const localIP = getLocalIP();
      connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
      ui.showSystem(`LAN server ready on ${connInfo.displayUrl}`);

      const joinCmd = `npx claude-duet join ${session.code} --password ${session.password} --url ${connInfo.displayUrl}`;
      console.log("");
      console.log(`  Send your partner this command to join:`);
      console.log(`  ${joinCmd}`);
      console.log("");
    }
  }

  ui.startInputLoop();
  ui.showHint(
    `chat · @claude <prompt> · Tab: chat/tree/viewer · ↑↓ scroll${options.allowShell ? " · Ctrl-T your shell · /watch candidate" : ""} · /help`,
  );

  // Filesystem panel — watch the project (Claude's working dir), confined to it.
  const fsWatcher = new FsWatcher(process.cwd());
  ui.setFsRoot(fsWatcher.root);
  let latestTree: FsNode | undefined;

  // Per-role views: guests only ever see /workspace (broadcast). The interviewer
  // additionally sees an extra dir (e.g. the protected /records) merged into
  // their OWN tree under a "records/" prefix — never broadcast to guests.
  const REC_PREFIX = "records/";
  const recordsWatcher = options.interviewerRoot ? new FsWatcher(options.interviewerRoot) : undefined;
  let latestRecords: FsNode | undefined;
  const prefixPaths = (nodes: FsNode[] | undefined, prefix: string): FsNode[] =>
    (nodes ?? []).map((n) => ({ ...n, path: prefix + n.path, children: n.children ? prefixPaths(n.children, prefix) : undefined }));
  const renderHostTree = () => {
    if (!recordsWatcher) {
      ui.setFsTree(latestTree ?? { name: "project", path: "", type: "dir", children: [] });
      return;
    }
    const wsChildren = latestTree?.children ?? [];
    const recChildren = prefixPaths(latestRecords?.children, REC_PREFIX);
    ui.setFsTree({
      name: "session",
      path: "",
      type: "dir",
      children: [
        { name: "workspace", path: "__ws", type: "dir", children: wsChildren },
        { name: "records (interviewer only)", path: "__rec", type: "dir", children: recChildren },
      ],
    });
  };

  fsWatcher.on("tree", (tree: FsNode) => {
    latestTree = tree;
    renderHostTree();
    server.broadcast({ type: "fs_tree", root: fsWatcher.root, tree, timestamp: Date.now() });
  });
  fsWatcher.start();
  if (recordsWatcher) {
    recordsWatcher.on("tree", (tree: FsNode) => {
      latestRecords = tree;
      renderHostTree();
    });
    recordsWatcher.start();
  }

  // Host opens a file locally (confined read) — route records/ paths to the
  // records watcher, everything else to the workspace watcher.
  ui.onOpenFile(async (rel) => {
    if (recordsWatcher && rel.startsWith(REC_PREFIX)) {
      const res = await recordsWatcher.readFile(rel.slice(REC_PREFIX.length));
      ui.setFileContent(rel, res.content, res.truncated, res.error);
      return;
    }
    const res = await fsWatcher.readFile(rel);
    ui.setFileContent(rel, res.content, res.truncated, res.error);
  });

  // Guest asked to open a file — serve it (confined read) over the wire.
  server.on("fs_open", async (rel: string) => {
    const res = await fsWatcher.readFile(rel);
    server.broadcast({
      type: "fs_file",
      path: rel,
      content: res.content,
      truncated: res.truncated,
      error: res.error,
      timestamp: Date.now(),
    });
  });

  // Two shells with different views:
  //  • candidateShell — runs as the unprivileged candidate; the candidate drives
  //    it (requesting control, gated by approval) and every guest watches it. The
  //    interviewer can watch it read-only (/watch). Broadcast to guests.
  //  • interviewerShell — the interviewer's OWN shell (Ctrl-T), spawned with the
  //    interviewer's privileges. Private: never broadcast to guests.
  let candidateShell: PtyShellSession | undefined;
  let interviewerShell: PtyShellSession | undefined;
  let resolveShellControl: ((id: string, approved: boolean) => void) | undefined;
  let openInterviewerShell: (() => void) | undefined;  // Ctrl-T / host /shell
  let watchCandidateShell: (() => void) | undefined;    // host /watch
  if (options.allowShell) {
    const hostSize = ui.terminalSize();
    candidateShell = newPtyShellSession({
      cwd: process.cwd(),
      cols: hostSize.cols,
      rows: hostSize.rows,
      uid: options.runAsUid,
      gid: options.runAsGid,
    });
    ui.setShellEnabled(true);

    let controllerId: string | null = null;           // which guest drives the candidate shell
    let hostWatching = false;                          // is the host viewing the candidate shell?
    const pendingControl = new Map<string, string>();  // id -> requesting user (awaiting approval)

    const giveControlToGuest = (id: string, user: string) => {
      controllerId = id;
      const size = server.guestSize(id);
      if (size) candidateShell!.resize(size.cols, size.rows);
      server.setShellController(id);
      ui.showSystem(`${user} now controls the candidate shell.`);
    };

    // Candidate PTY output → the host screen (only while watching) + all guests.
    candidateShell.on("data", (chunk: string) => {
      if (hostWatching) ui.writeShell(chunk);
      server.broadcast({ type: "shell_data", data: chunk, timestamp: Date.now() });
    });
    candidateShell.on("exit", () => {
      if (hostWatching && ui.isShellActive()) ui.exitShell();
      ui.showSystem("Candidate shell exited.");
    });

    server.on("shell_attach", (info: { id: string }) => {
      server.sendToGuest(info.id, { type: "shell_data", data: candidateShell!.snapshot(), timestamp: Date.now() });
    });
    server.on("shell_resize", (info: { id: string; cols: number; rows: number }) => {
      if (info.id === controllerId) candidateShell!.resize(info.cols, info.rows);
    });
    server.on("shell_input", (data: string) => {
      if (controllerId !== null) candidateShell!.write(data);   // server already limits to the controller
    });
    server.on("shell_control_request", (info: { id: string; user: string }) => {
      if (info.id === controllerId) return;
      if (approvalMode) {
        pendingControl.set(info.id, info.user);
        ui.showApprovalRequest(`shell-control:${info.id}`, info.user, "wants to use the shell");
      } else {
        giveControlToGuest(info.id, info.user);
      }
    });
    server.on("shell_control_released", () => {
      controllerId = null;
    });
    resolveShellControl = (id: string, approved: boolean) => {
      const user = pendingControl.get(id) ?? "guest";
      pendingControl.delete(id);
      if (approved) {
        giveControlToGuest(id, user);
      } else {
        server.sendToGuest(id, { type: "shell_control_grant", granted: false, timestamp: Date.now() });
        ui.showSystem(`Shell request from ${user} denied.`);
      }
    };

    // Host watches the candidate's shell (read-only). Candidate can't see this.
    watchCandidateShell = () => {
      if (ui.isShellActive() || !candidateShell) return;
      hostWatching = true;
      ui.enterShell({
        readOnly: true,
        header: "watching candidate shell — read-only · Ctrl-\\ back",
        onData: () => {},
        onDetach: () => {
          hostWatching = false;
          ui.exitShell();
        },
        onResize: () => {},
      });
      ui.writeShell(candidateShell.snapshot());
    };

    // Host's own private shell (Ctrl-T), spawned with the interviewer's
    // privileges — never broadcast, so the candidate never sees it.
    openInterviewerShell = () => {
      if (ui.isShellActive()) return;
      if (!interviewerShell) {
        const sz = ui.terminalSize();
        interviewerShell = newPtyShellSession({
          cwd: process.cwd(),
          cols: sz.cols,
          rows: sz.rows,
          uid: options.interviewerUid,
          gid: options.interviewerGid,
          env: options.interviewerHome
            ? ({ ...process.env, HOME: options.interviewerHome, USER: "interviewer" } as NodeJS.ProcessEnv)
            : process.env,
        });
        interviewerShell.on("data", (d: string) => ui.writeShell(d)); // host screen only
        interviewerShell.on("exit", () => {
          if (ui.isShellActive()) ui.exitShell();
          interviewerShell = undefined;
        });
      }
      ui.enterShell({
        readOnly: false,
        header: "your private shell (interviewer) · Ctrl-\\ back",
        onData: (data) => interviewerShell!.write(data),
        onDetach: () => ui.exitShell(),
        onResize: (cols, rows) => interviewerShell!.resize(cols, rows),
      });
      ui.writeShell(interviewerShell.snapshot());
    };
    ui.onShellEnter(openInterviewerShell); // Ctrl-T → interviewer's own shell
  }

  const router = new PromptRouter(claude, server, {
    hostUser: options.name,
    approvalMode,
  });

  server.on("prompt", (msg) => {
    ui.showUserPrompt(msg.user, msg.text, "guest", "claude");
    record({ kind: "prompt", user: msg.user, source: "guest", text: msg.text });
    router.handlePrompt(msg);
  });

  server.on("chat", (msg) => {
    ui.showUserPrompt(msg.user, msg.text, "guest", "chat");
    record({ kind: "chat", user: msg.user, source: "guest", text: msg.text });
  });

  let messageCount = 0;
  const sessionStartTime = Date.now();

  // Build command context for slash commands
  const cmdCtx: CommandContext = {
    ui,
    role: "host",
    sessionCode: session.code,
    partnerName: undefined,
    startTime: sessionStartTime,
    onShell: options.allowShell ? () => openInterviewerShell?.() : undefined,
    onWatch: options.allowShell ? () => watchCandidateShell?.() : undefined,
    questionText: options.question,
    onLeave: async () => {
      // Notify guest before shutting down
      server.broadcast({
        type: "notice",
        message: "Host ended the session. Goodbye!",
        timestamp: Date.now(),
      });
      const elapsed = Date.now() - sessionStartTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      ui.showSessionSummary({
        duration: `${minutes}m ${seconds}s`,
        messageCount,
      });
      connInfo?.cleanup?.();
      peerCleanup?.();
      fsWatcher.stop();

      recordsWatcher?.stop();
      candidateShell?.dispose();

      interviewerShell?.dispose();
      recordStream?.end();
      await claude.stop();
      await server.stop();
      ui.close();
      process.exit(0);
    },
    onTrustChange: (trusted) => {
      router.setApprovalMode(!trusted);
    },
    onKick: () => {
      server.kickGuest();
    },
    onEffort: async (level: string) => {
      ui.showSystem(`Reloading Claude at effort=${level} (conversation preserved)…`);
      server.broadcast({ type: "notice", message: `Host set Claude effort to ${level}.`, timestamp: Date.now() });
      try {
        await claude.setEffort(level);
        ui.showSystem(`Effort is now ${level}.`);
      } catch (err) {
        ui.showError(`Failed to change effort: ${err instanceof Error ? err.message : err}`);
      }
    },
  };

  server.on("guest_joined", async (user: string) => {
    sessionManager.addGuest(session.code, user);
    ui.showPartnerJoined(user);
    cmdCtx.partnerName = user;

    // Send the interview question so the guest's box populates on join.
    if (options.question) {
      server.broadcast({ type: "question", text: options.question, timestamp: Date.now() });
    }

    // Send the current project tree so the guest's panel populates immediately.
    if (latestTree) {
      server.broadcast({ type: "fs_tree", root: fsWatcher.root, tree: latestTree, timestamp: Date.now() });
    }

    // Send session history to guest if resuming an existing session
    const claudeSessionId = claude.getSessionId();
    if (claudeSessionId && (options.continueSession || options.resumeSession)) {
      try {
        const sessionDir = getProjectSessionDir();
        const sessionFilePath = join(sessionDir, `${claudeSessionId}.jsonl`);
        const history = await parseSessionHistory(sessionFilePath);
        if (history.length > 0) {
          server.broadcast({
            type: "history_replay",
            messages: history,
            sessionId: claudeSessionId,
            resumedFrom: history.length,
            timestamp: Date.now(),
          });
          ui.showSystem(`Sent ${history.length} history messages to ${user}.`);
        }
      } catch {
        // History replay is best-effort — don't fail the session
        ui.showSystem("Could not load session history for replay.");
      }
    }
  });

  server.on("guest_left", (user?: string) => {
    ui.showPartnerLeft(user || "partner");
    // Reflect a remaining watcher (if any) as the current partner.
    cmdCtx.partnerName = server.getGuestUser();
  });

  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let isTyping = false;

  ui.onKeystroke(() => {
    if (!isTyping) {
      isTyping = true;
      server.broadcast({
        type: "typing_indicator",
        user: options.name,
        isTyping: true,
        timestamp: Date.now(),
      } as any);
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTyping = false;
      server.broadcast({
        type: "typing_indicator",
        user: options.name,
        isTyping: false,
        timestamp: Date.now(),
      } as any);
    }, 2000);
  });

  ui.onInput((text) => {
    if (typingTimeout) clearTimeout(typingTimeout);
    if (isTyping) {
      isTyping = false;
      server.broadcast({
        type: "typing_indicator",
        user: options.name,
        isTyping: false,
        timestamp: Date.now(),
      } as any);
    }

    messageCount++;

    // Slash commands
    if (handleSlashCommand(text, cmdCtx)) return;

    if (text.toLowerCase().startsWith("@claude ")) {
      // Claude prompt
      const prompt = text.slice(8);
      const msg = {
        type: "prompt" as const,
        id: `host-${Date.now()}`,
        user: options.name,
        text: prompt,
        source: "host" as const,
        timestamp: Date.now(),
      };
      ui.showUserPrompt(options.name, prompt, "host", "claude");
      record({ kind: "prompt", user: options.name, source: "host", text: prompt });
      ui.showClaudeThinking();
      router.handlePrompt(msg);
    } else {
      // Chat message — broadcast to guest, don't send to Claude
      ui.showUserPrompt(options.name, text, "host", "chat");
      server.broadcast({
        type: "chat_received",
        user: options.name,
        text,
        source: "host",
        timestamp: Date.now(),
      });
    }
  });

  ui.onApproval((promptId, approved) => {
    if (promptId.startsWith("shell-control:")) {
      resolveShellControl?.(promptId.slice("shell-control:".length), approved);
      return;
    }
    router.handleApproval({ promptId, approved });
    if (!approved) {
      ui.showSystem("Prompt rejected.");
    }
  });

  server.on("server_message", (msg) => {
    if (msg.type === "approval_request") {
      ui.showApprovalRequest(msg.promptId, msg.user, msg.text);
    }
    if (msg.type === "typing_indicator") {
      if ((msg as any).user !== options.name) {
        ui.showTypingIndicator((msg as any).user, (msg as any).isTyping);
      }
    }
  });

  process.on("SIGINT", async () => {
    // Notify guest before shutting down
    server.broadcast({
      type: "notice",
      message: "Host ended the session. Goodbye!",
      timestamp: Date.now(),
    });
    const elapsed = Date.now() - sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSessionSummary({
      duration: `${minutes}m ${seconds}s`,
      messageCount,
    });
    connInfo?.cleanup?.();
    peerCleanup?.();
    fsWatcher.stop();

    recordsWatcher?.stop();
    candidateShell?.dispose();

    interviewerShell?.dispose();
    recordStream?.end();
    await claude.stop();
    await server.stop();
    ui.close();
    process.exit(0);
  });
}

function promptForAnswerCode(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("  Paste answer code: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
