import React from "react";
import { Box, Text } from "ink";

interface Props {
  question: string;
  width: number;
  height: number; // total rows incl. border
}

type Kind = "h" | "bullet" | "code" | "normal" | "blank";
interface Row {
  text: string;
  kind: Kind;
}

// Greedy word-wrap to a column width (same approach as the chat view).
function wrap(s: string, width: number): string[] {
  if (s === "") return [""];
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur === "") cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
    while (cur.length > width) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

// Lightweight markdown → styled, wrapped rows. Line-level styling only
// (headers, bullets, fenced code); inline **bold**/`code` markers are stripped
// so the text stays clean without a full inline parser.
export function formatQuestion(md: string, width: number): Row[] {
  const w = Math.max(4, width);
  const out: Row[] = [];
  let inFence = false;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      (raw === "" ? [""] : wrap(raw, w)).forEach((t) => out.push({ text: t, kind: "code" }));
      continue;
    }
    const line = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"); // strip inline markers
    if (line.trim() === "") {
      out.push({ text: "", kind: "blank" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      wrap(h[2], w).forEach((t) => out.push({ text: t, kind: "h" }));
      continue;
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) {
      wrap(b[1], w - 2).forEach((t, i) => out.push({ text: (i === 0 ? "• " : "  ") + t, kind: "bullet" }));
      continue;
    }
    wrap(line, w).forEach((t) => out.push({ text: t, kind: "normal" }));
  }
  return out;
}

export function QuestionBox(props: Props) {
  const questionRows = Math.max(1, props.height - 3); // borders (2) + "📋 Question" header (1)
  const innerWidth = Math.max(4, props.width - 4); // borders + padding
  const rows = formatQuestion(props.question, innerWidth);
  const truncated = rows.length > questionRows;
  const shown = truncated ? rows.slice(0, questionRows - 1) : rows.slice(0, questionRows);

  const render = (r: Row, i: number) => {
    if (r.kind === "h") return <Text key={i} bold color="cyan" wrap="truncate-end">{r.text}</Text>;
    if (r.kind === "code") return <Text key={i} color="green" wrap="truncate-end">{r.text}</Text>;
    if (r.kind === "bullet") return <Text key={i} wrap="truncate-end">{r.text}</Text>;
    if (r.kind === "blank") return <Text key={i}> </Text>;
    return <Text key={i} wrap="truncate-end">{r.text}</Text>;
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={props.width} height={props.height}>
      <Text bold color="yellow" wrap="truncate">📋 Question</Text>
      {shown.map(render)}
      {truncated ? <Text dimColor>… type /question for the full text</Text> : null}
    </Box>
  );
}
