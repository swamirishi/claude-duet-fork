#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

const program = new Command();

function readQuestion(path?: string): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined; // missing/unreadable question file — just skip the box
  }
}

program
  .name("claude-duet")
  .description("Claude duet coding — share a Claude Code session with a partner")
  .version("0.2.0");

program
  .command("host")
  .description("Start a claude-duet session as host")
  .option("-n, --name <name>", "your display name", process.env.USER || "host")
  .option("--no-approval", "disable approval mode (trust your partner)")
  .option("--tunnel [provider]", "use a tunnel for remote access (localtunnel, cloudflare)")
  .option("--relay <url>", "use a relay server for remote access")
  .option("-p, --port <port>", "WebSocket server port (tunnel/LAN modes)", "0")
  .option("-c, --continue", "resume most recent Claude Code session")
  .option("--resume <id>", "resume a specific Claude Code session by ID")
  .option("--permission-mode <mode>", "permission mode: auto (default) or interactive")
  .option("--effort <level>", "reasoning effort: low | medium | high | xhigh | max")
  .option("--web-link <url>", "browser link to pin in the banner for the candidate")
  .option("--web-user <name>", "basic-auth username shown with the browser link")
  .option("--approve-link <url>", "local URL where you approve candidate check-ins")
  .option("--allow-shell", "enable the shared interactive shell (Ctrl-T) in the sandbox")
  .option("--run-as-uid <uid>", "run Claude + the candidate shell as this uid (sandbox)")
  .option("--run-as-gid <gid>", "run Claude + the candidate shell as this gid")
  .option("--record-file <path>", "append the full transcript to this file (interviewer-only)")
  .option("--interviewer-uid <uid>", "run the interviewer's private shell as this uid")
  .option("--interviewer-gid <gid>", "run the interviewer's private shell as this gid")
  .option("--interviewer-home <path>", "HOME for the interviewer's private shell")
  .option("--interviewer-root <path>", "extra dir shown only in the host's file tree (e.g. records)")
  .option("--question-file <path>", "markdown file shown in the pinned question box on startup")
  .option("--ide-link <url>", "remote VS Code (code-server) URL, surfaced by /ide")
  .action(async (options) => {
    console.log("  Starting session...");
    const { hostCommand } = await import("./commands/host.js");
    const config = loadConfig();
    const tunnelFlag = options.tunnel === true ? "localtunnel" : options.tunnel;
    const tunnel = tunnelFlag || config.tunnel;
    hostCommand({
      name: options.name !== process.env.USER ? options.name : (config.name || options.name),
      noApproval: !options.approval || config.approvalMode === false,
      tunnel,
      relay: options.relay || config.relay,
      port: parseInt(options.port, 10) || config.port || 0,
      continueSession: options.continue || false,
      resumeSession: options.resume,
      permissionMode: options.permissionMode || config.permissionMode || "auto",
      effort: options.effort,
      webLink: options.webLink,
      webUser: options.webUser,
      approveLink: options.approveLink,
      allowShell: options.allowShell || false,
      runAsUid: options.runAsUid !== undefined ? parseInt(options.runAsUid, 10) : undefined,
      runAsGid: options.runAsGid !== undefined ? parseInt(options.runAsGid, 10) : undefined,
      recordFile: options.recordFile,
      interviewerUid: options.interviewerUid !== undefined ? parseInt(options.interviewerUid, 10) : undefined,
      interviewerGid: options.interviewerGid !== undefined ? parseInt(options.interviewerGid, 10) : undefined,
      interviewerHome: options.interviewerHome,
      interviewerRoot: options.interviewerRoot,
      question: readQuestion(options.questionFile),
      ideLink: options.ideLink,
    });
  });

program
  .command("join <session-code-or-offer>")
  .description("Join an existing claude-duet session (session code or P2P offer code)")
  .option("-n, --name <name>", "your display name", process.env.USER || "guest")
  .option("--password <password>", "session password")
  .option("--url <url>", "WebSocket URL (direct, SSH tunnel, VPN, etc.)")
  .action(async (sessionCodeOrOffer, options) => {
    if (!options.password) {
      console.error("Error: --password is required");
      process.exit(1);
    }
    console.log("  Connecting...");
    const { joinCommand } = await import("./commands/join.js");
    const config = loadConfig();
    joinCommand(sessionCodeOrOffer, {
      name: options.name !== (process.env.USER || "guest") ? options.name : (config.name || options.name),
      password: options.password,
      url: options.url,
    });
  });

program
  .command("relay")
  .description("Run a self-hosted relay server for remote claude-duet sessions")
  .option("-p, --port <port>", "relay server port", "9877")
  .action(async (options) => {
    const { startRelayServer } = await import("./relay-server.js");
    startRelayServer(parseInt(options.port, 10));
  });

const configCmd = program
  .command("config")
  .description("View and manage claude-duet configuration")
  .action(async () => {
    const { configShowCommand } = await import("./commands/config.js");
    configShowCommand();
  });

configCmd
  .command("set <key> <value>")
  .description("Set a config value")
  .option("--project", "save to project config (.claude-duet.json)")
  .action(async (key, value, options) => {
    const { configSetCommand } = await import("./commands/config.js");
    configSetCommand(key, value, options);
  });

configCmd
  .command("get <key>")
  .description("Get a config value")
  .action(async (key) => {
    const { configGetCommand } = await import("./commands/config.js");
    configGetCommand(key);
  });

configCmd
  .command("path")
  .description("Show config file paths")
  .action(async () => {
    const { configPathCommand } = await import("./commands/config.js");
    configPathCommand();
  });

program.parse();
