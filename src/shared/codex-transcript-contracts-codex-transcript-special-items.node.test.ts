import { describe, expect, test, vi } from "vite-plus/test";
import {
  buildAutomaticApprovalReviewActionSummary,
  buildAutomaticApprovalReviewSummary,
  buildAutomaticApprovalReviewTitle,
  normalizeAutomaticApprovalReviewPayload,
  normalizeMultiAgentActionPayload,
  shouldShowAutoReviewInterruptionWarning,
} from "./codex-transcript-special-items";
import type {
  CodexTranscriptEvent,
  CodexTranscriptSnapshot,
  CodexTranscriptUpdate,
} from "./codex-transcript-projection";
import {
  chunkCodexTranscriptReset,
  CODEX_TRANSCRIPT_PENDING_CODE_UNITS,
  createCodexTranscriptSubscription,
} from "./codex-transcript-subscription";
import type { ThreadInjectItemsParams } from "@nodex/codex-app-server-protocol/v2";
import {
  CODEX_VISUALIZATION_PASSIVE_MAX_BYTES,
  codexVisualizationPassiveParts,
  compileCodexVisualizationPassiveContext,
  selectCodexVisualizationPassiveContextKey,
  type CodexVisualizationPassiveAttachment,
} from "./codex-visualization-passive-context";
import { parseCodexVisualizationInteractionState } from "./codex-visualization-state";

describe("codex-transcript-special-items", () => {
  test("normalizes automatic approval review payloads from nested review records", () => {
    const payload = normalizeAutomaticApprovalReviewPayload(
      {
        review: {
          status: "approved",
          riskScore: 0.25,
          riskLevel: "low",
          rationale: "Looks safe",
        },
      },
      "item_123",
    );

    expect(payload).toEqual({
      targetItemId: "item_123",
      status: "approved",
      riskScore: 0.25,
      riskLevel: "low",
      userAuthorization: null,
      rationale: "Looks safe",
      action: null,
    });
  });

  test("normalizes current guardian review protocol fields", () => {
    const payload = normalizeAutomaticApprovalReviewPayload({
      targetItemId: null,
      review: {
        status: "timedOut",
        riskLevel: "critical",
        userAuthorization: "high",
        rationale: null,
      },
      action: {
        type: "requestPermissions",
      },
    });

    expect(payload).toEqual({
      targetItemId: null,
      status: "timedOut",
      riskScore: null,
      riskLevel: "critical",
      userAuthorization: "high",
      rationale: null,
      action: {
        type: "requestPermissions",
      },
    });
  });

  test("matches auto-review interruption guardian warnings by message prefix", () => {
    expect(
      shouldShowAutoReviewInterruptionWarning({
        threadId: "thread-1",
        message: "Automatic approval review rejected too many approval requests for this turn.",
      }),
    ).toBe(true);
    expect(
      shouldShowAutoReviewInterruptionWarning({
        threadId: "thread-1",
        message: "Different guardian warning",
      }),
    ).toBe(false);
  });

  test("formats automatic approval review title and fallback detail like the thread row", () => {
    expect(buildAutomaticApprovalReviewTitle({ status: "inProgress", riskLevel: null })).toBe(
      "Auto-reviewing",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "approved", riskLevel: "low" })).toBe(
      "Auto-review approved",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "denied", riskLevel: "high" })).toBe(
      "Auto-review denied high risk",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "denied", riskLevel: "medium" })).toBe(
      "Auto-review denied",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "timedOut", riskLevel: null })).toBe(
      "Auto-review timed out",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "aborted", riskLevel: null })).toBe(
      "Auto-review stopped",
    );

    expect(buildAutomaticApprovalReviewSummary({ status: "timedOut", rationale: null })).toBe(
      "A carefully prompted reviewer agent timed out before Nodex ran this request",
    );
  });

  test("formats automatic approval review action summaries from guardian protocol actions", () => {
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "command",
        command: "bun test",
        source: "shell",
        cwd: "/tmp/project",
      }),
    ).toBe("bun test");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "execve",
        program: "python",
        argv: ["-m", "pytest"],
        source: "shell",
        cwd: "/tmp/project",
      }),
    ).toBe("python -m pytest");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "applyPatch",
        cwd: "/tmp/project",
        files: ["src/app.ts"],
      }),
    ).toBe("Editing src/app.ts");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "applyPatch",
        cwd: "/tmp/project",
        files: ["src/app.ts", "src/app.test.ts"],
      }),
    ).toBe("Editing 2 files");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "networkAccess",
        target: "api.openai.com",
        host: "api.openai.com",
        protocol: "https",
        port: 443,
      }),
    ).toBe("Network access to api.openai.com");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "mcpToolCall",
        server: "docs",
        toolName: "search",
        connectorId: null,
        connectorName: "Docs",
        toolTitle: null,
      }),
    ).toBe("MCP search on Docs");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "requestPermissions",
        reason: "Need to edit generated assets",
        permissions: "fullAccess",
      }),
    ).toBe("Permission request: Need to edit generated assets");
    expect(buildAutomaticApprovalReviewActionSummary(null)).toBe("Request");
  });

  test("filters invalid receiver threads and agent states in multi-agent action payloads", () => {
    const payload = normalizeMultiAgentActionPayload({
      tool: "sendInput",
      status: "completed",
      receiverThreadIds: ["thr_a", 42, "thr_b"],
      receiverThreads: [
        {
          threadId: "thr_a",
          thread: {
            nickname: "Scout",
            model: "gpt-5",
            agentRole: "explorer",
          },
        },
        {
          threadId: 7,
          thread: {
            nickname: "Broken",
          },
        },
      ],
      agentsStates: {
        thr_a: {
          status: "running",
          message: "Working",
        },
        thr_b: {
          status: "mystery",
          message: "Bad",
        },
      },
    });

    expect(payload).toEqual({
      id: null,
      action: "sendInput",
      status: "completed",
      senderThreadId: null,
      receiverThreadIds: ["thr_a", "thr_b"],
      receiverThreads: [
        {
          threadId: "thr_a",
          thread: {
            nickname: "Scout",
            model: "gpt-5",
            agentRole: "explorer",
          },
        },
      ],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {
        thr_a: {
          status: "running",
          message: "Working",
        },
      },
    });
  });

  test("normalizes subagent receiver display metadata aliases", () => {
    const payload = normalizeMultiAgentActionPayload({
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["thr_euclid", "thr_named", "thr_source"],
      receiverThreads: [
        {
          threadId: "thr_euclid",
          thread: {
            agentNickname: "@Euclid",
            model: "gpt-5-codex",
            agentRole: "explorer",
          },
        },
        {
          threadId: "thr_named",
          thread: {
            name: "Proof Writer",
            model: null,
            agentRole: "worker",
          },
        },
        {
          threadId: "thr_source",
          thread: {
            model: "gpt-5-codex",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "thr_parent",
                  agent_nickname: "@Nash",
                  agent_role: "reviewer",
                },
              },
            },
          },
        },
      ],
      agentsStates: {},
    });

    expect(payload?.receiverThreads[0]?.thread?.nickname).toBe("@Euclid");
    expect(payload?.receiverThreads[1]?.thread?.nickname).toBeNull();
    expect(payload?.receiverThreads[1]?.thread?.name).toBe("Proof Writer");
    expect(payload?.receiverThreads[2]?.thread?.nickname).toBe("@Nash");
    expect(payload?.receiverThreads[2]?.thread?.agentRole).toBe("reviewer");
  });
});

describe("codex transcript subscription", () => {
  function snapshot(count = 0): CodexTranscriptSnapshot {
    return {
      resumeState: "resumed",
      historyComplete: true,
      itemTimeline: null,
      timeline: null,
      turnEntityKeys: [],
      turnsByKey: {},
      realtimeItems: {},
      itemsByKey: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          String(index),
          { type: "plan", id: String(index), text: "hello" },
        ]),
      ),
    };
  }
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  function change(insert: string): CodexTranscriptUpdate {
    return {
      type: "changes",
      changes: [
        {
          type: "text",
          key: { hostId: "local", threadId: "thread", entityKey: "turn", itemId: "item" },
          target: { field: "text" },
          edits: [{ at: 0, deleteCount: 0, insert }],
        },
      ],
    };
  }
  function source(initial: CodexTranscriptSnapshot | null) {
    let listener: ((update: CodexTranscriptUpdate) => void) | undefined;
    let current = initial;
    const unsubscribe = vi.fn(() => {
      listener = undefined;
    });
    return {
      getSnapshot: () => current,
      subscribe: (next: (update: CodexTranscriptUpdate) => void) => {
        listener = next;
        next({ type: "reset", value: current });
        return unsubscribe;
      },
      emit: (update: CodexTranscriptUpdate) => listener?.(update),
      setSnapshot: (next: CodexTranscriptSnapshot | null) => {
        current = next;
      },
      unsubscribe,
    };
  }

  describe("normalized transcript async delivery", () => {
    test.each([255, 256, 257])("reset %i map entries respects exact chunk threshold", (count) => {
      const original = snapshot(count);
      const events = [...chunkCodexTranscriptReset(original)];
      if (count < 256) {
        expect(events).toEqual([{ type: "reset", value: original }]);
        return;
      }
      expect(events.map((event) => event.type)).toEqual(
        count === 256
          ? ["reset-start", "reset-part", "reset-commit"]
          : ["reset-start", "reset-part", "reset-part", "reset-commit"],
      );
      const parts = events.filter((event) => event.type === "reset-part");
      expect(parts.map((part) => Object.keys(part.itemsByKey).length)).toEqual(
        count === 256 ? [256] : [256, 1],
      );
      expect(Object.assign({}, ...parts.map((part) => part.itemsByKey))).toEqual(
        original.itemsByKey,
      );
    });

    test("counts combined maps and emits items before realtime entries", () => {
      const value = {
        ...snapshot(255),
        realtimeItems: {
          rt: {
            item: {
              type: "realtimeSessionStarted" as const,
              id: "rt",
              realtimeSessionId: "session",
            },
            completed: true,
          },
          rt2: {
            item: {
              type: "realtimeSessionStarted" as const,
              id: "rt2",
              realtimeSessionId: "session",
            },
            completed: true,
          },
        },
      };
      const events = [...chunkCodexTranscriptReset(value)];
      const parts = events.filter((event) => event.type === "reset-part");
      expect(parts).toHaveLength(2);
      expect(Object.keys(parts[0]!.itemsByKey)).toHaveLength(255);
      expect(Object.keys(parts[0]!.realtimeItems)).toEqual(["rt"]);
      expect(Object.keys(parts[1]!.realtimeItems)).toEqual(["rt2"]);
    });

    test("awaits each callback and merges adjacent pending changes", async () => {
      const input = source(snapshot());
      const held = deferred();
      const seen: CodexTranscriptEvent[] = [];
      const subscription = createCodexTranscriptSubscription({
        ...input,
        listener: (event) => {
          seen.push(event);
          return seen.length === 1 ? held.promise : undefined;
        },
      });
      input.emit(change("a"));
      input.emit(change("b"));
      expect(seen).toHaveLength(1);
      held.resolve();
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen[1]).toEqual({
        type: "changes",
        changes: [
          ...(change("a") as Extract<CodexTranscriptUpdate, { type: "changes" }>).changes,
          ...(change("b") as Extract<CodexTranscriptUpdate, { type: "changes" }>).changes,
        ],
      });
      subscription.dispose();
      await subscription.completion;
      expect(input.unsubscribe).toHaveBeenCalledTimes(1);
    });

    test.each([0, 1])(
      "backlog threshold +%i uses JSON code units, not UTF-8 bytes",
      async (overflow) => {
        const input = source(snapshot());
        const held = deferred();
        const seen: CodexTranscriptEvent[] = [];
        const subscription = createCodexTranscriptSubscription({
          ...input,
          listener: (event) => {
            seen.push(event);
            return seen.length === 1 ? held.promise : undefined;
          },
        });
        const overhead = JSON.stringify(change("")).length;
        const update = change(
          "世".repeat(CODEX_TRANSCRIPT_PENDING_CODE_UNITS - overhead + overflow),
        );
        expect(JSON.stringify(update).length).toBe(CODEX_TRANSCRIPT_PENDING_CODE_UNITS + overflow);
        expect(new TextEncoder().encode(JSON.stringify(update)).length).toBeGreaterThan(
          CODEX_TRANSCRIPT_PENDING_CODE_UNITS,
        );
        input.emit(update);
        input.setSnapshot({ ...snapshot(), historyComplete: false });
        held.resolve();
        await vi.waitFor(() => expect(seen).toHaveLength(2));
        expect(seen[1]!.type).toBe(overflow === 0 ? "changes" : "reset");
        if (overflow === 1) expect(seen[1]).toEqual({ type: "reset", value: input.getSnapshot() });
        subscription.dispose();
      },
    );

    test("new reset drops queued increments and rereads current snapshot after callback", async () => {
      const input = source(snapshot());
      const held = deferred();
      const seen: CodexTranscriptEvent[] = [];
      const subscription = createCodexTranscriptSubscription({
        ...input,
        listener: (event) => {
          seen.push(event);
          return seen.length === 1 ? held.promise : undefined;
        },
      });
      input.emit(change("discarded"));
      input.emit({ type: "reset", value: snapshot(2) });
      input.emit(change("also discarded"));
      input.setSnapshot(snapshot(3));
      held.resolve();
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen[1]).toEqual({ type: "reset", value: input.getSnapshot() });
      subscription.dispose();
    });

    test("chunked reset completes atomically before a newer fresh reset", async () => {
      const input = source(snapshot(256));
      const held = deferred();
      const seen: CodexTranscriptEvent[] = [];
      const subscription = createCodexTranscriptSubscription({
        ...input,
        listener: (event) => {
          seen.push(event);
          return seen.length === 1 ? held.promise : undefined;
        },
      });
      input.setSnapshot(snapshot(1));
      input.emit({ type: "reset", value: snapshot(1) });
      expect(seen.map((event) => event.type)).toEqual(["reset-start"]);
      held.resolve();
      await vi.waitFor(() => expect(seen).toHaveLength(4));
      expect(seen.map((event) => event.type)).toEqual([
        "reset-start",
        "reset-part",
        "reset-commit",
        "reset",
      ]);
      subscription.dispose();
    });

    test("failed increment converges via fresh reset; failed reset ends subscription", async () => {
      const input = source(snapshot());
      const seen: CodexTranscriptEvent[] = [];
      const subscription = createCodexTranscriptSubscription({
        ...input,
        listener: async (event) => {
          seen.push(event);
          if (event.type === "changes") throw new Error("increment failed");
          if (seen.length > 2) throw new Error("reset failed");
        },
      });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      input.emit(change("a"));
      await subscription.completion;
      expect(seen.map((event) => event.type)).toEqual(["reset", "changes", "reset"]);
      expect(input.unsubscribe).toHaveBeenCalledTimes(1);
    });

    test("dispose releases pending callback and viewport exactly once", async () => {
      const input = source(null);
      const held = deferred();
      const releaseCallback = vi.fn();
      const callback = Object.assign(held.promise, { [Symbol.dispose]: releaseCallback });
      const onDispose = vi.fn();
      const listener = vi.fn(() => callback);
      const subscription = createCodexTranscriptSubscription({ ...input, listener, onDispose });
      input.emit(change("pending"));
      subscription.dispose();
      subscription[Symbol.dispose]();
      await subscription.completion;
      held.resolve();
      await Promise.resolve();
      expect(releaseCallback).toHaveBeenCalledTimes(1);
      expect(onDispose).toHaveBeenCalledTimes(1);
      expect(input.unsubscribe).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});

describe("codex visualization passive context", () => {
  const scope = { hostId: "local", threadId: "thread" };
  const uuid = "00000000-0000-4000-8000-000000000000";
  const entry = (path: string, state: unknown) => ({ ...scope, path, state });
  const state = (path: string, modelContent: unknown) => entry(path, { modelContent });
  function compile(
    stateRecord: unknown = {},
    interactionRecord: unknown = {},
    attachments?: readonly CodexVisualizationPassiveAttachment[],
    createUUID: () => string = () => uuid,
  ) {
    return compileCodexVisualizationPassiveContext({
      scope,
      stateRecord,
      interactionRecord,
      attachments,
      createUUID,
    });
  }
  function pair(
    path: string,
    field: "state" | "interaction",
    value: unknown,
  ): ThreadInjectItemsParams["items"] {
    const callId = `visualization_state_${uuid}`;
    return [
      { type: "function_call", name: "untrusted_input", arguments: "{}", call_id: callId },
      {
        type: "function_call_output",
        call_id: callId,
        output: [{ type: "input_text", text: JSON.stringify({ path, [field]: value }) }],
      },
    ];
  }
  function payloads(context: ReturnType<typeof compile>) {
    if (!context) throw new Error("Expected compiled context");
    return codexVisualizationPassiveParts(context);
  }

  describe("passive widget model context", () => {
    test("orders state before interaction and compiles model content as paired untrusted native items", () => {
      const context = compile(
        { "/z.html": state("/z.html", [1, "z"]), "/a.html": state("/a.html", null) },
        { "/a.html": state("/a.html", { selected: 2 }) },
      );
      expect(context?.items).toEqual([
        ...pair("/a.html", "state", null),
        ...pair("/z.html", "state", [1, "z"]),
        ...pair("/a.html", "interaction", { selected: 2 }),
      ]);
      expect(context?.key).toMatch(/^[\da-f]{16}$/);
    });

    test("fingerprints Unicode code points independently of native call identity", () => {
      expect(compile({ "/🧪.html": state("/🧪.html", { selected: "界🧪" }) })?.key).toBe(
        "622a942fa1023f6d",
      );
    });

    test("takes the final 100 stored entries independently before sorting each record", () => {
      const record = (prefix: string) =>
        Object.fromEntries(
          Array.from({ length: 103 }, (_, index) => {
            const path = `/${prefix}-${String(102 - index).padStart(3, "0")}.html`;
            return [path, state(path, { value: index })];
          }),
        );
      const context = compile(record("state"), record("interaction"));
      const output = payloads(context);
      expect(output).toHaveLength(200);
      expect(output[0]?.path).toBe("/state-000.html");
      expect(output[99]?.path).toBe("/state-099.html");
      expect(output[100]?.path).toBe("/interaction-000.html");
      expect(output[199]?.path).toBe("/interaction-099.html");
    });

    test("rejects foreign identities, mismatched normalized keys, invalid paths and whole-state budget violations", () => {
      const valid = state("/valid.html", { result: true });
      const context = compile(
        {
          "/valid.html": valid,
          "/foreign-host.html": { ...state("/foreign-host.html", 1), hostId: "ssh" },
          "/foreign-thread.html": { ...state("/foreign-thread.html", 2), threadId: "other" },
          "/wrong-key.html": state("/other-path.html", 3),
          "relative.html": state("relative.html", 4),
          "/image.html": entry("/image.html", { modelContent: 5, imageIds: ["image"] }),
          "/large-private.html": entry("/large-private.html", {
            modelContent: 6,
            privateContent: "界".repeat(6_000),
          }),
          "/bad.html": entry("/bad.html", { modelContent: Infinity }),
        },
        { "/string.html": state("/string.html", "not-an-object") },
      );
      expect(payloads(context)).toEqual([{ path: "/valid.html", state: { result: true } }]);
      expect(context?.key).toBe(compile({ "/valid.html": valid })?.key);
    });

    test("malformed or absent buckets are empty independently", () => {
      expect(compile(undefined, null)).toBeUndefined();
      expect(
        payloads(
          compile("malformed", { "/interaction.html": state("/interaction.html", { a: 1 }) }),
        ),
      ).toEqual([{ path: "/interaction.html", interaction: { a: 1 } }]);
    });

    test("private changes and random call IDs do not change the model fingerprint; null is an explicit clear", () => {
      const context = compile({
        "/a.html": entry("/a.html", { modelContent: null, privateContent: "first" }),
      });
      const changedPrivate = compile(
        { "/a.html": entry("/a.html", { modelContent: null, privateContent: "second" }) },
        {},
        undefined,
        () => "different",
      );
      expect(changedPrivate?.key).toBe(context?.key);
      expect(changedPrivate?.items).not.toEqual(context?.items);
      expect(payloads(context)).toEqual([{ path: "/a.html", state: null }]);
      expect(compile({ "/a.html": state("/a.html", false) })?.key).not.toBe(context?.key);
    });

    test("raw path spelling changes only the wire payload for the same normalized native identity", () => {
      const key = "win32:/mnt/c/plot.html";
      const first = compile({ [key]: state("C:\\Plot.html", { result: 1 }) });
      const second = compile({ [key]: state("c:/PLOT.html", { result: 1 }) });
      expect(first?.key).toBe(second?.key);
      expect(payloads(first)[0]?.path).toBe("C:\\Plot.html");
      expect(payloads(second)[0]?.path).toBe("c:/PLOT.html");
    });

    test("only exact explicitly untrusted interaction context suppresses its passive output", () => {
      const states = { "/a.html": state("/a.html", { one: 1, two: 2 }) };
      const attachment = { id: "/a.html", untrusted: true, structuredContent: { two: 2, one: 1 } };
      const deduped = compile(states, states, [attachment]);
      expect(payloads(deduped)).toEqual([{ path: "/a.html", state: { one: 1, two: 2 } }]);
      expect(deduped?.key).toBe(compile(states, states)?.key);
      expect(compile({}, states, [attachment])?.items).toEqual([]);
      expect(compile({}, states, [attachment])?.key).toBeDefined();
      for (const other of [
        { ...attachment, untrusted: false },
        { ...attachment, id: "/other.html" },
        { ...attachment, structuredContent: { one: 1 } },
      ])
        expect(payloads(compile({}, states, [other]))).toHaveLength(1);
    });

    test("accepts the exact wire-byte boundary and stops all later entries on overflow", () => {
      const states = Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => {
          const path = `/state-${index}.html`;
          return [path, state(path, "x".repeat(14_000))];
        }),
      );
      const baseBytes = new TextEncoder().encode(
        JSON.stringify(pair("/interaction.html", "interaction", { value: "" })),
      ).byteLength;
      const acceptedStateBytes = Object.keys(states).reduce(
        (bytes, path) =>
          bytes +
          new TextEncoder().encode(JSON.stringify(pair(path, "state", "x".repeat(14_000))))
            .byteLength,
        0,
      );
      const value = "x".repeat(
        CODEX_VISUALIZATION_PASSIVE_MAX_BYTES - acceptedStateBytes - baseBytes,
      );
      const exact = compile(states, { "/interaction.html": state("/interaction.html", { value }) });
      expect(payloads(exact)).toHaveLength(9);
      expect(
        acceptedStateBytes +
          new TextEncoder().encode(
            JSON.stringify(pair("/interaction.html", "interaction", { value })),
          ).byteLength,
      ).toBe(CODEX_VISUALIZATION_PASSIVE_MAX_BYTES);
      const overflow = compile(states, {
        "/interaction.html": state("/interaction.html", { value: `${value}x` }),
        "/z-after-overflow.html": state("/z-after-overflow.html", {}),
      });
      expect(payloads(overflow)).toHaveLength(8);
      expect(overflow?.key).toBe(compile(states)?.key);
    });

    test("budgets multibyte native output independently of the interaction character limit", () => {
      const context = { value: "界".repeat(16_000) };
      expect(parseCodexVisualizationInteractionState({ modelContent: context }).ok).toBe(true);
      const output = compile(
        {},
        {
          "/a.html": state("/a.html", context),
          "/b.html": state("/b.html", context),
          "/c.html": state("/c.html", context),
          "/d.html": state("/d.html", {}),
        },
      );
      expect(payloads(output).map(({ path }) => path)).toEqual(["/a.html", "/b.html"]);
    });
  });

  describe("idle passive injection admission", () => {
    test("requires the same unbound optimistic Turn and a changed key without confusing equal active values", () => {
      const active = { type: "active" as const, activeFlags: [] };
      const input = {
        context: { key: "next", items: [] },
        previousWasIdle: true,
        clientUserMessageId: "client",
        latestTurn: { turnId: null, params: { clientUserMessageId: "client" } },
        currentRuntimeStatus: active,
        admittedRuntimeStatus: active,
        lastInjectedKey: "previous",
      };
      expect(selectCodexVisualizationPassiveContextKey(input)).toBe("next");
      expect(
        selectCodexVisualizationPassiveContextKey({
          ...input,
          currentRuntimeStatus: { type: "idle" },
        }),
      ).toBe("next");
      for (const patch of [
        { previousWasIdle: false },
        { lastInjectedKey: "next" },
        { latestTurn: null },
        { latestTurn: { turnId: "native-turn", params: { clientUserMessageId: "client" } } },
        { latestTurn: { turnId: null, params: { clientUserMessageId: "other" } } },
        { currentRuntimeStatus: { type: "active" as const, activeFlags: [] } },
      ])
        expect(selectCodexVisualizationPassiveContextKey({ ...input, ...patch })).toBeUndefined();
    });
  });

  describe("interaction context storage contract", () => {
    test("uses formatted JSON UTF-16 characters and accepts only an object or null", () => {
      const overhead = JSON.stringify({ value: "" }, null, 2).length;
      const exact = { value: "界".repeat(32_768 - overhead) };
      expect(parseCodexVisualizationInteractionState({ modelContent: exact }).ok).toBe(true);
      expect(
        parseCodexVisualizationInteractionState({ modelContent: { value: `${exact.value}界` } }).ok,
      ).toBe(false);
      expect(parseCodexVisualizationInteractionState({})).toEqual({
        ok: true,
        state: { modelContent: null },
      });
      expect(parseCodexVisualizationInteractionState({ modelContent: null, discarded: 3 })).toEqual(
        {
          ok: true,
          state: { modelContent: null },
        },
      );
      for (const modelContent of ["text", [1], Infinity, { value: () => 1 }])
        expect(parseCodexVisualizationInteractionState({ modelContent }).ok).toBe(false);
    });
  });
});
