import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "../../../../../components/ui/tooltip";
import { THREAD_SETTINGS_STORAGE_KEY } from "../../../../../lib/codex-thread-settings";
import { render, settleAsyncRender, textContent } from "../../../../../test/dom";
import type { CodexTranscriptEntry } from "../../../../../lib/types";
import { CodexThreadSettingsProvider } from "../../../../../lib/use-codex-thread-settings";
import { CommandToolCall, isDateCommand, resolveCommandSummaryLabel } from "./command-tool-call";

const LONG_COMMAND = [
  "bun x tsx scripts/collect-long-command-metrics.ts",
  "--project nodex",
  "--scope renderer",
  "--filter command-tool-call",
  "--json",
].join(" ");

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

  test("keeps in-progress commands collapsed on first mount", () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
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
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Running command"))).toBe(true);
    expect(Boolean(textContent(container).includes("Running bun test"))).toBe(false);
    expect(Boolean(container.querySelector("[data-tool-activity-icon='run-command']"))).toBe(true);
    const shimmer = container.querySelector<HTMLElement>(".loading-shimmer-pure-text");
    expect(shimmer?.firstChild?.textContent ?? "").toBe("Running command");
    expect(Boolean(shimmer?.textContent?.includes("bun test"))).toBe(false);
    const collapsedBody = container.querySelector('[data-thread-find-skip="true"]');
    expect(Boolean(collapsedBody)).toBe(true);
    expect((collapsedBody as HTMLElement | null)?.style.height === "0px").toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(true);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);
  });

  test("uses canonical started and duration timing for active and settled labels", () => {
    const originalDateNow = Date.now;
    Date.now = () => 10_000;
    try {
      const view = render(
        <TooltipProvider>
          <CodexThreadSettingsProvider>
            <CommandToolCall
              item={buildCommandEntry({
                status: "inProgress",
                startedAtMs: 6_500,
                durationMs: null,
              })}
            />
          </CodexThreadSettingsProvider>
        </TooltipProvider>,
      );
      expect(Boolean(textContent(view.container).includes("for 3s"))).toBe(true);

      view.rerender(
        <TooltipProvider>
          <CodexThreadSettingsProvider>
            <CommandToolCall
              item={buildCommandEntry({
                status: "completed",
                startedAtMs: 6_500,
                durationMs: 2_500,
              })}
            />
          </CodexThreadSettingsProvider>
        </TooltipProvider>,
      );
      expect(Boolean(textContent(view.container).includes("in 2s"))).toBe(true);
    } finally {
      Date.now = originalDateNow;
    }
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

  test("resolves Electron command summary labels for generic, date, background, and skill-script commands", () => {
    expect(isDateCommand("/bin/date -u +%Y-%m-%d")).toBe(true);
    expect(isDateCommand("date --rfc-3339=seconds")).toBe(true);
    expect(isDateCommand("date tomorrow")).toBe(false);
    expect(isDateCommand("date ''")).toBe(false);

    expect(
      resolveCommandSummaryLabel({
        command: "bun test",
        effectiveStatus: "inProgress",
        isExpanded: false,
        isTurnInProgress: true,
        processId: null,
      }),
    ).toBe("Running command");
    expect(
      resolveCommandSummaryLabel({
        command: "bun test",
        effectiveStatus: "completed",
        isExpanded: false,
        isTurnInProgress: false,
        processId: null,
      }),
    ).toBe("Ran bun test");
    expect(
      resolveCommandSummaryLabel({
        command: "bun test",
        effectiveStatus: "completed",
        isExpanded: true,
        isTurnInProgress: false,
        processId: null,
      }),
    ).toBe("Ran command");
    expect(
      resolveCommandSummaryLabel({
        command: "date -u",
        effectiveStatus: "interrupted",
        isExpanded: false,
        isTurnInProgress: false,
        processId: null,
      }),
    ).toBe("Stopped checking the current date and time");
    expect(
      resolveCommandSummaryLabel({
        command: "bun run dev",
        effectiveStatus: "inProgress",
        isExpanded: false,
        isTurnInProgress: false,
        processId: "4172",
      }),
    ).toBe("Started background terminal with bun run dev");
    expect(
      resolveCommandSummaryLabel({
        command: "python .codex/skills/review-helper/scripts/check.py",
        effectiveStatus: "completed",
        isExpanded: false,
        isTurnInProgress: false,
        processId: null,
      }),
    ).toBe("Ran script check.py from Review Helper skill");
    expect(
      resolveCommandSummaryLabel({
        command: "python .codex/skills/review-helper/check.py",
        effectiveStatus: "completed",
        isExpanded: false,
        isTurnInProgress: false,
        processId: null,
      }),
    ).toBe("Ran python .codex/skills/review-helper/check.py");
    expect(
      resolveCommandSummaryLabel({
        command: "python .codex/skills/review-helper/scripts/check.py",
        effectiveStatus: "inProgress",
        isExpanded: false,
        isTurnInProgress: false,
        processId: "4172",
      }),
    ).toBe("Started background terminal running check.py from Review Helper skill");
  });

  test("switches settled generic command summary from specific collapsed text to generic expanded text", async () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={buildCommandEntry()} isStreamingTurn={false} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Ran bun test"))).toBe(true);

    await expandCommandShell(container);

    expect(Boolean(textContent(container).includes("Ran command"))).toBe(true);
    expect(Boolean(textContent(container).includes("Ran bun test"))).toBe(false);
  });

  test("renders date and background terminal command summaries", () => {
    const { container, rerender } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              command: "date -u",
              markdownText: "Running date",
              aggregatedOutput: "",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Checking the current date and time"))).toBe(
      true,
    );
    expect(
      container.querySelector<HTMLElement>(".loading-shimmer-pure-text")?.firstChild?.textContent ??
        "",
    ).toBe("Checking the current date and time");

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "completed",
              command: "date -u",
              markdownText: "Ran date",
              aggregatedOutput: "",
              exitCode: 0,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );
    expect(Boolean(textContent(container).includes("Checked the current date and time"))).toBe(
      true,
    );

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              command: "bun run dev",
              markdownText: "Running bun run dev",
              aggregatedOutput: "ready\n",
              exitCode: null,
              processId: "4172",
            })}
            isStreamingTurn={false}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(
      Boolean(textContent(container).includes("Started background terminal with bun run dev")),
    ).toBe(true);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
  });

  test("keeps settled commands collapsed on first mount in steps-with-commands mode", () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={buildCommandEntry()} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );
    const collapsedBody = container.querySelector('[data-thread-find-skip="true"]');
    expect(Boolean(collapsedBody)).toBe(true);
    expect((collapsedBody as HTMLElement | null)?.style.height === "0px").toBe(true);
  });

  test("keeps settled commands collapsed on first mount in steps-with-output mode", () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={buildCommandEntry()} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    const collapsedBody = container.querySelector('[data-thread-find-skip="true"]');
    expect(Boolean(collapsedBody)).toBe(true);
    expect((collapsedBody as HTMLElement | null)?.style.height === "0px").toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(true);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);
  });

  test("suppresses command cards entirely in steps mode", () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_PROSE" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall item={buildCommandEntry()} />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(textContent(container)).toBe("");
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

  test("shows in-progress skill definition reads in steps mode", () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_PROSE" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              command: "cat .codex/skills/review-helper/SKILL.md",
              markdownText: "Reading review helper skill",
              commandActions: [
                {
                  type: "read",
                  command: "cat .codex/skills/review-helper/SKILL.md",
                  name: ".codex/skills/review-helper/SKILL.md",
                  path: ".codex/skills/review-helper/SKILL.md",
                },
              ],
              aggregatedOutput: "",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Reading Review Helper skill"))).toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);
  });

  test("renders a completed single read action as a compact row without shell chrome", () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "sed -n '1,80p' src/index.ts",
              markdownText: "Read src/index.ts",
              commandActions: [
                {
                  type: "read",
                  command: "sed -n '1,80p' src/index.ts",
                  name: "src/index.ts",
                  path: "src/index.ts",
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Read src/index.ts"))).toBe(true);
    expect(Boolean(textContent(container).includes("Explored"))).toBe(false);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);
    expect(Boolean(container.querySelector("[data-testid='command-tool-summary-toggle']"))).toBe(
      false,
    );
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);
    expect(Boolean(container.querySelector("[data-agent-activity-file-link]"))).toBe(true);
  });

  test("hides an in-progress single read action", () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              command: "sed -n '1,80p' src/index.ts",
              markdownText: "Reading src/index.ts",
              commandActions: [
                {
                  type: "read",
                  command: "sed -n '1,80p' src/index.ts",
                  name: "src/index.ts",
                  path: "src/index.ts",
                },
              ],
              aggregatedOutput: "",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(textContent(container)).toBe("");
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);
  });

  test("renders completed single search and list actions as compact rows", () => {
    const { container, rerender } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "rg command src",
              markdownText: "Searched for command",
              commandActions: [
                {
                  type: "search",
                  command: "rg command src",
                  query: "command",
                  path: "src",
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Searched for command in src"))).toBe(true);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "find src -maxdepth 1",
              markdownText: "Listed files",
              commandActions: [
                {
                  type: "listFiles",
                  command: "find src -maxdepth 1",
                  path: "src",
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Listed files in src"))).toBe(true);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);
  });

  test("renders completed search and list fallback labels", () => {
    const { container, rerender } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "rg command",
              markdownText: "Searched for command",
              commandActions: [
                {
                  type: "search",
                  command: "rg command",
                  query: "command",
                  path: null,
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Searched for command"))).toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "find . -name '*.ts'",
              markdownText: "Searched for files",
              commandActions: [
                {
                  type: "search",
                  command: "find . -name '*.ts'",
                  query: null,
                  path: null,
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Searched for files"))).toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "ls",
              markdownText: "Listed files",
              commandActions: [
                {
                  type: "listFiles",
                  command: "ls",
                  path: null,
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Listed files"))).toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);
  });

  test("hides in-progress single search and list actions", () => {
    const { container, rerender } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              command: "rg command src",
              markdownText: "Searching for command",
              commandActions: [
                {
                  type: "search",
                  command: "rg command src",
                  query: "command",
                  path: "src",
                },
              ],
              aggregatedOutput: "",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(textContent(container)).toBe("");

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              command: "find src -maxdepth 1",
              markdownText: "Listing files",
              commandActions: [
                {
                  type: "listFiles",
                  command: "find src -maxdepth 1",
                  path: "src",
                },
              ],
              aggregatedOutput: "",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(textContent(container)).toBe("");
  });

  test("renders completed skill definition reads without treating them as ordinary file reads", () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "cat .codex/skills/review-helper/SKILL.md",
              markdownText: "Read review helper skill",
              commandActions: [
                {
                  type: "read",
                  command: "cat .codex/skills/review-helper/SKILL.md",
                  name: ".codex/skills/review-helper/SKILL.md",
                  path: ".codex/skills/review-helper/SKILL.md",
                },
              ],
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Read Review Helper skill"))).toBe(true);
    expect(
      Boolean(textContent(container).includes("Read .codex/skills/review-helper/SKILL.md")),
    ).toBe(false);
  });

  test("lets in-progress commands expand and collapse manually", async () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
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
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    const summaryToggle = container.querySelector<HTMLElement>(
      "[data-testid='command-tool-summary-toggle'] > button",
    );
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    const expandedBody = container.querySelector("[data-thread-find-skip]");
    expect(Boolean(expandedBody)).toBe(false);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    const collapsedBody = container.querySelector('[data-thread-find-skip="true"]');
    expect(Boolean(collapsedBody)).toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(true);
    expect(Boolean(textContent(container).includes("Shell"))).toBe(false);
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

  test("wraps parsed command summaries with attached automatic approval review rows", async () => {
    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: "rg needle src",
              commandActions: [
                {
                  type: "search",
                  query: "needle",
                  path: "src",
                  command: "rg needle src",
                },
              ],
            })}
            automaticApprovalReviews={[buildAutomaticApprovalReviewEntry()]}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Searched for needle in src"))).toBe(true);
    expect(Boolean(textContent(container).includes("Auto-review approved"))).toBe(true);
    expect(Boolean(container.querySelector('[data-testid="exec-shell-body"]'))).toBe(false);

    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(Boolean(disclosure)).toBe(true);
    const disclosureBody = disclosure?.parentElement?.nextElementSibling;
    expect(disclosureBody?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(disclosure as HTMLButtonElement);
    await settleAsyncRender();

    expect(disclosure?.getAttribute("aria-expanded") ?? "").toBe("true");
    expect(disclosureBody?.getAttribute("aria-hidden")).toBe("false");
    expect(Boolean(textContent(container).includes("Auto-review approved"))).toBe(true);
  });

  test("expands a long command line when clicked", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: LONG_COMMAND,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    await expandCommandShell(container);

    const toggle = container.querySelector<HTMLElement>("[data-command-shell-line-toggle]");
    expect(Boolean(toggle)).toBe(true);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle as HTMLElement);
    await settleAsyncRender();

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  test("expands a long command line from keyboard", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              command: LONG_COMMAND,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    await expandCommandShell(container);

    const toggle = container.querySelector<HTMLElement>("[data-command-shell-line-toggle]");
    expect(Boolean(toggle)).toBe(true);
    fireEvent.keyDown(toggle as HTMLElement, { key: "Enter" });
    await settleAsyncRender();

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  test("does not show a no-output placeholder while a command is still running", () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "inProgress",
              markdownText: "Running bun test",
              command: "bun test",
              aggregatedOutput: "",
              exitCode: null,
              toolCall: {
                subtype: "command",
                toolName: "bash",
                result: "",
              },
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("No output"))).toBe(false);
  });

  test("shows a no-output placeholder once a blank command output has settled", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "completed",
              markdownText: "Ran bun test",
              command: "bun test",
              aggregatedOutput: "",
              exitCode: 0,
              toolCall: {
                subtype: "command",
                toolName: "bash",
                result: "",
              },
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    await expandCommandShell(container);
    expect(Boolean(textContent(container).includes("No output"))).toBe(true);
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

  test("renders stopped, success, and unknown command footer labels", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_EXECUTION" }),
    );

    const { container, rerender } = render(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "interrupted",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );

    await expandCommandShell(container);
    expect(Boolean(textContent(container).includes("Stopped"))).toBe(true);

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "completed",
              exitCode: 0,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );
    await settleAsyncRender();
    expect(Boolean(textContent(container).includes("Success"))).toBe(true);

    rerender(
      <TooltipProvider>
        <CodexThreadSettingsProvider>
          <CommandToolCall
            item={buildCommandEntry({
              status: "failed",
              exitCode: null,
            })}
          />
        </CodexThreadSettingsProvider>
      </TooltipProvider>,
    );
    await settleAsyncRender();
    expect(Boolean(textContent(container).includes("Exit code unknown"))).toBe(true);
  });
});
