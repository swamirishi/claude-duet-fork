import { EventEmitter } from "node:events";
import { useSyncExternalStore } from "react";
import type { FsNode } from "../protocol.js";

export interface ChatMessage {
  id: string;
  type: "prompt" | "response" | "tool" | "system" | "session_event" | "error";
  user?: string;
  isHost?: boolean;
  text: string;
  timestamp: number;
}

export interface ApprovalState {
  promptId: string;
  user: string;
  text: string;
}

export interface UiState {
  role: "host" | "guest";
  userName: string;
  hostUser: string;
  guestUser?: string;
  sessionCode: string;
  password?: string;
  joinUrl?: string;       // tunnel/relay URL the candidate connects to (if any)
  webLink?: string;       // browser (ttyd) link to hand the candidate, if a bridge is running
  connectionMode: string;
  cost: number;
  contextPercent: number;

  messages: ChatMessage[];
  chatScroll: number;          // lines scrolled up from the bottom (0 = pinned to newest)
  streamingId?: string;        // id of the response message currently accumulating
  claudeProcessing: boolean;
  typingUser?: string;
  approval?: ApprovalState;
  hint?: string;

  // Filesystem panel (shared project view)
  fsRoot?: string;
  fsTree?: FsNode;
  fsSelected?: string;          // relative path of the highlighted node
  fsExpanded: Set<string>;      // expanded directory paths
  fsFilePath?: string;          // relative path of the file open in the viewer
  fsFileContent?: string;
  fsFileTruncated?: boolean;
  fsFileError?: string;
  focus: "input" | "tree" | "viewer";
  fsViewOffset: number;         // scroll offset in the file viewer (lines from top)

  // Terminal pane (read-only view of Claude's commands + output), shown in the
  // viewer box by default; the box switches to file content when a file is open.
  terminal: string[];
  terminalScroll: number;       // lines scrolled up from the bottom (0 = newest)
}

/**
 * A tiny EventEmitter-backed store. TerminalUI mutates it imperatively; the Ink
 * <App/> subscribes via useSyncExternalStore and re-renders on change.
 */
export class UiStore extends EventEmitter {
  state: UiState;

  constructor(role: "host" | "guest", userName: string) {
    super();
    this.setMaxListeners(0);
    this.state = {
      role,
      userName,
      hostUser: role === "host" ? userName : "host",
      sessionCode: "",
      connectionMode: "",
      cost: 0,
      contextPercent: 0,
      messages: [],
      chatScroll: 0,
      claudeProcessing: false,
      fsExpanded: new Set([""]),
      focus: "input",
      fsViewOffset: 0,
      terminal: [],
      terminalScroll: 0,
    };
  }

  addTerminal(lines: string[]) {
    if (lines.length === 0) return;
    const MAX = 2000;
    const merged = [...this.state.terminal, ...lines];
    const terminal = merged.length > MAX ? merged.slice(merged.length - MAX) : merged;
    this.state = { ...this.state, terminal, terminalScroll: 0 };
    this.emitChange();
  }

  private emitChange() {
    this.emit("change");
  }

  set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    this.emitChange();
  }

  addMessage(msg: ChatMessage) {
    this.state = { ...this.state, messages: [...this.state.messages, msg], chatScroll: 0 };
    this.emitChange();
  }

  // Append streamed text into the current response message (creating one if needed).
  appendStream(text: string) {
    const { messages, streamingId } = this.state;
    if (streamingId) {
      const next = messages.map((m) =>
        m.id === streamingId ? { ...m, text: m.text + text } : m,
      );
      this.state = { ...this.state, messages: next, chatScroll: 0 };
    } else {
      const id = `resp-${this.state.messages.length}-${text.length}`;
      const msg: ChatMessage = { id, type: "response", text, timestamp: 0 };
      this.state = { ...this.state, messages: [...messages, msg], streamingId: id, chatScroll: 0 };
    }
    this.emitChange();
  }

  endStream() {
    if (this.state.streamingId) this.set({ streamingId: undefined });
  }
}

// React hook: subscribe a component to the store.
export function useUiState(store: UiStore): UiState {
  return useSyncExternalStore(
    (cb) => {
      store.on("change", cb);
      return () => store.off("change", cb);
    },
    () => store.state,
  );
}
