import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CodexTranscriptEntry } from "../../../../../lib/types";
import { render, textContent } from "../../../../../test/dom";
import { DynamicToolCall, DynamicToolCallSummary } from "./dynamic-tool-call";
import type { CodexAppHandoffOperation } from "../../../../../../shared/codex-thread-handoff";
import { buildThreadHandoffOperation } from "../../../../../test/thread-handoff-fixture";

import {
  createThreadHandoffStore,
  ThreadHandoffStoreProvider,
} from "../../../../../lib/thread-handoff-runtime";
import type { CodexThreadHandoffSnapshot } from "../../../../../../shared/codex-thread-handoff";

vi.mock("../../../../../lib/use-theme", () => ({
  useTheme: () => ({ resolved: "dark" }),
}));

function activityText(container: HTMLElement): string {
  const shimmer = container.querySelector(".loading-shimmer-pure-text");
  return shimmer?.firstChild?.textContent ?? textContent(container);
}

function buildDynamicEntry(
  overrides?: Partial<NonNullable<CodexTranscriptEntry["dynamicToolCall"]>>,
): CodexTranscriptEntry {
  const dynamicToolCall: NonNullable<CodexTranscriptEntry["dynamicToolCall"]> = {
    callId: "dynamic-1",
    namespace: "codex_app",
    tool: "read_thread",
    arguments: { threadId: "thread-1" },
    status: "completed",
    contentItems: [{ type: "inputText", text: '{"schemaVersion":1}' }],
    success: true,
    durationMs: 12,
    completed: true,
    ...overrides,
  };

  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "dynamic-1",
    entryId: "dynamic-1",
    type: "dynamicToolCall",
    kind: "toolCall",
    semanticKind: "dynamicToolCall",
    status: "completed",
    toolCall: {
      subtype: "dynamic",
      toolName: dynamicToolCall.tool,
      server: dynamicToolCall.namespace ?? undefined,
      args: dynamicToolCall.arguments,
      result: dynamicToolCall.contentItems ?? undefined,
    },
    dynamicToolCall,
    rawItem: {
      type: "dynamicToolCall",
      id: dynamicToolCall.callId,
      namespace: dynamicToolCall.namespace,
      tool: dynamicToolCall.tool,
      arguments: dynamicToolCall.arguments,
      status: dynamicToolCall.status ?? "completed",
      contentItems: dynamicToolCall.contentItems ?? null,
      success: dynamicToolCall.success ?? null,
      durationMs: dynamicToolCall.durationMs ?? null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function renderHandoff(
  item: CodexTranscriptEntry,
  initialOperation: CodexAppHandoffOperation | null,
) {
  let snapshot: CodexThreadHandoffSnapshot = {
    revision: 1,
    operations: initialOperation ? [initialOperation] : [],
  };
  let deliver: (next: CodexThreadHandoffSnapshot) => void = () => undefined;
  const store = createThreadHandoffStore({
    read: async () => snapshot,
    subscribe: (listener) => {
      deliver = listener;
      return () => {
        deliver = () => undefined;
      };
    },
  });
  const view = render(
    <ThreadHandoffStoreProvider value={store}>
      <DynamicToolCall item={item} />
    </ThreadHandoffStoreProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return {
    ...view,
    publish: async (operation: CodexAppHandoffOperation) => {
      snapshot = { revision: snapshot.revision + 1, operations: [operation] };
      await act(async () => {
        deliver(snapshot);
        await Promise.resolve();
      });
    },
  };
}

describe("DynamicToolCall", () => {
  test("renders navigable Codex app thread rows through the registry renderer", async () => {
    const openedThreads: string[] = [];
    const { getByRole } = render(
      <DynamicToolCall
        item={buildDynamicEntry()}
        onOpenThread={(threadId) => {
          openedThreads.push(threadId);
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Read chat" }));
      await Promise.resolve();
    });

    expect(openedThreads.join(",")).toBe("thread-1");
  });

  test("renders completed create_thread success as an open-task card", async () => {
    const openedThreads: string[] = [];
    const { getByRole, container } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          tool: "create_thread",
          arguments: {
            prompt: "Continue in a background chat",
            target: { type: "projectless" },
          },
          contentItems: [{ type: "inputText", text: '{"threadId":"thread-created"}' }],
        })}
        onOpenThread={(threadId) => {
          openedThreads.push(threadId);
        }}
      />,
    );

    expect(textContent(container).includes("Chat created")).toBe(true);
    expect(textContent(container).includes("Open chat")).toBe(true);
    expect(getByRole("button", { name: "Open chat" }).getAttribute("aria-label")).toBe("Open chat");

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Open chat" }));
      await Promise.resolve();
    });

    expect(openedThreads.join(",")).toBe("thread-created");
  });

  test("opens create_thread client results through normal thread navigation", async () => {
    const openedThreads: string[] = [];
    const { getByRole, container } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          tool: "create_thread",
          arguments: {
            prompt: "Continue in a worktree chat",
            target: {
              type: "project",
              projectId: "project-1",
              environment: { type: "worktree" },
            },
          },
          contentItems: [
            {
              type: "inputText",
              text: '{"clientThreadId":"client-new-thread:11111111-1111-4111-8111-111111111111"}',
            },
          ],
        })}
        onOpenThread={(threadId) => {
          openedThreads.push(threadId);
        }}
      />,
    );

    expect(textContent(container).includes("Worktree chat")).toBe(true);
    expect(textContent(container).includes("Open chat")).toBe(true);
    expect(getByRole("button", { name: "Open chat" }).getAttribute("aria-label")).toBe("Open chat");

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Open chat" }));
      await Promise.resolve();
    });

    expect(openedThreads.join(",")).toBe("client-new-thread:11111111-1111-4111-8111-111111111111");
  });

  test("renders settings and Chrome tab-context calls with registered labels", () => {
    const { container: settings } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          tool: "read_settings",
          arguments: {},
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
          completed: false,
        })}
      />,
    );
    const { container: chrome } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          namespace: "chrome_extension",
          tool: "get_tab_context",
          arguments: { tabId: 12 },
          status: "completed",
          completed: true,
        })}
      />,
    );

    expect(activityText(settings)).toBe("Reading settings");
    expect(textContent(chrome).includes("Read tab")).toBe(true);
    expect(textContent(chrome).includes("Get Tab Context")).toBe(false);
  });

  test("falls back when a known registry renderer rejects invalid arguments", () => {
    const { container } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          namespace: "chrome_extension",
          tool: "get_tab_context",
          arguments: { tabId: -1 },
          status: "completed",
          completed: true,
        })}
      />,
    );

    expect(textContent(container).includes("Get Tab Context")).toBe(true);
  });

  test("shows both sides of an NFM patch in its specialised preview", () => {
    const { container } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          namespace: "nodex_app",
          tool: "edit_document",
          arguments: {
            documentId: "document-1",
            ifRevision: "revision-1",
            body: {
              kind: "nfm.patch",
              patches: [
                {
                  oldNfm: "## Draft\n- [ ] Verify migration",
                  newNfm: "## Ready\n- [x] Verify migration",
                },
              ],
            },
          },
        })}
      />,
    );

    expect(textContent(container).includes("## Draft")).toBe(true);
    expect(textContent(container).includes("## Ready")).toBe(true);
    expect(textContent(container).includes("−2")).toBe(true);
    expect(textContent(container).includes("+2")).toBe(true);
    expect(textContent(container).includes("Arguments")).toBe(false);
  });

  test("uses active fallback labels for in-progress generic dynamic tools", () => {
    const { container } = render(
      <DynamicToolCall
        item={buildDynamicEntry({
          tool: "automation_update",
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
          completed: false,
        })}
      />,
    );

    expect(activityText(container)).toBe("Updating scheduled task");
  });

  test("renders completed automation_update results as openable scheduled task cards", async () => {
    const opened: string[] = [];
    const { container, getByRole } = renderWithQueryClient(
      <DynamicToolCall
        item={buildDynamicEntry({
          tool: "automation_update",
          arguments: {
            mode: "create",
            kind: "cron",
            status: "ACTIVE",
            name: "Release notes",
            prompt: "Review release notes.",
            rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
            cwds: ["/repo/nodex"],
            executionEnvironment: "worktree",
            localEnvironmentConfigPath: null,
            model: "gpt-5-codex",
            reasoningEffort: "medium",
          },
          contentItems: [
            { type: "inputText", text: "Created automation in the app." },
            { type: "inputText", text: '{"automationId":"automation-release","mode":"create"}' },
          ],
        })}
        onOpenSummaryScheduledAutomation={(input) => {
          opened.push(`${input.automationId}:${input.title}`);
        }}
      />,
    );

    expect(textContent(container).includes("Release notes")).toBe(true);
    expect(textContent(container).includes("Created")).toBe(true);
    expect(textContent(container).includes("Daily")).toBe(true);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /Release notes/i }));
      await Promise.resolve();
    });

    expect(opened.join(",")).toBe("automation-release:Release notes");
  });

  test("opens suggested automation_update create cards as scheduled task side-panel proposals", async () => {
    const opened: string[] = [];
    const item = {
      ...buildDynamicEntry({
        tool: "automation_update",
        arguments: {
          mode: "suggested_create",
          kind: "cron",
          status: "ACTIVE",
          name: "Review release notes",
          prompt: "Review release notes and summarize risks.",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          cwds: "/repo/nodex",
          executionEnvironment: "worktree",
          localEnvironmentConfigPath: null,
          model: "gpt-5-codex",
          reasoningEffort: "medium",
        },
      }),
      threadId: "thread-current",
    };
    const { container, getByRole } = renderWithQueryClient(
      <DynamicToolCall
        item={item}
        onOpenSummaryScheduledAutomation={(input) => {
          opened.push(
            [
              input.mode,
              input.title,
              input.createInput?.kind,
              input.createInput?.name,
              input.createInput?.cwds?.join(","),
            ].join(":"),
          );
        }}
      />,
    );

    expect(textContent(container).includes("Proposed")).toBe(true);
    expect(textContent(container).includes("Open")).toBe(true);
    expect(textContent(container).includes("Create scheduled task")).toBe(false);
    expect(textContent(container).includes("Cancel")).toBe(false);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /Review release notes/i }));
      await Promise.resolve();
    });

    expect(opened.join(",")).toBe(
      "suggested-create:Review release notes:cron:Review release notes:/repo/nodex",
    );
  });
  test("collapses a live handoff when the operation settles without rewriting the original call", async () => {
    const item = buildDynamicEntry({
      tool: "handoff_thread",
      arguments: { threadId: "thread-target" },
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            operationId: "operation-1",
            status: "running",
            threadTitle: "Release notes",
            destinationHostDisplayName: "Local",
          }),
        },
      ],
    });
    const view = await renderHandoff(item, buildThreadHandoffOperation());
    expect(
      view
        .getByRole("button", { name: /Handing off Release notes to Local/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(view.getByText("Checking out codex/release in worktree")).toBeTruthy();
    await view.publish(buildThreadHandoffOperation({ status: "success", revision: 2 }));
    expect(
      view
        .getByRole("button", { name: "Handed off Release notes to Local" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("expands a running handoff when its operation arrives after the tool row", async () => {
    const item = buildDynamicEntry({
      tool: "handoff_thread",
      arguments: { threadId: "thread-target" },
      completed: false,
      success: null,
      contentItems: null,
    });
    const view = await renderHandoff(item, null);
    expect(view.queryByRole("button", { name: /Handing off/ })).toBeNull();
    await view.publish(
      buildThreadHandoffOperation({ operationId: "codex-app:handoff:thread-1:dynamic-1" }),
    );
    expect(
      view
        .getByRole("button", { name: /Handing off Release notes to Local/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("preserves a manual running collapse separately from settled expansion", async () => {
    const item = buildDynamicEntry({
      tool: "handoff_thread",
      arguments: { threadId: "thread-target" },
    });
    const operationId = "codex-app:handoff:thread-1:dynamic-1";
    const initialOperation = buildThreadHandoffOperation({ operationId });
    const view = await renderHandoff(item, initialOperation);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Handing off Release notes to Local/ }));
      await Promise.resolve();
    });
    await view.publish(
      buildThreadHandoffOperation({
        operationId,
        revision: 2,
        steps: [
          ...initialOperation.steps,
          {
            id: "apply-changes-to-worktree",
            label: "Apply changes",
            status: "running",
            message: null,
            updatedAt: 2,
          },
        ],
      }),
    );
    expect(
      view
        .getByRole("button", { name: /Handing off Release notes to Local/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await view.publish(buildThreadHandoffOperation({ operationId, status: "error", revision: 3 }));
    expect(
      view
        .getByRole("button", { name: "Failed to hand off Release notes to Local" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "Failed to hand off Release notes to Local" }),
      );
      await Promise.resolve();
    });
    expect(
      view
        .getByRole("button", { name: "Failed to hand off Release notes to Local" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("passes sentence position to registered dynamic summary labels", () => {
    const call = buildDynamicEntry({
      tool: "write_settings",
      arguments: {},
      success: false,
    }).dynamicToolCall!;
    const view = render(
      <DynamicToolCallSummary call={call} variant="summary-text" isLeadingSummaryPart={false} />,
    );
    expect(view.getByText("couldn't update settings")).toBeTruthy();
    view.rerender(
      <DynamicToolCallSummary call={call} variant="summary-text" isLeadingSummaryPart />,
    );
    expect(view.getByText("Couldn't update settings")).toBeTruthy();
  });
});
