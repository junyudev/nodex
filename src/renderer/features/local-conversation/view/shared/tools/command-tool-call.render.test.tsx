import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "../../../../../components/ui/tooltip";
import { THREAD_SETTINGS_STORAGE_KEY } from "../../../../../lib/codex-thread-settings";
import { render, settleAsyncRender, textContent } from "../../../../../test/dom";
import type { CodexTranscriptEntry } from "../../../../../lib/types";
import { CodexThreadSettingsProvider } from "../../../../../lib/use-codex-thread-settings";
import { CommandToolCall } from "./command-tool-call";
import {
  ConversationRuntimeContext,
  type ConversationRuntime,
} from "../../../conversation-runtime";

function buildCommandEntry(overrides?: Partial<CodexTranscriptEntry>): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "cmd-1",
    entryId: "cmd-1",
    type: "command_execution",
    kind: "commandExecution",
    semanticKind: "exec",
    status: "completed",
    markdownText: "Ran bun test",
    command: "bun test",
    cwd: null,
    processId: null,
    commandActions: [],
    aggregatedOutput: "3 pass\nExit code 0\n",
    exitCode: 0,
    durationMs: null,
    toolCall: {
      subtype: "command",
      toolName: "bash",
      args: {},
      result: "3 pass\nExit code 0\n",
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildAutomaticApprovalReviewEntry(
  overrides?: Partial<CodexTranscriptEntry>,
): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "review-1",
    entryId: "review-1",
    type: "automaticApprovalReview",
    kind: "systemEvent",
    semanticKind: "automaticApprovalReview",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    rawItem: {
      targetItemId: "cmd-1",
      review: {
        status: "approved",
        riskScore: 0.12,
        riskLevel: "low",
        rationale: "Only local tests are executed.",
      },
      action: {
        type: "commandExecution",
        command: "bun test",
      },
    },
    ...overrides,
  };
}

async function expandCommandShell(container: HTMLElement) {
  const summaryToggle = container.querySelector<HTMLElement>(
    "[data-testid='command-tool-summary-toggle'] > button",
  );
  if (!summaryToggle) throw new Error("Expected command summary toggle");
  fireEvent.click(summaryToggle);
  await settleAsyncRender();
}

describe("CommandToolCall render state", () => {
  beforeEach(() => {
    localStorage.removeItem(THREAD_SETTINGS_STORAGE_KEY);
  });

  test("reads withheld output when a finished command is opened", async () => {
    const reads: Array<readonly [string | null, string]> = [];
    const runtime = {
      readItemDetail: async (threadId: string | null, itemId: string) => {
        reads.push([threadId, itemId]);
      },
    } as unknown as ConversationRuntime;
    const renderCommand = (item: CodexTranscriptEntry) =>
      render(
        <TooltipProvider>
          <CodexThreadSettingsProvider>
            <ConversationRuntimeContext.Provider value={runtime}>
              <CommandToolCall item={item} />
            </ConversationRuntimeContext.Provider>
          </CodexThreadSettingsProvider>
        </TooltipProvider>,
      );

    const withheld = renderCommand(buildCommandEntry({ aggregatedOutput: null }));
    expect(reads).toEqual([]);
    await act(async () => {
      await expandCommandShell(withheld.container);
    });
    expect(reads).toEqual([["thread-1", "cmd-1"]]);
    withheld.unmount();

    const present = renderCommand(buildCommandEntry({ itemId: "cmd-2" }));
    await act(async () => {
      await expandCommandShell(present.container);
    });
    expect(reads).toEqual([["thread-1", "cmd-1"]]);
  });

  test("renders a declined parsed read as an inspectable command with direct authorization explanation", async () => {
    const item = buildCommandEntry({
      command: "cat private.txt",
      status: "declined",
      executionStatus: "declined",
      exitCode: null,
      parsedCmd: {
        type: "read",
        cmd: "cat private.txt",
        name: "private.txt",
        path: "private.txt",
        isFinished: true,
      },
      commandActions: [
        { type: "read", command: "cat private.txt", name: "private.txt", path: "private.txt" },
      ],
      durationMs: 5_000,
      aggregatedOutput: "Automatic approval review denied this request.",
    });
    const review = buildAutomaticApprovalReviewEntry({
      rawItem: {
        review: { status: "denied", riskLevel: "high", rationale: "Private review rationale" },
      },
    });
    const { getByRole, getByText, queryByRole, queryByText } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={item} automaticApprovalReviews={[review]} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );
    const trigger = getByRole("button", {
      name: "Command declined by auto-review: cat private.txt",
    });
    expect(queryByRole("link", { name: "private.txt" })).toBeNull();
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    expect(
      getByRole("button", { name: "Command declined by auto-review" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    expect(
      getByText("Requires explicit authorization because this action is considered high risk"),
    ).toBeTruthy();
    expect(getByText("Automatic approval review denied this request.")).toBeTruthy();
    expect(queryByRole("button", { name: "Auto-review denied high risk" })).toBeNull();
    expect(queryByText("Private review rationale")).toBeNull();
  });

  test("keeps automatic-review refusals visible without raw command details in steps mode", () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_PROSE" }),
    );
    const item = buildCommandEntry({
      command: "cat private.txt",
      status: "declined",
      executionStatus: "declined",
      parsedCmd: {
        type: "read",
        cmd: "cat private.txt",
        name: "private.txt",
        path: "private.txt",
        isFinished: true,
      },
    });
    const review = buildAutomaticApprovalReviewEntry({ rawItem: { review: { status: "denied" } } });
    const { getByText, queryByText, queryByRole } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={item} automaticApprovalReviews={[review]} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );
    expect(getByText("Command declined by auto-review")).toBeTruthy();
    expect(queryByText("cat private.txt")).toBeNull();
    expect(queryByRole("button", { name: /Command declined/ })).toBeNull();
  });

  test("keeps an expanded command shell open when a running command settles", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const inProgressEntry = buildCommandEntry({
      status: "inProgress",
      markdownText: "Running bun test",
      command: "bun test",
      aggregatedOutput: "running...\n",
      exitCode: null,
      toolCall: {
        subtype: "command",
        toolName: "bash",
        result: "running...\n",
      },
    });
    const completedEntry = buildCommandEntry();

    const { container, rerender } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={inProgressEntry} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    const summaryToggle = container.querySelector<HTMLElement>(
      "[data-testid='command-tool-summary-toggle'] > button",
    );
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={completedEntry} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    await settleAsyncRender();

    expect(Boolean(container.querySelector('[data-thread-find-skip="true"]'))).toBe(false);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(true);
  });

  test("renders attached automatic approval reviews before the command shell body", async () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry()}
            automaticApprovalReviews={[buildAutomaticApprovalReviewEntry()]}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Auto-review approved"))).toBe(false);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);

    await expandCommandShell(container);

    const reviewButton =
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
        textContent(element).includes("Auto-review approved"),
      ) ?? null;
    const shellLabel =
      Array.from(container.querySelectorAll<HTMLElement>("span")).find(
        (element) => textContent(element) === "Shell",
      ) ?? null;

    expect(Boolean(reviewButton)).toBe(true);
    expect(Boolean(shellLabel)).toBe(true);
    expect(
      Boolean(
        reviewButton && shellLabel
          ? reviewButton.compareDocumentPosition(shellLabel) & Node.DOCUMENT_POSITION_FOLLOWING
          : false,
      ),
    ).toBe(true);
    expect(Boolean(textContent(container).includes("Auto-review approved"))).toBe(true);
  });

  test("renders explicit canonical exit codes without parsing output text", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "failed",
              command: "bun test",
              aggregatedOutput: "tests failed\n",
              exitCode: 7,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    await expandCommandShell(container);
    expect(Boolean(textContent(container).includes("Exit code 7"))).toBe(true);
  });
});
