import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "./store.js";

export type { ChatMessage };

interface Line {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

// Greedy word-wrap; hard-splits words longer than the width. Always returns ≥1 line.
function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (word.length > width) {
      if (cur) { out.push(cur); cur = ""; }
      let w = word;
      while (w.length > width) { out.push(w.slice(0, width)); w = w.slice(width); }
      cur = w;
    } else if ((cur ? cur.length + 1 : 0) + word.length <= width) {
      cur = cur ? `${cur} ${word}` : word;
    } else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur || out.length === 0) out.push(cur);
  return out;
}

// Flatten messages into styled display lines, wrapped to `width`.
export function buildLines(messages: ChatMessage[], width: number): Line[] {
  const lines: Line[] = [];
  for (const msg of messages) {
    switch (msg.type) {
      case "prompt": {
        const color = msg.isHost ? "blue" : "magenta";
        for (const l of wrap(`${msg.user}: ${msg.text}`, width)) lines.push({ text: l, color, bold: true });
        break;
      }
      case "response":
        for (const raw of msg.text.split("\n"))
          for (const l of wrap(raw, width)) lines.push({ text: l });
        break;
      case "tool":
        for (const l of wrap(`  [tool] ${msg.text}`, width)) lines.push({ text: l, dim: true });
        break;
      case "system":
        for (const l of wrap(`  ${msg.text}`, width)) lines.push({ text: l, dim: true });
        break;
      case "error":
        for (const l of wrap(`  ${msg.text}`, width)) lines.push({ text: l, color: "red" });
        break;
      case "session_event":
        for (const l of wrap(`  ✦ ${msg.text}`, width)) lines.push({ text: l, color: "yellow", bold: true });
        break;
    }
  }
  return lines;
}

interface Props {
  messages: ChatMessage[];
  width: number;   // text width for wrapping
  height: number;  // number of rows the chat may occupy
  scroll: number;  // lines scrolled up from the bottom (0 = newest pinned to bottom)
}

export function ChatView({ messages, width, height, scroll }: Props) {
  const lines = buildLines(messages, Math.max(10, width));
  const total = lines.length;
  const rows = Math.max(1, height);
  const maxScroll = Math.max(0, total - rows);
  const eff = Math.min(Math.max(0, scroll), maxScroll);
  const end = total - eff;
  const start = Math.max(0, end - rows);
  const window = lines.slice(start, end);
  // Pad to a fixed height so chat never grows into the input bar.
  const padded: (Line | null)[] = [...window];
  while (padded.length < rows) padded.push(null);

  return (
    <Box flexDirection="column" height={rows}>
      {eff > 0 ? (
        <Text dimColor> ↑ {eff} more line{eff === 1 ? "" : "s"} — ↓ to catch up</Text>
      ) : null}
      {padded.slice(eff > 0 ? 1 : 0).map((l, i) =>
        l ? (
          <Text key={i} color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">
            {" "}{l.text || " "}
          </Text>
        ) : (
          <Text key={i}> </Text>
        ),
      )}
    </Box>
  );
}
