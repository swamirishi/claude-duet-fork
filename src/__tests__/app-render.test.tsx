import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App, ghostCompletion } from "../ui/App.js";
import { UiStore } from "../ui/store.js";
import type { FsNode } from "../protocol.js";

const tree: FsNode = {
  name: "project",
  path: "",
  type: "dir",
  children: [
    {
      name: "src",
      path: "src",
      type: "dir",
      children: [{ name: "auth.ts", path: "src/auth.ts", type: "file", changed: true }],
    },
    { name: "README.md", path: "README.md", type: "file" },
  ],
};

function mount(role: "host" | "guest" = "host", pre?: (s: UiStore) => void) {
  const store = new UiStore(role, "eliran");
  store.set({ sessionCode: "cd-abc123", password: "1eca17ca", joinUrl: "wss://demo.trycloudflare.com", connectionMode: "tunnel", fsRoot: "/home/interview/project" });
  store.set({ fsTree: tree, fsSelected: "src", fsExpanded: new Set(["", "src"]) });
  store.addMessage({ id: "p1", type: "prompt", user: "eliran", isHost: true, text: "fix the bug", timestamp: 0 });
  pre?.(store); // apply extra state BEFORE render so lastFrame() reflects it
  const r = render(
    <App
      store={store}
      onInput={vi.fn()}
      onKeystroke={() => {}}
      onApproval={() => {}}
      onOpenFile={vi.fn()}
      onQuit={() => {}}
    />,
  );
  return { store, ...r };
}

describe("App render", () => {
  it("renders the status bar, chat, filesystem tree and viewer together", () => {
    const { lastFrame, unmount } = mount();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude-duet");
    expect(frame).toContain("cd-abc123");
    expect(frame).toContain("share with candidate"); // persistent join banner
    expect(frame).toContain("1eca17ca");             // password pinned on top
    expect(frame).toContain("trycloudflare.com");    // join URL pinned on top
    expect(frame).toContain("fix the bug");     // chat message
    expect(frame).toContain("project");          // tree root (basename of fsRoot)
    expect(frame).toContain("auth.ts");          // expanded file
    expect(frame).toContain("README.md");        // top-level file
    expect(frame).toContain("⟩");                // input prompt
    unmount();
  });

  it("pins the candidate browser link + sign-in when a web bridge is running", () => {
    const { lastFrame, unmount } = mount("host", (s) =>
      s.set({ webLink: "https://calm-frog-123.trycloudflare.com", webUser: "ada" }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("send candidate this link");
    expect(frame).toContain("calm-frog-123.trycloudflare.com");
    expect(frame).toContain("ada");       // basic-auth username (candidate name)
    expect(frame).toContain("1eca17ca");  // password shown alongside
    expect(frame).toContain("cd-abc123"); // session code still shown below
    unmount();
  });

  it("shows the file viewer with an opened file's contents", () => {
    const { lastFrame, unmount } = mount("host", (s) =>
      s.set({ fsFilePath: "README.md", fsFileContent: "# Hello World", focus: "viewer" }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("README.md");
    expect(frame).toContain("Hello World");
    unmount();
  });

  it("renders a pending approval prompt on the host", () => {
    const { lastFrame, unmount } = mount("host", (s) =>
      s.set({ approval: { promptId: "p1", user: "benji", text: "rm -rf /" } }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Approve");
    expect(frame).toContain("benji");
    unmount();
  });
});

describe("ghostCompletion", () => {
  it("completes @claude", () => {
    expect(ghostCompletion("@cl", "host")).toBe("@claude ");
    expect(ghostCompletion("@claude ", "host")).toBeNull();
  });
  it("completes slash commands", () => {
    expect(ghostCompletion("/st", "host")).toBe("/status");
    expect(ghostCompletion("/he", "guest")).toBe("/help");
  });
  it("offers host-only commands only to the host", () => {
    expect(ghostCompletion("/tr", "host")).toBe("/trust");
    expect(ghostCompletion("/tr", "guest")).toBeNull();
  });
  it("returns null for empty input", () => {
    expect(ghostCompletion("", "host")).toBeNull();
  });
});
