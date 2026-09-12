import { describe, expect, test } from "vite-plus/test";
import {
  admitCodexCoalescedWaiter,
  admitCodexScheduledRequest,
  CODEX_REQUEST_SCHEDULER_LIMITS,
  codexRequestBackgroundLane,
  codexRequestCoalescingKey,
  codexRequestQueueExpiryMs,
  codexScheduledRequestBytes,
  defaultCodexRequestPriority,
  emptyCodexRequestSelectionState,
  selectNextCodexScheduledRequest,
  type CodexRequestPriority,
  type CodexRequestSchedulingSource,
  type CodexScheduledRequestDescriptor,
} from "./CodexRequestSchedulerPolicy";

const scheduledRequest = (
  requestId: string,
  overrides: Partial<CodexScheduledRequestDescriptor> = {},
): CodexScheduledRequestDescriptor => {
  const method = overrides.method ?? "thread/read";
  const priority = overrides.priority ?? defaultCodexRequestPriority(method);
  const source = overrides.source ?? null;
  return {
    requestId,
    hostId: "local",
    generation: 1,
    method,
    params: { threadId: "thread-a" },
    priority,
    source,
    backgroundLane: codexRequestBackgroundLane(priority, source),
    conversationId: "thread-a",
    widgetId: null,
    timeoutMs: null,
    queuedBytes: 1,
    ...overrides,
  };
};

const queueOf = (
  count: number,
  priority: CodexRequestPriority,
  overrides: Partial<CodexScheduledRequestDescriptor> = {},
): CodexScheduledRequestDescriptor[] =>
  Array.from({ length: count }, (_, index) =>
    scheduledRequest(`${priority}-${index}`, {
      priority,
      conversationId: `thread-${index}`,
      ...overrides,
    }),
  );

describe("Codex request scheduler method policy", () => {
  test.each([
    "thread/approveGuardianDeniedAction",
    "thread/resume",
    "thread/start",
    "turn/interrupt",
    "turn/start",
    "turn/steer",
  ])("defaults %s to critical", (method) => {
    expect(defaultCodexRequestPriority(method)).toBe("critical");
  });

  test.each([
    "app/list",
    "collaborationMode/list",
    "config/read",
    "configRequirements/read",
    "experimentalFeature/list",
    "hooks/list",
    "mcpServerStatus/list",
    "model/list",
    "permissionProfile/list",
    "plugin/list",
    "skills/list",
  ])("defaults %s to background metadata", (method) => {
    expect(defaultCodexRequestPriority(method)).toBe("background");
  });

  test("keeps ordinary and caller-overridden work in the requested priority", () => {
    expect(defaultCodexRequestPriority("thread/fork")).toBe("interactive");
    expect(defaultCodexRequestPriority("thread/read", "background")).toBe("background");
  });

  test("derives background lanes and queue expiry without reading a clock", () => {
    expect(codexRequestBackgroundLane("background", "tail_history")).toBe("thread");
    expect(codexRequestBackgroundLane("background", "history_export")).toBe("metadata");
    expect(codexRequestBackgroundLane("background", null)).toBe("metadata");
    expect(codexRequestBackgroundLane("interactive", "tail_history")).toBeNull();
    expect(
      codexRequestQueueExpiryMs({
        priority: "background",
        source: "tail_history",
        nowMs: 1_000,
      }),
    ).toBe(60_000);
    expect(
      codexRequestQueueExpiryMs({
        priority: "background",
        source: "thread_catalog",
        nowMs: 1_000,
      }),
    ).toBe(30_000);
    expect(
      codexRequestQueueExpiryMs({
        priority: "background",
        source: null,
        timeoutMs: 7_000,
        expiresAtMs: 5_000,
        nowMs: 1_000,
      }),
    ).toBe(4_000);
    expect(
      codexRequestQueueExpiryMs({
        priority: "interactive",
        source: null,
        timeoutMs: 0,
        nowMs: 1_000,
      }),
    ).toBeNull();
    expect(
      codexRequestQueueExpiryMs({
        priority: "interactive",
        source: null,
        nowMs: 1_000,
      }),
    ).toBeNull();
  });
});

describe("Codex request coalescing policy", () => {
  test("uses serialized request identity independently of caller routing context", () => {
    const first = scheduledRequest("first", {
      method: "thread/turns/list",
      params: { turnId: "turn-a", page: { limit: 100, cursor: "next" } },
      priority: "background",
      source: "tail_history",
      conversationId: "thread-a",
      widgetId: "widget-a",
      timeoutMs: 60_000,
    });
    const reordered = scheduledRequest("second", {
      ...first,
      requestId: "second",
      params: { page: { cursor: "next", limit: 100 }, turnId: "turn-a" },
    });
    const key = codexRequestCoalescingKey(first);
    expect(key).not.toBeNull();
    expect(codexRequestCoalescingKey(reordered)).not.toBe(key);
    for (const changed of [
      { hostId: "remote" },
      { generation: 2 },
      { conversationId: "thread-b" },
      { widgetId: "widget-b" },
    ]) {
      expect(codexRequestCoalescingKey({ ...first, ...changed })).toBe(key);
    }

    for (const changed of [
      { timeoutMs: 30_000 },
      { source: "thread_hydration" as CodexRequestSchedulingSource },
      { priority: "interactive" as const },
      { params: { turnId: "turn-b" } },
    ]) {
      expect(codexRequestCoalescingKey({ ...first, ...changed })).not.toBe(key);
    }
  });

  test("does not coalesce item pages or mutations and skips unsafe keys", () => {
    expect(
      codexRequestCoalescingKey(scheduledRequest("items", { method: "thread/items/list" })),
    ).toBeNull();
    expect(
      codexRequestCoalescingKey(scheduledRequest("mutation", { method: "turn/start" })),
    ).toBeNull();
    expect(codexRequestCoalescingKey(scheduledRequest("disabled"), { coalesce: false })).toBeNull();
    const params: { self?: unknown } = {};
    params.self = params;
    expect(codexRequestCoalescingKey(scheduledRequest("cyclic", { params }))).toBeNull();
    expect(codexScheduledRequestBytes("thread/read", params)).toBeNull();
  });

  test("measures deterministic UTF-8 request bytes without depending on object key order", () => {
    const first = codexScheduledRequestBytes("thread/read", { z: "😀", a: 1 });
    const reordered = codexScheduledRequestBytes("thread/read", { a: 1, z: "😀" });
    expect(first).toBe(reordered);
    expect(first).toBe(
      new TextEncoder().encode('{"method":"thread/read","params":{"a":1,"z":"😀"}}').byteLength,
    );
  });

  test("admits parameterless requests and treats omitted params like null for coalescing", () => {
    const omittedBytes = codexScheduledRequestBytes("configRequirements/read", undefined);
    expect(omittedBytes).toBe(
      new TextEncoder().encode('{"method":"configRequirements/read"}').byteLength,
    );

    const omitted = scheduledRequest("omitted", {
      method: "configRequirements/read",
      params: undefined,
      queuedBytes: omittedBytes ?? -1,
    });
    const explicitNull = scheduledRequest("null", {
      method: "configRequirements/read",
      params: null,
    });

    expect(admitCodexScheduledRequest({ request: omitted, queued: [], inFlightCount: 0 })).toEqual({
      accepted: true,
    });
    expect(codexRequestCoalescingKey(omitted)).not.toBeNull();
    expect(codexRequestCoalescingKey(omitted)).toBe(codexRequestCoalescingKey(explicitNull));
  });

  test("measures and coalesces large requests without a scheduler byte ceiling", () => {
    const params = { text: "x".repeat(17 * 1024 * 1024) };
    expect(codexScheduledRequestBytes("thread/read", params)).toBeGreaterThan(17 * 1024 * 1024);
    expect(codexRequestCoalescingKey(scheduledRequest("large", { params }))).not.toBeNull();
  });

  test("caps logical waiters independently of the physical queue", () => {
    expect(admitCodexCoalescedWaiter(127)).toEqual({ accepted: true });
    expect(admitCodexCoalescedWaiter(128)).toMatchObject({
      accepted: false,
      rejection: { reason: "coalesced-queue-full", waiterCount: 128, limit: 128 },
    });
  });
});

describe("Codex request queue admission", () => {
  test.each([
    ["background", 128],
    ["critical", 16],
    ["interactive", 64],
  ] as const)("enforces the %s count cap when execution capacity is full", (priority, count) => {
    const queued = queueOf(count, priority);
    const result = admitCodexScheduledRequest({
      inFlightCount: 6,
      request: scheduledRequest("candidate", {
        priority,
        conversationId: "candidate-thread",
      }),
      queued,
    });
    expect(result).toMatchObject({
      accepted: false,
      rejection: { reason: "priority-queue-full", queuedCount: count, limit: count },
    });
  });

  test("enforces the count cap for a conversation/widget group", () => {
    const group = queueOf(20, "interactive", {
      conversationId: "thread-a",
      widgetId: "widget-a",
    });
    expect(
      admitCodexScheduledRequest({
        inFlightCount: 6,
        request: scheduledRequest("group-count", {
          conversationId: "thread-a",
          widgetId: "widget-a",
        }),
        queued: group,
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reason: "group-queue-full", queuedCount: 20 },
    });
  });

  test("does not use retained byte counts as an admission ceiling", () => {
    const queued = queueOf(2, "interactive", {
      conversationId: "thread-a",
      queuedBytes: 100 * 1024 * 1024,
    });
    expect(
      admitCodexScheduledRequest({
        request: scheduledRequest("large", {
          conversationId: "thread-a",
          queuedBytes: 100 * 1024 * 1024,
        }),
        queued,
        inFlightCount: 6,
      }),
    ).toEqual({ accepted: true });
  });

  test("admits critical work at queue pressure while any physical execution slot is free", () => {
    const queued = queueOf(20, "critical", { conversationId: "thread-a" });
    const request = scheduledRequest("critical", {
      priority: "critical",
      conversationId: "thread-a",
    });
    expect(admitCodexScheduledRequest({ request, queued, inFlightCount: 5 })).toEqual({
      accepted: true,
    });
    expect(admitCodexScheduledRequest({ request, queued, inFlightCount: 6 })).toMatchObject({
      accepted: false,
    });
  });

  test("global requests use the priority queue cap rather than the conversation group cap", () => {
    const queued = queueOf(20, "interactive", { conversationId: null, widgetId: null });
    expect(
      admitCodexScheduledRequest({
        request: scheduledRequest("global", { conversationId: null }),
        queued,
        inFlightCount: 6,
      }),
    ).toEqual({ accepted: true });
  });
});

describe("Codex request dispatch selection", () => {
  test("reserves total and noncritical capacity while letting critical work take the final slot", () => {
    const fiveNonCritical = queueOf(5, "interactive");
    const queued = [
      scheduledRequest("interactive", { priority: "interactive" }),
      scheduledRequest("critical", { priority: "critical" }),
    ];
    const selected = selectNextCodexScheduledRequest({
      queued,
      inFlight: fiveNonCritical,
      state: emptyCodexRequestSelectionState(),
    });
    expect(selected?.request.requestId).toBe("critical");
    expect(
      selectNextCodexScheduledRequest({
        queued,
        inFlight: [...fiveNonCritical, scheduledRequest("sixth", { priority: "critical" })],
        state: emptyCodexRequestSelectionState(),
      }),
    ).toBeNull();
    expect(
      selectNextCodexScheduledRequest({
        queued: [queued[0]!],
        inFlight: fiveNonCritical,
        state: emptyCodexRequestSelectionState(),
      }),
    ).toBeNull();
  });

  test("prefers one eligible background request after four interactive dispatches", () => {
    const queued = [
      scheduledRequest("interactive", { priority: "interactive" }),
      scheduledRequest("background", {
        priority: "background",
        source: "tail_history",
        backgroundLane: "thread",
      }),
    ];
    const first = selectNextCodexScheduledRequest({
      queued,
      inFlight: [],
      state: emptyCodexRequestSelectionState(),
    });
    expect(first?.request.requestId).toBe("interactive");
    const fairState = {
      ...(first?.nextState ?? emptyCodexRequestSelectionState()),
      interactiveDispatchesSinceBackground:
        CODEX_REQUEST_SCHEDULER_LIMITS.interactiveDispatchesBeforeBackground,
    };
    const background = selectNextCodexScheduledRequest({ queued, inFlight: [], state: fairState });
    expect(background?.request.requestId).toBe("background");
    expect(background?.nextState.interactiveDispatchesSinceBackground).toBe(0);
  });

  test("selects no-conversation work first, then rotates conversations and widgets", () => {
    const global = scheduledRequest("global", { conversationId: null, widgetId: null });
    const queue = [
      scheduledRequest("a-1", { conversationId: "a", widgetId: "one" }),
      scheduledRequest("a-2", { conversationId: "a", widgetId: "two" }),
      scheduledRequest("b-1", { conversationId: "b", widgetId: "one" }),
    ];
    expect(
      selectNextCodexScheduledRequest({
        queued: [...queue, global],
        inFlight: [],
        state: emptyCodexRequestSelectionState(),
      })?.request.requestId,
    ).toBe("global");

    const first = selectNextCodexScheduledRequest({
      queued: queue,
      inFlight: [],
      state: emptyCodexRequestSelectionState(),
    });
    const second = selectNextCodexScheduledRequest({
      queued: queue,
      inFlight: [],
      state: first!.nextState,
    });
    const third = selectNextCodexScheduledRequest({
      queued: queue,
      inFlight: [],
      state: second!.nextState,
    });
    expect([first?.request.requestId, second?.request.requestId, third?.request.requestId]).toEqual(
      ["a-1", "b-1", "a-2"],
    );
  });

  test("enforces conversation, widget, background, and background-lane in-flight caps", () => {
    const sameWidget = queueOf(3, "interactive", {
      conversationId: "a",
      widgetId: "one",
    });
    const selected = selectNextCodexScheduledRequest({
      queued: [
        scheduledRequest("blocked-widget", { conversationId: "a", widgetId: "one" }),
        scheduledRequest("other-widget", { conversationId: "a", widgetId: "two" }),
      ],
      inFlight: sameWidget,
      state: emptyCodexRequestSelectionState(),
    });
    expect(selected?.request.requestId).toBe("other-widget");

    const sameConversation = queueOf(4, "interactive", { conversationId: "a" });
    expect(
      selectNextCodexScheduledRequest({
        queued: [
          scheduledRequest("blocked-conversation", { conversationId: "a" }),
          scheduledRequest("other-conversation", { conversationId: "b" }),
        ],
        inFlight: sameConversation,
        state: emptyCodexRequestSelectionState(),
      })?.request.requestId,
    ).toBe("other-conversation");

    const metadataInFlight = queueOf(3, "background", {
      source: null,
      backgroundLane: "metadata",
    });
    expect(
      selectNextCodexScheduledRequest({
        queued: [
          scheduledRequest("metadata", {
            priority: "background",
            source: null,
            backgroundLane: "metadata",
          }),
        ],
        inFlight: metadataInFlight,
        state: emptyCodexRequestSelectionState(),
      }),
    ).toBeNull();

    const hydrationInFlight = queueOf(2, "background", {
      source: "tail_history",
      backgroundLane: "thread",
    });
    expect(
      selectNextCodexScheduledRequest({
        queued: [
          scheduledRequest("hydration", {
            priority: "background",
            source: "tail_history",
            backgroundLane: "thread",
          }),
        ],
        inFlight: hydrationInFlight,
        state: emptyCodexRequestSelectionState(),
      }),
    ).toBeNull();

    const catalogInFlight = [
      scheduledRequest("catalog-active", {
        priority: "background",
        source: "thread_catalog",
        backgroundLane: "thread",
      }),
    ];
    expect(
      selectNextCodexScheduledRequest({
        queued: [
          scheduledRequest("catalog", {
            priority: "background",
            source: "thread_catalog",
            backgroundLane: "thread",
          }),
        ],
        inFlight: catalogInFlight,
        state: emptyCodexRequestSelectionState(),
      }),
    ).toBeNull();

    const backgroundInFlight = queueOf(4, "background", {
      source: "tail_history",
      backgroundLane: "thread",
    });
    expect(
      selectNextCodexScheduledRequest({
        queued: [
          scheduledRequest("background", {
            priority: "background",
            source: "tail_history",
            backgroundLane: "thread",
          }),
        ],
        inFlight: backgroundInFlight,
        state: emptyCodexRequestSelectionState(),
      }),
    ).toBeNull();
  });
});
