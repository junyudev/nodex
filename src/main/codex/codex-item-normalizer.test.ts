import { describe, expect, test } from "bun:test";
import { normalizeThreadItem } from "./codex-item-normalizer";

describe("codex-item-normalizer", () => {
  test("normalizes commandExecution items with structured tool metadata", () => {
    const item = normalizeThreadItem(
      {
        id: "item-command",
        type: "commandExecution",
        status: "in_progress",
        command: "bun run lint",
        cwd: "/tmp/repo",
        aggregatedOutput: "Checked 42 files",
        commandActions: [
          {
            type: "read",
            command: "cat src/main.ts",
            name: "main.ts",
            path: "src/main.ts",
          },
          {
            type: "search",
            command: "rg normalize",
            query: "normalize",
            path: "src",
          },
        ],
      },
      "thread-1",
      "turn-1",
    );

    expect(item).not.toBeNull();
    expect(item?.normalizedKind).toBe("commandExecution");
    expect(item?.status).toBe("inProgress");
    expect(item?.toolCall?.subtype).toBe("command");
    expect(item?.toolCall?.toolName).toBe("bash");
    expect((item?.toolCall?.args as { command?: string }).command).toBe("bun run lint");
    expect((item?.toolCall?.args as { commandActions?: unknown[] })?.commandActions?.length).toBe(2);
    expect((item?.toolCall?.result as string | undefined)?.includes("Checked 42 files")).toBeTrue();
  });

  test("normalizes fileChange items with structured diffs", () => {
    const item = normalizeThreadItem(
      {
        id: "item-file",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "src/example.ts",
            diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        ],
      },
      "thread-1",
      "turn-1",
    );

    expect(item).not.toBeNull();
    expect(item?.normalizedKind).toBe("fileChange");
    expect(item?.status).toBe("completed");
    expect(item?.toolCall?.subtype).toBe("fileChange");
    expect(item?.toolCall?.toolName).toBe("file_change");
    expect((item?.toolCall?.args as { label?: string }).label).toBe("Edited src/example.ts");
    expect(((item?.toolCall?.result as { diff?: string } | undefined)?.diff ?? "").includes("@@ -1 +1 @@")).toBeTrue();
  });

  test("normalizes mcpToolCall items into canonical tool payloads", () => {
    const item = normalizeThreadItem(
      {
        id: "item-mcp",
        type: "mcpToolCall",
        server: "docs",
        tool: "search",
        status: "in_progress",
        arguments: { query: "thread item schema" },
        result: {
          content: [{ type: "text", text: "ok" }],
        },
      },
      "thread-1",
      "turn-1",
    );

    expect(item).not.toBeNull();
    expect(item?.normalizedKind).toBe("toolCall");
    expect(item?.status).toBe("inProgress");
    expect(item?.toolCall?.subtype).toBe("mcp");
    expect(item?.toolCall?.server).toBe("docs");
    expect((item?.toolCall?.args as { query?: string }).query).toBe("thread item schema");
    expect(((item?.toolCall?.result as { content?: unknown[] } | undefined)?.content?.length ?? 0) > 0).toBeTrue();
  });

  test("normalizes reasoning items and preserves status when provided", () => {
    const item = normalizeThreadItem(
      {
        id: "item-thinking",
        type: "reasoning",
        status: "in_progress",
        summary: ["Checking thread state"],
        content: ["Comparing item lifecycle with turn status"],
      },
      "thread-1",
      "turn-1",
    );

    expect(item).not.toBeNull();
    expect(item?.normalizedKind).toBe("reasoning");
    expect(item?.status).toBe("inProgress");
    expect(item?.markdownText?.includes("Checking thread state")).toBeTrue();
    expect(item?.markdownText?.includes("Comparing item lifecycle with turn status")).toBeTrue();
  });

  test("normalizes request_user_input items with transcript answers", () => {
    const item = normalizeThreadItem(
      {
        id: "item-user-input",
        type: "request_user_input",
        status: "completed",
        questions: [
          {
            id: "q1",
            header: "Math",
            question: "What is 1 + 1?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "2", description: "Correct" },
              { label: "3", description: "Incorrect" },
            ],
          },
        ],
        answers: {
          q1: {
            answers: ["2"],
          },
        },
      },
      "thread-1",
      "turn-1",
    );

    expect(item).not.toBeNull();
    expect(item?.normalizedKind).toBe("userInputRequest");
    expect(item?.status).toBe("completed");
    expect(item?.markdownText).toBe("Asked 1 question");
    expect(item?.userInputQuestions?.[0]?.question).toBe("What is 1 + 1?");
    expect(item?.userInputAnswers?.q1?.[0]).toBe("2");
  });

  test("keeps unknown item variants visible with fallback content", () => {
    const item = normalizeThreadItem(
      {
        id: "item-unknown",
        type: "futureToolThing",
        foo: "bar",
      },
      "thread-1",
      "turn-1",
    );

    expect(item).not.toBeNull();
    expect(item?.normalizedKind).toBe("systemEvent");
    expect(item?.markdownText).toBe("Future Tool Thing");
    expect((item?.rawItem as { foo?: string }).foo).toBe("bar");
  });
});
