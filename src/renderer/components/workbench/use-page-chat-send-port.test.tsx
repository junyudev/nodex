import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { createMaitaiStore } from "@/lib/maitai/maitai-store";
import { TestMaitaiRoot } from "@/test/app-maitai";
import { usePageChatSendPort } from "./use-page-chat-send-port";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  message: vi.fn(),
  queue: vi.fn(),
  queued: false,
}));
vi.mock("@/lib/use-workbench-window-state", () => ({ useWorkbenchWindowOwner: () => ({}) }));
vi.mock("@/lib/use-agent-runtime-session-launch", () => ({
  useAgentRuntimeSessionLaunch: () => mocks.launch,
}));
vi.mock("@/lib/agent-runtime-runtime", () => ({
  agentRuntimeRuntime: {
    inspect: async () => ({}),
    message: mocks.message,
    queueMessage: mocks.queue,
  },
}));
vi.mock("@/lib/codex-turn-presentation", () => ({
  readCodexSubmissionPresentation: () => ({}),
  captureCodexTurnPresentation: async () => undefined,
}));
vi.mock("@/lib/prompt-file-images", () => ({
  materializePromptFileImages: async (_route: unknown, _page: unknown, input: unknown) => input,
}));
vi.mock("@/lib/thread-composer-follow-up-mode", () => ({
  readThreadQueueFollowUpsEnabled: () => mocks.queued,
}));
vi.mock("@/lib/api", () => ({ readPastedTextAttachment: vi.fn() }));
vi.mock("@/features/conversation-launch/session-first-submission-owner", () => ({
  sessionFirstSubmissionOwner: {
    begin: (input: { identity: object }) => input.identity,
    update: vi.fn(),
    fail: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queued = false;
  mocks.launch.mockResolvedValue({ sessionId: "chat", threadId: "root" });
  mocks.message.mockResolvedValue({ sequence: 1 });
  mocks.queue.mockResolvedValue({ sequence: 2 });
});
function setup() {
  const store = createMaitaiStore();
  return renderHook(
    () =>
      usePageChatSendPort({
        routingContext: { kind: "project", projectId: "project" },
        pageId: "page",
        onEnsureDefaultDraftSessionForProject: vi.fn(),
        onRefreshSessions: vi.fn(),
        onResolveChatSessionForThread: async () => ({
          id: "chat",
          projectId: "project",
          executionRef: { runtimeId: "runtime", threadId: "root" },
        }),
        onLinkPageToChat: vi.fn(),
      }),
    { wrapper: ({ children }) => <TestMaitaiRoot store={store}>{children}</TestMaitaiRoot> },
  );
}
it("returns the launch's accepted user message identity", async () => {
  const view = setup();
  await act(async () => {
    const accepted = await view.result.current.onStartNewSessionThreadFromEditor({
      projectId: "project",
      targetSessionId: "chat",
      prompt: "Review",
    });
    expect(accepted).toEqual({
      sessionId: "chat",
      threadId: "root",
      messageId: mocks.launch.mock.calls[0]![0].launchIdentity.messageId,
    });
  });
  view.unmount();
});
it.each([false, true])(
  "returns the message accepted by an existing chat (queue=%s)",
  async (queued) => {
    mocks.queued = queued;
    const view = setup();
    await act(async () => {
      const accepted = await view.result.current.onSendPagePrompt({
        projectId: "project",
        threadId: "root",
        prompt: "Review",
      });
      const deliver = queued ? mocks.queue : mocks.message;
      expect(accepted).toEqual({
        sessionId: "chat",
        threadId: "root",
        messageId: deliver.mock.calls[0]![0].message.messageId,
      });
      expect(deliver.mock.calls[0]![0].message.text).toBe("Review");
    });
    view.unmount();
  },
);
it("rejects a failed send instead of returning a send record", async () => {
  mocks.message.mockRejectedValueOnce(new Error("Rejected"));
  const view = setup();
  await act(async () => {
    await expect(
      view.result.current.onSendPagePrompt({
        projectId: "project",
        threadId: "root",
        prompt: "Review",
      }),
    ).rejects.toThrow("Rejected");
  });
  view.unmount();
});
