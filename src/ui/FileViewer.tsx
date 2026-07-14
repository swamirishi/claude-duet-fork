import React from "react";
import { Box, Text } from "ink";

interface Props {
  path?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
  offset: number;
  height: number;
}

export function FileViewer({ path, content, truncated, error, offset, height }: Props) {
  const bodyHeight = Math.max(1, height - 1); // reserve a line for the header

  let body: React.ReactNode;
  if (error) {
    body = <Text color="red">  {error}</Text>;
  } else if (content === undefined) {
    body = <Text dimColor>  Select a file and press Enter to view it.</Text>;
  } else {
    const lines = content.split("\n");
    const start = Math.min(offset, Math.max(0, lines.length - 1));
    const window = lines.slice(start, start + bodyHeight);
    const width = String(start + window.length).length;
    body = (
      <>
        {window.map((line, i) => {
          const n = String(start + i + 1).padStart(width, " ");
          return (
            <Text key={start + i} wrap="truncate">
              <Text dimColor>{n} </Text>
              {line || " "}
            </Text>
          );
        })}
        {truncated ? <Text color="yellow" dimColor>  … file truncated (200 KB cap)</Text> : null}
      </>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" flexGrow={1} paddingX={1}>
      <Text bold color="green" wrap="truncate">
        📄 {path ?? "viewer"}
      </Text>
      {body}
    </Box>
  );
}
