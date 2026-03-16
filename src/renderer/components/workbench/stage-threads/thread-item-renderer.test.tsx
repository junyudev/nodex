import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { CodexItemView } from "../../../lib/types";
import { ThreadItemRenderer } from "./thread-item-renderer";

const EXAMPLE_FILE_LINK = "/workspace/nodex/src/renderer/styles/design-system-theme.css#L450";

function renderItem(
  item: CodexItemView,
  options?: {
    projectWorkspacePath?: string;
    threadCwd?: string;
    isStreamingTurn?: boolean;
    showAssistantMessageActions?: boolean;
  },
): string {
  return renderToStaticMarkup(
    createElement(
      RadixTooltip.Provider,
      {
        delayDuration: 200,
        skipDelayDuration: 150,
        children: createElement(ThreadItemRenderer, {
          item,
          isLatestTurn: true,
          isStreamingTurn: options?.isStreamingTurn ?? false,
          showAssistantMessageActions: options?.showAssistantMessageActions,
          projectWorkspacePath: options?.projectWorkspacePath,
          threadCwd: options?.threadCwd,
        }),
      },
    ),
  );
}

function createBaseItem(partial: Partial<CodexItemView>): CodexItemView {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    type: "agentMessage",
    normalizedKind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("ThreadItemRenderer", () => {
  test("renders assistant markdown as rich content", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "# Heading\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      }),
    );

    expect(markup.includes("<h1")).toBeTrue();
    expect(markup.includes("Heading")).toBeTrue();
    expect(markup.includes("<ul")).toBeTrue();
    expect(markup.includes("<pre")).toBeTrue();
    expect(markup.includes("<table")).toBeTrue();
  });

  test("renders copy and mock edit actions under user messages", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "userMessage",
        role: "user",
        markdownText: "Refine the transcript actions.",
      }),
    );

    expect(markup.includes("aria-label=\"Copy message\"")).toBeTrue();
    expect(markup.includes("aria-label=\"Edit message\"")).toBeTrue();
    expect(markup.includes("Edit message (mock)")).toBeTrue();
  });

  test("renders copy action under the selected assistant message only", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "Implemented the transcript action row.",
      }),
      { showAssistantMessageActions: true },
    );

    expect(markup.includes("aria-label=\"Copy message\"")).toBeTrue();
    expect(markup.includes("aria-label=\"Edit message\"")).toBeFalse();
  });

  test("omits assistant action row when it is not the last assistant message", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "Older assistant message.",
      }),
    );

    expect(markup.includes("aria-label=\"Copy message\"")).toBeFalse();
  });

  test("renders local file links in markdown with a hover title", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: `[design-system-theme.css](<${EXAMPLE_FILE_LINK}>)`,
      }),
    );

    expect(
      markup.includes(
        'title="/workspace/nodex/src/renderer/styles/design-system-theme.css (line 450)"',
      ),
    ).toBeTrue();
    expect(markup.includes("design-system-theme.css")).toBeTrue();
  });

  test("renders assistant display math via Streamdown math plugin", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "$$b^2$$",
      }),
    );

    expect(markup.includes('class="katex"')).toBeTrue();
    expect(markup.includes("annotation")).toBeTrue();
  });

  test("renders mermaid fences through the Streamdown code block shell", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "```mermaid\ngraph TD\nA-->B\n```",
      }),
    );

    expect(markup.includes("animate-spin")).toBeTrue();
    expect(markup.includes("graph TD")).toBeFalse();
  });

  test("renders tool call toggles collapsed by default", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "toolCall",
        type: "mcpToolCall",
        status: "failed",
        toolCall: {
          subtype: "mcp",
          toolName: "search",
          server: "docs",
          args: { query: "render markdown" },
          result: { ok: false },
          error: "Request failed",
        },
      }),
    );

    expect(markup.includes("docs / search")).toBeTrue();
    // Status shown inline for failures
    expect(markup.includes("Failed")).toBeTrue();
    // Collapsed — body content not rendered
    expect(markup.includes("Arguments")).toBeFalse();
    expect(markup.includes("Result")).toBeFalse();
    expect(markup.includes("Request failed")).toBeFalse();
  });

  test("renders completed command exploration summary collapsed by default", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "commandExecution",
        type: "commandExecution",
        status: "completed",
        toolCall: {
          subtype: "command",
          toolName: "bash",
          args: {
            command: "bash -lc 'cat src/app.ts && rg normalize src'",
            cwd: "/tmp/repo",
            commandActions: [
              {
                type: "read",
                command: "cat src/app.ts",
                name: "app.ts",
                path: "src/app.ts",
              },
              {
                type: "read",
                command: "cat src/main.ts",
                name: "main.ts",
                path: "src/main.ts",
              },
              {
                type: "search",
                command: "rg normalize src",
                query: "isProjectedPatchDirty|mergeProjectedPatchesIntoPending|getReadyProjectedPatches",
                path: "src",
              },
            ],
          },
        },
      }),
    );

    expect(markup.includes("Explored")).toBeTrue();
    expect(markup.includes("2 files, 1 search")).toBeTrue();
    expect(markup.includes("aria-expanded=\"false\"")).toBeTrue();
    expect(markup.includes("Activity")).toBeFalse();
  });

  test("renders in-progress command exploration expanded by default", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "commandExecution",
        type: "commandExecution",
        status: "inProgress",
        toolCall: {
          subtype: "command",
          toolName: "bash",
          args: {
            command: "bash -lc 'cat src/app.ts && rg normalize src'",
            cwd: "/tmp/repo",
            commandActions: [
              {
                type: "read",
                command: "cat src/app.ts",
                name: "app.ts",
                path: "src/app.ts",
              },
              {
                type: "search",
                command: "rg normalize src",
                query: "normalize",
                path: "src",
              },
            ],
          },
        },
      }),
    );

    expect(markup.includes("Exploring")).toBeTrue();
    expect(markup.includes("aria-expanded=\"true\"")).toBeTrue();
    expect(markup.includes("Activity")).toBeTrue();
    expect(markup.includes("Read app.ts")).toBeTrue();
    expect(markup.includes("Searched for normalize in src")).toBeTrue();
  });

  test("renders command execution without shell wrapper prefix", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "commandExecution",
        type: "commandExecution",
        status: "completed",
        toolCall: {
          subtype: "command",
          toolName: "bash",
          args: {
            command: "/bin/zsh -lc 'ls -la src'",
            cwd: "/tmp/repo",
          },
          result: "total 2",
        },
      }),
      { threadCwd: "/tmp/repo" },
    );

    expect(markup.includes("ls -la src")).toBeTrue();
    expect(markup.includes("/bin/zsh -lc")).toBeFalse();
    expect(markup.includes("in /tmp/repo")).toBeFalse();
  });

  test("renders in-progress generic commands as a running status line", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "commandExecution",
        type: "commandExecution",
        status: "inProgress",
        toolCall: {
          subtype: "command",
          toolName: "bash",
          args: {
            command: "git status",
            cwd: "/tmp/repo",
          },
          result: "On branch main",
        },
      }),
      { threadCwd: "/tmp/repo" },
    );

    expect(markup.includes("Running command")).toBeTrue();
    expect(markup.includes("Ran git status")).toBeFalse();
    expect(markup.includes("git status")).toBeFalse();
    expect(markup.includes("aria-expanded=\"false\"")).toBeTrue();
  });

  test("renders command execution cwd subtitle when command runs outside thread cwd", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "commandExecution",
        type: "commandExecution",
        status: "completed",
        toolCall: {
          subtype: "command",
          toolName: "bash",
          args: {
            command: "git status",
            cwd: "/tmp/repo/packages/ui",
          },
          result: "On branch main",
        },
      }),
      { threadCwd: "/tmp/repo" },
    );

    expect(markup.includes("in /tmp/repo/packages/ui")).toBeTrue();
    expect(markup.includes("text-xs")).toBeFalse();
  });

  test("renders file-change inline toggle with filename", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "fileChange",
        type: "fileChange",
        status: "completed",
        toolCall: {
          subtype: "fileChange",
          toolName: "file_change",
          args: {
            changes: [{ path: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
          },
          result: {
            paths: ["src/app.ts"],
            diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        },
      }),
    );

    expect(markup.includes("app.ts")).toBeTrue();
    // Inline toggle — no status badge for completed
    expect(markup.includes("Completed")).toBeFalse();
  });

  test("renders unknown tool items as inline toggle with label", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "toolCall",
        status: "failed",
        markdownText: "Future tool",
        rawItem: {
          type: "futureToolThing",
          foo: "bar",
        },
      }),
    );

    expect(markup.includes("Future tool")).toBeTrue();
    // Collapsed — no body content
    expect(markup.includes("Raw Item")).toBeFalse();
    expect(markup.includes("foo")).toBeFalse();
    expect(markup.includes("bar")).toBeFalse();
  });

  test("renders Thinking toggle collapsed by default", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "reasoning",
        role: "assistant",
        markdownText: "Internal reasoning content",
      }),
    );

    expect(markup.includes("Thinking")).toBeTrue();
    expect(markup.includes("aria-expanded=\"false\"")).toBeTrue();
    expect(markup.includes("Internal reasoning content")).toBeFalse();
  });

  test("renders answered questions as a collapsed transcript disclosure", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "userInputRequest",
        type: "request_user_input",
        status: "completed",
        markdownText: "Asked 1 question",
        userInputQuestions: [
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
        userInputAnswers: {
          q1: ["2"],
        },
      }),
    );

    expect(markup.includes("Asked")).toBeTrue();
    expect(markup.includes("1 question")).toBeTrue();
    expect(markup.includes("aria-expanded=\"false\"")).toBeTrue();
    expect(markup.includes("What is 1 + 1?")).toBeFalse();
    expect(markup.includes(">2<")).toBeFalse();
  });

  test("renders completed plans as collapsed preview cards", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "plan",
        type: "plan",
        role: "assistant",
        markdownText: [
          "Title: Calculate 1+1",
          "",
          "Summary",
          "",
          "- Use the built-in `calculator` tool to evaluate `1+1`.",
          "",
          "Implementation Changes",
          "",
          "- No file edits are required.",
          "",
          "Test Plan",
          "",
          "- Verify the calculator returns `2`.",
        ].join("\n"),
      }),
    );

    expect(markup.includes(">Plan<")).toBeTrue();
    expect(markup.includes("aria-label=\"Expand plan summary\"")).toBeTrue();
    expect(markup.includes("aria-expanded=\"false\"")).toBeTrue();
    expect(markup.includes("Expand plan")).toBeTrue();
    expect(markup.includes("Download plan")).toBeTrue();
    expect(markup.includes("Copy")).toBeTrue();
  });

  test("renders streaming plans expanded by default", () => {
    const markup = renderItem(
      createBaseItem({
        normalizedKind: "plan",
        type: "plan",
        role: "assistant",
        status: "inProgress",
        markdownText: "- inspect the repo\n- write the plan\n- verify the result",
      }),
      { isStreamingTurn: true },
    );

    expect(markup.includes("aria-label=\"Collapse plan summary\"")).toBeTrue();
    expect(markup.includes("aria-expanded=\"true\"")).toBeTrue();
    expect(markup.includes("Expand plan")).toBeFalse();
  });
});
