import { describe, expect, test } from "vite-plus/test";
import type { CodexDynamicToolCallView } from "../../../../lib/types";
import {
  buildDynamicToolAuthoredPanels,
  formatToolOutputText,
} from "./dynamic-tool-fallback-details";

function call(overrides: Partial<CodexDynamicToolCallView> = {}): CodexDynamicToolCallView {
  return {
    callId: "call-1",
    namespace: null,
    tool: "Workflow",
    arguments: {},
    status: "completed",
    contentItems: null,
    success: true,
    durationMs: 1,
    completed: true,
    ...overrides,
  };
}

describe("dynamic tool fallback details", () => {
  test("reads what the caller authored verbatim and leaves its plumbing to the inspector", () => {
    const script = "export const meta = {\n  name: 'triage',\n}\n";
    expect(buildDynamicToolAuthoredPanels(call({ arguments: { script } }))).toEqual([
      { title: "script", text: script },
    ]);
    expect(
      buildDynamicToolAuthoredPanels(
        call({ arguments: { name: "triage", prompt: "Line one\nLine two", limit: 2 } }),
      ),
    ).toEqual([{ title: "prompt", text: "Line one\nLine two" }]);
    expect(buildDynamicToolAuthoredPanels(call({ arguments: ["a", 1] }))).toEqual([]);
  });

  test("offers nothing for empty arguments and a script tool's code as its only panel", () => {
    expect(buildDynamicToolAuthoredPanels(call({ arguments: {} }))).toEqual([]);
    expect(buildDynamicToolAuthoredPanels(call({ arguments: null }))).toEqual([]);
    expect(buildDynamicToolAuthoredPanels(call({ arguments: "  " }))).toEqual([]);
    expect(
      buildDynamicToolAuthoredPanels(
        call({ tool: "js", arguments: { title: "Inspect", code: "console.log(1)" } }),
      ),
    ).toEqual([{ title: "javascript", text: "console.log(1)" }]);
  });

  test("indents JSON output without changing its values and leaves prose unchanged", () => {
    expect(
      formatToolOutputText(
        '{"id":12345678901234567890,"path":"a\\"b, c:{d}","items":[],"meta":{ },"ok":[true,null]}',
      ),
    ).toBe(
      [
        "{",
        '  "id": 12345678901234567890,',
        '  "path": "a\\"b, c:{d}",',
        '  "items": [],',
        '  "meta": {},',
        '  "ok": [',
        "    true,",
        "    null",
        "  ]",
        "}",
      ].join("\n"),
    );
    expect(formatToolOutputText("Launching skill: {name}")).toBe("Launching skill: {name}");
    expect(formatToolOutputText("{not json")).toBe("{not json");
  });
});
