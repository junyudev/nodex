import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem, CodexConversationTurn } from "@/lib/types";
import type { VisibleConversationTurnEntry } from "./selectors";
import { renderConversationMarkdown } from "./conversation-markdown";

function item(itemId: string, overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    type: "systemEvent",
    kind: "systemEvent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function entry(items: CodexConversationItem[], diff?: string): VisibleConversationTurnEntry {
  const turn: CodexConversationTurn = {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    itemIds: items.map((candidate) => candidate.itemId),
    items,
    ...(diff ? { diff } : {}),
  };
  return {
    turn,
    turnId: turn.turnId,
    turnKey: "turn-1::0",
    turnSearchKey: "turn-1::0",
    requests: [],
    isMostRecentTurn: true,
  };
}

describe("renderConversationMarkdown", () => {
  test("frames the canonical transcript with a normalized title and final LF", () => {
    const markdown = renderConversationMarkdown({
      cwd: "/Users/asc/project",
      title: "  Review   #42  ",
      turns: [
        entry([
          item("user", {
            type: "userMessage",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            markdownText:
              "Inspect [the file](/Users/asc/project/src/app.ts:12).\n\n<details>unsafe</details>",
          }),
          item("assistant", {
            type: "assistantMessage",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            role: "assistant",
            markdownText: "Done.",
          }),
        ]),
      ],
    });

    expect(markdown).toBe(
      [
        "# Review \\#42",
        "",
        "> Inspect [the file](./src/app.ts:12).",
        ">",
        "> &lt;details&gt;unsafe&lt;/details&gt;",
        "",
        "Done.",
        "",
      ].join("\n"),
    );
  });

  test("groups command, patch, MCP, plan, and diff activity before the assistant response", () => {
    const markdown = renderConversationMarkdown({
      title: "Tool fidelity",
      cwd: "/Users/asc/project",
      turns: [
        entry(
          [
            item("user", {
              type: "userMessage",
              kind: "userMessage",
              semanticKind: "userMessage",
              role: "user",
              markdownText: "Make the change",
              userAttachments: [
                {
                  type: "file",
                  id: "file-1",
                  label: "app.ts",
                  path: "/Users/asc/project/src/app.ts",
                  sourceKind: "mention",
                },
              ],
            }),
            item("command", {
              type: "commandExecution",
              kind: "commandExecution",
              semanticKind: "exec",
              command: "pnpm test",
              aggregatedOutput: "all good",
              exitCode: 0,
              executionStatus: "completed",
            }),
            item("patch", {
              type: "fileChange",
              kind: "fileChange",
              semanticKind: "patch",
              fileChange: {
                changes: {
                  "/Users/asc/project/src/app.ts": {
                    type: "update",
                    unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new",
                    movePath: null,
                  },
                },
              },
            }),
            item("mcp", {
              type: "toolCall",
              kind: "toolCall",
              semanticKind: "mcpToolCall",
              mcpToolCall: {
                callId: "mcp",
                functionName: "search",
                pluginId: null,
                readOnlyHint: true,
                mcpAppResourceUri: undefined,
                source: null,
                invocation: { server: "docs", tool: "search", arguments: { q: "Radix" } },
                result: {
                  type: "success",
                  content: [{ type: "text", text: "Found it" }],
                  structuredContent: null,
                  raw: { content: [], structuredContent: null, _meta: null },
                },
                durationMs: 10,
                completed: true,
              },
            }),
            item("plan", {
              type: "plan",
              kind: "plan",
              semanticKind: "todoList",
              markdownText: "- [x] Inspect\n- [ ] Verify",
            }),
            item("assistant", {
              type: "assistantMessage",
              kind: "assistantMessage",
              semanticKind: "assistantMessage",
              role: "assistant",
              markdownText: "Implemented.",
            }),
          ],
          "diff --git a/src/app.ts b/src/app.ts\n+new",
        ),
      ],
    });

    expect(markdown).toContain("<details><summary>5 previous messages</summary>");
    expect(markdown).toContain("Ran <code>pnpm test</code>");
    expect(markdown).toContain("Updated <code>./src/app.ts</code> +1 -1");
    expect(markdown).toContain("docs.search");
    expect(markdown).toContain("- [x] Inspect");
    expect(markdown.indexOf("5 previous messages") < markdown.indexOf("Implemented.")).toBe(true);
  });

  test("does not crop transcripts beyond the selected-text bridge limit", () => {
    const longMessage = "x".repeat(80_500);
    const markdown = renderConversationMarkdown({
      title: "Long transcript",
      turns: [
        entry([
          item("assistant", {
            type: "assistantMessage",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            role: "assistant",
            markdownText: longMessage,
          }),
        ]),
      ],
    });

    expect(markdown.endsWith(`${longMessage}\n`)).toBe(true);
    expect(markdown.length).toBeGreaterThan(80_500);
  });

  test("exports a recovered request with its settled status and original provider diagnostics", () => {
    const markdown = renderConversationMarkdown({
      title: "Recovered request",
      turns: [
        entry([
          item("recovery", {
            semanticKind: "streamError",
            markdownText: "Retrying request",
            rawItem: { type: "error", message: "Claude API unknown." },
            additionalDetails: "Code: unknown",
            recovery: {
              state: "recovered",
              reason: "unknown",
              attempt: 2,
              maxAttempts: null,
              retryAt: null,
              updatedAt: 1,
            },
          }),
        ]),
      ],
    });

    expect(markdown).toContain(
      "> Request resumed\n>\n> Claude API unknown.\n>\n> Code: unknown\n>\n> State: recovered\n> Reason: unknown\n> Retry: Attempt 2",
    );
    expect(markdown).not.toContain("Stream error");
  });

  test("exports a terminal recovery with its cause and preserves ordinary error export", () => {
    const markdown = renderConversationMarkdown({
      title: "Request failure",
      turns: [
        entry([
          item("failure", {
            semanticKind: "systemError",
            markdownText: "Session token expired",
            recovery: {
              state: "failed",
              reason: "authentication",
              attempt: null,
              maxAttempts: null,
              retryAt: null,
              updatedAt: 1,
            },
          }),
          item("ordinary", { semanticKind: "systemError", markdownText: "Workspace missing" }),
        ]),
      ],
    });

    expect(markdown).toContain(
      "> Sign-in required\n>\n> Session token expired\n>\n> State: failed\n> Reason: authentication",
    );
    expect(markdown).toContain("> System error\n>\n> Workspace missing");
  });
});
