import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type { CodexUserInputRequest } from "@/lib/types";
import { render, settleAsyncRender } from "@/test/dom";
import type {
  CodexUserInputAutoResolutionChange,
  CodexUserInputAutoResolutionEntry,
} from "../../../shared/codex-user-input-auto-resolution";
import {
  recordUserInputActivity,
  resetUserInputAutoResolutionStateForTests,
  snoozeUserInput,
  useUserInputAutoResolution,
} from "./user-input-auto-resolution-state";
import { resetCodexUserInputDraftStateForTests } from "./user-input-draft-state";
import { CodexUserInputRequestCard } from "./view/composer/request-cards/codex-user-input-request-card";

const api = vi.hoisted(() => ({
  getSnapshot: vi.fn<() => Promise<CodexUserInputAutoResolutionEntry[]>>(),
  recordActivity:
    vi.fn<(conversation: { hostId: string; conversationId: string }) => Promise<boolean>>(),
  snooze:
    vi.fn<
      (target: {
        hostId: string;
        conversationId: string;
        requestId: string | number;
      }) => Promise<boolean>
    >(),
  listener: null as ((change: CodexUserInputAutoResolutionChange) => void) | null,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getUserInputAutoResolutionSnapshot: () => api.getSnapshot(),
  recordUserInputAutoResolutionActivity: (conversation: {
    hostId: string;
    conversationId: string;
  }) => api.recordActivity(conversation),
  snoozeUserInputAutoResolution: (target: {
    hostId: string;
    conversationId: string;
    requestId: string | number;
  }) => api.snooze(target),
  subscribeUserInputAutoResolutionChanges: (
    listener: (change: CodexUserInputAutoResolutionChange) => void,
  ) => {
    api.listener = listener;
    return () => {
      if (api.listener === listener) api.listener = null;
    };
  },
}));

function AutoResolutionProbe({
  conversationId,
  requestId,
  hostId = "local",
}: {
  conversationId: string;
  requestId: string | number;
  hostId?: string;
}) {
  const entry = useUserInputAutoResolution(conversationId, requestId, hostId);
  return (
    <output>
      {entry?.phase.type === "scheduled"
        ? `scheduled:${entry.phase.deadlineMs}`
        : (entry?.phase.type ?? "none")}
    </output>
  );
}

const draftRequest: CodexUserInputRequest = {
  type: "userInput",
  requestId: "draft-request",
  projectId: "project-1",
  threadId: "thread-draft",
  turnId: "turn-1",
  itemId: "item-1",
  questions: [
    {
      id: "secret-context",
      header: "Secret context",
      question: "What should Codex know?",
      isOther: false,
      isSecret: true,
      options: undefined,
    },
  ],
  isBlocking: false,
  createdAt: 1,
};

beforeEach(() => {
  resetUserInputAutoResolutionStateForTests();
  resetCodexUserInputDraftStateForTests();
  api.getSnapshot.mockReset();
  api.recordActivity.mockReset();
  api.snooze.mockReset();
  api.listener = null;
  api.getSnapshot.mockResolvedValue([]);
  api.recordActivity.mockResolvedValue(true);
  api.snooze.mockResolvedValue(true);
});

describe("user input auto-resolution renderer state", () => {
  test("does not let a late snapshot overwrite a newer live update", async () => {
    let resolveSnapshot: (entries: CodexUserInputAutoResolutionEntry[]) => void = () => undefined;
    api.getSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const view = render(<AutoResolutionProbe conversationId="thread-1" requestId="request-1" />);
    await settleAsyncRender();

    await act(async () => {
      api.listener?.({
        type: "updated",
        entry: {
          hostId: "local",
          conversationId: "thread-1",
          requestId: "request-1",
          phase: { type: "scheduled", deadlineMs: 91_000 },
        },
      });
      await settleAsyncRender();
    });
    expect(view.getByText("scheduled:91000")).not.toBeNull();

    await act(async () => {
      resolveSnapshot([
        {
          hostId: "local",
          conversationId: "thread-1",
          requestId: "request-1",
          phase: { type: "waitingForInactivity" },
        },
      ]);
      await settleAsyncRender();
    });
    expect(view.getByText("scheduled:91000")).not.toBeNull();
  });

  test("keeps numeric and textual request identities distinct", async () => {
    const view = render(
      <>
        <AutoResolutionProbe conversationId="thread-1" requestId={73} />
        <AutoResolutionProbe conversationId="thread-1" requestId="73" />
      </>,
    );
    await settleAsyncRender();

    await act(async () => {
      api.listener?.({
        type: "updated",
        entry: {
          hostId: "local",
          conversationId: "thread-1",
          requestId: 73,
          phase: { type: "snoozed" },
        },
      });
      await settleAsyncRender();
    });

    expect(view.getAllByText("snoozed")).toHaveLength(1);
    expect(view.getAllByText("none")).toHaveLength(1);
  });

  test("delegates external activity and exact-request snooze intents", async () => {
    await recordUserInputActivity("thread-1");
    await snoozeUserInput("thread-1", 73);

    expect(api.recordActivity).toHaveBeenCalledWith({
      hostId: "local",
      conversationId: "thread-1",
    });
    expect(api.snooze).toHaveBeenCalledWith({
      hostId: "local",
      conversationId: "thread-1",
      requestId: 73,
    });
  });

  test("clears an unmounted secret draft when its app-server generation disconnects", async () => {
    const card = (
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread-draft"
          request={draftRequest}
          onRespond={async () => undefined}
        />
      </TooltipProvider>
    );
    const view = render(card);
    await settleAsyncRender();
    await act(async () => {
      fireEvent.change(view.getByPlaceholderText("Type your answer"), {
        target: { value: "private material" },
      });
    });
    view.unmount();

    api.listener?.({
      type: "removed",
      hostId: "local",
      conversationId: "thread-draft",
      requestId: "draft-request",
      reason: "disconnected",
    });
    const afterDisconnect = render(card);
    await settleAsyncRender();
    expect(
      (afterDisconnect.getByPlaceholderText("Type your answer") as HTMLInputElement).value,
    ).toBe("");
  });
});

test("a matching Thread and request on another host cannot change the visible deadline", async () => {
  const view = render(
    <AutoResolutionProbe conversationId="same-thread" requestId="same-request" />,
  );
  await act(async () => {
    await settleAsyncRender();
    api.listener?.({
      type: "updated",
      entry: {
        hostId: "local",
        conversationId: "same-thread",
        requestId: "same-request",
        phase: { type: "snoozed" },
      },
    });
  });
  expect(view.getByText("snoozed")).not.toBeNull();
  await act(async () => {
    api.listener?.({
      type: "updated",
      entry: {
        hostId: "remote",
        conversationId: "same-thread",
        requestId: "same-request",
        phase: { type: "scheduled", deadlineMs: 1000 },
      },
    });
    api.listener?.({
      type: "removed",
      hostId: "remote",
      conversationId: "same-thread",
      requestId: "same-request",
      reason: "resolved",
    });
    await Promise.resolve();
  });
  expect(view.getByText("snoozed")).not.toBeNull();
});
