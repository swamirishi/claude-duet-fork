import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "./store.js";

export type { ChatMessage };

interface Props {
  messages: ChatMessage[];
  maxRows?: number;
}

export function ChatView({ messages, maxRows }: Props) {
  // Keep only the most recent messages that fit the viewport (Ink doesn't scroll).
  const shown = maxRows ? messages.slice(-Math.max(1, maxRows)) : messages;
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
      {shown.map((msg) => {
        switch (msg.type) {
          case "prompt":
            return (
              <Box key={msg.id} marginTop={1}>
                <Text color={msg.isHost ? "blue" : "magenta"} bold>
                  {msg.user}:
                </Text>
                <Text> {msg.text}</Text>
              </Box>
            );
          case "response":
            return <Text key={msg.id}>{msg.text}</Text>;
          case "tool":
            return <Text key={msg.id} dimColor>  [tool] {msg.text}</Text>;
          case "system":
            return <Text key={msg.id} dimColor>  {msg.text}</Text>;
          case "error":
            return <Text key={msg.id} color="red">  {msg.text}</Text>;
          case "session_event":
            return (
              <Box key={msg.id} marginY={1}>
                <Text color="yellow" bold>  ✦ {msg.text}</Text>
              </Box>
            );
          default:
            return null;
        }
      })}
    </Box>
  );
}
