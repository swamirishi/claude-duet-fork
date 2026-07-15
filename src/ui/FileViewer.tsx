import React from "react";
import { Box, Text } from "ink";

interface Props {
  mode: "terminal" | "file";
  // file mode
  path?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
  offset: number;         // file: lines from top
  // terminal mode
  terminal: string[];
  terminalScroll: number; // terminal: lines from bottom (0 = newest)
  focused: boolean;
  height: number;
}

export function FileViewer(props: Props) {
  const { mode, height, focused } = props;
  const bodyHeight = Math.max(1, height - 1); // header line

  let header: React.ReactNode;
  let body: React.ReactNode;

  if (mode === "file") {
    header = (
      <Text bold color="green" wrap="truncate">
        📄 {props.path ?? "viewer"}
      </Text>
    );
    if (props.error) {
      body = <Text color="red">  {props.error}</Text>;
    } else if (props.content === undefined) {
      body = <Text dimColor>  Loading…</Text>;
    } else {
      const lines = props.content.split("\n");
      const start = Math.min(props.offset, Math.max(0, lines.length - 1));
      const window = lines.slice(start, start + bodyHeight);
      const width = String(start + window.length).length;
      body = (
        <>
          {window.map((line, i) => (
            <Text key={start + i} wrap="truncate-end">
              <Text dimColor>{String(start + i + 1).padStart(width, " ")} </Text>
              {line || " "}
            </Text>
          ))}
          {props.truncated ? <Text color="yellow" dimColor>  … file truncated (200 KB cap)</Text> : null}
        </>
      );
    }
  } else {
    // terminal mode — bottom-pinned window of the command/output log
    const t = props.terminal;
    const total = t.length;
    const maxScroll = Math.max(0, total - bodyHeight);
    const eff = Math.min(Math.max(0, props.terminalScroll), maxScroll);
    const end = total - eff;
    const start = Math.max(0, end - bodyHeight);
    const window = t.slice(start, end);
    header = (
      <Text bold color="cyan" wrap="truncate">
        📟 terminal{eff > 0 ? ` (↑${eff})` : ""}
      </Text>
    );
    body =
      total === 0 ? (
        <Text dimColor>  Commands Claude runs will appear here.</Text>
      ) : (
        window.map((line, i) => (
          <Text key={start + i} color={line.startsWith("$ ") ? "green" : undefined} wrap="truncate-end">
            {line || " "}
          </Text>
        ))
      );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? "cyan" : "gray"} flexGrow={1} paddingX={1}>
      {header}
      {body}
    </Box>
  );
}
