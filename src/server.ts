import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { ServerMessage } from "./protocol.js";
import {
  isJoinRequest,
  isPromptMessage,
  isApprovalResponse,
  isChatMessage,
  isTypingMessage,
  isFsOpenMessage,
  isShellAttachMessage,
  isShellDetachMessage,
  isShellResizeMessage,
  isShellInputMessage,
  isShellControlRequestMessage,
} from "./protocol.js";
import { deriveKey, encrypt, decrypt } from "./crypto.js";
import type { DuetTransport } from "./transport.js";

export interface ServerOptions {
  hostUser: string;
  password: string;
  sessionCode: string;
  approvalMode?: boolean;
  shellEnabled?: boolean;
}

const P2P_ID = "p2p"; // synthetic guest id for the single P2P transport peer

/**
 * Session server. Supports MANY guests over WebSocket (tunnel/LAN) — anyone with
 * the password joins as a watcher; `broadcast` fans out to all of them. The
 * single P2P transport peer (when used) is treated as one more guest. Inbound
 * messages are attributed to the sending connection. The shared shell is
 * exclusive: at most one guest holds control at a time (`shellControllerId`);
 * only that guest's keystrokes are forwarded, and control grants are targeted.
 */
export class ClaudeDuetServer extends EventEmitter {
  private wss?: WebSocketServer;
  private guests = new Map<WebSocket, { id: string; user: string }>();
  private guestTransport?: DuetTransport;
  private guestTransportUser?: string;
  private guestSizes = new Map<string, { cols: number; rows: number }>();
  private shellControllerId: string | null = null; // null => host drives
  private options: Required<ServerOptions>;
  private encryptionKey: Uint8Array;

  constructor(options: ServerOptions) {
    super();
    this.setMaxListeners(0);
    this.options = {
      approvalMode: true,
      shellEnabled: false,
      ...options,
    };
    this.encryptionKey = deriveKey(options.password, options.sessionCode);
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port });
      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        const listeningPort = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(listeningPort);
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
    });
  }

  attachTransport(transport: DuetTransport): void {
    if (this.guestTransport) return;
    this.guestTransport = transport;

    transport.on("message", (data: string) => {
      try {
        const decrypted = decrypt(data, this.encryptionKey);
        const msg: unknown = JSON.parse(decrypted);
        this.handleTransportMessage(transport, msg);
      } catch {
        // Ignore malformed or undecryptable messages
      }
    });

    transport.on("close", () => {
      if (transport === this.guestTransport) {
        this.guestTransport = undefined;
        this.guestTransportUser = undefined;
        this.guestSizes.delete(P2P_ID);
        if (this.shellControllerId === P2P_ID) {
          this.shellControllerId = null;
          this.emit("shell_control_released");
        }
        this.emit("guest_left");
      }
    });
  }

  private handleConnection(ws: WebSocket): void {
    // No cap — every authenticated connection is a watcher. Eviction is never
    // needed; a stale socket simply drops out of the guest map on close.
    ws.on("message", (data) => {
      try {
        const decrypted = decrypt(data.toString(), this.encryptionKey);
        const msg: unknown = JSON.parse(decrypted);
        this.handleMessage(ws, msg);
      } catch {
        // Ignore malformed or undecryptable messages
      }
    });

    ws.on("close", () => {
      const g = this.guests.get(ws);
      if (!g) return;
      this.guests.delete(ws);
      this.guestSizes.delete(g.id);
      if (this.shellControllerId === g.id) {
        this.shellControllerId = null;
        this.emit("shell_control_released");
      }
      this.emit("guest_left", g.user);
    });
  }

  private handleTransportMessage(transport: DuetTransport, msg: unknown): void {
    if (isJoinRequest(msg)) {
      if (msg.passwordHash !== this.options.password) {
        this.sendTransport(transport, { type: "join_rejected", reason: "Invalid password", timestamp: Date.now() });
        return;
      }
      this.guestTransport = transport;
      this.guestTransportUser = msg.user;
      this.sendTransport(transport, this.joinAccepted());
      this.emit("guest_joined", msg.user);
      return;
    }
    this.routeGuestMessage(msg, P2P_ID, () => this.guestTransportUser ?? "guest");
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    if (isJoinRequest(msg)) {
      if (msg.passwordHash !== this.options.password) {
        this.send(ws, { type: "join_rejected", reason: "Invalid password", timestamp: Date.now() });
        return;
      }
      const id = nanoid(8);
      this.guests.set(ws, { id, user: msg.user });
      this.send(ws, this.joinAccepted());
      this.emit("guest_joined", msg.user);
      return;
    }
    const g = this.guests.get(ws);
    if (!g) return; // not joined yet
    this.routeGuestMessage(msg, g.id, () => g.user);
  }

  /** Shared inbound handling for a guest (ws or transport), attributed by id/user. */
  private routeGuestMessage(msg: unknown, id: string, user: () => string): void {
    if (isPromptMessage(msg)) {
      msg.user = user();
      msg.source = "guest";
      this.emit("prompt", msg);
      return;
    }
    if (isApprovalResponse(msg)) {
      this.emit("approval_response", msg);
      return;
    }
    if (isChatMessage(msg)) {
      msg.user = user();
      msg.source = "guest";
      this.broadcast({ type: "chat_received", user: msg.user, text: msg.text, source: "guest", timestamp: Date.now() });
      this.emit("chat", msg);
      return;
    }
    if (isTypingMessage(msg)) {
      this.emit("server_message", { type: "typing_indicator", user: user(), isTyping: msg.isTyping, timestamp: Date.now() });
      return;
    }
    if (isFsOpenMessage(msg)) {
      this.emit("fs_open", msg.path);
      return;
    }
    if (isShellAttachMessage(msg)) {
      this.guestSizes.set(id, { cols: msg.cols, rows: msg.rows });
      this.emit("shell_attach", { id, user: user(), cols: msg.cols, rows: msg.rows });
      return;
    }
    if (isShellDetachMessage(msg)) {
      if (this.shellControllerId === id) {
        this.shellControllerId = null;
        this.emit("shell_control_released");
      }
      this.emit("shell_detach", { id, user: user() });
      return;
    }
    if (isShellResizeMessage(msg)) {
      this.guestSizes.set(id, { cols: msg.cols, rows: msg.rows });
      this.emit("shell_resize", { id, cols: msg.cols, rows: msg.rows });
      return;
    }
    if (isShellInputMessage(msg)) {
      // Only the controlling guest may drive the PTY.
      if (this.shellControllerId === id) this.emit("shell_input", msg.data);
      return;
    }
    if (isShellControlRequestMessage(msg)) {
      this.emit("shell_control_request", { id, user: user() });
      return;
    }
  }

  private joinAccepted(): ServerMessage {
    return {
      type: "join_accepted",
      sessionId: "session",
      hostUser: this.options.hostUser,
      approvalMode: this.options.approvalMode,
      shellEnabled: this.options.shellEnabled,
      timestamp: Date.now(),
    };
  }

  // ---- Shared shell control (host-driven) ----

  /** Grant PTY control to a guest id, or null to return control to the host. */
  setShellController(id: string | null): void {
    this.shellControllerId = id;
    for (const [ws, g] of this.guests) {
      this.send(ws, { type: "shell_control_grant", granted: g.id === id, timestamp: Date.now() });
    }
    if (this.guestTransport) {
      this.sendTransport(this.guestTransport, { type: "shell_control_grant", granted: id === P2P_ID, timestamp: Date.now() });
    }
  }

  /** Last-reported terminal size for a guest id (for sizing the PTY on grant). */
  guestSize(id: string): { cols: number; rows: number } | undefined {
    return this.guestSizes.get(id);
  }

  broadcast(msg: ServerMessage): void {
    const encrypted = encrypt(JSON.stringify(msg), this.encryptionKey);
    for (const ws of this.guests.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encrypted);
    }
    if (this.guestTransport?.isOpen()) this.guestTransport.send(encrypted);
    // Also emit locally for the host TUI.
    this.emit("server_message", msg);
  }

  /** Send a message to just one guest by id (used for per-attach shell snapshots). */
  sendToGuest(id: string, msg: ServerMessage): void {
    if (id === P2P_ID) {
      if (this.guestTransport) this.sendTransport(this.guestTransport, msg);
      return;
    }
    for (const [ws, g] of this.guests) {
      if (g.id === id) {
        this.send(ws, msg);
        return;
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encrypt(JSON.stringify(msg), this.encryptionKey));
    }
  }

  private sendTransport(transport: DuetTransport, msg: ServerMessage): void {
    if (transport.isOpen()) {
      transport.send(encrypt(JSON.stringify(msg), this.encryptionKey));
    }
  }

  kickGuest(): void {
    const bye: ServerMessage = { type: "error", message: "You have been disconnected by the host.", timestamp: Date.now() };
    for (const ws of this.guests.keys()) {
      this.send(ws, bye);
      ws.close();
    }
    this.guests.clear();
    if (this.guestTransport) {
      this.sendTransport(this.guestTransport, bye);
      this.guestTransport.close();
      this.guestTransport = undefined;
      this.guestTransportUser = undefined;
    }
    this.guestSizes.clear();
    this.shellControllerId = null;
  }

  async stop(): Promise<void> {
    for (const ws of this.guests.keys()) ws.close();
    this.guests.clear();
    this.guestTransport?.close();
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  isGuestConnected(): boolean {
    return this.guests.size > 0 || (this.guestTransport?.isOpen() ?? false);
  }

  guestCount(): number {
    return this.guests.size + (this.guestTransport?.isOpen() ? 1 : 0);
  }

  getGuestUser(): string | undefined {
    const first = this.guests.values().next().value as { user: string } | undefined;
    return first?.user ?? this.guestTransportUser;
  }
}
