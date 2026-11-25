import { expect, test, vi, describe } from "vite-plus/test";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeConversation } from "../../../shared/agent-runtime-api";
import { agentRuntimeSnapshotFixture } from "../../../shared/testing/agent-runtime-snapshot";
import { createAgentRuntimeMarkdownReader } from "./agent-runtime-markdown-export";
import {
  streamReadOnlyConversationMarkdown,
  CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES,
  runCopyConversationMarkdown,
} from "./copy-conversation-markdown";
import { activateAppLocale, resetAppLocaleForTests } from "@/lib/i18n";
import type { CodexConversationItem, CodexConversationTurn } from "@/lib/types";
import type { VisibleConversationTurnEntry } from "./selectors";
import { renderConversationMarkdown } from "./conversation-markdown";

describe("agent runtime markdown export", () => {
  const target = { sessionId: "product-session", threadId: "selected-child" };
  const base = {
    threadId: "fork-origin",
    runId: "original-run",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    title: null,
    startedAt: "2026-10-15T00:00:00Z",
    completedAt: null,
    updatedAt: "2026-10-15T00:00:00Z",
    status: "completed" as const,
  };
  const user: AgentTurnItem = {
    ...base,
    id: "original-user",
    ordinal: 1,
    type: "user_message",
    messageId: "user-message",
    text: "Original question",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
  };
  const command: AgentTurnItem = {
    ...base,
    id: "original-command",
    ordinal: 2,
    type: "command_execution",
    input: "printf result",
    outputOmitted: true,
    exitCode: 0,
  };
  const answer: AgentTurnItem = {
    ...base,
    id: "original-answer",
    ordinal: 3,
    type: "assistant_message",
    text: "Original answer",
    streaming: false,
    messageId: "answer-message",
  };
  const row = (item: AgentTurnItem, position = 0) => ({
    position,
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });
  const snapshot = agentRuntimeSnapshotFixture({
    snapshot: { snapshotSequence: 10, historyCursor: "older", hasMoreHistory: true },
    thread: { id: target.threadId },
    projection: { visibleTurnItems: [row(command), row(answer, 1)] },
  });
  const conversation: AgentRuntimeConversation = { ...target, projectId: null, snapshot };

  test("copy pages the selected Session and explicitly reads only omitted captured-ancestry items", async () => {
    const transport = {
      read: vi.fn(async () => conversation),
      history: vi.fn(async () => ({
        snapshotSequence: 10,
        items: [row(user)],
        nextCursor: null,
        hasMoreHistory: false,
      })),
      item: vi.fn(async () => ({ ...command, outputOmitted: false, output: "Full tool result" })),
    };
    const chunks: string[] = [];
    for await (const chunk of streamReadOnlyConversationMarkdown({
      title: "Selected child",
      cwd: "/workspace",
      signal: new AbortController().signal,
      readPage: createAgentRuntimeMarkdownReader(target, transport),
    }))
      chunks.push(chunk);
    const markdown = chunks.join("");
    expect(transport.read).toHaveBeenCalledExactlyOnceWith(target);
    expect(transport.history).toHaveBeenCalledExactlyOnceWith({
      ...target,
      cursor: "older",
      conversationOnly: true,
    });
    expect(transport.item).toHaveBeenCalledExactlyOnceWith({
      ...target,
      itemId: "original-command",
      sourceThreadId: "fork-origin",
      full: true,
    });
    expect(markdown).toContain("Original question");
    expect(markdown).toContain("Full tool result");
    expect(markdown).toContain("Original answer");
    expect(markdown.indexOf("Original question")).toBeLessThan(markdown.indexOf("Original answer"));
    expect(conversation.snapshot.projection.visibleTurnItems[0]!.item).toBe(command);
    expect("output" in command).toBe(false);
  });

  test("changed product bindings and unavailable detail stop export before later pages", async () => {
    const transport = {
      read: vi.fn(async () => ({ ...conversation, threadId: "another-thread" })),
      history: vi.fn(async () => ({
        snapshotSequence: 10,
        items: [],
        nextCursor: null,
        hasMoreHistory: false,
      })),
      item: vi.fn(async () => null),
    };
    await expect(createAgentRuntimeMarkdownReader(target, transport)(null)).rejects.toThrow(
      "Conversation identity changed",
    );
    expect(transport.history).not.toHaveBeenCalled();
    expect(transport.item).not.toHaveBeenCalled();
    transport.read.mockResolvedValue(conversation);
    await expect(createAgentRuntimeMarkdownReader(target, transport)(null)).rejects.toThrow(
      "Conversation item is unavailable",
    );
    expect(transport.history).not.toHaveBeenCalled();
  });
});

describe("conversation markdown", () => {
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
    test("copies visible answers while hiding private answers from exported Markdown", () => {
      const markdown = renderConversationMarkdown({
        turns: [
          entry([
            item("answers", {
              type: "userInputResponse",
              kind: "userInputResponse",
              semanticKind: "userInputResponse",
              status: "completed",
              userInputQuestions: [
                {
                  id: "private",
                  header: "Private",
                  question: "Token?",
                  isOther: true,
                  isSecret: true,
                  options: [],
                },
                { id: "scope", header: "Scope", question: "Where?", isOther: false, options: [] },
                {
                  id: "blank",
                  header: "Blank",
                  question: "Anything else?",
                  isOther: true,
                  isSecret: true,
                  options: [],
                },
              ],
              userInputAnswers: { private: ["private-token"], scope: [" Project "], blank: [" "] },
            }),
          ]),
        ],
      });

      expect(markdown).toContain("> - Token?\n>   - Hidden response");
      expect(markdown).toContain("> - Where?\n>   - Project");
      expect(markdown).not.toContain("private-token");
      expect(markdown.match(/Hidden response/g)).toHaveLength(1);
    });

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

    test("exports recovery status and provider diagnostics in English with a Chinese interface", async () => {
      await activateAppLocale("zh-CN");
      try {
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
      } finally {
        resetAppLocaleForTests();
      }
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
});

describe("copy conversation markdown", () => {
  const stream = (...chunks: string[]): AsyncIterable<string> =>
    (async function* () {
      yield* chunks;
    })();

  test("read-only export keeps late background replies with their source Turn across overlapping pages", async () => {
    const turn = (
      turnId: string,
      itemId: string,
      role: "user" | "assistant",
      text: string,
    ): CodexConversationTurn => ({
      threadId: "thread",
      turnId,
      status: "completed",
      itemIds: [itemId],
      items: [
        {
          threadId: "thread",
          turnId,
          itemId,
          type: role === "user" ? "userMessage" : "agentMessage",
          role,
          kind: role === "user" ? "userMessage" : "assistantMessage",
          markdownText: text,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const latest = turn("new-run", "new-user", "user", "New task");
    const lateReply = turn("old-run", "old-answer", "assistant", "Original background reply");
    const original = turn("old-run", "old-user", "user", "Original task");
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ turns: [latest, lateReply], olderCursor: "older" })
      .mockResolvedValueOnce({ turns: [original, lateReply], olderCursor: null });
    const chunks: string[] = [];
    for await (const chunk of streamReadOnlyConversationMarkdown({
      title: "History",
      cwd: null,
      signal: new AbortController().signal,
      readPage,
    }))
      chunks.push(chunk);
    const markdown = chunks.join("");
    expect(readPage.mock.calls).toEqual([[null], ["older"]]);
    expect(markdown.indexOf("Original task")).toBeLessThan(
      markdown.indexOf("Original background reply"),
    );
    expect(markdown.indexOf("Original background reply")).toBeLessThan(
      markdown.indexOf("New task"),
    );
    expect(markdown.split("Original background reply")).toHaveLength(2);
  });

  describe("runCopyConversationMarkdown", () => {
    test("collects bounded stream pages and writes the complete document byte-for-byte", async () => {
      const calls: string[] = [];
      const value = `# Transcript\n\n${"x".repeat(80_500)}\n`;
      const writeText = vi.fn(async (markdown: string) => {
        calls.push("write");
        expect(markdown).toBe(value);
      });
      const showSuccess = vi.fn();
      await runCopyConversationMarkdown({
        streamMarkdown: () => {
          calls.push("stream");
          return stream("# Transcript", `\n\n${"x".repeat(80_500)}`, "\n");
        },
        writeText,
        showSuccess,
        showTooLarge: vi.fn(),
        showError: vi.fn(),
      });

      expect(calls).toEqual(["stream", "write"]);
      expect(showSuccess).toHaveBeenCalledOnce();
    });

    test("silently ignores an empty export", async () => {
      const writeText = vi.fn();
      const showSuccess = vi.fn();
      const showError = vi.fn();
      await runCopyConversationMarkdown({
        streamMarkdown: () => stream(),
        writeText,
        showSuccess,
        showTooLarge: vi.fn(),
        showError,
      });
      expect(writeText).not.toHaveBeenCalled();
      expect(showSuccess).not.toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });

    test("fails safely before allocating an oversized clipboard document", async () => {
      const showTooLarge = vi.fn();
      const writeText = vi.fn();
      await runCopyConversationMarkdown({
        streamMarkdown: () => stream("x".repeat(CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES + 1)),
        writeText,
        showSuccess: vi.fn(),
        showTooLarge,
        showError: vi.fn(),
      });
      expect(writeText).not.toHaveBeenCalled();
      expect(showTooLarge).toHaveBeenCalledWith(CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES);
    });

    test("uses the failure toast for stream and clipboard errors", async () => {
      for (const failingStep of ["stream", "clipboard"] as const) {
        const showError = vi.fn();
        await runCopyConversationMarkdown({
          streamMarkdown: () =>
            failingStep === "stream"
              ? (async function* () {
                  yield await Promise.reject<string>(new Error("stream"));
                })()
              : stream("# Transcript\n"),
          writeText: async () => {
            if (failingStep === "clipboard") throw new Error("clipboard");
          },
          showSuccess: vi.fn(),
          showTooLarge: vi.fn(),
          showError,
        });
        expect(showError).toHaveBeenCalledOnce();
      }
    });

    test("cancellation stops collection without reporting a failure", async () => {
      const controller = new AbortController();
      const showError = vi.fn();
      const writeText = vi.fn();
      await runCopyConversationMarkdown({
        signal: controller.signal,
        streamMarkdown: () =>
          (async function* () {
            yield "# Transcript";
            controller.abort();
            yield "\nnot copied";
          })(),
        writeText,
        showSuccess: vi.fn(),
        showTooLarge: vi.fn(),
        showError,
      });
      expect(writeText).not.toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });
  });
});
