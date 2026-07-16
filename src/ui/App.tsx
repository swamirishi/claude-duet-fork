import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { StatusBar } from "./StatusBar.js";
import { ChatView, buildLines } from "./ChatView.js";
import { FileTree, flattenTree } from "./FileTree.js";
import { FileViewer } from "./FileViewer.js";
import { UiStore, useUiState } from "./store.js";

interface AppProps {
  store: UiStore;
  onInput: (text: string) => void;
  onKeystroke: () => void;
  onApproval: (promptId: string, approved: boolean) => void;
  onOpenFile: (relPath: string) => void;
  onShellEnter: () => void;
  onQuit: () => void;
}

const HOST_CMDS = ["/trust", "/approval", "/kick", "/effort "];
const BASE_CMDS = ["@claude ", "/help", "/status", "/clear", "/shell", "/watch", "/leave", "/end", "/quit"];

export function ghostCompletion(input: string, role: "host" | "guest"): string | null {
  if (!input) return null;
  const pool = role === "host" ? [...BASE_CMDS, ...HOST_CMDS] : BASE_CMDS;
  const hit = pool.find((c) => c.startsWith(input) && c !== input);
  return hit ?? null;
}

export function App({ store, onInput, onKeystroke, onApproval, onOpenFile, onShellEnter, onQuit }: AppProps) {
  const { exit } = useApp();
  const state = useUiState(store);
  const [buffer, setBuffer] = useState("");
  const [, force] = useState(0);

  // Re-render on terminal resize so the layout tracks the window.
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    process.stdout.on("resize", onResize);
    return () => void process.stdout.off("resize", onResize);
  }, []);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const sidebarWidth = Math.max(28, Math.min(52, Math.floor(cols * 0.42)));
  const showJoinInfo = state.role === "host" && !!state.sessionCode;
  const showWebLink = showJoinInfo && !!state.webLink;
  const showApprove = showJoinInfo && !!state.approveLink;
  // Chrome rows: StatusBar (3) + input bar (3) + hint (1) = 7; host join banner up
  // to 2 more, +2 for the pinned candidate link, +1 for the approve line.
  const bodyHeight = Math.max(4, rows - 7 - (showJoinInfo ? 2 : 0) - (showWebLink ? 2 : 0) - (showApprove ? 1 : 0));
  const treeHeight = Math.max(4, Math.floor(bodyHeight / 2));
  const viewerHeight = Math.max(4, bodyHeight - treeHeight);

  const flatRows = flattenTree(state.fsTree, state.fsExpanded);

  // Chat pane sizing + scroll bounds (line-based so it never overflows the input bar).
  const chatColWidth = cols - sidebarWidth - 1;
  const chatTextWidth = Math.max(10, chatColWidth - 1);
  const indicatorLines = (state.claudeProcessing ? 1 : 0) + (state.typingUser ? 1 : 0);
  const chatHeight = Math.max(1, bodyHeight - indicatorLines);
  const maxChatScroll = Math.max(0, buildLines(state.messages, chatTextWidth).length - chatHeight);
  const scrollChat = (delta: number) =>
    store.set({ chatScroll: Math.min(maxChatScroll, Math.max(0, store.state.chatScroll + delta)) });

  const cycleFocus = () => {
    const order: Array<typeof state.focus> = ["input", "tree", "viewer"];
    const next = order[(order.indexOf(state.focus) + 1) % order.length];
    store.set({ focus: next });
  };

  const moveSelection = (delta: number) => {
    if (flatRows.length === 0) return;
    const idx = flatRows.findIndex((r) => r.node.path === store.state.fsSelected);
    const nextIdx = Math.min(flatRows.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
    store.set({ fsSelected: flatRows[nextIdx].node.path });
  };

  const activateSelection = () => {
    const sel = store.state.fsSelected;
    const row = flatRows.find((r) => r.node.path === sel);
    if (!row) return;
    if (row.node.type === "dir") {
      const expanded = new Set(store.state.fsExpanded);
      if (expanded.has(row.node.path)) expanded.delete(row.node.path);
      else expanded.add(row.node.path);
      store.set({ fsExpanded: expanded });
    } else {
      store.set({
        fsFilePath: row.node.path,
        fsFileContent: undefined,
        fsFileError: undefined,
        fsViewOffset: 0,
        focus: "viewer",
      });
      onOpenFile(row.node.path);
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onQuit();
      exit();
      return;
    }

    // Ctrl-T — enter the shared fullscreen shell (when the host offers it).
    if (key.ctrl && input === "t") {
      if (state.shellEnabled) onShellEnter();
      return;
    }

    // Approval prompt takes priority (host only).
    if (state.approval) {
      if (input === "y" || input === "Y") return onApproval(state.approval.promptId, true);
      if (input === "n" || input === "N") return onApproval(state.approval.promptId, false);
      return;
    }

    if (state.focus === "tree") {
      if (key.tab) return cycleFocus();
      if (key.upArrow) return moveSelection(-1);
      if (key.downArrow) return moveSelection(1);
      if (key.return || key.rightArrow) return activateSelection();
      if (key.leftArrow) {
        const expanded = new Set(store.state.fsExpanded);
        if (store.state.fsSelected && expanded.has(store.state.fsSelected)) {
          expanded.delete(store.state.fsSelected);
          store.set({ fsExpanded: expanded });
        }
        return;
      }
      return;
    }

    if (state.focus === "viewer") {
      if (key.tab) return cycleFocus();
      if (key.escape && store.state.fsFilePath) {
        // close the file
        return store.set({ fsFilePath: undefined, fsFileContent: undefined, fsFileError: undefined });
      }
      if (key.upArrow) return store.set({ fsViewOffset: Math.max(0, store.state.fsViewOffset - 1) });
      if (key.downArrow) return store.set({ fsViewOffset: store.state.fsViewOffset + 1 });
      if (key.pageUp) return store.set({ fsViewOffset: Math.max(0, store.state.fsViewOffset - viewerHeight) });
      if (key.pageDown) return store.set({ fsViewOffset: store.state.fsViewOffset + viewerHeight });
      return;
    }

    // focus === "input": ↑/↓ scroll the chat log (input has no history nav)
    if (key.upArrow) return scrollChat(1);
    if (key.downArrow) return scrollChat(-1);
    if (key.pageUp) return scrollChat(Math.max(1, chatHeight - 1));
    if (key.pageDown) return scrollChat(-Math.max(1, chatHeight - 1));
    if (key.tab) {
      const g = ghostCompletion(buffer, state.role);
      if (g) {
        setBuffer(g);
        onKeystroke();
      } else {
        cycleFocus();
      }
      return;
    }
    if (key.return) {
      const text = buffer.trim();
      setBuffer("");
      if (text) onInput(text);
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      onKeystroke();
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b + input);
      onKeystroke();
    }
  });

  const ghost = state.focus === "input" ? ghostCompletion(buffer, state.role) : null;
  const rootName = state.fsRoot ? state.fsRoot.split("/").filter(Boolean).pop() || "/" : "project";

  return (
    <Box flexDirection="column" height={rows}>
      <StatusBar
        hostUser={state.hostUser}
        guestUser={state.guestUser}
        sessionCode={state.sessionCode}
        connectionMode={state.connectionMode}
        cost={state.cost}
        contextPercent={state.contextPercent}
        selfRole={state.role}
      />
      {showJoinInfo ? (
        <Box flexDirection="column" paddingX={1} width={cols}>
          {showApprove ? (
            <Text wrap="wrap">
              <Text color="yellow" bold>✔ approve candidates here — </Text>
              <Text bold color="yellow">{state.approveLink}</Text>
              <Text dimColor> (open in your browser)</Text>
            </Text>
          ) : null}
          {showWebLink ? (
            <Text wrap="wrap">
              <Text color="green" bold>▶ send candidate this link — </Text>
              <Text bold color="cyan">{state.webLink}</Text>
            </Text>
          ) : null}
          {showWebLink ? (
            <Text wrap="wrap">
              <Text dimColor>  sign in — user </Text>
              <Text color="white">{state.webUser ?? "interview"}</Text>
              <Text dimColor> · password </Text>
              <Text color="white">{state.password ?? ""}</Text>
            </Text>
          ) : null}
          <Text wrap="wrap">
            <Text color="green" bold>{showWebLink ? "  session — " : "▶ share with candidate — "}</Text>
            <Text>code </Text>
            <Text bold color="white">{state.sessionCode}</Text>
            <Text>   password </Text>
            <Text bold color="white">{state.password ?? ""}</Text>
            {state.joinUrl ? (
              <Text>
                {"   url "}
                <Text bold color="white">{state.joinUrl}</Text>
              </Text>
            ) : (
              <Text dimColor>   (P2P: use the join command printed at startup)</Text>
            )}
          </Text>
        </Box>
      ) : null}
      <Box flexGrow={1}>
        <Box flexDirection="column" width={chatColWidth} height={bodyHeight}>
          <ChatView messages={state.messages} width={chatTextWidth} height={chatHeight} scroll={state.chatScroll} />
          {state.claudeProcessing ? <Text dimColor>  ✦ Claude is thinking…</Text> : null}
          {state.typingUser ? <Text dimColor>  ✎ {state.typingUser} is typing…</Text> : null}
        </Box>
        <Box
          flexDirection="column"
          width={sidebarWidth}
          height={bodyHeight}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <FileTree
            rows={flatRows}
            selected={state.fsSelected}
            expanded={state.fsExpanded}
            focused={state.focus === "tree"}
            height={treeHeight}
            rootName={rootName}
          />
          <FileViewer
            path={state.fsFilePath}
            content={state.fsFileContent}
            truncated={state.fsFileTruncated}
            error={state.fsFileError}
            offset={state.fsViewOffset}
            focused={state.focus === "viewer"}
            height={viewerHeight}
          />
        </Box>
      </Box>
      {state.approval ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">
            Approve {state.approval.user}'s request? "{state.approval.text.slice(0, 48)}"  [y] approve  [n] reject
          </Text>
        </Box>
      ) : (
        <Box borderStyle="single" borderColor={state.focus === "input" ? "cyan" : "gray"} paddingX={1}>
          <Text color="gray">⟩ </Text>
          <Text>{buffer}</Text>
          {ghost ? <Text dimColor>{ghost.slice(buffer.length)}</Text> : null}
        </Box>
      )}
      <Box paddingX={1}>
        <Text dimColor>
          {state.hint ??
            `Type to chat · @claude <prompt> · Tab: cycle · ↑↓ navigate${state.shellEnabled ? " · Ctrl-T shell" : ""}`}
        </Text>
      </Box>
    </Box>
  );
}
