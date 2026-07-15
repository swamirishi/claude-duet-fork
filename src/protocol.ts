// ---- Base ----

export interface BaseMessage {
  type: string;
  timestamp: number;
}

// ---- Client → Server ----

export interface PromptMessage extends BaseMessage {
  type: "prompt";
  id: string;
  user: string;
  text: string;
  source?: "host" | "guest";
}

export interface TypingMessage extends BaseMessage {
  type: "typing";
  user: string;
  isTyping: boolean;
}

export interface ApprovalResponse extends BaseMessage {
  type: "approval_response";
  promptId: string;
  approved: boolean;
}

export interface JoinRequest extends BaseMessage {
  type: "join";
  user: string;
  passwordHash: string;
}

export interface ChatMessage extends BaseMessage {
  type: "chat";
  id: string;
  user: string;
  text: string;
  source?: "host" | "guest";
}

// ---- Server → Client(s) ----

export interface JoinAccepted extends BaseMessage {
  type: "join_accepted";
  sessionId: string;
  hostUser: string;
  approvalMode: boolean;
  shellEnabled?: boolean;    // host offers the shared interactive shell (Ctrl-T)
}

export interface JoinRejected extends BaseMessage {
  type: "join_rejected";
  reason: string;
}

export interface PromptReceived extends BaseMessage {
  type: "prompt_received";
  promptId: string;
  user: string;
  text: string;
  source?: "host" | "guest";
}

export interface ApprovalRequest extends BaseMessage {
  type: "approval_request";
  promptId: string;
  user: string;
  text: string;
}

export interface StreamChunk extends BaseMessage {
  type: "stream_chunk";
  text: string;
}

export interface ToolUseMessage extends BaseMessage {
  type: "tool_use";
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultMessage extends BaseMessage {
  type: "tool_result";
  tool: string;
  output: string;
}

export interface TurnComplete extends BaseMessage {
  type: "turn_complete";
  cost: number;
  durationMs: number;
}

export interface PresenceMessage extends BaseMessage {
  type: "presence";
  users: Array<{ name: string; role: "host" | "guest" }>;
}

export interface NoticeMessage extends BaseMessage {
  type: "notice";
  message: string;
}

export interface ErrorMessage extends BaseMessage {
  type: "error";
  message: string;
}

export interface ChatReceived extends BaseMessage {
  type: "chat_received";
  user: string;
  text: string;
  source?: "host" | "guest";
}

export interface TypingIndicator extends BaseMessage {
  type: "typing_indicator";
  user: string;
  isTyping: boolean;
}

export interface ApprovalStatusMessage extends BaseMessage {
  type: "approval_status";
  promptId: string;
  status: "pending" | "approved" | "rejected";
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  user?: string;
  text: string;
  toolName?: string;
  cost?: number;
  timestamp: number;
}

export interface HistoryReplayMessage extends BaseMessage {
  type: "history_replay";
  messages: HistoryMessage[];
  sessionId: string;
  resumedFrom: number;
}

// ---- Union Types ----

// ---- Filesystem view (shared project state) ----

// A node in the project file tree. Paths are RELATIVE to the confined root
// (the candidate's working directory); the root itself has path "".
export interface FsNode {
  name: string;
  path: string;              // relative to root; "" for the root
  type: "file" | "dir";
  changed?: boolean;         // recently created/modified
  children?: FsNode[];       // present on directories
}

// Host → guest: a fresh snapshot of the project tree.
export interface FsTreeMessage extends BaseMessage {
  type: "fs_tree";
  root: string;              // absolute root path (display only)
  tree: FsNode;
}

// Host → guest: the contents of a file the guest asked to open.
export interface FsFileMessage extends BaseMessage {
  type: "fs_file";
  path: string;              // relative to root
  content: string;
  truncated: boolean;
  error?: string;
}

// Guest → host: request to open/read a file from the shared tree.
export interface FsOpenMessage extends BaseMessage {
  type: "fs_open";
  path: string;              // relative to root
}

// ---- Shared interactive shell (fullscreen attach/detach) ----

// Guest → host: attach to / detach from the shared PTY.
export interface ShellAttachMessage extends BaseMessage {
  type: "shell_attach";
  user: string;
  cols: number;
  rows: number;
}

export interface ShellDetachMessage extends BaseMessage {
  type: "shell_detach";
  user: string;
}

// Guest → host: the attached client's terminal was resized.
export interface ShellResizeMessage extends BaseMessage {
  type: "shell_resize";
  cols: number;
  rows: number;
}

// Host → guest: raw PTY output bytes (a UTF-8 chunk, control sequences intact).
export interface ShellDataMessage extends BaseMessage {
  type: "shell_data";
  data: string;
}

export type ClientMessage =
  | PromptMessage
  | TypingMessage
  | ApprovalResponse
  | JoinRequest
  | ChatMessage
  | FsOpenMessage
  | ShellAttachMessage
  | ShellDetachMessage
  | ShellResizeMessage;

export type ServerMessage =
  | JoinAccepted
  | JoinRejected
  | PromptReceived
  | ApprovalRequest
  | ApprovalStatusMessage
  | StreamChunk
  | ToolUseMessage
  | ToolResultMessage
  | TurnComplete
  | PresenceMessage
  | NoticeMessage
  | ErrorMessage
  | ChatReceived
  | HistoryReplayMessage
  | TypingIndicator
  | FsTreeMessage
  | FsFileMessage
  | ShellDataMessage;

export type Message = ClientMessage | ServerMessage;

// ---- Type Guards ----

export function isPromptMessage(msg: unknown): msg is PromptMessage {
  return isObject(msg) && msg.type === "prompt";
}

export function isStreamChunk(msg: unknown): msg is StreamChunk {
  return isObject(msg) && msg.type === "stream_chunk";
}

export function isApprovalRequest(msg: unknown): msg is ApprovalRequest {
  return isObject(msg) && msg.type === "approval_request";
}

export function isApprovalResponse(msg: unknown): msg is ApprovalResponse {
  return isObject(msg) && msg.type === "approval_response";
}

export function isPresenceMessage(msg: unknown): msg is PresenceMessage {
  return isObject(msg) && msg.type === "presence";
}

export function isJoinRequest(msg: unknown): msg is JoinRequest {
  return isObject(msg) && msg.type === "join";
}

export function isChatMessage(msg: unknown): msg is ChatMessage {
  return isObject(msg) && msg.type === "chat";
}

export function isTypingMessage(msg: unknown): msg is TypingMessage {
  return isObject(msg) && msg.type === "typing";
}

export function isHistoryReplay(msg: unknown): msg is HistoryReplayMessage {
  return isObject(msg) && msg.type === "history_replay";
}

export function isFsOpenMessage(msg: unknown): msg is FsOpenMessage {
  return isObject(msg) && msg.type === "fs_open";
}

export function isShellAttachMessage(msg: unknown): msg is ShellAttachMessage {
  return isObject(msg) && msg.type === "shell_attach";
}

export function isShellDetachMessage(msg: unknown): msg is ShellDetachMessage {
  return isObject(msg) && msg.type === "shell_detach";
}

export function isShellResizeMessage(msg: unknown): msg is ShellResizeMessage {
  return isObject(msg) && msg.type === "shell_resize";
}

export function isShellDataMessage(msg: unknown): msg is ShellDataMessage {
  return isObject(msg) && msg.type === "shell_data";
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && "type" in val;
}
