import { describe, expect, test } from "vite-plus/test";
import type { CodexDynamicToolCallView } from "../../../../lib/types";
import {
  buildDynamicToolArgumentPanels,
  formatToolOutputText,
  resolveDynamicToolFallbackIdentity,
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
  test("names the tool only when its activity label does not already", () => {
    expect(resolveDynamicToolFallbackIdentity(call())).toBeNull();
    expect(
      resolveDynamicToolFallbackIdentity(
        call({ tool: "Skill", displayTitle: "Skill: workflow-authoring" }),
      ),
    ).toBeNull();
    expect(resolveDynamicToolFallbackIdentity(call({ tool: "read_file" }))).toBeNull();
    expect(
      resolveDynamicToolFallbackIdentity(call({ namespace: "docs_search", tool: "read_file" })),
    ).toBe("docs_search.read_file");
    expect(
      resolveDynamicToolFallbackIdentity(
        call({ namespace: "node_repl", tool: "js", arguments: { title: "Inspect metadata" } }),
      ),
    ).toBe("node_repl.js");
    expect(
      resolveDynamicToolFallbackIdentity(call({ tool: "go", displayTitle: "Google search" })),
    ).toBe("go");
  });

  test("reads multi-line arguments verbatim and keeps the remaining fields as JSON", () => {
    const script = "export const meta = {\n  name: 'triage',\n}\n";
    expect(buildDynamicToolArgumentPanels(call({ arguments: { script } }))).toEqual([
      { title: "script", text: script },
    ]);
    expect(
      buildDynamicToolArgumentPanels(
        call({ arguments: { name: "triage", prompt: "Line one\nLine two", limit: 2 } }),
      ),
    ).toEqual([
      { title: "Arguments", text: '{\n  "name": "triage",\n  "limit": 2\n}' },
      { title: "prompt", text: "Line one\nLine two" },
    ]);
    expect(buildDynamicToolArgumentPanels(call({ arguments: ["a", 1] }))).toEqual([
      { title: "Arguments", text: '[\n  "a",\n  1\n]' },
    ]);
  });

  test("omits empty arguments and keeps script tools' code as their only panel", () => {
    expect(buildDynamicToolArgumentPanels(call({ arguments: {} }))).toEqual([]);
    expect(buildDynamicToolArgumentPanels(call({ arguments: null }))).toEqual([]);
    expect(buildDynamicToolArgumentPanels(call({ arguments: "  " }))).toEqual([]);
    expect(
      buildDynamicToolArgumentPanels(
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
