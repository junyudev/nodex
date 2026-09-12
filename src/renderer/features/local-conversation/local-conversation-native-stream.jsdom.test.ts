import { conversationFollowerRequest } from "../../../shared/codex-thread-follower-request";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../../shared/codex-conversation-state/codex-canonical-history-loader";
import { createCodexHistoryBoundaryRef } from "../../../shared/codex-conversation-state/codex-history-topology";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, waitFor } from "@testing-library/react";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2";
import type { ConversationCoordinationHost } from "../../../shared/codex-client-coordination";
import type { CodexThreadSummary } from "../../../shared/types";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { residentConversationTurns } from "../../../shared/codex-conversation-state/codex-turn-mutation";
import type { CodexAppServerManager } from "./local-conversation-store";
import type { ConversationResumePreparationOptions } from "../../../shared/codex-conversation-state/codex-resume-request";

const fixture = vi.hoisted(() => ({
  owner: null as CodexAppServerManager | null,
  follower: null as CodexAppServerManager | null,
  ownerId: null as string | null,
  hostId: "local",
  generation: 1,
  sourceEpoch: null as string | null,
  accountId: "account",
  hostContextReady: null as Promise<void> | null,
  hostContextReads: 0,
  resumePrepareReady: null as Promise<void> | null,
  workspaceReady: null as Promise<void> | null,
  resumePreparations: 0,
  resumeOptions: [] as (ConversationResumePreparationOptions | undefined)[],
  releasedResumes: 0,
  queuedPreparations: 0,
  windowFocusListeners: new Set<(focused: boolean) => void>(),
  response: null as ThreadResumeResponse | null,
  summary: null as CodexThreadSummary | null,
  calls: [] as { method: string; params: unknown }[],
  scheduling: [] as { method: string; priority?: string; source?: string; timeoutMs?: number }[],
  changes: [] as unknown[],
  followerRequests: [] as unknown[],
  queueState: {} as import("../../../shared/codex-queued-message").CodexQueuedMessageState,
  queueBroadcasts: [] as unknown[],
  readGoal: null as
    | (() => Promise<import("@nodex/codex-app-server-protocol/v2").ThreadGoal | null>)
    | null,
  nativeRequest: null as ((method: string, params: unknown) => Promise<unknown>) | null,
  updateSettings: null as (() => Promise<unknown>) | null,
}));

vi.mock("./local-conversation-deps", () => ({
  subscribeWindowFocusChanges: (listener: (focused: boolean) => void) => {
    fixture.windowFocusListeners.add(listener);
    return () => {
      fixture.windowFocusListeners.delete(listener);
    };
  },
  subscribeCodexEvents: () => () => {},
  subscribeCodexHostMessages: () => () => {},
  subscribeCodexRendererClientRequests: () => () => {},
  runConversationOperation: async (channel: string, ...args: unknown[]) => {
    if (channel === "codex:thread:native-fork:prepare")
      return {
        receiptId: "fork",
        hostId: "local",
        generation: 1,
        request: { threadId: args[0], lastTurnId: args[1] },
        sourceTitle: "Source title",
      };
    if (channel === "codex:thread:native-fork:execute") {
      fixture.calls.push({
        method: "thread/fork",
        params: { threadId: fixture.summary!.threadId },
      });
      return {
        type: "result",
        result: {
          ...fixture.response!,
          thread: {
            ...fixture.response!.thread,
            id: "fork-child",
            forkedFromId: fixture.summary!.threadId,
            turns: [],
          },
        },
      };
    }
    if (channel === "codex:thread:native-fork:accept")
      return {
        threadId: "fork-child",
        summary: {
          ...fixture.summary!,
          threadId: "fork-child",
          forkedFromId: fixture.summary!.threadId,
        },
        session: { id: "child-session" },
        composerIntent: { prompt: "", focusNonce: 1 },
      };
    if (channel === "codex:thread:native-fork:release") return;
    if (
      channel === "codex:turn:native:release" ||
      channel === "codex:turn:native-steer:release" ||
      channel === "codex:queued-messages:release-send" ||
      channel === "codex:thread:interrupt-effects"
    )
      return;
    if (channel === "codex:queued-messages:acquire-send") return true;
    if (channel === "codex:queued-messages:prepare-native") {
      fixture.queuedPreparations += 1;
      const message = args[1] as import("../../../shared/codex-queued-message").CodexQueuedMessage;
      return {
        steer: {
          conversationId: args[0],
          clientUserMessageId: message.id,
          input: [{ type: "text", text: message.context.prompt, text_elements: [] }],
          restoreMessage: message,
        },
        requiresIdle: false,
      };
    }
    if (channel === "codex:turn:native-steer:execute") {
      const input = args[0] as { request: { method: string; params: { expectedTurnId: string } } };
      fixture.calls.push(input.request);
      return { type: "result", result: { turnId: input.request.params.expectedTurnId } };
    }
    if (channel === "codex:queued-messages:read") return fixture.queueState;
    if (channel === "codex:queued-messages:write") {
      fixture.queueState = args[0] as typeof fixture.queueState;
      return;
    }
    if (channel === "codex:queued-messages:prepare")
      return {
        id: crypto.randomUUID(),
        cwd: "/tmp",
        submissionOptions: args[2],
        context: {
          prompt: args[1],
          fileAttachments: [],
          addedFiles: [],
          commentAttachments: [],
          imageAttachments: [],
        },
      };
    if (channel === "codex:execution-assignments:read")
      return { permissionRefresh: false, threadQueue: false };
    if (channel === "codex:app-server:host-context") {
      fixture.hostContextReads += 1;
      const context = {
        hostId: fixture.hostId,
        generation: fixture.generation,
        sourceEpoch: fixture.sourceEpoch ?? `native-${fixture.generation}`,
        supportsPaginatedHistory: true,
        supportsTurnApprovalsReviewer: false,
        accountContext: {
          identity: { kind: "chatgpt", accountId: fixture.accountId, userId: "user" },
          executionHostKey: fixture.hostId,
        },
      };
      if (fixture.hostContextReady) await fixture.hostContextReady;
      return context;
    }
    if (channel === "codex:thread:history-hydration:prepare") {
      if (fixture.workspaceReady) await fixture.workspaceReady;
      return {
        summary: fixture.summary,
        context: {
          hostId: fixture.hostId,
          model: fixture.response!.model,
          reasoningEffort: fixture.response!.reasoningEffort,
          cwd: fixture.response!.cwd,
          approvalPolicy: fixture.response!.approvalPolicy,
          approvalsReviewer: fixture.response!.approvalsReviewer,
          sandboxPolicy: fixture.response!.sandbox,
          activePermissionProfile: fixture.response!.activePermissionProfile,
          runtimeWorkspaceRoots: fixture.response!.runtimeWorkspaceRoots,
        },
      };
    }
    if (channel === "codex:thread:resume:prepare") {
      fixture.resumeOptions.push(args[3] as ConversationResumePreparationOptions | undefined);
      const metadata = args[1] as ThreadResumeResponse["thread"] | null;
      const legacyHistory =
        (metadata?.historyMode ?? fixture.response?.thread.historyMode) === "legacy";
      const prepared = {
        receiptId: "resume",
        nativeRequestId: "resume-native",
        hostId: fixture.hostId,
        generation: fixture.generation,
        supportsPaginatedHistory: true,
        requestedCwd:
          (args[2] as { cwd?: string | null } | undefined)?.cwd ?? metadata?.cwd ?? null,
        params: {
          threadId: args[0],
          excludeTurns: fixture.hostId !== "durable",
          ...(args[2] as object),
          ...(legacyHistory && fixture.hostId !== "durable"
            ? { initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } }
            : {}),
        },
        summary: { ...fixture.summary, threadId: args[0] },
      };
      fixture.resumePreparations += 1;
      if (fixture.resumePrepareReady) await fixture.resumePrepareReady;
      return prepared;
    }
    if (channel === "codex:thread:resume:accept") return;
    if (channel === "codex:thread:resume:release") {
      fixture.releasedResumes += 1;
      return;
    }
    if (channel === "codex:app-server:request") {
      const input = args[0] as {
        request: { method: string; params: unknown };
        scheduling?: { priority?: string; source?: string };
        caller?: { timeoutMs?: number };
      };
      fixture.calls.push(input.request);
      fixture.scheduling.push({
        method: input.request.method,
        priority: input.scheduling?.priority,
        source: input.scheduling?.source,
        timeoutMs: input.caller?.timeoutMs,
      });
      if (fixture.nativeRequest)
        return {
          type: "result",
          result: await fixture.nativeRequest(input.request.method, input.request.params),
        };
      if (input.request.method === "thread/resume")
        return {
          type: "result",
          result:
            (input.request.params as { threadId: string }).threadId === "fork-child"
              ? {
                  ...fixture.response!,
                  thread: {
                    ...fixture.response!.thread,
                    id: "fork-child",
                    forkedFromId: fixture.summary!.threadId,
                  },
                }
              : fixture.response,
        };
      if (input.request.method === "thread/read")
        return {
          type: "result",
          result: {
            thread: {
              ...fixture.response!.thread,
              id: (input.request.params as { threadId: string }).threadId,
            },
          },
        };
      if (input.request.method === "thread/items/list") {
        const { turnId, sortDirection } = input.request.params as {
          turnId: string;
          sortDirection: string;
        };
        const items = [
          ...(fixture.response!.thread.turns.find((turn) => turn.id === turnId)?.items ?? []),
        ];
        if (sortDirection === "desc") items.reverse();
        return {
          type: "result",
          result: {
            data: items.map((item) => ({ turnId, item })),
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      }
      if (input.request.method === "thread/turns/list")
        return {
          type: "result",
          result: {
            data: [...fixture.response!.thread.turns].reverse(),
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      if (input.request.method === "thread/goal/get")
        return { type: "result", result: { goal: (await fixture.readGoal?.()) ?? null } };
      if (input.request.method === "thread/unsubscribe") return { type: "result", result: {} };
      if (input.request.method === "thread/settings/update")
        return { type: "result", result: (await fixture.updateSettings?.()) ?? {} };
    }
    throw new Error(`Unexpected native test operation ${channel}`);
  },
}));

vi.mock("./local-conversation-operations", async () => {
  const deps = await import("./local-conversation-deps");
  return { runConversationOperation: deps.runConversationOperation };
});

vi.mock("./conversation-coordination-connection", () => ({
  connectConversationCoordination: () => {
    const host: ConversationCoordinationHost = {
      findThreadOwner: async (input) =>
        input.conversationId === "fork-child" ? null : fixture.ownerId,
      setThreadOwnership: async () => {},
      threadArchived: async () => {},
      threadUnarchived: async () => {},
      threadQueuedFollowUpsChanged: async (params) => {
        fixture.queueBroadcasts.push(params);
        fixture.follower?.receiveCoordination("threadQueuedFollowUpsChanged", {
          sourceClientId: "owner",
          params,
        });
      },
      threadStreamFollowingStatusRequested: async () => {},
      threadStreamFollowingChanged: async (input) => {
        fixture.owner?.receiveCoordination("threadStreamFollowingChanged", {
          sourceClientId: "follower",
          params: input.params,
        });
      },
      threadStreamStateChanged: async (input) => {
        fixture.changes.push(input.params.change);
        fixture.follower?.receiveCoordination("threadStreamStateChanged", {
          sourceClientId: "owner",
          params: input.params,
        });
      },
      requestThreadFollower: async (input) => {
        fixture.followerRequests.push(input.request);
        if (!fixture.owner) throw new Error("Owner unavailable");
        const result = await fixture.owner.handleThreadFollowerRequest(input.request);
        return {
          type: "response",
          requestId: "peer",
          resultType: "success",
          method: result.method,
          handledByClientId: "owner",
          result: result.result,
        };
      },
    };
    return {
      ready: Promise.resolve(host),
      readStateReady: Promise.resolve(undefined),
      [Symbol.dispose]: () => {},
    };
  },
}));

import {
  CodexAppServerManager as Manager,
  CodexAppServerManagerRegistry,
} from "./local-conversation-store";
import { rendererQueuedMessageStorage } from "./renderer-queued-message-storage";
import { dispatchCodexAppServerMessage } from "./app-server-message-bus";

async function connectedManagers(
  items: Parameters<typeof buildAgentActivityV2CorpusThread>[0] = [],
  hostId = "local",
) {
  fixture.hostId = hostId;
  const thread = { ...buildAgentActivityV2CorpusThread(items), path: "/tmp/native-stream.jsonl" };
  fixture.summary = {
    threadId: thread.id,
    projectId: "project",
    threadName: "Thread",
    threadPreview: "",
    modelProvider: "openai",
    cwd: thread.cwd,
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    hasUnreadTurn: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-09-13T00:00:00Z",
    source: null,
  };
  fixture.response = {
    thread,
    model: "model-one",
    modelProvider: "openai",
    serviceTier: null,
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: { data: thread.turns, nextCursor: null, backwardsCursor: null },
    turnsBackwardsCursor: "resume-tail",
    itemsBackwardsCursor: null,
  };
  fixture.owner = new Manager(hostId);
  await fixture.owner.requestThreadStreamResume(thread.id);
  fixture.ownerId = "owner";
  fixture.follower = new Manager(hostId);
  fixture.follower.retainActiveConversation(thread.id);
  await fixture.follower.requestThreadStreamResume(thread.id);
  return {
    owner: fixture.owner,
    follower: fixture.follower,
    threadId: thread.id,
    turnId: thread.turns[0]!.id,
  };
}

afterEach(() => {
  fixture.owner?.destroy();
  fixture.follower?.destroy();
  fixture.owner = null;
  fixture.follower = null;
  fixture.ownerId = null;
  fixture.hostId = "local";
  fixture.generation = 1;
  fixture.sourceEpoch = null;
  fixture.accountId = "account";
  fixture.hostContextReady = null;
  fixture.resumePrepareReady = null;
  fixture.workspaceReady = null;
  fixture.resumePreparations = 0;
  fixture.resumeOptions.length = 0;
  fixture.releasedResumes = 0;
  fixture.queuedPreparations = 0;
  fixture.windowFocusListeners.clear();
  fixture.queueState = {};
  fixture.queueBroadcasts.length = 0;
  rendererQueuedMessageStorage.invalidate();
  fixture.calls.length = 0;
  fixture.scheduling.length = 0;
  fixture.changes.length = 0;
  fixture.updateSettings = null;
  fixture.nativeRequest = null;
  fixture.readGoal = null;
  fixture.followerRequests.length = 0;
});

test("an already attached follower stays resumed without requiring another owner snapshot", async () => {
  const { follower, threadId } = await connectedManagers();
  const before = follower.readConversation(threadId)!.canonicalState!;
  const requests = fixture.calls.length;
  const changes = fixture.changes.length;
  await act(async () => {
    await follower.requestThreadStreamResume(threadId);
  });
  expect(follower.readConversation(threadId)?.resumeState).toBe("resumed");
  expect(follower.readConversation(threadId)?.canonicalState).toBe(before);
  expect(follower.readConversationStreamRole(threadId)).toBe("follower");
  expect(fixture.calls).toHaveLength(requests);
  expect(fixture.changes).toHaveLength(changes);
});

test("an inactive unowned window leaves retained history resumable without native preparation", async () => {
  const { owner, threadId } = await connectedManagers();
  owner.retireNativeHostContext();
  const activity = owner.registerWindowActivity({
    canAcquireThreadStream: false,
    routePath: "/hotkey-window",
    visibilityState: "hidden",
  });
  const requests = fixture.calls.length;
  const preparations = fixture.resumePreparations;
  try {
    expect(await owner.requestThreadStreamResume(threadId)).toBeNull();
    expect(owner.getStreamRole(threadId)).toBeNull();
    expect(owner.readConversation(threadId)?.resumeState).toBe("needs_resume");
    expect(fixture.calls).toHaveLength(requests);
    expect(fixture.resumePreparations).toBe(preparations);
  } finally {
    activity[Symbol.dispose]();
  }
});

test.each(["metadata", "preparation"] as const)(
  "ownership permission lost during %s defers resume and releases unused admission",
  async (stage) => {
    const { owner, threadId } = await connectedManagers();
    owner.retireNativeHostContext();
    const active = {
      canAcquireThreadStream: true,
      routePath: "/hotkey-window",
      visibilityState: "visible" as const,
    };
    const activity = owner.registerWindowActivity(active);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (stage === "metadata") fixture.workspaceReady = gate;
    else fixture.resumePrepareReady = gate;
    const preparations = fixture.resumePreparations;
    const releases = fixture.releasedResumes;
    fixture.calls.length = 0;
    const pending = owner.requestThreadStreamResume(threadId);
    try {
      await waitFor(() => {
        if (stage === "preparation") expect(fixture.resumePreparations).toBe(preparations + 1);
        else expect(fixture.calls.some((call) => call.method === "thread/read")).toBe(true);
      });
      activity.update({ ...active, canAcquireThreadStream: false });
      release();
      expect(await pending).toBeNull();
      expect(owner.getStreamRole(threadId)).toBeNull();
      expect(owner.readConversation(threadId)?.resumeState).toBe("needs_resume");
      expect(fixture.calls.some((call) => call.method === "thread/resume")).toBe(false);
      expect(fixture.resumePreparations).toBe(preparations + 1);
      expect(fixture.releasedResumes).toBe(releases + 1);
    } finally {
      release();
      activity[Symbol.dispose]();
      await pending.catch(() => {});
    }
  },
);

test("activity restrictions do not demote an attached follower", async () => {
  const { follower, threadId } = await connectedManagers();
  const activity = follower.registerWindowActivity({
    canAcquireThreadStream: false,
    routePath: "/hotkey-window",
    visibilityState: "hidden",
  });
  const before = follower.readConversation(threadId)?.canonicalState;
  try {
    expect((await follower.requestThreadStreamResume(threadId))?.canonicalState).toBe(before);
    expect(follower.readConversationStreamRole(threadId)).toBe("follower");
  } finally {
    activity[Symbol.dispose]();
  }
});

test("registered managers track window activity and retire their document listener", async () => {
  const registry = new CodexAppServerManagerRegistry();
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const initialUrl = window.location.href;
  const initialState: unknown = window.history.state;
  const focus = vi.spyOn(document, "hasFocus");
  const removeListener = vi.spyOn(document, "removeEventListener");
  let visible: DocumentVisibilityState = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible });
  window.history.replaceState(null, "", "/hotkey-window/thread/thread");
  focus.mockReturnValue(false);
  const manager = registry.getForHostId("local");
  try {
    expect(manager.getWindowActivity()?.canAcquireThreadStream).toBe(false);
    for (const [route, visibilityState, focused, canAcquire] of [
      ["/hotkey-window/thread/thread", "visible", false, false],
      ["/hotkey-window/thread/thread", "visible", true, true],
      ["/?initialRoute=/hotkey-window", "hidden", false, false],
      ["/hotkey-window-other", "hidden", false, true],
      ["/global-dictation", "hidden", false, true],
      ["/", "hidden", false, true],
    ] as const) {
      window.history.replaceState(null, "", route);
      visible = visibilityState;
      focus.mockReturnValue(focused);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(manager.getWindowActivity()).toEqual({
        canAcquireThreadStream: canAcquire,
        routePath: window.location.pathname,
        visibilityState,
      });
    }
    removeListener.mockClear();
    window.history.replaceState(null, "", "/hotkey-window");
    visible = "visible";
    focus.mockReturnValue(true);
    await act(async () => {
      for (const listener of fixture.windowFocusListeners) listener(true);
    });
    expect(manager.getWindowActivity()?.canAcquireThreadStream).toBe(true);
    focus.mockReturnValue(false);
    await act(async () => {
      for (const listener of fixture.windowFocusListeners) listener(false);
    });
    expect(manager.getWindowActivity()?.canAcquireThreadStream).toBe(false);
    expect(fixture.windowFocusListeners.size).toBe(1);
    registry.deleteManager("local");
    expect(fixture.windowFocusListeners.size).toBe(0);
    expect(manager.getWindowActivity()).toBeUndefined();
    expect(removeListener.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);
  } finally {
    registry.deleteManager("local");
    focus.mockRestore();
    removeListener.mockRestore();
    window.history.replaceState(initialState, "", initialUrl);
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("executor acquisition reads live window activity instead of a stale view registration", async () => {
  const { owner, threadId } = await connectedManagers();
  owner.retireNativeHostContext();
  const activity = owner.registerWindowActivity({
    canAcquireThreadStream: false,
    routePath: "/hotkey-window",
    visibilityState: "hidden",
  });
  try {
    expect(await owner.requestThreadStreamResume(threadId)).toBeNull();
    expect(await owner.requestThreadStreamResume(threadId, { source: "executor" })).toMatchObject({
      threadId,
      resumeState: "resumed",
    });
    expect(owner.readConversationStreamRole(threadId)).toBe("owner");
  } finally {
    activity[Symbol.dispose]();
  }
});

test.each(
  ["local", "durable"].flatMap((hostId) =>
    ["selected-profile", ":danger-full-access"].map((profileId) => ({ hostId, profileId })),
  ),
)(
  "renderer resume retains caller permission provenance on $hostId/$profileId",
  async ({ hostId, profileId }) => {
    const { owner, follower, threadId } = await connectedManagers([], hostId);
    follower.destroy();
    fixture.follower = null;
    owner.retireNativeHostContext();
    const options: ConversationResumePreparationOptions = {
      permissions: {
        activePermissionProfile: { id: profileId, extends: null },
        runtimeWorkspaceRoots: [fixture.response!.cwd, "/selected"],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      serviceTier: null,
      useAppServerPermissionDefault: true,
      preserveServerConfiguration: hostId === "durable",
    };
    const resumed = await owner.requestThreadStreamResume(threadId, options);
    expect(resumed?.threadId).toBe(threadId);
    expect(fixture.resumeOptions.at(-1)).toEqual(options);
    expect(resumed?.canonicalState?.currentPermissions?.activePermissionProfile).toEqual(
      options.permissions?.activePermissionProfile,
    );
    expect(
      resumed?.canonicalState?.hydrationContext?.latestThreadSettings?.activePermissionProfile,
    ).toEqual(options.permissions?.activePermissionProfile);
    if (profileId === ":danger-full-access") {
      expect(resumed?.canonicalState?.currentPermissions?.sandboxPolicy.type).toBe(
        "dangerFullAccess",
      );
      for (const turn of residentConversationTurns(resumed?.canonicalState)) {
        expect(turn.params.sandboxPolicy).toEqual(fixture.response!.sandbox);
        expect(turn.params.approvalPolicy).toBe(fixture.response!.approvalPolicy);
      }
    }
  },
);

test("automatic queued preparation retains its tier while resuming and defers while its native turn is active", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, callback: () => Promise<void>) => callback() },
  });
  const { owner, follower, threadId } = await connectedManagers();
  const completed = {
    ...fixture.response!.thread.turns[0]!,
    status: "completed" as const,
    completedAt: 2,
    durationMs: 1000,
  };
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: "before-reconnect",
    occurrenceToken: 1,
    notification: { method: "turn/completed", params: { threadId, turn: completed } },
  });
  follower.destroy();
  fixture.follower = null;
  owner.retireNativeHostContext();
  fixture.response = {
    ...fixture.response!,
    thread: {
      ...fixture.response!.thread,
      status: { type: "active", activeFlags: [] },
      turns: [completed, { ...fixture.response!.thread.turns[0]!, id: "active-on-server" }],
    },
  };
  await owner.enqueueQueuedFollowUp(threadId, "Keep this queued until the active turn completes", {
    serviceTier: "priority",
  });
  const message = fixture.queueState[threadId]![0]!;
  expect(message.submissionOptions?.serviceTier).toBe("priority");
  fixture.calls.length = 0;
  const prepared = fixture.queuedPreparations;
  dispatchCodexAppServerMessage("shared-object-updated", {
    hostId: "local",
    object: {
      objectType: "connection",
      objectId: "connection",
      value: { status: "connected", retries: 0 },
    },
  });
  await waitFor(() => expect(fixture.queuedPreparations).toBe(prepared + 1));
  expect(owner.readConversationStreamRole(threadId)).toBe("owner");
  expect(fixture.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
  expect(fixture.resumeOptions.at(-1)?.serviceTier).toBe("priority");
  expect(
    fixture.calls.some((call) => call.method === "turn/start" || call.method === "turn/steer"),
  ).toBe(false);
  expect(fixture.queueState[threadId]).toEqual([message]);
  expect(owner.readConversation(threadId)?.queuedFollowUps.entries).toHaveLength(1);
});

test.each(["view", "executor"] as const)(
  "a different resume source reevaluates after failed %s preparation while recovery shares it",
  async (source) => {
    const { owner, threadId } = await connectedManagers();
    owner.retireNativeHostContext();
    let reject!: (error: Error) => void;
    fixture.resumePrepareReady = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const preparations = fixture.resumePreparations;
    const first = owner.requestThreadStreamResume(threadId, { source }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitFor(() => expect(fixture.resumePreparations).toBe(preparations + 1));
    const different = owner
      .requestThreadStreamResume(threadId, {
        source: source === "view" ? "executor" : "view",
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    const recovery = owner.requestThreadStreamResume(threadId, { source: "recovery" }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    fixture.resumePrepareReady = null;
    const failure = new Error("Initial resume preparation failed");
    reject(failure);
    expect(await first).toEqual({ error: failure });
    expect(await recovery).toEqual({ error: failure });
    expect(await different).toMatchObject({ value: { threadId, resumeState: "resumed" } });
    expect(fixture.resumePreparations).toBe(preparations + 2);
    expect(owner.readConversationStreamRole(threadId)).toBe("owner");
  },
);

test.each(["archive", "dispose"] as const)(
  "a different-source waiter cannot recreate a conversation after %s during preparation",
  async (ending) => {
    const { owner, threadId } = await connectedManagers();
    owner.retireNativeHostContext();
    let release!: () => void;
    fixture.resumePrepareReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparations = fixture.resumePreparations;
    const first = owner
      .requestThreadStreamResume(threadId, { source: "executor" })
      .catch(() => null);
    await waitFor(() => expect(fixture.resumePreparations).toBe(preparations + 1));
    const waiting = owner.requestThreadStreamResume(threadId, { source: "view" }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (ending === "archive") {
      owner.receiveCoordination("threadArchived", {
        sourceClientId: "peer",
        params: { hostId: "local", conversationId: threadId },
      });
    } else owner.destroy();
    release();
    await first;
    expect(await waiting).toEqual({ value: null });
    expect(fixture.resumePreparations).toBe(preparations + 1);
    expect(owner.getStreamRole(threadId)).toBeNull();
  },
);

test("a followed snapshot arriving during preparation avoids a second native resume", async () => {
  const { follower, threadId } = await connectedManagers();
  follower.destroy();
  const fresh = new Manager("local");
  fixture.follower = fresh;
  fixture.ownerId = null;
  let finishPreparation!: () => void;
  fixture.resumePrepareReady = new Promise<void>((resolve) => {
    finishPreparation = resolve;
  });
  const preparations = fixture.resumePreparations;
  const requests = fixture.calls.filter((call) => call.method === "thread/resume").length;
  const pending = fresh.requestThreadStreamResume(threadId);
  await waitFor(() => expect(fixture.resumePreparations).toBe(preparations + 1));
  const view = fresh.retainActiveConversation(threadId);
  try {
    await waitFor(() => expect(fresh.readConversationStreamRole(threadId)).toBe("follower"));
    await act(async () => {
      finishPreparation();
      await pending;
    });
    expect(fresh.readConversationStreamRole(threadId)).toBe("follower");
    expect(fresh.readConversation(threadId)?.resumeState).toBe("resumed");
    expect(fixture.calls.filter((call) => call.method === "thread/resume")).toHaveLength(requests);
  } finally {
    finishPreparation();
    view[Symbol.dispose]();
  }
});

test("a follower loads and coalesces its resident history page without changing its owner", async () => {
  const { owner, follower, threadId } = await connectedManagers();
  const ownerState = owner.readConversation(threadId)!.canonicalState!;
  const partial = produce(ownerState, (draft) => {
    replaceCanonicalHistoryDraft(draft, residentConversationTurns(ownerState), false, {
      cursor: "older-page",
      oldestLoadedTurnId: residentConversationTurns(ownerState)[0]!.turnId,
    });
  });
  follower.receiveCoordination("threadStreamStateChanged", {
    sourceClientId: "owner",
    params: {
      hostId: "local",
      conversationId: threadId,
      change: { type: "snapshot", revision: 10, conversationState: partial },
    },
  });
  const history = partial.turnHistory!.history;
  const island = history.islands[0]!;
  if (island.olderBoundary.status !== "available")
    throw new Error("Expected an older history boundary");
  const request = {
    threadId,
    expectedConversationGeneration: 1,
    expectedHistoryMutationRevision: 0,
    target: {
      kind: "turnBoundary" as const,
      boundary: createCodexHistoryBoundaryRef(
        history.generation,
        island.id,
        "older",
        island.olderBoundary,
      ),
    },
  };
  let complete!: (value: unknown) => void;
  fixture.nativeRequest = async (method) => {
    if (method === "thread/items/list")
      return {
        data: fixture.response!.thread.turns[0]!.items.map((item) => ({
          turnId: "older-turn",
          item,
        })),
        nextCursor: null,
      };
    if (method !== "thread/turns/list") throw new Error(`Unexpected page method ${method}`);
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  fixture.calls.length = 0;
  fixture.changes.length = 0;
  fixture.followerRequests.length = 0;
  const first = follower.requestHistoryPage(request);
  const second = follower.requestHistoryPage(request);
  expect(second).toBe(first);
  await waitFor(() => expect(fixture.calls).toHaveLength(1));
  expect(fixture.calls[0]).toMatchObject({
    method: "thread/turns/list",
    params: { threadId, cursor: "older-page", limit: 5, sortDirection: "desc" },
  });
  complete({
    data: [
      {
        ...fixture.response!.thread.turns[0]!,
        id: "older-turn",
        items: [],
        itemsView: "notLoaded",
      },
    ],
    nextCursor: null,
    backwardsCursor: null,
  });
  await expect(first).resolves.toEqual({ status: "applied" });
  expect(
    residentConversationTurns(follower.readConversation(threadId)!.canonicalState!).map(
      (turn) => turn.turnId,
    ),
  ).toContain("older-turn");
  expect(owner.readConversation(threadId)!.canonicalState).toBe(ownerState);
  expect(follower.getStreamRole(threadId)).toEqual({ role: "follower", ownerClientId: "owner" });
  expect(fixture.followerRequests).toHaveLength(0);
  expect(fixture.changes).toHaveLength(0);
  await expect(follower.requestHistoryPage(request)).resolves.toEqual({ status: "stale" });
  expect(fixture.calls.map((call) => call.method)).toEqual([
    "thread/turns/list",
    "thread/items/list",
  ]);
});

test("peer actions require the current owner and a supported method", async () => {
  const { owner, follower, threadId } = await connectedManagers();
  const request = conversationFollowerRequest("thread-follower-compact-thread", {
    conversationId: threadId,
  });
  await expect(follower.handleThreadFollowerRequest(request)).rejects.toThrow("not owner");
  await expect(
    owner.handleThreadFollowerRequest({
      method: "startTurn",
      params: { conversationId: threadId },
    }),
  ).rejects.toThrow("Unsupported conversation follower method");
  await expect(
    owner.handleThreadFollowerRequest({ method: request.method, params: { threadId } }),
  ).rejects.toThrow("conversation identity");
  expect(fixture.calls.some((call) => call.method === "thread/compact/start")).toBe(false);
});

test("native owner mutations reach a following manager as actual draft patches", async () => {
  const { owner, follower, threadId, turnId } = await connectedManagers();
  const notification = (
    value: Parameters<
      typeof dispatchCodexAppServerMessage<"native-notification">
    >[1]["notification"],
  ) =>
    dispatchCodexAppServerMessage("native-notification", {
      type: "nativeNotification",
      hostId: "local",
      generation: 1,
      occurrenceId: crypto.randomUUID(),
      occurrenceToken: 1,
      notification: value,
    });
  const item = {
    type: "agentMessage" as const,
    id: "message",
    text: "",
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  notification({ method: "item/started", params: { threadId, turnId, item, startedAtMs: 1 } });
  notification({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: item.id, delta: "Final answer" },
  });
  notification({
    method: "item/completed",
    params: { threadId, turnId, item: { ...item, text: "Final answer" }, completedAtMs: 2 },
  });
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState).toEqual(
      owner.readConversation(threadId)?.canonicalState,
    ),
  );
  const state = follower.readConversation(threadId)?.canonicalState;
  expect(
    state &&
      residentConversationTurns(state)
        .flatMap((turn) => turn.items)
        .some((entry) => entry.type === "agentMessage" && entry.text === "Final answer"),
  ).toBe(true);
  expect(fixture.changes.some((change) => (change as { type: string }).type === "patches")).toBe(
    true,
  );
  expect(fixture.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
});

test("follower settings use the owner's native FIFO and publish the completed value", async () => {
  const { owner, follower, threadId } = await connectedManagers();
  let finish!: () => void;
  fixture.updateSettings = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const first = follower.setThreadSettingsForConversation(threadId, { model: "model-two" });
  await waitFor(() =>
    expect(fixture.calls.filter((call) => call.method === "thread/settings/update")).toHaveLength(
      1,
    ),
  );
  const second = owner.setThreadSettingsForConversation(threadId, { reasoningEffort: "low" });
  await Promise.resolve();
  expect(fixture.calls.filter((call) => call.method === "thread/settings/update")).toHaveLength(1);
  fixture.updateSettings = null;
  finish();
  await Promise.all([first, second]);
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState?.latestModel).toBe("model-two"),
  );
  expect(follower.readConversation(threadId)?.canonicalState?.latestReasoningEffort).toBe("low");
});

test("complete-history follower requests always publish a revision the follower can await", async () => {
  const { owner, threadId } = await connectedManagers();
  fixture.changes.length = 0;
  const response = await owner.handleThreadFollowerRequest(
    conversationFollowerRequest("thread-follower-load-complete-history", {
      conversationId: threadId,
    }),
  );
  expect(response.method).toBe("thread-follower-load-complete-history");
  expect(response.result).toEqual({ revision: expect.any(Number) });
  expect((response.result as { revision: number }).revision).toBeGreaterThan(0);
  expect(fixture.changes.at(-1)).toMatchObject({
    type: "snapshot",
    revision: (response.result as { revision: number }).revision,
  });
});

test("native request identity and resolution propagate through the owner's document", async () => {
  const { owner, follower, threadId, turnId } = await connectedManagers();
  dispatchCodexAppServerMessage("native-request", {
    type: "nativeRequest",
    hostId: "local",
    generation: 1,
    occurrenceId: "request-occurrence",
    occurrenceToken: 21,
    request: {
      method: "item/tool/requestUserInput",
      id: 0,
      params: {
        threadId,
        turnId,
        itemId: "question",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Continue?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Continue", description: "Proceed" },
              { label: "Stop", description: "Pause" },
            ],
          },
        ],
      },
    },
  });
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState?.requests).toEqual(
      owner.readConversation(threadId)?.canonicalState?.requests,
    ),
  );
  expect(follower.readConversation(threadId)?.canonicalState?.requests[0]?.id).toBe(0);
  expect(owner.readConversation(threadId)?.requests).toHaveLength(1);
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: "resolved-occurrence",
    occurrenceToken: 22,
    notification: { method: "serverRequest/resolved", params: { threadId, requestId: 0 } },
  });
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState?.requests).toHaveLength(0),
  );
});

test("hydration leaves async questions closed while a live owner patch opens them", async () => {
  const hydrated = {
    type: "agentMessage" as const,
    id: "hydrated-question",
    text: "Earlier question",
    phase: null,
    memoryCitation: null,
    delivery: "async" as const,
    questions: [{ title: "Earlier?", options: ["Yes", "No"] }],
  };
  const { owner, follower, threadId, turnId } = await connectedManagers([hydrated]);
  expect(follower.asyncQuestions.read(threadId).selectedId).toBeNull();
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: "live-question",
    occurrenceToken: 31,
    notification: {
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: Date.now(),
        item: {
          ...hydrated,
          id: "live-question",
          questions: [{ title: "Continue now?", options: ["Yes", "No"] }],
        },
      },
    },
  });
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState).toEqual(
      owner.readConversation(threadId)?.canonicalState,
    ),
  );
  expect(
    Object.values(follower.asyncQuestions.read(threadId).questions).map(
      (entry) => entry.sourceItemId,
    ),
  ).toContain("live-question");
  await waitFor(() => expect(follower.asyncQuestions.read(threadId).selectedId).not.toBeNull());
  expect(owner.asyncQuestions.read(threadId).selectedId).toBe(
    follower.asyncQuestions.read(threadId).selectedId,
  );
});

test("an inactive owner retires its native subscription after the final follower leaves", async () => {
  vi.useFakeTimers();
  try {
    const { owner, follower, threadId, turnId } = await connectedManagers();
    dispatchCodexAppServerMessage("native-notification", {
      type: "nativeNotification",
      hostId: "local",
      generation: 1,
      occurrenceId: "completed",
      occurrenceToken: 40,
      notification: {
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        },
      },
    });
    dispatchCodexAppServerMessage("native-notification", {
      type: "nativeNotification",
      hostId: "local",
      generation: 1,
      occurrenceId: "idle",
      occurrenceToken: 41,
      notification: {
        method: "thread/status/changed",
        params: { threadId, status: { type: "idle" } },
      },
    });
    await follower.setThreadStreamFollowing(threadId, false);
    await vi.advanceTimersByTimeAsync(10_800_000 - 1);
    expect(fixture.calls.some((call) => call.method === "thread/unsubscribe")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(fixture.calls.filter((call) => call.method === "thread/unsubscribe")).toHaveLength(1);
    expect(owner.getStreamRole(threadId)).toBeNull();
    expect(owner.readConversation(threadId)?.resumeState).toBe("needs_resume");
  } finally {
    vi.useRealTimers();
  }
});

test("follower queue edits persist whole messages and converge through the independent peer broadcast", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, callback: () => Promise<void>) => callback() },
  });
  const { owner, follower, threadId } = await connectedManagers();
  const patchCount = fixture.changes.length;
  await follower.enqueueQueuedFollowUp(threadId, "Next question");
  await waitFor(() =>
    expect(owner.readConversation(threadId)?.queuedFollowUps.entries).toHaveLength(1),
  );
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.queuedFollowUps.entries).toEqual(
      owner.readConversation(threadId)?.queuedFollowUps.entries,
    ),
  );
  const message = fixture.queueState[threadId]?.[0];
  expect(message?.context.prompt).toBe("Next question");
  expect(fixture.queueBroadcasts).toHaveLength(1);
  expect(fixture.changes).toHaveLength(patchCount);
  await follower.removeQueuedFollowUp(threadId, message!.id);
  await waitFor(() =>
    expect(owner.readConversation(threadId)?.queuedFollowUps.entries).toEqual([]),
  );
  expect(fixture.queueState[threadId]).toBeUndefined();
});

test("a queue loaded before its conversation retains paused rows when history arrives", async () => {
  const { owner, follower, threadId } = await connectedManagers();
  owner.destroy();
  follower.destroy();
  fixture.ownerId = null;
  fixture.follower = null;
  fixture.queueState = {
    [threadId]: ["first", "second"].map((id) => ({
      id,
      cwd: "/tmp",
      pausedReason: "Interrupted before the steer was accepted.",
      context: {
        prompt: id,
        fileAttachments: [],
        addedFiles: [],
        commentAttachments: [],
        imageAttachments: [],
      },
    })),
  };
  rendererQueuedMessageStorage.invalidate();
  const manager = (fixture.owner = new Manager("local"));
  const view = manager.retainActiveConversation(threadId);
  try {
    await rendererQueuedMessageStorage.load();
    expect(manager.readConversation(threadId)).toBeNull();
    await manager.requestThreadStreamResume(threadId);
    expect(
      manager.readConversation(threadId)?.queuedFollowUps.entries.map((entry) => ({
        id: entry.followUpId,
        pause: entry.pause?.kind,
      })),
    ).toEqual([
      { id: "first", pause: "interrupted" },
      { id: "second", pause: "interrupted" },
    ]);
    expect(fixture.queueState[threadId]).toHaveLength(2);
    expect(
      fixture.calls.some((call) => call.method === "turn/start" || call.method === "turn/steer"),
    ).toBe(false);
  } finally {
    view[Symbol.dispose]();
  }
});

test("manual queued send uses the native steer driver with the captured message identity", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, callback: () => Promise<void>) => callback() },
  });
  const { owner, threadId, turnId } = await connectedManagers();
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: "start",
    occurrenceToken: 1,
    notification: {
      method: "turn/started",
      params: { threadId, turn: { ...fixture.response!.thread.turns[0]!, status: "inProgress" } },
    },
  });
  await owner.enqueueQueuedFollowUp(threadId, "Change direction");
  const message = fixture.queueState[threadId]![0]!;
  await owner.sendQueuedFollowUpNow(threadId, message.id);
  await waitFor(() =>
    expect(owner.readConversation(threadId)?.queuedFollowUps.entries).toEqual([]),
  );
  const request = fixture.calls.find((call) => call.method === "turn/steer");
  expect(request?.params).toMatchObject({
    threadId,
    expectedTurnId: turnId,
    clientUserMessageId: message.id,
    input: [{ type: "text", text: "Change direction" }],
  });
});

test("forking from a follower hydrates the new owner from native responses before adding its marker", async () => {
  const { follower, threadId, turnId } = await connectedManagers();
  const result = await follower.forkConversationFromTurn(threadId, turnId, "");
  expect(result.threadId).toBe("fork-child");
  expect(follower.getStreamRole("fork-child")).toMatchObject({ role: "owner" });
  const child = follower.readConversation("fork-child")?.canonicalState;
  expect(residentConversationTurns(child).flatMap((turn) => turn.items)).toContainEqual(
    expect.objectContaining({
      type: "forkedFromConversation",
      sourceConversationId: threadId,
      sourceConversationTitle: "Source title",
    }),
  );
  expect(fixture.calls.filter((call) => call.method === "thread/fork")).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.method === "thread/resume")).toHaveLength(2);
});

test("follower manual compaction is native on the owner and classifies the following native item", async () => {
  const { owner, follower, threadId, turnId } = await connectedManagers();
  fixture.nativeRequest = async () => ({});
  await follower.compactThread(threadId);
  expect(fixture.calls.filter((call) => call.method === "thread/compact/start")).toMatchObject([
    { method: "thread/compact/start", params: { threadId } },
  ]);
  const items = () =>
    residentConversationTurns(owner.readConversation(threadId)!.canonicalState!).flatMap(
      (turn) => turn.items,
    );
  expect(items()).toContainEqual({
    type: "contextCompaction",
    id: "pending-manual-context-compaction",
    completed: false,
    source: "manual",
  });
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: crypto.randomUUID(),
    occurrenceToken: 1,
    notification: {
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: 1,
        item: { type: "contextCompaction", id: "actual-compaction" },
      },
    },
  });
  expect(items().find((item) => item.id === "actual-compaction")).toMatchObject({
    source: "manual",
    completed: false,
  });
  expect(items().some((item) => item.id === "pending-manual-context-compaction")).toBe(false);
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState).toEqual(
      owner.readConversation(threadId)?.canonicalState,
    ),
  );
});

test("a rejected manual compaction removes its pending marker and does not misclassify later automatic work", async () => {
  const { owner, threadId, turnId } = await connectedManagers();
  fixture.nativeRequest = async () => {
    throw new Error("compaction rejected");
  };
  await expect(owner.compactThread(threadId)).rejects.toThrow("compaction rejected");
  const items = () =>
    residentConversationTurns(owner.readConversation(threadId)!.canonicalState!).flatMap(
      (turn) => turn.items,
    );
  expect(items().some((item) => item.id === "pending-manual-context-compaction")).toBe(false);
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: crypto.randomUUID(),
    occurrenceToken: 1,
    notification: {
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: 1,
        item: { type: "contextCompaction", id: "automatic-compaction" },
      },
    },
  });
  expect(items().find((item) => item.id === "automatic-compaction")).toMatchObject({
    source: "automatic",
  });
});

test("goal objectives are owner-local native mutations while clearing waits for the native notification", async () => {
  const { owner, follower, threadId } = await connectedManagers();
  const goal = {
    threadId,
    objective: "Complete the change",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 3,
    updatedAt: 3,
  };
  fixture.nativeRequest = async (method) =>
    method === "thread/goal/set" ? { goal } : { cleared: true };
  await expect(follower.setThreadGoal({ threadId, objective: goal.objective })).rejects.toThrow();
  expect(fixture.calls.some((call) => call.method === "thread/goal/set")).toBe(false);
  expect(await owner.setThreadGoal({ threadId, objective: goal.objective })).toEqual(goal);
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState?.threadGoal).toEqual(goal),
  );
  const state = owner.readConversation(threadId)!.canonicalState!;
  expect(residentConversationTurns(state).at(-1)?.params.input).toEqual([
    { type: "text", text: "/goal Complete the change", text_elements: [] },
  ]);
  await owner.clearThreadGoal(threadId);
  expect(owner.readConversation(threadId)?.canonicalState?.threadGoal).toEqual(goal);
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: crypto.randomUUID(),
    occurrenceToken: 1,
    notification: { method: "thread/goal/cleared", params: { threadId } },
  });
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState?.threadGoal).toBeNull(),
  );
});

test("background resume goal hydration cannot overwrite a newer native goal notification", async () => {
  let resolveGoal!: (goal: import("@nodex/codex-app-server-protocol/v2").ThreadGoal) => void;
  fixture.readGoal = () =>
    new Promise((resolve) => {
      resolveGoal = resolve;
    });
  const { owner, follower, threadId } = await connectedManagers();
  const current = {
    threadId,
    objective: "New objective",
    status: "paused" as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 3,
    updatedAt: 4,
  };
  dispatchCodexAppServerMessage("native-notification", {
    type: "nativeNotification",
    hostId: "local",
    generation: 1,
    occurrenceId: crypto.randomUUID(),
    occurrenceToken: 1,
    notification: {
      method: "thread/goal/updated",
      params: { threadId, turnId: null, goal: current },
    },
  });
  resolveGoal({ ...current, objective: "Old objective", updatedAt: 3 });
  await waitFor(() =>
    expect(follower.readConversation(threadId)?.canonicalState?.threadGoal).toEqual(current),
  );
  await Promise.resolve();
  expect(owner.readConversation(threadId)?.canonicalState?.threadGoal).toEqual(current);
});

test("requested resume confirmation hydrates a paused goal before resume resolves", async () => {
  const { owner, threadId } = await connectedManagers();
  fixture.scheduling.length = 0;
  const goal = {
    threadId,
    objective: "Resume after review",
    status: "paused" as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 3,
    updatedAt: 4,
  };
  fixture.readGoal = async () => goal;
  owner.retireNativeHostContext();
  const resumed = await owner.requestThreadStreamResume(threadId, {
    showThreadGoalResumeConfirmation: true,
  });
  expect(resumed?.canonicalState?.threadGoal).toEqual(goal);
  expect(resumed?.canonicalState?.threadGoalResumeConfirmation).toEqual(goal);
  expect(fixture.scheduling.find((request) => request.method === "thread/goal/get")).toMatchObject({
    priority: "critical",
    source: "thread_hydration",
  });
});

test.each(["ancestor", "different root"])(
  "resume keeps a selected directory only within its returned %s",
  async (kind) => {
    const { owner, follower, threadId } = await connectedManagers();
    const selectedCwd = owner.readConversation(threadId)!.canonicalState!.cwd!;
    const parent = selectedCwd.slice(0, selectedCwd.lastIndexOf("/"));
    expect(parent.length).toBeGreaterThan(0);
    const root = kind === "ancestor" ? parent : "/moved-workspace";
    const expectedCwd = kind === "ancestor" ? selectedCwd : root;
    fixture.response = {
      ...fixture.response!,
      cwd: root,
      thread: { ...fixture.response!.thread, cwd: root },
    };
    fixture.calls.length = 0;
    await act(async () => {
      owner.retireNativeHostContext();
      await owner.requestThreadStreamResume(threadId);
    });
    expect(fixture.calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
      cwd: expectedCwd,
    });
    await waitFor(() => {
      expect(owner.readConversation(threadId)?.canonicalState?.cwd).toBe(expectedCwd);
      expect(follower.readConversation(threadId)?.canonicalState?.cwd).toBe(expectedCwd);
    });
    const canonical = owner.readConversation(threadId)!.canonicalState!;
    expect(canonical.hydrationContext?.cwd).toBe(expectedCwd);
    expect(canonical.hydrationContext?.latestThreadSettings?.cwd).toBe(expectedCwd);
    expect(residentConversationTurns(canonical).at(-1)?.params.cwd).toBe(expectedCwd);
  },
);

test("paginated resume uses its returned cursor and a later empty tail preserves resident history", async () => {
  const { owner, threadId } = await connectedManagers();
  expect(fixture.calls.find((call) => call.method === "thread/turns/list")?.params).toMatchObject({
    threadId,
    cursor: "resume-tail",
    limit: 5,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  const before = residentConversationTurns(owner.readConversation(threadId)!.canonicalState!);
  expect(before.length).toBeGreaterThan(0);
  fixture.response = { ...fixture.response!, turnsBackwardsCursor: null };
  fixture.calls.length = 0;
  owner.retireNativeHostContext();
  await owner.requestThreadStreamResume(threadId);
  expect(fixture.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
  expect(fixture.calls.some((call) => call.method === "thread/turns/list")).toBe(false);
  expect(
    residentConversationTurns(owner.readConversation(threadId)!.canonicalState!).map(
      (turn) => turn.turnId,
    ),
  ).toEqual(before.map((turn) => turn.turnId));
});

test("durable resume merges a complete page with inline turns without reopening completed work", async () => {
  const { owner, follower, threadId } = await connectedManagers([], "durable");
  const original = fixture.response!;
  const template = original.thread.turns[0]!;
  const item = (id: string) => ({
    type: "agentMessage" as const,
    id,
    text: id,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
  const completed = {
    ...template,
    id: "completed-page",
    status: "completed" as const,
    items: [item("finished")],
  };
  const inline = {
    ...template,
    id: "inline-only",
    status: "inProgress" as const,
    items: [item("live")],
  };
  const thread = { ...original.thread, historyMode: "paginated" as const, turns: [] };
  fixture.nativeRequest = async (method, params) => {
    if (method === "thread/read") return { thread };
    if (method === "thread/resume")
      return {
        ...original,
        thread: {
          ...thread,
          turns: [{ ...completed, status: "inProgress", items: [item("stale")] }, inline],
        },
        initialTurnsPage: null,
        turnsBackwardsCursor: null,
      };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/turns/list")
      return {
        data: [{ ...completed, items: [], itemsView: "notLoaded" }],
        nextCursor: "older-durable",
        backwardsCursor: null,
      };
    if (method === "thread/items/list")
      return {
        data: completed.items.map((value) => ({
          turnId: (params as { turnId: string }).turnId,
          item: value,
        })),
        nextCursor: null,
        backwardsCursor: null,
      };
    throw new Error(`Unexpected durable request ${method}`);
  };
  fixture.calls.length = 0;
  fixture.scheduling.length = 0;
  await act(async () => {
    owner.retireNativeHostContext();
    await owner.requestThreadStreamResume(threadId);
  });
  expect(fixture.calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
    excludeTurns: false,
  });
  expect(
    fixture.calls.filter((call) => call.method === "thread/turns/list").map((call) => call.params),
  ).toEqual([{ threadId, cursor: null, limit: 5, sortDirection: "desc", itemsView: "notLoaded" }]);
  expect(fixture.calls.find((call) => call.method === "thread/items/list")?.params).toMatchObject({
    turnId: completed.id,
    cursor: null,
    limit: 500,
    sortDirection: "asc",
  });
  expect(fixture.scheduling.find((call) => call.method === "thread/items/list")).toMatchObject({
    priority: "critical",
    timeoutMs: 30_000,
  });
  await waitFor(() => {
    for (const manager of [owner, follower]) {
      const state = manager.readConversation(threadId)!.canonicalState!;
      const turns = residentConversationTurns(state);
      expect(turns.find((turn) => turn.turnId === completed.id)).toMatchObject({
        status: "completed",
        items: [item("finished")],
      });
      expect(turns.find((turn) => turn.turnId === inline.id)?.items).toEqual([item("live")]);
      expect(state.turnsPagination).toMatchObject({
        olderCursor: "older-durable",
        hasLoadedOldest: false,
      });
      expect(state.paginatedHistory).toBeUndefined();
    }
  });
});

test("legacy resume without an inline page reads full history instead of treating the tail as empty", async () => {
  const { owner, threadId } = await connectedManagers();
  const original = fixture.response!;
  const legacyThread = { ...original.thread, historyMode: "legacy" as const };
  fixture.nativeRequest = async (method) => {
    if (method === "thread/read") return { thread: legacyThread };
    if (method === "thread/resume")
      return { ...original, thread: legacyThread, initialTurnsPage: null };
    if (method === "thread/goal/get") return { goal: null };
    throw new Error(`Unexpected legacy request ${method}`);
  };
  fixture.calls.length = 0;
  owner.retireNativeHostContext();
  await owner.requestThreadStreamResume(threadId);
  expect(
    fixture.calls.filter((call) => call.method === "thread/read").map((call) => call.params),
  ).toEqual([
    { threadId, includeTurns: false },
    { threadId, includeTurns: true },
  ]);
  expect(
    residentConversationTurns(owner.readConversation(threadId)!.canonicalState!).map(
      (turn) => turn.turnId,
    ),
  ).toEqual(legacyThread.turns.map((turn) => turn.id));
});

test("replacing a host manager disposes the old lifetime and duplicate registration is inert", () => {
  const registry = new CodexAppServerManagerRegistry();
  const first = new Manager("local");
  const replacement = new Manager("local");
  const changed = vi.fn();
  registry.addRegistryCallback(changed);
  try {
    registry.addManager(first);
    registry.addManager(first);
    expect(changed).toHaveBeenCalledTimes(1);
    registry.addManager(replacement);
    expect(() => first.retainActiveConversation("retired-thread")).toThrow("disposed");
    expect(registry.getForHostId("local")).toBe(replacement);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    registry.deleteManager("local");
    first.destroy();
  }
});

test("native reconnect retires stream roles and invalidates canonical history without losing resident turns", async () => {
  const { owner, threadId } = await connectedManagers();
  const before = owner.readConversation(threadId)!.canonicalState!;
  const turnIds = residentConversationTurns(before).map((turn) => turn.turnId);
  const generation = before.turnHistory!.history.generation;
  fixture.generation = 2;
  dispatchCodexAppServerMessage("shared-object-updated", {
    hostId: "local",
    object: {
      objectType: "connection",
      objectId: "connection",
      value: { status: "connected", retries: 0 },
    },
  });
  await waitFor(() => expect(owner.readConversationStreamRole(threadId)).toBeNull());
  const after = owner.readConversation(threadId)!.canonicalState!;
  expect(after.resumeState).toBe("needs_resume");
  expect(after.turnHistory!.history.generation).toBe(generation + 1);
  expect(after.turnHistory!.history.isComplete).toBe(false);
  expect(residentConversationTurns(after).map((turn) => turn.turnId)).toEqual(turnIds);
});

test("WebSocket reconnect restores its existing owner and follower using one interactive native resume", async () => {
  fixture.sourceEpoch = "persistent-endpoint";
  const { owner, follower, threadId } = await connectedManagers();
  const native = {
    sourceEpoch: fixture.sourceEpoch,
    transportKind: "websocket" as const,
    generation: 1,
  };
  const connection = (status: "connected" | "disconnected", generation: number) =>
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: "local",
      object: {
        objectType: "connection",
        objectId: "connection",
        value: { status, retries: 1, native: { ...native, generation } },
      },
    });
  await act(async () => {
    connection("connected", 1);
  });
  const historyGeneration =
    owner.readConversation(threadId)!.canonicalState!.turnHistory!.history.generation;
  fixture.calls.length = 0;
  fixture.scheduling.length = 0;
  await act(async () => {
    connection("disconnected", 1);
  });
  expect(owner.getStreamRole(threadId)?.role).toBe("owner");
  expect(follower.getStreamRole(threadId)?.role).toBe("follower");
  fixture.generation = 2;
  await act(async () => {
    connection("connected", 2);
  });
  await waitFor(() => {
    expect(fixture.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(owner.readConversation(threadId)?.resumeState).toBe("resumed");
    expect(follower.readConversation(threadId)?.resumeState).toBe("resumed");
  });
  expect(owner.getStreamRole(threadId)?.role).toBe("owner");
  expect(follower.getStreamRole(threadId)?.role).toBe("follower");
  expect(
    owner.readConversation(threadId)!.canonicalState!.turnHistory!.history.generation,
  ).toBeGreaterThan(historyGeneration);
  expect(fixture.scheduling.filter((call) => call.method === "thread/resume")).toEqual([
    {
      method: "thread/resume",
      priority: "interactive",
      source: "thread_hydration",
      timeoutMs: 30_000,
    },
  ]);
  expect(fixture.scheduling.find((request) => request.method === "thread/goal/get")).toMatchObject({
    priority: "interactive",
    source: "thread_hydration",
  });
});

test.each(["account", "endpoint"] as const)(
  "a WebSocket %s replacement clears roles without restoring the old identity",
  async (replacement) => {
    fixture.sourceEpoch = "persistent-endpoint";
    const { owner, threadId } = await connectedManagers();
    const native = {
      sourceEpoch: fixture.sourceEpoch,
      transportKind: "websocket" as const,
      generation: 1,
    };
    await act(async () => {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "connection",
          objectId: "connection",
          value: { status: "disconnected", retries: 1, native },
        },
      });
    });
    fixture.calls.length = 0;
    fixture.generation = 2;
    if (replacement === "account") fixture.accountId = "new-account";
    else fixture.sourceEpoch = "replacement-endpoint";
    await act(async () => {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "connection",
          objectId: "connection",
          value: {
            status: "connected",
            retries: 1,
            native: { ...native, sourceEpoch: fixture.sourceEpoch!, generation: 2 },
          },
        },
      });
    });
    await waitFor(() => expect(owner.getStreamRole(threadId)).toBeNull());
    expect(owner.readConversation(threadId)?.resumeState).toBe("needs_resume");
    expect(fixture.calls.some((call) => call.method === "thread/resume")).toBe(false);
  },
);

test("another host reconnect cannot invalidate a local conversation", async () => {
  const { owner, threadId } = await connectedManagers();
  const before = owner.readConversation(threadId)!.canonicalState;
  await act(async () => {
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: "remote",
      object: {
        objectType: "connection",
        objectId: "connection",
        value: { status: "disconnected", retries: 1 },
      },
    });
  });
  expect(owner.readConversation(threadId)!.canonicalState).toBe(before);
  expect(owner.getStreamRole(threadId)?.role).toBe("owner");
});

test("disconnect immediately rejects native callers and ignores late lifecycle notifications", async () => {
  const { owner, threadId } = await connectedManagers();
  let resolveGoal!: (goal: null) => void;
  fixture.readGoal = () =>
    new Promise((resolve) => {
      resolveGoal = resolve;
    });
  const pending = owner.getThreadGoal(threadId);
  const rejected = expect(pending).rejects.toThrow("lifetime retired");
  await waitFor(() => expect(resolveGoal).toBeDefined());
  await act(async () => {
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: "local",
      object: {
        objectType: "connection",
        objectId: "connection",
        value: { status: "disconnected", retries: 0 },
      },
    });
    expect(owner.readConversationStreamRole(threadId)).toBeNull();
    expect(owner.readConversation(threadId)?.resumeState).toBe("needs_resume");
    dispatchCodexAppServerMessage("native-notification", {
      type: "nativeNotification",
      hostId: "local",
      generation: 1,
      occurrenceToken: 999,
      occurrenceId: "retired-archive-999",
      notification: { method: "thread/archived", params: { threadId } },
    });
    resolveGoal(null);
  });
  await rejected;
  expect(owner.readConversation(threadId)).not.toBeNull();
  fixture.readGoal = null;
  fixture.generation = 2;
  fixture.ownerId = null;
  await owner.requestThreadStreamResume(threadId);
  await act(async () => {
    dispatchCodexAppServerMessage("native-notification", {
      type: "nativeNotification",
      hostId: "local",
      generation: 1,
      occurrenceToken: 1000,
      occurrenceId: "retired-archive-1000",
      notification: { method: "thread/archived", params: { threadId } },
    });
  });
  expect(owner.readConversationStreamRole(threadId)).toBe("owner");
  expect(owner.readConversation(threadId)?.resumeState).toBe("resumed");
});

test("a retired host-context lookup cannot replace a newer resumed lifetime", async () => {
  const { owner, threadId } = await connectedManagers();
  let release!: () => void;
  fixture.hostContextReady = new Promise((resolve) => {
    release = resolve;
  });
  const previousReads = fixture.hostContextReads;
  const oldResume = owner.requestThreadStreamResume(threadId);
  const rejected = expect(oldResume).rejects.toThrow("retired during host bootstrap");
  await waitFor(() => expect(fixture.hostContextReads).toBe(previousReads + 1));
  await act(async () => {
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: "local",
      object: {
        objectType: "connection",
        objectId: "connection",
        value: { status: "disconnected", retries: 0 },
      },
    });
  });
  fixture.hostContextReady = null;
  fixture.generation = 2;
  fixture.ownerId = null;
  await owner.requestThreadStreamResume(threadId);
  const replacement = owner.readConversation(threadId)!.canonicalState;
  release();
  await rejected;
  expect(owner.readConversation(threadId)!.canonicalState).toBe(replacement);
  expect(owner.readConversationStreamRole(threadId)).toBe("owner");
});

test("refreshing an unchanged host preserves pending work and resident history generation", async () => {
  const { owner, threadId } = await connectedManagers();
  const generation =
    owner.readConversation(threadId)!.canonicalState!.turnHistory!.history.generation;
  let resolveGoal!: (goal: null) => void;
  fixture.readGoal = () =>
    new Promise((resolve) => {
      resolveGoal = resolve;
    });
  const pending = owner.getThreadGoal(threadId);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitFor(() => expect(resolveGoal).toBeDefined());
  await act(async () => {
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: "local",
      object: {
        objectType: "connection",
        objectId: "connection",
        value: { status: "connected", retries: 0 },
      },
    });
  });
  expect(settled).toBe(false);
  expect(owner.readConversationStreamRole(threadId)).toBe("owner");
  expect(owner.readConversation(threadId)!.canonicalState!.turnHistory!.history.generation).toBe(
    generation,
  );
  resolveGoal(null);
  await expect(pending).resolves.toBeNull();
});

test("resume remains pending until its canonical history tail has arrived", async () => {
  const { owner, follower, threadId } = await connectedManagers();
  owner.destroy();
  follower.destroy();
  fixture.ownerId = null;
  fixture.follower = null;
  const manager = (fixture.owner = new Manager("local"));
  let releaseHistory!: (value: unknown) => void;
  fixture.nativeRequest = async (method, params) => {
    if (method === "thread/read") return { thread: { ...fixture.response!.thread, turns: [] } };
    if (method === "thread/resume") return fixture.response;
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/items/list") {
      const { turnId } = params as { turnId: string };
      return {
        data: [...(fixture.response!.thread.turns.find((turn) => turn.id === turnId)?.items ?? [])]
          .reverse()
          .map((item) => ({ turnId, item })),
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    if (method === "thread/turns/list")
      return new Promise((resolve) => {
        releaseHistory = resolve;
      });
    throw new Error(`Unexpected resume request ${method}`);
  };
  const resume = manager.requestThreadStreamResume(threadId);
  await waitFor(() => expect(releaseHistory).toBeDefined());
  try {
    expect(manager.readConversation(threadId)?.resumeState).toBe("resuming");
    expect(residentConversationTurns(manager.readConversation(threadId)?.canonicalState)).toEqual(
      [],
    );
  } finally {
    releaseHistory({
      data: [...fixture.response!.thread.turns].reverse(),
      nextCursor: null,
      backwardsCursor: null,
    });
    await resume;
  }
  expect(manager.readConversation(threadId)?.resumeState).toBe("resumed");
  expect(
    residentConversationTurns(manager.readConversation(threadId)?.canonicalState).map(
      (turn) => turn.turnId,
    ),
  ).toEqual(fixture.response!.thread.turns.map((turn) => turn.id));
});

test("late resume preparation cannot overwrite a newer accepted conversation", async () => {
  const { owner, threadId } = await connectedManagers();
  owner.retireNativeHostContext();
  fixture.ownerId = null;
  const preparations = fixture.resumePreparations;
  let release!: () => void;
  fixture.resumePrepareReady = new Promise((resolve) => {
    release = resolve;
  });
  const oldResume = owner.requestThreadStreamResume(threadId);
  const rejected = expect(oldResume).rejects.toThrow("retired during resume preparation");
  await waitFor(() => expect(fixture.resumePreparations).toBe(preparations + 1));
  owner.retireNativeHostContext();
  fixture.generation = 2;
  fixture.resumePrepareReady = null;
  await owner.requestThreadStreamResume(threadId);
  const replacement = owner.readConversation(threadId)!.canonicalState;
  release();
  await rejected;
  expect(owner.readConversation(threadId)!.canonicalState).toBe(replacement);
  expect(owner.readConversation(threadId)?.resumeState).toBe("resumed");
});

test("retirement rejects settings already sent and settings waiting for their predecessor", async () => {
  const { owner, threadId } = await connectedManagers();
  let release!: () => void;
  fixture.updateSettings = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const update = (approvalPolicy: "never" | "on-request") =>
    owner.handleThreadFollowerRequest(
      conversationFollowerRequest("thread-follower-update-thread-settings", {
        conversationId: threadId,
        threadSettings: { approvalPolicy },
      }),
    );
  const first = update("never");
  const firstRejected = expect(first).rejects.toThrow(/lifetime/);
  await waitFor(() => expect(release).toBeDefined());
  const second = update("on-request");
  const secondRejected = expect(second).rejects.toThrow(/lifetime/);
  owner.retireNativeHostContext();
  release();
  await Promise.all([firstRejected, secondRejected]);
  expect(fixture.calls.filter((call) => call.method === "thread/settings/update")).toHaveLength(1);
});

test("resume materializes explicit owner settings into the actual native request", async () => {
  const { owner, threadId } = await connectedManagers();
  const first = fixture.calls.find((call) => call.method === "thread/resume")!.params;
  expect(first).not.toHaveProperty("approvalPolicy");
  await owner.handleThreadFollowerRequest(
    conversationFollowerRequest("thread-follower-update-thread-settings", {
      conversationId: threadId,
      threadSettings: { approvalPolicy: "never", approvalsReviewer: "guardian_subagent" },
    }),
  );
  fixture.calls.length = 0;
  owner.retireNativeHostContext();
  await owner.requestThreadStreamResume(threadId);
  expect(fixture.calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
    threadId,
    approvalPolicy: "never",
    approvalsReviewer: "guardian_subagent",
    sandbox: "read-only",
  });
});
