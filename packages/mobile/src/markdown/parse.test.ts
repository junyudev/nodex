import { describe, expect, it } from "vitest";

import { flattenNodexMarkdown, previewMarkdown } from "./parse";

describe("flattenNodexMarkdown", () => {
  it("turns a File attachment into a link a phone can open", () => {
    expect(
      flattenNodexMarkdown(':attachment{kind="file" source="nodex://files/a1" name="notes.txt"}'),
    ).toBe("[notes.txt](nodex://files/a1)");
  });

  it("names mentions instead of showing their URLs", () => {
    expect(flattenNodexMarkdown("See <nodex://pages/p1> and <nodex://sessions/s1>")).toBe(
      "See [Page](nodex://pages/p1) and [Chat](nodex://sessions/s1)",
    );
  });

  it("shows a date's text and drops Agent settings", () => {
    expect(flattenNodexMarkdown(':date{start="2026-10-28"} ok')).toBe("2026-10-28 ok");
    expect(flattenNodexMarkdown(':date{start="2026-10-28" end="2026-10-30"}')).toBe(
      "2026-10-28 – 2026-10-30",
    );
    expect(flattenNodexMarkdown(':agent-config{mode="plan"}x')).toBe("x");
  });

  it("keeps a container's title and dedents its body", () => {
    expect(flattenNodexMarkdown(":::toggle[Details]\n  Body\n:::\nAfter")).toBe(
      "**Details**\n\nBody\nAfter",
    );
  });

  it("leaves code untouched, even when it looks like a directive", () => {
    const code = '```\n:date{start="x"}\n:::toggle[a]\n```';
    expect(flattenNodexMarkdown(code)).toBe(code);
  });

  it("leaves text with no markup literal", () => {
    const text = "a < b, [draft, price is $5, snake_case";
    expect(flattenNodexMarkdown(text)).toBe(text);
  });
});

describe("previewMarkdown", () => {
  it("keeps a short body whole", () => {
    expect(previewMarkdown("short")).toEqual({ text: "short", cut: false });
  });

  it("cuts a long body at a line", () => {
    const body = `${"a".repeat(400)}\n${"b".repeat(400)}`;
    expect(previewMarkdown(body)).toEqual({ text: "a".repeat(400), cut: true });
  });

  it("closes a code fence the cut left open", () => {
    const body = `\`\`\`\n${"x\n".repeat(400)}`;
    const preview = previewMarkdown(body, 100);
    expect(preview.cut).toBe(true);
    expect(preview.text.endsWith("\n```")).toBe(true);
    expect(preview.text.match(/^```/gmu)).toHaveLength(2);
  });
});
