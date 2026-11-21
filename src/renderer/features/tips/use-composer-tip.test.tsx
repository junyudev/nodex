import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeSessionActivity } from "../../../shared/agent-runtime-api";
import { composerDraftIntents } from "@/lib/composer-draft-intents";
import { createMaitaiStore } from "@/lib/maitai";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { TestMaitaiRoot } from "@/test/app-maitai";
import { TipsNavigationProvider } from "./tips-navigation";
import { useTipsState } from "./tips-state";
import { useComposerTip } from "./use-composer-tip";

const activity = vi.hoisted(() => ({
  sessions: new Map<string, AgentRuntimeSessionActivity>(),
  listeners: new Set<() => void>(),
}));

vi.mock("@/lib/desktop-notification-authorization", () => ({
  useDesktopNotificationAuthorization: () => ({
    query: { data: "authorized" },
    request: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("@/lib/agent-runtime-session-activity", () => ({
  agentRuntimeActivityStore: {
    readAll: () => activity.sessions,
    subscribeAll: (listener: () => void) => {
      activity.listeners.add(listener);
      return () => activity.listeners.delete(listener);
    },
  },
}));

const chat = { kind: "session", sessionId: "composer-tip-chat" } as const;
const otherChat = { kind: "session", sessionId: "other-chat" } as const;

async function publishActivity(sessionId: string, status: AgentRuntimeSessionActivity["status"]) {
  await act(async () => {
    activity.sessions.set(sessionId, {
      sessionId,
      threadId: `thread:${sessionId}`,
      status,
      activeRunId: status === "running" ? `run:${sessionId}` : null,
      pendingRequestCount: status === "waiting" ? 1 : 0,
      backgroundTasks: [],
      providerInstanceId: "codex",
      model: "model",
      updatedAt: "2026-11-20T00:00:00.000Z",
    });
    for (const listener of activity.listeners) listener();
  });
}

type TipInput = Parameters<typeof useComposerTip>[0];
const rested: TipInput["moment"] = {
  started: true,
  working: false,
  finishedRuns: 1,
  pageOpened: false,
  teammate: "Claude Code",
  teamedUp: false,
  canConnectAgent: true,
};

async function mountTip(overrides: Partial<Pick<TipInput, "enabled" | "moment">> = {}) {
  const store = createMaitaiStore();
  const openInbox = vi.fn();
  const input: TipInput = {
    enabled: true,
    sessionId: chat.sessionId,
    chat,
    moment: rested,
    connectAgent: vi.fn(),
    ...overrides,
  };
  const hook = renderHook((props) => ({ notice: useComposerTip(props), tips: useTipsState() }), {
    initialProps: input,
    wrapper: ({ children }: PropsWithChildren) => (
      <TestMaitaiRoot store={store}>
        <TipsNavigationProvider value={{ openInbox }}>{children}</TipsNavigationProvider>
      </TestMaitaiRoot>
    ),
  });
  await waitFor(() => expect(hook.result.current.tips.state).not.toBeNull());
  return { ...hook, input, openInbox };
}

beforeEach(() => {
  clearPersistedAtomStoreForTests();
  activity.sessions.clear();
});

afterEach(() => {
  const draft = composerDraftIntents.read(chat);
  if (draft) composerDraftIntents.consume(chat, draft.focusNonce);
});

describe("useComposerTip", () => {
  it("offers a teammate's opinion and leaves the named review request in this chat's draft", async () => {
    const { result } = await mountTip();
    expect(result.current.notice).toMatchObject({
      text: "Want a second opinion? Claude Code can review this.",
      action: { label: "Ask Claude Code" },
    });
    const ask = result.current.notice?.action;
    expect(ask).toBeDefined();
    expect(composerDraftIntents.read(chat)).toBeNull();

    await act(async () => {
      await ask!.run();
    });

    // The request joins whatever is already drafted instead of replacing it.
    expect(composerDraftIntents.read(chat)).toMatchObject({
      prompt: "",
      attachmentMode: "append",
      promptInput: {
        documentItems: [
          {
            type: "text",
            text: "Ask Claude Code to review your work above, then tell me what you’d change.",
          },
        ],
      },
    });
    expect(composerDraftIntents.read(otherChat)).toBeNull();
    expect(result.current.tips.state?.settled).toContain("second-opinion");
    expect(result.current.notice).toBeNull();
  });

  it("settles the shown tip when the chat carries on working", async () => {
    const { input, result, rerender } = await mountTip();
    expect(result.current.notice?.key).toBe("tip:second-opinion");

    await act(async () => {
      rerender({ ...input, moment: { ...rested, working: true } });
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.tips.state?.settled).toContain("second-opinion");

    rerender({ ...input, moment: { ...rested, finishedRuns: 2 } });
    expect(result.current.notice).toBeNull();
  });

  it("passes the prior tip when the next completed Run arrives without an intermediate working state", async () => {
    const { input, result, rerender } = await mountTip();
    expect(result.current.notice?.key).toBe("tip:second-opinion");

    await act(async () => {
      rerender({ ...input, moment: { ...rested, finishedRuns: 2, pageOpened: true } });
    });

    expect(result.current.notice?.key).toBe("tip:page");
    expect(result.current.tips.state?.settled).toContain("second-opinion");
  });

  it("stays quiet when the chat is disabled or the Profile turns tips off", async () => {
    const { input, result, rerender } = await mountTip({ enabled: false });
    expect(result.current.tips.state?.on).toBe(true);
    expect(result.current.notice).toBeNull();

    rerender({ ...input, enabled: true });
    expect(result.current.notice?.key).toBe("tip:second-opinion");
    await act(async () => {
      await result.current.tips.setOn(false);
    });
    expect(result.current.tips.state?.on).toBe(false);
    expect(result.current.notice).toBeNull();
  });

  it("settles both teamwork tips when the chat has already teamed up", async () => {
    const { result } = await mountTip({ moment: { ...rested, teamedUp: true } });
    expect(result.current.notice).toBeNull();
    await waitFor(() =>
      expect(result.current.tips.state?.settled).toEqual(["second-opinion", "second-agent"]),
    );
  });

  it("offers the Inbox to an unstarted chat when another Session starts running", async () => {
    const { result, openInbox } = await mountTip({
      moment: { ...rested, started: false, finishedRuns: 0 },
    });
    await publishActivity(chat.sessionId, "running");
    await publishActivity(otherChat.sessionId, "waiting");
    expect(result.current.notice).toBeNull();

    await publishActivity(otherChat.sessionId, "running");
    expect(result.current.notice).toMatchObject({
      key: "tip:inbox",
      action: { label: "Open Inbox" },
    });
    const open = result.current.notice?.action;
    expect(open).toBeDefined();
    expect(openInbox).not.toHaveBeenCalled();

    await act(async () => {
      await open!.run();
    });
    expect(openInbox).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toBeNull();
  });

  it("keeps the Inbox tip out of a started chat even when another Session is running", async () => {
    await publishActivity(otherChat.sessionId, "running");
    const { result } = await mountTip({ moment: { ...rested, finishedRuns: 0 } });
    expect(result.current.notice).toBeNull();
  });
});
