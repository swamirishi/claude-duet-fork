import React from "react";
import { Box, Text } from "ink";

interface Props {
  path?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
  offset: number;   // lines scrolled from the top
  focused: boolean;
  height: number;
}

export function FileViewer(props: Props) {
  const { height, focused } = props;
  const bodyHeight = Math.max(1, height - 1); // header line

  const header = (
    <Text bold color="green" wrap="truncate">
      📄 {props.path ?? "viewer"}
    </Text>
  );

  let body: React.ReactNode;
  if (!props.path) {
    body = <Text dimColor>  Select a file in the tree to view it here.</Text>;
  } else if (props.error) {
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

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? "cyan" : "gray"} flexGrow={1} paddingX={1}>
      {header}
      {body}
    </Box>
  );
}
