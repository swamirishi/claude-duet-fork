import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalUI } from "../ui.js";
import type { FsNode } from "../protocol.js";

// The UI now drives an Ink render tree via a reactive store. These tests assert
// on the store state (via ui.getState()) rather than console output.

describe("TerminalUI", () => {
  let ui: TerminalUI;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    ui?.close();
    vi.restoreAllMocks();
  });

  const lastMessage = () => {
    const msgs = ui.getState().messages;
    return msgs[msgs.length - 1];
  };

  it("stores input handler via onInput", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    const handler = vi.fn();
    ui.onInput(handler);
    ui.simulateInput("hello");
    expect(handler).toHaveBeenCalledWith("hello");
  });

  it("stores approval handler via onApproval", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    const handler = vi.fn();
    ui.onApproval(handler);
    ui.simulateApproval("p1", true);
    expect(handler).toHaveBeenCalledWith("p1", true);
  });

  it("onKeystroke stores handler without throwing", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    expect(() => ui.onKeystroke(vi.fn())).not.toThrow();
  });

  it("startInputLoop does not throw", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    expect(() => ui.startInputLoop()).not.toThrow();
  });

  it("showUserPrompt records a prompt message with the user and text", () => {
    ui = new TerminalUI({ userName: "benji", role: "guest" });
    ui.showUserPrompt("benji", "hello world", "guest");
    const m = lastMessage();
    expect(m.type).toBe("prompt");
    expect(m.user).toBe("benji");
    expect(m.text).toBe("hello world");
    expect(m.isHost).toBe(false);
  });

  it("showUserPrompt marks host messages with isHost", () => {
    ui = new TerminalUI({ userName: "benji", role: "guest" });
    ui.showUserPrompt("eliran", "hey there", "host");
    const m = lastMessage();
    expect(m.isHost).toBe(true);
    expect(m.user).toBe("eliran");
  });

  it("showStreamChunk accumulates into a single response message", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.showStreamChunk("Hello ");
    ui.showStreamChunk("world");
    const responses = ui.getState().messages.filter((m) => m.type === "response");
    expect(responses).toHaveLength(1);
    expect(responses[0].text).toBe("Hello world");
  });

  it("showTurnComplete records cost and updates the status bar", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.showTurnComplete(0.05, 4600);
    expect(ui.getState().cost).toBeCloseTo(0.05);
    expect(lastMessage().text).toContain("$0.0500");
    expect(lastMessage().text).toContain("4.6s");
  });

  it("showClaudeThinking sets the processing flag", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.showClaudeThinking();
    expect(ui.getState().claudeProcessing).toBe(true);
  });

  it("showApprovalRequest sets a pending approval; status clears it", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.showApprovalRequest("p9", "benji", "delete everything");
    expect(ui.getState().approval?.promptId).toBe("p9");
    ui.showApprovalStatus("approved");
    expect(ui.getState().approval).toBeUndefined();
  });

  it("showPartnerJoined sets guestUser on the host", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.showPartnerJoined("benji");
    expect(ui.getState().guestUser).toBe("benji");
    expect(lastMessage().type).toBe("session_event");
  });

  it("typing indicator toggles typingUser", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.showTypingIndicator("benji", true);
    expect(ui.getState().typingUser).toBe("benji");
    ui.showTypingIndicator("benji", false);
    expect(ui.getState().typingUser).toBeUndefined();
  });

  it("setFsTree populates the tree and default selection", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    const tree: FsNode = {
      name: "proj",
      path: "",
      type: "dir",
      children: [
        { name: "src", path: "src", type: "dir", children: [] },
        { name: "README.md", path: "README.md", type: "file" },
      ],
    };
    ui.setFsTree(tree);
    expect(ui.getState().fsTree?.children).toHaveLength(2);
    expect(ui.getState().fsSelected).toBe("src");
  });

  it("setFileContent populates the viewer; error clears content", () => {
    ui = new TerminalUI({ userName: "eliran", role: "host" });
    ui.setFileContent("README.md", "# Title", false);
    expect(ui.getState().fsFilePath).toBe("README.md");
    expect(ui.getState().fsFileContent).toBe("# Title");
    ui.setFileContent("secret.bin", "", false, "Binary file — not shown.");
    expect(ui.getState().fsFileError).toContain("Binary");
    expect(ui.getState().fsFileContent).toBeUndefined();
  });
});
