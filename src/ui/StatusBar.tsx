import React from "react";
import { Box, Text } from "ink";

interface Props {
  hostUser: string;
  guestUser?: string;
  sessionCode: string;
  connectionMode: string;
  cost: number;
  contextPercent: number;
  selfRole?: "host" | "guest";
}

export function StatusBar({ hostUser, guestUser, sessionCode, connectionMode, cost, contextPercent, selfRole }: Props) {
  return (
    <Box justifyContent="space-between" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box gap={1}>
        <Text color="cyan" bold>claude-duet</Text>
        <Text dimColor>──</Text>
        <Text color="green">●</Text>
        <Text color="blue" bold>{hostUser}{selfRole === "host" ? " (you)" : ""}</Text>
        {guestUser ? (
          <>
            <Text color="green">●</Text>
            <Text color="magenta" bold>{guestUser}{selfRole === "guest" ? " (you)" : ""}</Text>
          </>
        ) : (
          <Text dimColor>waiting for candidate…</Text>
        )}
        <Text dimColor>──</Text>
        <Text dimColor>{sessionCode}</Text>
        <Text dimColor>──</Text>
        <Text dimColor>{connectionMode}</Text>
      </Box>
      <Box gap={2}>
        <Text dimColor>${cost.toFixed(4)}</Text>
        <Text dimColor>{contextPercent}% ctx</Text>
      </Box>
    </Box>
  );
}
