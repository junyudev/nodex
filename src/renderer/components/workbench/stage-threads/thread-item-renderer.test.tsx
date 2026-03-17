import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { CodexItemView } from "../../../lib/types";
import { ThreadItemRenderer } from "./thread-item-renderer";
import {
  render,
  textContent,
  waitForStreamdownCodeHighlight,
  waitForStreamdownMermaidBlock,
} from "../../../test/dom";

const EXAMPLE_FILE_LINK = "/workspace/nodex/src/renderer/styles/design-system-theme.css#L450";

function renderItem(
  item: CodexItemView,
  options?: {
    projectWorkspacePath?: string;
    threadCwd?: string;
    isStreamingTurn?: boolean;
    showAssistantMessageActions?: boolean;
  },
) {
  return render(
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
  test("renders assistant markdown as rich content", async () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "# Heading\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      }),
    );
    await waitForStreamdownCodeHighlight(item.container);

    expect(item.container.querySelector("h1")).not.toBeNull();
    expect(textContent(item.container).includes("Heading")).toBeTrue();
    expect(item.container.querySelector("ul")).not.toBeNull();
    expect(item.container.querySelector("pre")).not.toBeNull();
    expect(item.container.querySelector("table")).not.toBeNull();
  });

  test("renders copy and mock edit actions under user messages", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "userMessage",
        role: "user",
        markdownText: "Refine the transcript actions.",
      }),
    );

    expect(item.getByLabelText("Copy message").getAttribute("aria-label")).toBe("Copy message");
    expect(item.getByLabelText("Edit message").getAttribute("title")).toBe("Edit message (mock)");
  });

  test("renders copy action under the selected assistant message only", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "Implemented the transcript action row.",
      }),
      { showAssistantMessageActions: true },
    );

    expect(item.getByLabelText("Copy message").getAttribute("aria-label")).toBe("Copy message");
    expect(item.queryByLabelText("Edit message") === null).toBeTrue();
  });

  test("omits assistant action row when it is not the last assistant message", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "Older assistant message.",
      }),
    );

    expect(item.queryByLabelText("Copy message") === null).toBeTrue();
  });

  test("renders local file links in markdown with a hover title", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: `[design-system-theme.css](<${EXAMPLE_FILE_LINK}>)`,
      }),
    );

    const link = item.getByText("design-system-theme.css");
    expect(link.getAttribute("title")).toBe("/workspace/nodex/src/renderer/styles/design-system-theme.css (line 450)");
  });

  test("renders assistant display math via Streamdown math plugin", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "$$b^2$$",
      }),
    );

    expect(item.container.querySelector(".katex")).not.toBeNull();
    expect(item.container.querySelector("annotation")).not.toBeNull();
  });

  test("renders mermaid fences through the Streamdown mermaid block shell", async () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "```mermaid\ngraph TD\nA-->B\n```",
      }),
    );
    await waitForStreamdownMermaidBlock(item.container);

    expect(item.container.querySelector('[data-streamdown="mermaid-block"]')).not.toBeNull();
    expect(textContent(item.container).includes("graph TD")).toBeFalse();
  });

  test("renders tool call toggles collapsed by default", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("docs / search")).toBeTrue();
    expect(item.container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(textContent(item.container).includes("Arguments")).toBeFalse();
    expect(textContent(item.container).includes("Result")).toBeFalse();
    expect(textContent(item.container).includes("Request failed")).toBeFalse();
  });

  test("renders completed command exploration summary collapsed by default", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("Explored")).toBeTrue();
    expect(textContent(item.container).includes("2 files, 1 search")).toBeTrue();
    expect(item.container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(textContent(item.container).includes("Activity")).toBeFalse();
  });

  test("renders in-progress command exploration expanded by default", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("Exploring")).toBeTrue();
    expect(item.container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(textContent(item.container).includes("Activity")).toBeTrue();
    expect(textContent(item.container).includes("Read app.ts")).toBeTrue();
    expect(textContent(item.container).includes("Searched for normalize in src")).toBeTrue();
  });

  test("renders command execution without shell wrapper prefix", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("ls -la src")).toBeTrue();
    expect(textContent(item.container).includes("/bin/zsh -lc")).toBeFalse();
    expect(textContent(item.container).includes("in /tmp/repo")).toBeFalse();
  });

  test("renders in-progress generic commands as a running status line", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("Running command")).toBeTrue();
    expect(textContent(item.container).includes("Ran git status")).toBeFalse();
    expect(textContent(item.container).includes("git status")).toBeFalse();
    expect(item.container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  test("renders command execution cwd subtitle when command runs outside thread cwd", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("in /tmp/repo/packages/ui")).toBeTrue();
  });

  test("renders file-change inline toggle with filename", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("app.ts")).toBeTrue();
    expect(textContent(item.container).includes("Completed")).toBeFalse();
  });

  test("renders unknown tool items as inline toggle with label", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("Future tool")).toBeTrue();
    expect(textContent(item.container).includes("Raw Item")).toBeFalse();
    expect(textContent(item.container).includes("foo")).toBeFalse();
    expect(textContent(item.container).includes("bar")).toBeFalse();
  });

  test("renders Thinking toggle collapsed by default", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "reasoning",
        role: "assistant",
        markdownText: "Internal reasoning content",
      }),
    );

    expect(textContent(item.container).includes("Thinking")).toBeTrue();
    expect(item.container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(textContent(item.container).includes("Internal reasoning content")).toBeFalse();
  });

  test("renders answered questions as a collapsed transcript disclosure", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("Asked")).toBeTrue();
    expect(textContent(item.container).includes("1 question")).toBeTrue();
    expect(item.container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(textContent(item.container).includes("What is 1 + 1?")).toBeFalse();
    expect(textContent(item.container).includes("2")).toBeFalse();
  });

  test("renders completed plans as collapsed preview cards", () => {
    const item = renderItem(
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

    expect(textContent(item.container).includes("Plan")).toBeTrue();
    expect(item.getByLabelText("Expand plan summary").getAttribute("aria-expanded")).toBe("false");
    expect(textContent(item.container).includes("Expand plan")).toBeTrue();
    expect(item.getByLabelText("Download plan").getAttribute("aria-label")).toBe("Download plan");
    expect(item.getByLabelText("Copy").getAttribute("aria-label")).toBe("Copy");
  });

  test("renders streaming plans expanded by default", () => {
    const item = renderItem(
      createBaseItem({
        normalizedKind: "plan",
        type: "plan",
        role: "assistant",
        status: "inProgress",
        markdownText: "- inspect the repo\n- write the plan\n- verify the result",
      }),
      { isStreamingTurn: true },
    );

    expect(item.getByLabelText("Collapse plan summary").getAttribute("aria-expanded")).toBe("true");
    expect(textContent(item.container).includes("Expand plan")).toBeFalse();
  });
});
