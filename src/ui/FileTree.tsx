import React from "react";
import { Box, Text } from "ink";
import type { FsNode } from "../protocol.js";

export interface FlatRow {
  node: FsNode;
  depth: number;
}

// Flatten the tree into the list of currently-visible rows (respecting which
// directories are expanded). The root's own row is omitted; its children start
// at depth 0.
export function flattenTree(root: FsNode | undefined, expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  if (!root) return rows;
  const walk = (node: FsNode, depth: number) => {
    for (const child of node.children ?? []) {
      rows.push({ node: child, depth });
      if (child.type === "dir" && expanded.has(child.path)) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return rows;
}

interface Props {
  rows: FlatRow[];
  selected?: string;
  expanded: Set<string>;
  focused: boolean;
  height: number;
  rootName: string;
}

export function FileTree({ rows, selected, expanded, focused, height, rootName }: Props) {
  // Scroll so the selected row stays in view.
  const selIdx = Math.max(0, rows.findIndex((r) => r.node.path === selected));
  const visible = Math.max(1, height);
  let start = 0;
  if (selIdx >= visible) start = selIdx - visible + 1;
  const window = rows.slice(start, start + visible);

  return (
    <Box flexDirection="column">
      <Text bold color={focused ? "cyan" : "gray"}>
        {focused ? "▸ " : "  "}📁 {rootName}
      </Text>
      {window.length === 0 ? (
        <Text dimColor>  (empty)</Text>
      ) : (
        window.map(({ node, depth }) => {
          const isSel = node.path === selected;
          const indent = "  ".repeat(depth + 1);
          const icon =
            node.type === "dir" ? (expanded.has(node.path) ? "▾ " : "▸ ") : "  ";
          const label = `${indent}${icon}${node.name}`;
          return (
            <Text
              key={node.path}
              inverse={isSel && focused}
              color={isSel && !focused ? "cyan" : node.type === "dir" ? "blue" : undefined}
              wrap="truncate"
            >
              {label}
              {node.changed ? <Text color="yellow"> ●</Text> : null}
            </Text>
          );
        })
      )}
    </Box>
  );
}
