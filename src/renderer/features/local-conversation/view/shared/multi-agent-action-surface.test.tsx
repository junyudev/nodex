import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
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
    expect(content.includes(threadId)).toBe(false);
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

  test("uses the parent model only for a spawn without an explicit model", async () => {
    for (const [action, model, expected] of [
      ["spawnAgent", null, "gpt-5.6-sol"],
      ["spawnAgent", "gpt-5.4-mini", "gpt-5.4-mini"],
      ["sendInput", null, null],
    ] as const) {
      const item = buildActionItem({ id: "model-source", action, status: "completed" });
      const calls: Array<ThreadOpenThreadContext | undefined> = [];
      const view = render(
        <MultiAgentActionSurface
          items={[{ ...item, rawItem: { ...(item.rawItem as object), model } }]}
          parentModel="gpt-5.6-sol"
          onOpenThread={(_id, context) => {
            calls.push(context);
          }}
        />,
      );
      await act(async () => {
        fireEvent.click(multiAgentDisclosureButton(view.getByTestId("multi-agent-action-header")));
      });
      await settleAsyncRender();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Open subagent agent1" }));
      });
      expect(calls[0]?.subagent?.spawnModel).toBe(expected);
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
