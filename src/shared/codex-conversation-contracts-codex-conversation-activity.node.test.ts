import { expect, it, vi, describe, test, afterEach, beforeEach } from "vite-plus/test";
import { ConversationActivity } from "./codex-conversation-activity";
import { projectCodexConversationDocument } from "./codex-conversation-document";
import {
  applyCodexConversationStateUpdates,
  buildCodexConversationStateUpdates,
} from "./codex-conversation-patches";
import { codexHostMessageParts, CodexHostMessageReceiver } from "./codex-host-chunked-message";
import type {
  CodexConversationSnapshot,
  CodexCanonicalConversationState,
  CodexUserInputRequest,
  CodexMcpServerElicitationRequest,
} from "./types";
import {
  codexConversationHistoryTurnItemsProgressKey,
  createCodexConversationHistoryTurnItemsRef,
} from "./codex-conversation-history-page";
import { ConversationStreamRecovery } from "./codex-conversation-recovery";
import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import { selectPrimaryBackgroundConversationRequest } from "./codex-conversation-request";

describe("codex conversation activity", () => {
  it("retains a conversation until its last independent view releases it", () => {
    const changed = vi.fn();
    const activity = new ConversationActivity(changed);
    const first = activity.retain("thread");
    const second = activity.retain("thread");
    expect(changed.mock.calls).toEqual([["thread", true]]);
    first[Symbol.dispose]();
    first[Symbol.dispose]();
    expect(activity.has("thread")).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    second[Symbol.dispose]();
    expect(activity.has("thread")).toBe(false);
    expect(changed.mock.calls).toEqual([
      ["thread", true],
      ["thread", false],
    ]);
  });

  it.each(["remove", "clear"] as const)(
    "ignores old handles after %s and reacquisition",
    (operation) => {
      const changed = vi.fn();
      const activity = new ConversationActivity(changed);
      const old = activity.retain("thread");
      if (operation === "remove") activity.remove("thread");
      else activity.clear();
      const current = activity.retain("thread");
      changed.mockClear();
      old[Symbol.dispose]();
      expect(activity.has("thread")).toBe(true);
      expect(changed).not.toHaveBeenCalled();
      current[Symbol.dispose]();
      expect(changed.mock.calls).toEqual([["thread", false]]);
    },
  );
});

describe("codex conversation document", () => {
  const conversation = (): CodexConversationSnapshot => ({
    threadId: "thread-document",
    projectId: "project-1",
    source: null,
    threadName: "Thread",
    threadPreview: "BOOT_OK",
    modelProvider: "openai",
    cwd: "/workspace/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    linkedAt: "2026-09-08T00:00:00Z",
    resumeState: "resumed",
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    },
    turns: [
      {
        threadId: "thread-document",
        turnId: "turn-completed",
        status: "completed",
        errorMessage: undefined,
        diff: undefined,
        itemIds: ["answer"],
        completedAt: null,
        items: [
          {
            threadId: "thread-document",
            turnId: "turn-completed",
            itemId: "answer",
            type: "agentMessage",
            kind: "assistantMessage",
            markdownText: "BOOT_OK",
            status: "completed",
            assistantPhase: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawItem: { result: { text: "", enabled: false, count: 0, value: null } },
          },
        ],
      },
    ],
  });

  const relay = <T>(payload: T): T => {
    const receiver = new CodexHostMessageReceiver();
    for (const part of codexHostMessageParts(payload, { transferId: "conversation-relay" })) {
      const result = receiver.receive(part);
      if (result.type === "complete") return result.message as T;
    }
    throw new Error("The conversation relay did not complete");
  };

  describe("shared conversation document", () => {
    test("omits absent optional members before a strict snapshot relay and preserves defined data", () => {
      const local = conversation();
      const shared = projectCodexConversationDocument(local);
      const received = relay(shared);

      expect(received).toEqual(shared);
      expect(received.turns[0]).not.toHaveProperty("errorMessage");
      expect(received.turns[0]).not.toHaveProperty("diff");
      expect(received.turns[0]?.items[0]).not.toHaveProperty("assistantPhase");
      expect(received.turns[0]?.items[0]?.markdownText).toBe("BOOT_OK");
      expect(shared.turns[0]?.items[0]?.rawItem).toBe(local.turns[0]?.items[0]?.rawItem);
      expect(received.turns[0]?.items[0]?.rawItem).toEqual({
        result: { text: "", enabled: false, count: 0, value: null },
      });
      expect(received.turns[0]?.completedAt).toBeNull();
      expect(received).toEqual(projectCodexConversationDocument(local));
      expect(projectCodexConversationDocument(local)).toBe(shared);
      expect(projectCodexConversationDocument(shared)).toBe(shared);
      expect(local.turns[0]).toHaveProperty("errorMessage", undefined);
    });

    test("clearing an optional value relays a remove patch that converges with the next snapshot", () => {
      const local = conversation();
      const before = projectCodexConversationDocument({
        ...local,
        turns: [{ ...local.turns[0]!, errorMessage: "A prior failure" }],
      });
      const next = projectCodexConversationDocument({
        ...before,
        turns: [{ ...before.turns[0]!, errorMessage: undefined }],
      });
      const patches = relay(buildCodexConversationStateUpdates(before, next));
      expect(patches).toEqual([{ op: "remove", path: ["turns", 0, "errorMessage"] }]);
      const follower = applyCodexConversationStateUpdates(relay(before), patches);
      expect(follower).toEqual(relay(next));
      expect(follower).toEqual(projectCodexConversationDocument(next));
      expect(next.turns[0]?.items).toBe(before.turns[0]?.items);
    });

    test("rejects invalid array entries without removing or reordering them", () => {
      for (const turns of [[undefined], new Array(1), [Number.NaN], [() => null]]) {
        const invalid = { ...conversation(), turns } as CodexConversationSnapshot;
        expect(() => projectCodexConversationDocument(invalid)).toThrow();
        expect(invalid.turns).toBe(turns);
      }
    });
  });
});

describe("codex conversation history page", () => {
  test("item history navigation addresses the incomplete native older cursor", () => {
    const pagination = {
      olderCursor: "native",
      hasLoadedOldest: false,
      isLoadingOlder: false,
      itemsView: "summary" as const,
    };
    const ref = createCodexConversationHistoryTurnItemsRef({
      turnId: "turn",
      expectedTopologyGeneration: 4,
      pagination,
    });
    expect(ref).toMatchObject({ turnId: "turn", expectedTopologyGeneration: 4, edge: "older" });
    expect(
      createCodexConversationHistoryTurnItemsRef({
        turnId: "turn",
        expectedTopologyGeneration: 4,
        pagination: { ...pagination, olderCursor: "next" },
      })?.progressKey,
    ).not.toBe(ref?.progressKey);
    expect(
      createCodexConversationHistoryTurnItemsRef({
        turnId: "turn",
        expectedTopologyGeneration: 4,
        pagination: { ...pagination, hasLoadedOldest: true },
      }),
    ).toBeNull();
  });

  test("released Turn history remains navigable through its item anchor", () => {
    const pagination = {
      olderCursor: { type: "item" as const, itemId: "retained-first" },
      hasLoadedOldest: false,
      isLoadingOlder: false,
      itemsView: "summary" as const,
    };
    const input = { turnId: "turn", expectedTopologyGeneration: 4, pagination };
    expect(createCodexConversationHistoryTurnItemsRef(input)).toMatchObject({
      turnId: "turn",
      edge: "older",
    });
    expect(
      createCodexConversationHistoryTurnItemsRef({
        ...input,
        pagination: { ...pagination, hasLoadedOldest: true },
      }),
    ).toBeNull();
    expect(createCodexConversationHistoryTurnItemsRef({ ...input, edge: "newer" })).toBeNull();
    const progress = codexConversationHistoryTurnItemsProgressKey(pagination);
    expect(
      codexConversationHistoryTurnItemsProgressKey({
        ...pagination,
        olderCursor: { type: "item", itemId: "another-first" },
      }),
    ).not.toBe(progress);
    expect(
      codexConversationHistoryTurnItemsProgressKey({ ...pagination, olderCursor: "page" }),
    ).not.toBe(progress);
  });
});

describe("codex conversation patches", () => {
  function buildConversation(
    overrides?: Partial<CodexConversationSnapshot>,
  ): CodexConversationSnapshot {
    return {
      threadId: "thread-1",
      projectId: "project-1",
      source: overrides?.source ?? null,
      threadName: "Thread",
      threadPreview: "Preview",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      linkedAt: "2026-04-07T00:00:00.000Z",
      resumeState: "resumed",
      turns: [],
      requests: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditUserTurns: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
      ...overrides,
      hasUnreadTurn: overrides?.hasUnreadTurn ?? false,
    };
  }

  describe("codex-conversation-patches", () => {
    test("builds add patches for appended array entries and replays them", () => {
      const previous = buildConversation();
      const next = buildConversation({
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      });

      const patches = buildCodexConversationStateUpdates(previous, next);
      expect(String(patches.length)).toBe("1");
      expect(patches[0]?.op).toBe("add");
      expect((patches[0]?.path ?? []).join("/")).toBe("turns/0");

      const replayed = applyCodexConversationStateUpdates(previous, patches);
      expect(String(replayed.turns.length)).toBe("1");
      expect(replayed.turns[0]?.turnId).toBe("turn-1");
    });

    test("applies root replace patches", () => {
      const previous = buildConversation();
      const replacement = buildConversation({
        threadId: "thread-2",
        projectId: "project-2",
      });

      const replayed = applyCodexConversationStateUpdates(previous, [
        {
          op: "replace",
          path: [],
          value: replacement,
        },
      ]);

      expect(replayed.threadId).toBe("thread-2");
      expect(replayed.projectId).toBe("project-2");
    });

    test("applies array append patches that use the dash path segment", () => {
      const previous = buildConversation({
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      });

      const replayed = applyCodexConversationStateUpdates(previous, [
        {
          op: "add",
          path: ["turns", "-"],
          value: {
            threadId: "thread-1",
            turnId: "turn-2",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        },
      ]);

      expect(String(replayed.turns.length)).toBe("2");
      expect(replayed.turns[1]?.turnId).toBe("turn-2");
    });
  });
});

describe("codex conversation recovery", () => {
  type Conversation = {
    -readonly [Key in "id" | "resumeState"]: CodexCanonicalConversationState[Key];
  };
  type Attempt = { id: string; resolve(): void; reject(error: unknown): void };

  function fixture(ids: string[]) {
    const conversations = new Map<string, Conversation>(
      ids.map((id) => [id, { id, resumeState: "resumed" }]),
    );
    const owners = new Set(ids);
    const suppressed = new Set<string>();
    const inFlight = new Map<string, Attempt>();
    const attempts: Attempt[] = [];
    const resets: string[] = [];
    const errors: unknown[] = [];
    let disposed = false;
    const resume = (conversation: Conversation) => {
      let ready = false;
      let error: unknown;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const pending = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      const attempt: Attempt = { id: conversation.id, resolve, reject };
      attempts.push(attempt);
      inFlight.set(conversation.id, attempt);
      conversation.resumeState = "resuming";
      return pending
        .then(() => {
          ready = true;
        })
        .catch((cause: unknown) => {
          error = cause;
          throw cause;
        })
        .finally(() => {
          if (inFlight.get(conversation.id) !== attempt) return;
          conversation.resumeState = ready ? "resumed" : "needs_resume";
          recovery.onResumeAttemptSettled(conversation.id, ready, error);
          inFlight.delete(conversation.id);
        });
    };
    const recovery = new ConversationStreamRecovery<Conversation>({
      conversations: () => conversations.values(),
      getConversation: (id) => conversations.get(id),
      streamingConversationIds: () => [...conversations.keys()],
      ownsHistory: (id) => owners.has(id),
      hasResumeInFlight: (id) => inFlight.has(id),
      isSuppressed: (id) => suppressed.has(id),
      isDisposed: () => disposed,
      cancelResumes: () => {
        inFlight.clear();
        resets.push("resumes");
      },
      resetHistory: () => {
        resets.push("history");
      },
      resetStreams: (preserve) => {
        if (!preserve) owners.clear();
        resets.push("streams");
      },
      markNeedsResume: (id) => {
        conversations.get(id)!.resumeState = "needs_resume";
      },
      resume,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      onError: (_id, error) => {
        errors.push(error);
      },
    });
    return {
      recovery,
      conversations,
      owners,
      suppressed,
      attempts,
      inFlight,
      resets,
      errors,
      resume,
      dispose: () => {
        disposed = true;
        recovery.dispose();
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);

  test("restores only owners with at most two concurrent resumes and releases a slot on settlement", async () => {
    const f = fixture(["a", "b", "c", "follower"]);
    f.owners.delete("follower");
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    expect(f.attempts.map((attempt) => attempt.id)).toEqual(["a", "b"]);
    expect(f.conversations.get("follower")?.resumeState).toBe("needs_resume");
    expect(f.resets).toEqual(["resumes", "history", "streams"]);
    f.attempts[0]!.reject(new Error("offline"));
    await flush();
    expect(f.attempts.map((attempt) => attempt.id)).toEqual(["a", "b", "c"]);
    expect(f.errors).toHaveLength(1);
    f.attempts[1]!.resolve();
    f.attempts[2]!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.attempts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.attempts[3]?.id).toBe("a");
    f.dispose();
  });

  test("ordinary restart invalidates history and roles without automatically acquiring streams", async () => {
    const f = fixture(["a", "b"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.owners.size).toBe(0);
    expect([...f.conversations.values()].map((c) => c.resumeState)).toEqual([
      "needs_resume",
      "needs_resume",
    ]);
    expect(f.attempts).toEqual([]);
    f.dispose();
  });

  test("foreground has a ten-second fallback while other streams restore immediately", async () => {
    const f = fixture(["foreground", "other"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({
      restoreStreams: true,
      foregroundConversationId: "foreground",
    });
    await flush();
    expect(f.attempts.map((a) => a.id)).toEqual(["other"]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.attempts.map((a) => a.id)).toEqual(["other", "foreground"]);
    f.dispose();
  });

  test("a successful foreground view resume cancels its fallback without another native request", async () => {
    const f = fixture(["foreground"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({
      restoreStreams: true,
      foregroundConversationId: "foreground",
    });
    const view = f.resume(f.conversations.get("foreground")!);
    f.attempts[0]!.resolve();
    await view;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  });

  test("transient recovery failures back off from two seconds and cap at sixty seconds", async () => {
    const f = fixture(["a"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const count = f.attempts.length;
      f.attempts.at(-1)!.reject(new Error("temporary disconnect"));
      await flush();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.attempts).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.attempts).toHaveLength(count + 1);
    }
    f.attempts.at(-1)!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.attempts).toHaveLength(8);
    f.dispose();
  });

  test.each([
    new Error("thread not found: a"),
    new Error("THREAD NOT LOADED: a"),
    new Error("no rollout found for thread id a"),
    new Error("invalid thread id: a"),
    Object.assign(new Error("missing"), { code: "thread_not_found" }),
    Object.assign(new Error("missing"), { jsonRpcCode: "thread_not_found" }),
  ])(
    "requires two confirmed missing-thread failures before abandoning recovery: %s",
    async (error) => {
      const f = fixture(["a"]);
      f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
      await flush();
      f.attempts[0]!.reject(error);
      await flush();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.attempts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.attempts).toHaveLength(2);
      f.attempts[1]!.reject(error);
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.attempts).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      f.dispose();
    },
  );

  test.each([new Error("file not found"), { code: "thread_not_found", message: "missing" }])(
    "does not mistake another lookup failure or a plain object for confirmed missing history: %s",
    async (error) => {
      const f = fixture(["a"]);
      f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
      await flush();
      f.attempts[0]!.reject(error);
      await flush();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.attempts).toHaveLength(2);
      f.dispose();
    },
  );

  test("a different error between missing results requires another missing confirmation", async () => {
    const f = fixture(["a"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    for (const error of [
      new Error("thread not found: a"),
      new Error("offline"),
      new Error("thread not found: a"),
    ]) {
      const count = f.attempts.length;
      f.attempts.at(-1)!.reject(error);
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.attempts).toHaveLength(count + 1);
    }
    f.dispose();
  });

  test.each(["archive", "owner-loss", "removal", "writer", "local-writer"])(
    "stops retrying when the conversation becomes ineligible: %s",
    async (reason) => {
      const f = fixture(["a"]);
      f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
      await flush();
      if (reason === "archive") f.suppressed.add("a");
      if (reason === "owner-loss") f.owners.delete("a");
      if (reason === "removal") f.conversations.delete("a");
      f.attempts[0]!.reject(
        new Error(
          reason === "writer"
            ? "Thread already has an active writer"
            : reason === "local-writer"
              ? "Thread already has a live local writer"
              : "offline",
        ),
      );
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.attempts).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      f.dispose();
    },
  );

  test("old-generation settlements cannot consume or release the new generation's two slots", async () => {
    const f = fixture(["a", "b", "c"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    const old = f.attempts.slice();
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    expect(f.attempts.map((a) => a.id)).toEqual(["a", "b", "a", "b"]);
    old[0]!.resolve();
    old[1]!.reject(new Error("old connection"));
    await flush();
    expect(f.attempts).toHaveLength(4);
    expect(f.errors).toHaveLength(0);
    f.attempts[2]!.resolve();
    await flush();
    expect(f.attempts[4]?.id).toBe("c");
    f.dispose();
  });

  test("fallback joins the in-flight view's eventual result and disposal cancels its retries", async () => {
    const f = fixture(["a"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({
      restoreStreams: true,
      foregroundConversationId: "a",
    });
    const view = f.resume(f.conversations.get("a")!).catch(() => {});
    // The timer is allowed to observe needs_resume while another source is still doing preparation.
    f.conversations.get("a")!.resumeState = "needs_resume";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.attempts).toHaveLength(1);
    f.attempts[0]!.reject(new Error("offline"));
    await view;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.attempts).toHaveLength(2);
    f.attempts[1]!.reject(new Error("offline"));
    await flush();
    f.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.attempts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("codex conversation request", () => {
  function elicitation(
    requestId: string,
    turnId: string,
    overrides: Partial<CodexMcpServerElicitationRequest> = {},
  ): CodexMcpServerElicitationRequest {
    return {
      type: "mcpServerElicitation",
      requestId,
      turnId,
      threadId: "child",
      projectId: "project",
      itemId: requestId,
      kind: "generic",
      mode: "form",
      serverName: "workspace",
      message: "Choose a workspace",
      createdAt: 1,
      ...overrides,
    };
  }

  function conversation(
    turnIds: string[],
    requests: CodexConversationRequestContext["requests"],
  ): CodexConversationRequestContext {
    return {
      projectId: "project",
      threadId: "child",
      requests,
      turns: turnIds.map((turnId) => ({
        threadId: "child",
        turnId,
        status: "inProgress",
        itemIds: [],
        items: [],
      })),
    };
  }

  const question: CodexUserInputRequest = {
    type: "userInput",
    requestId: "question",
    questions: [{ id: "q", header: "Choice", question: "Continue?", isOther: false }],
    isBlocking: true,
    projectId: "project",
    threadId: "child",
    turnId: "older",
    itemId: "command",
    createdAt: 2,
  };

  describe("background conversation requests", () => {
    test.each(["generic", "mcpToolCall", "toolSuggestion"] as const)(
      "selects a pending %s MCP elicitation from a materialized turn",
      (kind) => {
        const request = elicitation("request", "turn", { kind });
        expect(selectPrimaryBackgroundConversationRequest(conversation(["turn"], [request]))).toBe(
          request,
        );
      },
    );

    test("prefers a genuine question within a turn, while a newer Turn elicitation precedes it", () => {
      const older = elicitation("older-mcp", "older");
      const newer = elicitation("newer-mcp", "newer");
      expect(
        selectPrimaryBackgroundConversationRequest(conversation(["older"], [question, older])),
      ).toBe(question);
      expect(
        selectPrimaryBackgroundConversationRequest(
          conversation(["older", "newer"], [question, older, newer]),
        ),
      ).toBe(newer);
    });

    test("uses the latest turnless MCP request only after materialized-turn requests", () => {
      const oldest = elicitation("old-turnless", "", { createdAt: 100 });
      const latest = elicitation("latest-turnless", "", {
        mode: "url",
        url: "https://example.com/authorize",
      });
      expect(selectPrimaryBackgroundConversationRequest(conversation([], [oldest, latest]))).toBe(
        latest,
      );
      expect(
        selectPrimaryBackgroundConversationRequest(conversation(["older"], [question, latest])),
      ).toBe(question);
    });

    test("does not treat a discovered per-turn request as hydrated history", () => {
      const pending = elicitation("request", "turn");
      const cold = conversation([], [pending]);
      expect(selectPrimaryBackgroundConversationRequest(cold)).toBeNull();
      expect(
        selectPrimaryBackgroundConversationRequest({
          ...cold,
          turns: conversation(["turn"], []).turns,
        }),
      ).toBe(pending);
      expect(selectPrimaryBackgroundConversationRequest(conversation(["turn"], []))).toBeNull();
    });
  });

  test("keeps a Session-origin question visible without inventing a Turn or loading history", () => {
    const request = {
      type: "userInput" as const,
      requestId: "native-question",
      threadId: "child",
      projectId: "project",
      turnId: null,
      itemId: "question-item",
      questions: [{ id: "q", header: "Choice", question: "Continue?", isOther: false }],
      isBlocking: true,
      createdAt: 3,
    };
    const context = conversation([], [request]);
    expect(selectPrimaryBackgroundConversationRequest(context)).toBe(request);
  });
});
