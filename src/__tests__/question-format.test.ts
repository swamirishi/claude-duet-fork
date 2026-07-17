import { describe, it, expect } from "vitest";
import { formatQuestion } from "../ui/QuestionBox.js";

describe("formatQuestion (markdown-lite)", () => {
  it("styles headers, bullets, and strips inline markers", () => {
    const rows = formatQuestion("# Title\nSome **bold** and `code` text.\n- first\n- second", 60);
    const byText = (t: string) => rows.find((r) => r.text.includes(t));
    expect(byText("Title")?.kind).toBe("h");
    expect(byText("Some bold and code text.")).toBeTruthy(); // ** and ` stripped
    expect(byText("first")?.kind).toBe("bullet");
    expect(byText("first")?.text.startsWith("•")).toBe(true);
  });

  it("renders fenced code blocks as code rows", () => {
    const rows = formatQuestion("intro\n```\nconst x = 1\n```\nafter", 60);
    expect(rows.find((r) => r.text.includes("const x = 1"))?.kind).toBe("code");
    expect(rows.find((r) => r.text.includes("intro"))?.kind).toBe("normal");
  });

  it("wraps long lines to the given width", () => {
    const rows = formatQuestion("word ".repeat(40).trim(), 20);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.text.length <= 20)).toBe(true);
  });
});
