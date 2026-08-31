import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { NodexTooltipProvider as TooltipProvider } from "../../../../components/ui/tooltip";
import type {
  CodexConversationChildMembership,
  CodexConversationItem,
} from "../../../../lib/types";
import {
  installElementScrollHeight,
  installMeasuredResizeObserver,
} from "../../../../test/browser-globals";
import {
  render as renderWithoutTooltip,
  settleAsyncRender,
  textContent,
} from "../../../../test/dom";
import type {
  CodexMultiAgentActionName,
  CodexMultiAgentActionStatus,
  CodexMultiAgentAgentStatus,
} from "../../../../../shared/codex-transcript-special-items";
import type { ThreadOpenThreadContext } from "../../thread-stage-types";
import { MultiAgentActionSurface } from "./multi-agent-action-surface";

function render(ui: ReactElement) {
  return renderWithoutTooltip(<TooltipProvider>{ui}</TooltipProvider>);
}

function activityHeaderText(element: HTMLElement): string {
  const accessible = element.cloneNode(true) as HTMLElement;
  for (const hidden of accessible.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return textContent(accessible);
}

function multiAgentDisclosureButton(header: HTMLElement): HTMLButtonElement {
  const button = header.querySelector("button");
  if (!button) throw new Error("Expected the multi-agent disclosure button");
  return button;
}

function buildMultiAgentItem(overrides?: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-multi-agent",
    entryId: "item-multi-agent",
    type: "collabAgentToolCall",
    kind: "toolCall",
    semanticKind: "multiAgentAction",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    rawItem: {
      id: "item-multi-agent",
      tool: "sendInput",
      status: "completed",
      senderThreadId: "thread-main",
      receiverThreadIds: ["thread-agent-1"],
      receiverThreads: [
        {
          threadId: "thread-agent-1",
          thread: {
            nickname: "@research",
            model: "gpt-5.4-mini",
            agentRole: "worker",
          },
        },
      ],
      prompt: "Gather the failing tests.",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      agentsStates: {
        "thread-agent-1": {
          status: "running",
          message: "Inspecting the renderer tests",
        },
      },
    },
    ...overrides,
  };
}

function buildActionItem({
  id,
  action,
  status,
  prompt = "Gather the failing tests.",
  receiverThreadId = "thread-agent-1",
}: {
  id: string;
  action: CodexMultiAgentActionName;
  status: CodexMultiAgentActionStatus;
  prompt?: string | null;
  receiverThreadId?: string;
}): CodexConversationItem {
  return buildMultiAgentItem({
    itemId: id,
    entryId: id,
    status,
    rawItem: {
      id,
      tool: action,
      status,
      senderThreadId: "thread-main",
      receiverThreadIds: [receiverThreadId],
      receiverThreads: [
        {
          threadId: receiverThreadId,
          thread: {
            nickname: `@${receiverThreadId.replace(/^thread-agent-/, "agent")}`,
            model: "gpt-5.4-mini",
            agentRole: "worker",
          },
        },
      ],
      prompt,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      agentsStates: {},
    },
  });
}

describe("MultiAgentActionSurface", () => {
  beforeEach(() => {
    installElementScrollHeight(96);
    installMeasuredResizeObserver({ blockSize: 96, inlineSize: 320 });
  });

  test("renders a dedicated Codex-style grouped surface for settled items", async () => {
    const { getByTestId, container } = render(
      <MultiAgentActionSurface items={[buildMultiAgentItem()]} />,
    );

    const header = getByTestId("multi-agent-action-header");
    expect(textContent(header).includes("Messaged")).toBe(true);
    expect(textContent(header).includes("an agent")).toBe(true);
    expect(Boolean(container.querySelector('[data-subagent-glyph-icon="true"]'))).toBe(true);

    fireEvent.click(multiAgentDisclosureButton(header));
    await settleAsyncRender();

    const rows = getByTestId("multi-agent-action-rows");
    const content = textContent(rows);
    expect(content.includes("Messaged research (worker): Gather the failing tests.")).toBe(true);
    expect(Boolean(container.querySelector('[style*="pointer-events: auto"]'))).toBe(true);
  });

  test("keeps in-progress actions collapsed but expandable without rendering wait-only entries", async () => {
    const inProgressItem = buildMultiAgentItem({
      status: "inProgress",
      rawItem: {
        id: "item-multi-agent-live",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-main",
        receiverThreadIds: ["thread-agent-1", "thread-agent-2"],
        prompt: "Investigate the regression",
        agentsStates: {
          "thread-agent-1": { status: "pendingInit", message: null },
          "thread-agent-2": { status: "running", message: "Reading the transcript" },
        },
      },
    });
    const waitItem = buildMultiAgentItem({
      itemId: "item-multi-agent-wait",
      entryId: "item-multi-agent-wait",
      rawItem: {
        id: "item-multi-agent-wait",
        tool: "wait",
        status: "completed",
        senderThreadId: "thread-main",
        receiverThreadIds: ["thread-agent-1"],
        agentsStates: {},
      },
    });

    const { container, getByTestId } = render(
      <MultiAgentActionSurface items={[inProgressItem, waitItem]} />,
    );
    const content = textContent(container);
    expect(content.includes("Creating")).toBe(true);
    expect(content.includes("2 agents")).toBe(true);
    expect(content.includes("Created")).toBe(false);
    expect(content.includes("Waiting")).toBe(false);
    const headerButton = multiAgentDisclosureButton(getByTestId("multi-agent-action-header"));
    expect(headerButton.getAttribute("aria-expanded")).toBe("false");
    expect(getByTestId("multi-agent-action-rows").parentElement?.style.visibility).toBe("hidden");

    fireEvent.click(headerButton);
    await settleAsyncRender();

    expect(headerButton.getAttribute("aria-expanded")).toBe("true");
    expect(getByTestId("multi-agent-action-rows").parentElement?.style.visibility).toBe("visible");
  });

  test("uses Electron header grammar and count labels", () => {
    const cases: Array<{
      action: CodexMultiAgentActionName;
      status: CodexMultiAgentActionStatus;
      expected: string;
    }> = [
      { action: "spawnAgent", status: "inProgress", expected: "Creating an agent" },
      { action: "spawnAgent", status: "completed", expected: "Created an agent" },
      { action: "spawnAgent", status: "failed", expected: "Failed to create an agent" },
      { action: "sendInput", status: "inProgress", expected: "Messaging an agent" },
      { action: "sendInput", status: "completed", expected: "Messaged an agent" },
      { action: "sendInput", status: "failed", expected: "Failed to message an agent" },
      { action: "sendInput", status: "interrupted", expected: "Interrupted an agent" },
      { action: "sendMessage", status: "completed", expected: "Messaged an agent" },
      { action: "followupTask", status: "inProgress", expected: "Messaging an agent" },
      { action: "interruptAgent", status: "inProgress", expected: "Interrupting an agent" },
      { action: "interruptAgent", status: "completed", expected: "Interrupted an agent" },
      { action: "interruptAgent", status: "failed", expected: "Failed to interrupt an agent" },
      { action: "listAgents", status: "completed", expected: "Listed" },
      { action: "resumeAgent", status: "inProgress", expected: "Resuming an agent" },
      { action: "resumeAgent", status: "completed", expected: "Resumed an agent" },
      { action: "resumeAgent", status: "failed", expected: "Failed to resume an agent" },
      { action: "closeAgent", status: "inProgress", expected: "Closing an agent" },
      { action: "closeAgent", status: "completed", expected: "Closed an agent" },
      { action: "closeAgent", status: "failed", expected: "Failed to close an agent" },
    ];

    for (const testCase of cases) {
      const { getByTestId, unmount } = render(
        <MultiAgentActionSurface
          items={[
            buildActionItem({
              id: `${testCase.action}-${testCase.status}`,
              action: testCase.action,
              status: testCase.status,
            }),
          ]}
        />,
      );
      expect(activityHeaderText(getByTestId("multi-agent-action-header"))).toBe(testCase.expected);
      unmount();
    }
  });

  test("aggregates grouped header status before choosing the label", () => {
    const { getByTestId: getLiveHeader, unmount: unmountLiveHeader } = render(
      <MultiAgentActionSurface
        items={[
          buildActionItem({
            id: "message-completed",
            action: "sendInput",
            status: "completed",
            receiverThreadId: "thread-agent-1",
          }),
          buildActionItem({
            id: "message-live",
            action: "sendInput",
            status: "inProgress",
            receiverThreadId: "thread-agent-2",
          }),
        ]}
      />,
    );
    expect(activityHeaderText(getLiveHeader("multi-agent-action-header"))).toBe(
      "Messaging 2 agents",
    );
    unmountLiveHeader();

    const { getByTestId: getInterruptedHeader, unmount: unmountInterruptedHeader } = render(
      <MultiAgentActionSurface
        items={[
          buildActionItem({
            id: "message-completed-before-interrupt",
            action: "sendInput",
            status: "completed",
            receiverThreadId: "thread-agent-1",
          }),
          buildActionItem({
            id: "message-interrupted",
            action: "sendInput",
            status: "interrupted",
            receiverThreadId: "thread-agent-2",
          }),
        ]}
      />,
    );
    expect(activityHeaderText(getInterruptedHeader("multi-agent-action-header"))).toBe(
      "Interrupted 2 agents",
    );
    unmountInterruptedHeader();

    const { getByTestId: getFailedHeader } = render(
      <MultiAgentActionSurface
        items={[
          buildActionItem({
            id: "close-completed",
            action: "closeAgent",
            status: "completed",
            receiverThreadId: "thread-agent-1",
          }),
          buildActionItem({
            id: "close-failed",
            action: "closeAgent",
            status: "failed",
            receiverThreadId: "thread-agent-2",
          }),
        ]}
      />,
    );
    expect(textContent(getFailedHeader("multi-agent-action-header"))).toBe(
      "Failed to close 2 agents",
    );
  });

  test("renders prompt rows with inline truncation nodes and metadata prompt rows", async () => {
    const spawnPrompt =
      "Audit the renderer rows and keep the prompt visible in the overflow tooltip.";
    const resumePrompt = "First line of resume input\nSecond line of resume input";
    const { getByTestId, container } = render(
      <MultiAgentActionSurface
        items={[
          buildActionItem({
            id: "spawn-with-prompt",
            action: "spawnAgent",
            status: "completed",
            prompt: spawnPrompt,
            receiverThreadId: "thread-agent-1",
          }),
          buildActionItem({
            id: "resume-with-prompt",
            action: "resumeAgent",
            status: "completed",
            prompt: resumePrompt,
            receiverThreadId: "thread-agent-2",
          }),
        ]}
      />,
    );

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    const rows = getByTestId("multi-agent-action-rows");
    const content = textContent(rows);
    expect(content.includes(`Created agent1 (worker) with the instructions: ${spawnPrompt}`)).toBe(
      true,
    );
    expect(content.includes("Resumed agent2 (worker)")).toBe(true);
    expect(content.includes(`Input: ${resumePrompt}`)).toBe(true);
    expect(
      container.querySelectorAll('[data-testid="multi-agent-action-inline-prompt"]').length,
    ).toBe(1);
    expect(
      container.querySelectorAll('[data-testid="multi-agent-action-meta-prompt"]').length,
    ).toBe(1);
  });

  test("opens the target agent thread from the inline agent button", async () => {
    const openedThreadIds: string[] = [];
    const { getByRole, getByTestId } = render(
      <MultiAgentActionSurface
        items={[buildMultiAgentItem()]}
        onOpenThread={(threadId) => {
          openedThreadIds.push(threadId);
        }}
      />,
    );

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    const agentButton = getByRole("button", { name: "Open subagent research" });
    fireEvent.click(agentButton);

    expect(openedThreadIds.join(",")).toBe("thread-agent-1");
  });

  test("uses app-server agent nicknames instead of thread ids in inline agent rows", async () => {
    const calls: Array<{ threadId: string; context: ThreadOpenThreadContext | undefined }> = [];
    const item = buildMultiAgentItem({
      rawItem: {
        id: "item-agent-nickname",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-main",
        receiverThreadIds: ["019f3c6a-2ebc-7b82-ab83-cb7edb449ada"],
        receiverThreads: [
          {
            threadId: "019f3c6a-2ebc-7b82-ab83-cb7edb449ada",
            thread: {
              agentNickname: "@Euclid",
              model: "gpt-5-codex",
              agentRole: "explorer",
            },
          },
        ],
        prompt: "Map the subagent UI.",
        model: "gpt-5-codex",
        reasoningEffort: "medium",
        agentsStates: {
          "019f3c6a-2ebc-7b82-ab83-cb7edb449ada": {
            status: "running",
            message: "Reading fixtures",
          },
        },
      },
    });

    const { container, getByRole, getByTestId } = render(
      <MultiAgentActionSurface
        items={[item]}
        onOpenThread={(threadId, context) => {
          calls.push({ threadId, context });
        }}
      />,
    );

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    const content = textContent(container);
    expect(content.includes("Euclid (explorer)")).toBe(true);
    expect(content.includes("019f3c6a-2ebc-7b82-ab83-cb7edb449ada")).toBe(false);

    fireEvent.click(getByRole("button", { name: "Open subagent Euclid" }));
    expect(calls[0]?.threadId).toBe("019f3c6a-2ebc-7b82-ab83-cb7edb449ada");
    expect(calls[0]?.context?.subagent?.displayName).toBe("Euclid");
    expect(calls[0]?.context?.subagent?.agentRole).toBe("explorer");
  });

  test("falls back to parent child membership metadata when tool items only contain thread ids", async () => {
    const calls: Array<{ threadId: string; context: ThreadOpenThreadContext | undefined }> = [];
    const threadId = "019f3c8c-e9b6-7b31-a255-fd447335a704";
    const childMemberships: CodexConversationChildMembership[] = [
      {
        threadId,
        parentThreadId: "thread-main",
        role: "backgroundChild",
        actorName: threadId,
        thread: {
          nickname: "@Nash",
          agentRole: "worker",
          model: "gpt-5-codex",
        },
      },
    ];
    const item = buildMultiAgentItem({
      rawItem: {
        id: "item-agent-membership",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-main",
        receiverThreadIds: [threadId],
        receiverThreads: [
          {
            threadId,
            thread: {
              displayName: threadId,
              nickname: null,
              model: null,
              agentRole: null,
            },
          },
        ],
        prompt: "Write a smoke file.",
        model: null,
        reasoningEffort: "medium",
        agentsStates: {
          [threadId]: {
            status: "completed",
            message: null,
          },
        },
      },
    });

    const { container, getByRole, getByTestId } = render(
      <MultiAgentActionSurface
        childMemberships={childMemberships}
        items={[item]}
        onOpenThread={(openedThreadId, context) => {
          calls.push({ threadId: openedThreadId, context });
        }}
      />,
    );

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    const content = textContent(container);
    expect(content.includes("Nash (worker)")).toBe(true);
    expect(content.includes(threadId)).toBe(false);

    fireEvent.click(getByRole("button", { name: "Open subagent Nash" }));
    expect(calls[0]?.threadId).toBe(threadId);
    expect(calls[0]?.context?.subagent?.displayName).toBe("Nash");
    expect(calls[0]?.context?.subagent?.agentRole).toBe("worker");
    expect(calls[0]?.context?.subagent?.spawnModel).toBe("gpt-5-codex");
  });

  test("does not use child membership actor labels as agent display names", async () => {
    const threadId = "019f3c8c-e9b6-7b31-a255-fd447335a704";
    const childMemberships: CodexConversationChildMembership[] = [
      {
        threadId,
        parentThreadId: "thread-main",
        role: "backgroundChild",
        actorName: "Structure Scout report preview",
      },
    ];
    const item = buildMultiAgentItem({
      rawItem: {
        id: "item-agent-actor-fallback",
        tool: "sendInput",
        status: "completed",
        senderThreadId: "thread-main",
        receiverThreadIds: [threadId],
        receiverThreads: [],
        prompt: "Continue.",
        model: null,
        reasoningEffort: "medium",
        agentsStates: {
          [threadId]: {
            status: "running",
            message: null,
          },
        },
      },
    });

    const { container, getByTestId } = render(
      <MultiAgentActionSurface childMemberships={childMemberships} items={[item]} />,
    );

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    const content = textContent(container);
    expect(content.includes(threadId)).toBe(true);
    expect(content.includes("Structure Scout report preview")).toBe(false);
  });

  test("passes Codex-style subagent context from inline agent buttons", async () => {
    const calls: Array<{ threadId: string; context: ThreadOpenThreadContext | undefined }> = [];
    const spawnItem = buildMultiAgentItem({
      itemId: "item-spawn-agent",
      entryId: "item-spawn-agent",
      rawItem: {
        id: "item-spawn-agent",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-main",
        receiverThreadIds: ["thread-agent-1"],
        receiverThreads: [
          {
            threadId: "thread-agent-1",
            thread: {
              nickname: "@research",
              model: "gpt-5.4-mini",
              agentRole: "worker",
            },
          },
        ],
        prompt: "Gather the failing tests.",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        agentsStates: {},
      },
    });
    const sendInputItem = buildMultiAgentItem();
    const { getAllByRole, getByTestId } = render(
      <MultiAgentActionSurface
        items={[spawnItem, sendInputItem]}
        onOpenThread={(threadId, context) => {
          calls.push({ threadId, context });
        }}
      />,
    );

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    const agentButtons = getAllByRole("button", { name: "Open subagent research" });
    const sendInputAgentButton = agentButtons[1];
    if (!sendInputAgentButton) throw new Error("Expected a send-input agent button");
    fireEvent.click(sendInputAgentButton);

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          threadId: "thread-agent-1",
          context: {
            subagent: {
              agentRole: "worker",
              conversationId: "thread-agent-1",
              diffStats: null,
              displayName: "research",
              spawnModel: "gpt-5.4-mini",
              status: "active",
              statusSummary: "Inspecting the renderer tests",
            },
          },
        },
      ]),
    );
  });

  test("maps terminal inline agent open statuses to done", async () => {
    for (const agentStatus of [
      "interrupted",
      "errored",
      "shutdown",
      "notFound",
    ] as CodexMultiAgentAgentStatus[]) {
      const calls: Array<{ context: ThreadOpenThreadContext | undefined }> = [];
      const view = render(
        <MultiAgentActionSurface
          items={[
            buildMultiAgentItem({
              rawItem: {
                id: `item-${agentStatus}`,
                tool: "sendInput",
                status: "completed",
                senderThreadId: "thread-main",
                receiverThreadIds: ["thread-agent-1"],
                receiverThreads: [
                  {
                    threadId: "thread-agent-1",
                    thread: {
                      nickname: "@research",
                      model: "gpt-5.4-mini",
                      agentRole: "worker",
                    },
                  },
                ],
                prompt: "Gather the failing tests.",
                model: "gpt-5.4-mini",
                reasoningEffort: "medium",
                agentsStates: {
                  "thread-agent-1": {
                    status: agentStatus,
                    message: null,
                  },
                },
              },
            }),
          ]}
          onOpenThread={(_threadId, context) => {
            calls.push({ context });
          }}
        />,
      );

      fireEvent.click(multiAgentDisclosureButton(view.getByTestId("multi-agent-action-header")));
      await settleAsyncRender();
      fireEvent.click(view.getByRole("button", { name: "Open subagent research" }));

      expect(calls[0]?.context?.subagent?.status).toBe("done");
      view.unmount();
    }
  });

  test("renders sparse receiverThreadIds as a generic row without opening a child thread", async () => {
    const openedThreadIds: string[] = [];
    const { getByTestId, queryByRole } = render(
      <MultiAgentActionSurface
        items={[
          buildMultiAgentItem({
            itemId: "generic-row",
            entryId: "generic-row",
            rawItem: {
              id: "generic-row",
              tool: "closeAgent",
              status: "failed",
              senderThreadId: "thread-main",
              receiverThreadIds: ["thread-agent-1"],
              receiverThreads: [],
              prompt: null,
              agentsStates: {},
            },
          }),
        ]}
        onOpenThread={(threadId) => {
          openedThreadIds.push(threadId);
        }}
      />,
    );

    expect(textContent(getByTestId("multi-agent-action-header"))).toBe("Failed to close an agent");

    fireEvent.click(multiAgentDisclosureButton(getByTestId("multi-agent-action-header")));
    await settleAsyncRender();

    expect(textContent(getByTestId("multi-agent-action-rows"))).toBe("Failed closing");

    expect(queryByRole("button", { name: "thread-agent-1" }) === null).toBe(true);
    expect(openedThreadIds.join(",")).toBe("");
  });
});
