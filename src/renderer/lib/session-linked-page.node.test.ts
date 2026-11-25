import { beforeAll, describe, expect, test, vi, it } from "vite-plus/test";
import { bindRendererSpace } from "./renderer-space";
import {
  resolveSessionExecution,
  resolveSessionForkAvailability,
  resolveSessionProjectMove,
  type SessionExecutionSource,
  hasSessionConversation,
  resolveSessionExecutionLocation,
  resolveSessionMarkdownExport,
  resolveSessionPageSendTarget,
  runtimeSessionLiveIndicator,
  runtimeSessionTarget,
  sessionExecutionThreadId,
} from "./session-execution";
import { resolveWorkbenchPanelCapabilities } from "./workbench-panel-capabilities";
import type { CodexThreadSummary, SessionLinkedPageSummaryResult } from "../../shared/types";
import { sessionForkDestinations } from "./session-fork";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";
import { createSessionLinkedPageStore, type SessionLinkedPage } from "./session-linked-page";
import { createIntl } from "react-intl";
import { NEW_CHAT_TITLE } from "../../shared/session-title";
import { presentSessionTitle } from "./session-title-presentation";
import { resolveSideChatProjectId } from "./side-chat-conversation-context";
import { selectReusableSideChat, type SideChatSelectionCandidate } from "./side-chat-selection";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { CodexHooksListResponse } from "../../shared/codex-hooks";
import { applyCodexHookStatePatch, normalizeCodexHooksCwds } from "./use-codex-hooks";

describe("session execution", () => {
  const hosted: SessionExecutionSource = {
    id: "session-1",
    projectId: "project-1",
    displayTitle: "Hosted work",
    archived: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T01:00:00.000Z",
    thread: null,
    executionRef: { runtimeId: "host-runtime", threadId: "root-1" },
  };

  beforeAll(() => {
    bindRendererSpace({
      spaceId: "team",
      kind: "team",
      memberId: "alice",
      deviceId: "desktop",
      name: "Crew",
      availability: "ready",
    });
  });

  describe("a team Space's hosted chats", () => {
    test("fork on their Space host from the chat they run", () => {
      expect(resolveSessionForkAvailability(resolveSessionExecution(hosted))).toEqual({
        available: true,
        source: { sessionId: "session-1", threadId: "root-1" },
      });
    });

    test("move to another Project for their owner or a Space Owner, through the host", () => {
      expect(resolveSessionProjectMove({ ...hosted, canManage: true })).toEqual({
        kind: "runtime",
        sessionId: "session-1",
      });
      expect(resolveSessionProjectMove({ ...hosted, canManage: false })).toBeNull();
    });

    test("open side chats on their Space host", () => {
      const panels = resolveWorkbenchPanelCapabilities({
        panelId: "right",
        owner: {
          kind: "session",
          backendKind: "codex",
          projectId: "project-1",
          hasAttachedThread: true,
          cwd: null,
        },
      });
      expect(panels.actions.side_chat).toEqual({ available: true, reason: null });
      expect(panels.availableActionKinds).toContain("side_chat");
    });
  });
});

describe("session execution", () => {
  const base: SessionExecutionSource = {
    id: "session-1",
    projectId: "project-1",
    displayTitle: "Plan the launch",
    archived: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T01:00:00.000Z",
    thread: null,
    executionRef: null,
  };
  const runtime: SessionExecutionSource = {
    ...base,
    executionRef: { runtimeId: "runtime-1", threadId: "root-1" },
  };
  const nativeCodex: SessionExecutionSource = {
    ...base,
    thread: {
      threadId: "codex-1",
      executionHostId: "ssh-host",
      backendBinding: { driver: "codex", instanceId: "codex" },
      parentThreadId: null,
      cwd: " /remote/repo ",
      managedWorktreePath: null,
    },
  };
  const nativeClaude: SessionExecutionSource = {
    ...base,
    thread: {
      threadId: "claude-1",
      executionHostId: "local",
      backendBinding: { driver: "claudeAgent", instanceId: "claude-main" },
      cwd: "/repo",
    },
  };

  describe("Session execution projection", () => {
    test("forks Runtime and remote Codex conversations while leaving imported local history passive", () => {
      expect(resolveSessionForkAvailability(resolveSessionExecution(runtime))).toEqual({
        available: true,
        source: { sessionId: "session-1", threadId: "root-1" },
      });
      expect(resolveSessionForkAvailability(resolveSessionExecution(nativeCodex))).toEqual({
        available: true,
        source: { sessionId: "session-1", threadId: "codex-1" },
      });
      const localCodex = {
        ...nativeCodex,
        thread: { ...nativeCodex.thread!, executionHostId: "local" },
      };
      const remoteClaude = {
        ...nativeClaude,
        thread: { ...nativeClaude.thread!, executionHostId: "ssh-host" },
      };
      for (const session of [localCodex, nativeClaude, remoteClaude, base]) {
        const availability = resolveSessionForkAvailability(resolveSessionExecution(session));
        expect(availability.available).toBe(false);
        expect(availability.available ? null : availability.reason).toBeTruthy();
      }
    });

    test("classifies Runtime, native and unstarted Sessions by their execution owner", () => {
      expect(resolveSessionExecution(runtime)).toEqual({
        kind: "runtime",
        sessionId: "session-1",
        runtimeId: "runtime-1",
        rootThreadId: "root-1",
      });
      expect(resolveSessionExecution(nativeCodex)).toMatchObject({
        kind: "native",
        rootThreadId: "codex-1",
        hostId: "ssh-host",
        location: { cwd: "/remote/repo", managedWorktreePath: null },
      });
      expect(resolveSessionExecution(base)).toEqual({ kind: "unstarted", sessionId: "session-1" });
      expect([runtime, nativeClaude, base].map(sessionExecutionThreadId)).toEqual([
        "root-1",
        "claude-1",
        null,
      ]);
      expect([runtime, nativeClaude, base, null].map(hasSessionConversation)).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect(runtimeSessionTarget(runtime)).toEqual({
        sessionId: "session-1",
        rootThreadId: "root-1",
      });
      expect(runtimeSessionTarget(nativeCodex)).toBeNull();
    });

    test("reads Runtime location only from its execution owner", () => {
      const execution = resolveSessionExecution(runtime);
      expect(resolveSessionExecutionLocation(execution, null)).toBeNull();
      expect(
        resolveSessionExecutionLocation(execution, {
          hostId: "local",
          cwd: "/managed/feature/app",
          managedWorktreePath: "/managed/feature",
        }),
      ).toEqual({ cwd: "/managed/feature/app", managedWorktreePath: "/managed/feature" });
      expect(
        resolveSessionExecutionLocation(resolveSessionExecution(nativeClaude), {
          hostId: "local",
          cwd: "/elsewhere",
          managedWorktreePath: null,
        }),
      ).toEqual({ cwd: "/repo", managedWorktreePath: null });
    });

    test("routes export and Project moves to the owner that can perform them", () => {
      expect(resolveSessionMarkdownExport(resolveSessionExecution(runtime))).toEqual({
        kind: "runtime",
        target: { sessionId: "session-1", threadId: "root-1" },
      });
      expect(resolveSessionMarkdownExport(resolveSessionExecution(nativeCodex))).toEqual({
        kind: "native",
        conversationId: "codex-1",
        executionHostId: "ssh-host",
        parentConversationId: null,
      });
      expect(resolveSessionMarkdownExport(resolveSessionExecution(nativeClaude))).toBeNull();
      expect(resolveSessionMarkdownExport(resolveSessionExecution(base))).toBeNull();

      expect(resolveSessionProjectMove({ ...runtime, canManage: true })).toEqual({
        kind: "runtime",
        sessionId: "session-1",
      });
      expect(resolveSessionProjectMove({ ...nativeCodex, canManage: true })).toEqual({
        kind: "codex-thread",
        threadId: "codex-1",
      });
      expect(resolveSessionProjectMove({ ...nativeClaude, canManage: true })).toBeNull();
      expect(resolveSessionProjectMove({ ...base, canManage: true })).toBeNull();
    });

    test("never offers a bound Runtime Session as a new launch target", () => {
      const target = resolveSessionPageSendTarget(runtime, "project-1", null);
      expect(target.kind).toBe("thread");
      expect(target.kind === "thread" ? target.thread : null).toMatchObject({
        threadId: "root-1",
        threadName: "Plan the launch",
        archived: false,
      });
      expect(resolveSessionPageSendTarget(base, "project-1", null)).toEqual({ kind: "launch" });
      expect(resolveSessionPageSendTarget(base, "project-2", null)).toEqual({ kind: "none" });
      const nativeThread = { threadId: "codex-1" } as CodexThreadSummary;
      expect(resolveSessionPageSendTarget(nativeCodex, "project-1", nativeThread)).toEqual({
        kind: "thread",
        thread: nativeThread,
      });
    });

    test("treats absent activity as idle", () => {
      expect(runtimeSessionLiveIndicator(null)).toBeNull();
      expect(runtimeSessionLiveIndicator({ status: "background" })).toBe("background");
      expect(
        runtimeSessionLiveIndicator({
          status: "waiting",
          activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
        }),
      ).toBe("approval");
    });
  });
});

describe("Session fork destinations", () => {
  test("keeps an ordinary fork available outside Git and labels a managed source accurately", () => {
    expect(sessionForkDestinations({ isWorktree: false, canCreateWorktree: false })).toEqual([
      { target: "local", label: "Fork chat", iconKey: "local" },
    ]);
    expect(sessionForkDestinations({ isWorktree: true, canCreateWorktree: false })).toEqual([
      { target: "local", label: "Fork chat in same worktree", iconKey: "fork" },
    ]);
  });

  test("offers a new worktree only when the source supports it", () => {
    expect(sessionForkDestinations({ isWorktree: true, canCreateWorktree: true })).toEqual([
      { target: "local", label: "Fork chat in same worktree", iconKey: "fork" },
      { target: "newWorktree", label: "Fork chat in new worktree", iconKey: "worktree" },
    ]);
  });
});

describe("session linked page", () => {
  const scope: ProjectionScope = { kind: "library", libraryId: "library:one" };
  const page = (label = "Doing"): SessionLinkedPage => ({
    pageId: "page:one",
    pageKey: "LAB-1",
    title: "Current title",
    status: { optionId: "doing", label },
  });
  const result = (
    sessionIds: string[],
    value: SessionLinkedPage | null = page(),
    revision = 1,
  ): SessionLinkedPageSummaryResult => ({
    libraryId: "library:one",
    storeEpoch: "epoch:one",
    projectionRevision: revision,
    summaries: value ? sessionIds.map((sessionId) => ({ sessionId, page: value })) : [],
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function fixture(checkpointOnSubscribe: number | null = null) {
    const sessionListeners = new Set<(event: ProjectSessionsChangeEvent) => void>();
    const projectionListeners = new Set<(event: ProjectionStreamMessage) => void>();
    const registry = new ProjectionInvalidationRegistry({
      subscribeProjection: (_scope, listener) => {
        projectionListeners.add(listener);
        if (checkpointOnSubscribe !== null)
          listener({
            version: 2,
            kind: "checkpoint",
            scope,
            stream: { storeEpoch: "epoch:one", commitSeq: checkpointOnSubscribe },
          });
        return () => projectionListeners.delete(listener);
      },
    });
    const read = vi.fn(async ({ sessionIds }: { sessionIds: string[] }) => result(sessionIds));
    const store = createSessionLinkedPageStore({
      read,
      subscribeSessions: (listener) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      registerProjection: (registration) => registry.register(registration),
    });
    return {
      read,
      store,
      registry,
      sessionListeners,
      projectionListeners,
      sessionChange(
        sessionIds: string[],
        changeType: ProjectSessionsChangeEvent["changeType"] = "update",
      ) {
        for (const listener of sessionListeners)
          listener({
            summaryScopes: [],
            detailInvalidation: { kind: "sessions", sessionIds },
            changeType,
          });
      },
      projection(message: ProjectionStreamMessage) {
        for (const listener of projectionListeners) listener(message);
      },
    };
  }

  const statusEffect = (commitSeq: number): ProjectionStreamMessage => ({
    version: 2,
    kind: "effect",
    scope,
    stream: { storeEpoch: "epoch:one", commitSeq },
    delivery: {
      storeEpoch: "epoch:one",
      commitSeq,
      manifestHash: "a".repeat(64),
      operationId: `operation:${commitSeq}`,
      committedAt: "2026-10-28T00:00:00Z",
      impact: {
        kind: "resources",
        page_ids: ["page:one"],
        database_ids: [],
        data_source_ids: ["source:one"],
        view_ids: [],
        document_heads: [],
      },
      effect: {
        scope: {
          schema_version: 1,
          canonical_key: "source:one",
          scope: {
            kind: "page_detail_data_source",
            project_id: "project:one",
            database_id: "database:one",
            data_source_id: "source:one",
          },
        },
        baseRevision: commitSeq - 1,
        resultRevision: commitSeq,
        coveredCommitSeq: commitSeq,
        patch: null,
        requiresReadAtLeast: true,
        effectHash: "b".repeat(64),
      },
    },
  });

  describe("Session Linked Page store", () => {
    test("coalesces rows from different lanes, caches each Session, and releases shared subscriptions", async () => {
      const f = fixture();
      const releases = [
        f.store.subscribeSession("session:a", vi.fn()),
        f.store.subscribeSession("session:b", vi.fn()),
        f.store.subscribeSession("session:a", vi.fn()),
      ];
      expect(f.read).not.toHaveBeenCalled();
      await settle();
      expect(f.read).toHaveBeenCalledExactlyOnceWith({ sessionIds: ["session:a", "session:b"] });
      expect(f.store.read("session:a")).toEqual(page());
      expect(f.sessionListeners.size).toBe(1);
      expect(f.projectionListeners.size).toBe(1);
      releases.push(f.store.subscribeSession("session:a", vi.fn()));
      await settle();
      expect(f.read).toHaveBeenCalledOnce();
      releases.forEach((release) => release());
      await settle();
      expect(f.sessionListeners.size).toBe(0);
      expect(f.projectionListeners.size).toBe(0);
      f.registry.dispose();
    });

    test("chunks more than the Core bound into 200 and 1 without duplicate identities", async () => {
      const f = fixture(1);
      const releases = Array.from({ length: 201 }, (_, i) =>
        f.store.subscribeSession(`session:${i}`, () => {}),
      );
      await settle();
      expect(f.read.mock.calls.map(([input]) => input.sessionIds.length)).toEqual([200, 1]);
      expect(f.store.read("session:200")).toEqual(page());
      releases.forEach((release) => release());
      await settle();
      f.registry.dispose();
    });

    test("repairs a first snapshot older than the subscription checkpoint", async () => {
      const f = fixture(2);
      f.read.mockResolvedValueOnce(result(["session:a"], page("Doing"), 1));
      f.read.mockResolvedValue(result(["session:a"], page("In progress"), 2));
      const release = f.store.subscribeSession("session:a", () => {});
      await vi.waitFor(() => expect(f.store.read("session:a")?.status?.label).toBe("In progress"));
      expect(f.read).toHaveBeenCalledTimes(2);
      release();
      await settle();
      f.registry.dispose();
    });

    test("supersedes an initial read when a link changes and coalesces the trailing read", async () => {
      const f = fixture();
      let resolveInitial!: (value: SessionLinkedPageSummaryResult) => void;
      f.read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      );
      const release = f.store.subscribeSession("session:a", () => {});
      await settle();
      const otherLane = f.store.subscribeSession("session:a", () => {});
      f.sessionChange(["session:a"]);
      f.sessionChange(["session:a"]);
      f.read.mockResolvedValue(result(["session:a"], null, 2));
      resolveInitial(result(["session:a"]));
      await settle();
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.store.read("session:a")).toBeNull();
      otherLane();
      release();
      await settle();
      f.registry.dispose();
    });

    test("refreshes Status labels through Library projection effects and ignores covered effects", async () => {
      const f = fixture();
      const release = f.store.subscribeSession("session:a", () => {});
      await settle();
      f.read.mockResolvedValue(result(["session:a"], page("In progress"), 2));
      f.projection(statusEffect(2));
      await vi.waitFor(() => expect(f.store.read("session:a")?.status?.label).toBe("In progress"));
      expect(f.read).toHaveBeenCalledTimes(2);
      f.projection(statusEffect(2));
      await settle();
      expect(f.read).toHaveBeenCalledTimes(2);
      release();
      await settle();
      f.registry.dispose();
    });

    test("refreshes absent results after restore and clears pages across stream resets", async () => {
      const f = fixture();
      f.read.mockResolvedValueOnce(result(["session:a"], null));
      const release = f.store.subscribeSession("session:a", () => {});
      await settle();
      f.read.mockResolvedValue(result(["session:a"], page(), 2));
      f.projection(statusEffect(2));
      await vi.waitFor(() => expect(f.store.read("session:a")).toEqual(page()));
      f.read.mockResolvedValue(result(["session:a"], null, 3));
      f.projection({
        version: 2,
        kind: "reset",
        scope,
        stream: { storeEpoch: "epoch:one", commitSeq: 3 },
        reason: "reconnect",
      });
      expect(f.store.read("session:a")).toBeNull();
      await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
      release();
      await settle();
      f.registry.dispose();
    });

    test("notifies subscribers when a Session with no linked Page resolves and across resets", async () => {
      const f = fixture();
      f.read.mockResolvedValueOnce(result(["session:empty"], null, 1));
      const listener = vi.fn();
      const release = f.store.subscribeSession("session:empty", listener);
      expect(f.store.isResolved?.("session:empty")).toBe(false);

      await vi.waitFor(() => expect(f.store.isResolved?.("session:empty")).toBe(true));
      expect(f.store.read("session:empty")).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);

      f.read.mockResolvedValueOnce(result(["session:empty"], null, 2));
      f.projection({
        version: 2,
        kind: "reset",
        scope,
        stream: { storeEpoch: "epoch:one", commitSeq: 2 },
        reason: "reconnect",
      });
      expect(f.store.isResolved?.("session:empty")).toBe(false);
      await vi.waitFor(() => expect(f.store.isResolved?.("session:empty")).toBe(true));
      expect(listener).toHaveBeenCalledTimes(3);

      release();
      await settle();
      f.registry.dispose();
    });
  });
});

describe("session title presentation", () => {
  const zh = createIntl({
    locale: "zh-CN",
    messages: { "command.newThread.title": "新聊天" },
  });

  test("presents the canonical Session placeholder and empty titles in the display language", () => {
    for (const title of [NEW_CHAT_TITLE, "", "  ", null, undefined]) {
      expect(presentSessionTitle(title, zh)).toBe("新聊天");
    }
  });

  test("preserves real Session titles and a real fallback title", () => {
    expect(presentSessionTitle("  Review the PR  ", zh)).toBe("  Review the PR  ");
    expect(presentSessionTitle("New chat with Sam", zh)).toBe("New chat with Sam");
    expect(presentSessionTitle({ displayTitle: "", noThreadFallbackTitle: "Roadmap" }, zh)).toBe(
      "Roadmap",
    );
  });
});

describe("resolveSideChatProjectId", () => {
  it("preserves an explicit projectless owner on a ready side chat", () => {
    expect(
      resolveSideChatProjectId({
        ready: true,
        conversationProjectId: null,
        parentProjectId: "project-1",
      }),
    ).toBe(null);
  });

  it("uses the parent owner until the child conversation is ready", () => {
    expect(
      resolveSideChatProjectId({
        ready: false,
        conversationProjectId: null,
        parentProjectId: "project-1",
      }),
    ).toBe("project-1");
  });
});

describe("side chat selection", () => {
  const candidate = (
    tabId: string,
    overrides: Partial<SideChatSelectionCandidate> = {},
  ): SideChatSelectionCandidate => ({
    tabId,
    panelId: "right",
    active: false,
    accepting: true,
    ...overrides,
  });

  test("reuses the active accepting side chat, then other right-panel chats before bottom-panel chats", () => {
    const first = candidate("first");
    const active = candidate("active", { active: true });
    const bottom = candidate("bottom", { panelId: "bottom", active: true });
    expect(selectReusableSideChat([first, active, bottom])).toBe(active);
    expect(selectReusableSideChat([first, { ...active, accepting: false }, bottom])).toBe(first);
    expect(
      selectReusableSideChat([
        { ...first, accepting: false },
        { ...active, accepting: false },
        bottom,
      ]),
    ).toBe(bottom);
  });

  test("finds no side chat when every candidate is busy", () => {
    expect(
      selectReusableSideChat([
        candidate("running", { accepting: false, active: true }),
        candidate("failed", { accepting: false }),
      ]),
    ).toBeNull();
  });
});

describe("use codex hooks", () => {
  function hook(key: string, currentHash: string): HookMetadata {
    return {
      environmentId: null,
      key,
      eventName: "stop",
      handlerType: "command",
      matcher: null,
      command: "echo done",
      async: false,
      timeoutSec: 10n,
      statusMessage: null,
      source: "user",
      sourcePath: "/tmp/hooks.json",
      pluginId: null,
      displayOrder: 0n,
      enabled: true,
      isManaged: false,
      currentHash,
      trustStatus: "untrusted",
      additionalContextLimit: null,
    };
  }

  describe("Codex Hooks query state", () => {
    test("normalizes roots without changing their first-seen order", () => {
      expect(
        normalizeCodexHooksCwds([" /workspace/b ", "", "/workspace/a", "/workspace/b"]),
      ).toEqual(["/workspace/b", "/workspace/a"]);
    });

    test("optimistically patches every matching hook and trusts only its current hash", () => {
      const response: CodexHooksListResponse = {
        data: [
          { cwd: "/a", hooks: [hook("shared", "hash-a")], warnings: [], errors: [] },
          {
            cwd: "/b",
            hooks: [hook("shared", "hash-b"), hook("other", "hash-c")],
            warnings: [],
            errors: [],
          },
        ],
      };

      const patched = applyCodexHookStatePatch(response, {
        key: "shared",
        enabled: false,
        trustedHash: "hash-a",
      });

      expect(patched?.data[0]?.hooks[0]).toMatchObject({
        enabled: false,
        trustStatus: "trusted",
      });
      expect(patched?.data[1]?.hooks[0]).toMatchObject({
        enabled: false,
        trustStatus: "untrusted",
      });
      expect(patched?.data[1]?.hooks[1]).toEqual(response.data[1]?.hooks[1]);
    });
  });
});
