import { describe, expect, test } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type { CodexHistoryTimelineReadInput } from "../../shared/codex-history-timeline-read";
import { testLayer as mainConfigTestLayer } from "../app/MainConfig";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRendererNativeRequestAdmission } from "../ipc/handlers/CodexWorkspaceIpc";
import { CodexHistoryTimelineAdapter, live } from "./CodexHistoryTimelineAdapter";
import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { CodexNativeThreadLookup } from "./CodexNativeThreadLookup";
import { make, serializeCodexReadThreadProtocolItem } from "./CodexReadThreadHistory";
import { turnFixture } from "./conversation-test-fixture";

describe("CodexHistoryTimelineAdapter", () => {
  const input: CodexHistoryTimelineReadInput = {
    hostId: "local",
    hostGeneration: 7,
    sourceEpoch: "native-7",
    params: { threadId: "thread-a", cursor: "page-a", limit: 500 },
    options: {
      priority: "critical",
      source: "visible_history",
      timeoutMs: 30000,
      trace: { traceparent: "trace" },
    },
  };
  const page = { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: "voice-session" };

  function fixture(
    options: {
      readonly timelineEnabled?: boolean;
      readonly version?: string;
      readonly hostId?: string;
      readonly generation?: number;
      readonly sourceEpoch?: string;
      readonly retirement?: "generation" | "epoch" | "host" | "current";
    } = {},
  ) {
    let snapshot = createCodexAppServerCapabilitySnapshot({
      hostId: options.hostId ?? "local",
      generation: options.generation ?? 7,
      sourceEpoch: options.sourceEpoch ?? "native-7",
      userAgent: `codex/${options.version ?? "0.162.0-alpha.17.2"}`,
    });
    let current = true;
    const requests: Array<{
      threadId: string;
      method: string;
      params: unknown;
      scheduling: unknown;
    }> = [];
    const capabilities = CodexAppServerCapabilities.of({
      forThread: () => Effect.sync(() => snapshot),
      forHost: () => Effect.sync(() => snapshot),
      isCurrent: () => Effect.sync(() => current),
    });
    const gateway = CodexGateway.of({
      requestForThread: (threadId: string, method: string, params: unknown, scheduling: unknown) =>
        Effect.sync(() => {
          requests.push({ threadId, method, params, scheduling });
          if (options.retirement === "generation") snapshot = { ...snapshot, generation: 8 };
          if (options.retirement === "epoch")
            snapshot = { ...snapshot, sourceEpoch: "replacement" };
          if (options.retirement === "host") snapshot = { ...snapshot, hostId: "ssh:other" };
          if (options.retirement === "current") current = false;
          return page;
        }),
    } as unknown as CodexGateway["Service"]);
    const layer = live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CodexGateway, gateway),
          Layer.succeed(CodexAppServerCapabilities, capabilities),
          mainConfigTestLayer({
            environment:
              options.timelineEnabled === false
                ? {}
                : { NODEX_DEV_ENABLED_FEATURES: "thread-timeline-history" },
          }),
        ),
      ),
    );
    return { layer, requests };
  }

  it("local native chats admit history reads and refuse every execution method", () => {
    for (const method of ["thread/read", "thread/turns/list", "thread/items/list", "model/list"])
      assert.strictEqual(
        codexRendererNativeRequestAdmission(method, { threadQueue: true }, "local"),
        "allowed",
      );
    for (const method of [
      "thread/resume",
      "turn/interrupt",
      "thread/settings/update",
      "thread/compact/start",
      "thread/revert",
      "thread/queue/add",
    ]) {
      assert.strictEqual(
        codexRendererNativeRequestAdmission(method, { threadQueue: true }, "local"),
        "local-read-only",
      );
      assert.strictEqual(
        codexRendererNativeRequestAdmission(method, { threadQueue: true }, "remote"),
        "allowed",
      );
    }
  });

  it.effect(
    "raw renderer timeline requests remain denied while the admitted Thread reader preserves its page and scheduling",
    () => {
      const { layer, requests } = fixture();
      return Effect.gen(function* () {
        assert.strictEqual(
          codexRendererNativeRequestAdmission("thread/timeline/list", { threadQueue: true }),
          "requires-application-capability",
        );
        assert.strictEqual(
          codexRendererNativeRequestAdmission("thread/searchOccurrences", { threadQueue: true }),
          "requires-application-capability",
        );
        const reader = yield* CodexHistoryTimelineAdapter;
        const result = yield* reader.read(input);
        assert.deepStrictEqual(result, {
          threadId: "thread-a",
          hostId: "local",
          hostGeneration: 7,
          sourceEpoch: "native-7",
          response: page,
        });
        assert.deepStrictEqual(requests, [
          {
            threadId: "thread-a",
            method: "thread/timeline/list",
            params: input.params,
            scheduling: {
              priority: "critical",
              source: "visible_history",
              timeoutMs: 30000,
              wireTrace: { traceparent: "trace" },
              expectedHostId: "local",
              expectedGeneration: 7,
            },
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "accepts the normal resume's optional trace and priority without inventing a caller value",
    () => {
      const { layer, requests } = fixture();
      return Effect.gen(function* () {
        const reader = yield* CodexHistoryTimelineAdapter;
        yield* reader.read({
          ...input,
          options: { source: "thread_hydration", priority: undefined, trace: undefined },
        });
        assert.deepStrictEqual(requests[0]?.scheduling, {
          priority: "interactive",
          source: "thread_hydration",
          timeoutMs: undefined,
          wireTrace: undefined,
          expectedHostId: "local",
          expectedGeneration: 7,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  for (const options of [
    { timelineEnabled: false },
    { version: "0.149.0" },
    { hostId: "durable" },
  ] as const) {
    it.effect(
      `denies unsupported timeline policy before native dispatch ${JSON.stringify(options)}`,
      () => {
        const { layer, requests } = fixture(options);
        return Effect.gen(function* () {
          const reader = yield* CodexHistoryTimelineAdapter;
          const result = yield* reader
            .read({ ...input, hostId: options.hostId ?? "local" })
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (Result.isFailure(result))
            assert.strictEqual(result.failure.reason, "unsupported-capability");
          assert.strictEqual(requests.length, 0);
        }).pipe(Effect.provide(layer));
      },
    );
  }

  for (const options of [
    { hostId: "ssh:other" },
    { generation: 8 },
    { sourceEpoch: "replacement" },
  ] as const) {
    it.effect(`denies a foreign retained host context ${JSON.stringify(options)}`, () => {
      const { layer, requests } = fixture(options);
      return Effect.gen(function* () {
        const reader = yield* CodexHistoryTimelineAdapter;
        const result = yield* reader.read(input).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "stale-generation");
        assert.strictEqual(requests.length, 0);
      }).pipe(Effect.provide(layer));
    });
  }

  for (const retirement of ["generation", "epoch", "host", "current"] as const) {
    it.effect(`does not deliver a history page after ${retirement} retirement`, () => {
      const { layer, requests } = fixture({ retirement });
      return Effect.gen(function* () {
        const reader = yield* CodexHistoryTimelineAdapter;
        const result = yield* reader.read(input).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "stale-generation");
        assert.strictEqual(requests.length, 1);
      }).pipe(Effect.provide(layer));
    });
  }

  it.effect("rejects malformed generated pagination parameters without dispatch", () => {
    const { layer, requests } = fixture();
    return Effect.gen(function* () {
      const reader = yield* CodexHistoryTimelineAdapter;
      const result = yield* reader
        .read({ ...input, params: { ...input.params, limit: -1 } })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "invalid-input");
      assert.strictEqual(requests.length, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("CodexReadThreadHistory", () => {
  const nativeThread = (turns: Turn[], historyMode: Thread["historyMode"] = "paginated"): Thread =>
    ({
      id: "thread",
      historyMode,
      turns,
      name: "History",
      preview: "Native",
      status: { type: "idle" },
      cwd: "/repo",
      createdAt: 1,
      updatedAt: 2,
    }) as Thread;
  function service(
    thread: Thread,
    paginated: boolean,
    calls: { method: string; params: unknown }[],
    assertCurrent = () => {},
  ) {
    return make.pipe(
      Effect.provideService(CodexNativeThreadLookup, {
        resolve: () =>
          Effect.sync(() => {
            calls.push({
              method: "thread/read",
              params: { threadId: "thread", includeTurns: false },
            });
            return { hostId: "local", thread, manager: { assertCurrent, generation: 1 } };
          }),
      } as unknown as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: () =>
          Effect.succeed({
            ...createCodexAppServerCapabilitySnapshot({
              hostId: "local",
              generation: 1,
              userAgent: "0.153.0",
            }),
            flags: { paginatedHistory: paginated },
          }),
      } as unknown as CodexAppServerCapabilities["Service"]),
      Effect.provideService(CodexGateway, {
        requestOnHost: (_host: string, method: string, params: unknown) =>
          Effect.sync(() => {
            calls.push({ method, params });
            return method === "thread/read"
              ? { thread }
              : { data: [turnFixture("older")], nextCursor: "opaque-next" };
          }),
      } as unknown as CodexGateway["Service"]),
    );
  }
  it.effect(
    "paginated read forwards the native cursor and returns native metadata without resident hydration",
    () =>
      Effect.gen(function* () {
        const calls: { method: string; params: unknown }[] = [];
        const reader = yield* service(nativeThread([]), true, calls);
        const result = yield* reader.read({
          threadId: "thread",
          cursor: "opaque-before",
          turnLimit: 2,
        });
        assert.deepEqual(calls, [
          { method: "thread/read", params: { threadId: "thread", includeTurns: false } },
          {
            method: "thread/turns/list",
            params: { threadId: "thread", cursor: "opaque-before", itemsView: "full", limit: 2 },
          },
        ]);
        assert.strictEqual(result.page.nextCursor, "opaque-next");
        assert.strictEqual(result.thread.createdAt, 1);
        assert.strictEqual(result.thread.kind, "codex");
      }),
  );
  it.effect(
    "legacy paginated history translates turn identity cursors only at the native boundary",
    () =>
      Effect.gen(function* () {
        const calls: { method: string; params: unknown }[] = [];
        const reader = yield* service(
          nativeThread([], "default" as Thread["historyMode"]),
          true,
          calls,
        );
        const result = yield* reader.read({ threadId: "thread", cursor: "anchor" });
        assert.deepEqual(calls[1]?.params, {
          threadId: "thread",
          cursor: JSON.stringify({ turnId: "anchor", includeAnchor: false }),
          itemsView: "full",
          limit: 1,
        });
        assert.strictEqual(result.page.nextCursor, "older");
      }),
  );
  it.effect("nonpaginated history uses exclusive turn IDs and rejects unknown anchors", () =>
    Effect.gen(function* () {
      const calls: { method: string; params: unknown }[] = [];
      const reader = yield* service(
        nativeThread(
          [turnFixture("a"), turnFixture("b"), turnFixture("c")],
          "default" as Thread["historyMode"],
        ),
        false,
        calls,
      );
      const result = yield* reader.read({ threadId: "thread", cursor: "c" });
      assert.strictEqual(result.turns[0]?.id, "b");
      assert.strictEqual(result.page.nextCursor, "b");
      const error = yield* reader.read({ threadId: "thread", cursor: "missing" }).pipe(Effect.flip);
      assert.include(String(error.cause), "Unknown cursor");
    }),
  );
  test("native history preserves generated image source identity", () => {
    for (const source of [{ result: "AQID" }, { fileId: "file_123" }]) {
      const item = {
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        generationId: null,
        ...source,
      } as const;
      expect(serializeCodexReadThreadProtocolItem(item, false, 0)).toEqual({
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        savedPath: null,
        ...source,
      });
    }
  });

  test("output budget does not truncate user/assistant input and structured output reports original size", () => {
    expect(
      serializeCodexReadThreadProtocolItem(
        {
          type: "agentMessage",
          moderation: null,
          id: "answer",
          text: "complete answer",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
        true,
        3,
      ),
    ).toMatchObject({ text: "complete answer" });
    expect(
      serializeCodexReadThreadProtocolItem(
        {
          type: "functionCallOutput",
          id: "output",
          name: "tool",
          namespace: null,
          output: "abcdef",
        },
        true,
        3,
      ),
    ).toMatchObject({ output: { text: "abc", truncated: true, originalChars: 6 } });
    expect(
      serializeCodexReadThreadProtocolItem(
        {
          type: "userMessage",
          id: "input",
          clientId: null,
          content: [
            { type: "localImage", path: "/image.png" },
            { type: "image", fileId: "file-123" },
            { type: "audio", fileId: "file-456" },
          ],
        },
        false,
        0,
      ),
    ).toEqual({
      type: "userMessage",
      id: "input",
      content: [
        { type: "localImage", path: "/image.png" },
        { type: "image", fileId: "file-123" },
        { type: "audio", fileId: "file-456" },
      ],
    });
  });

  it.effect("native history rejects a page returned after its authenticated manager retires", () =>
    Effect.gen(function* () {
      const calls: { method: string; params: unknown }[] = [];
      const reader = yield* service(nativeThread([]), true, calls, () => {
        if (calls.length > 1) throw new Error("account retired");
      });
      const error = yield* reader.read({ threadId: "thread" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "request-failed");
      assert.include(String(error.cause), "account retired");
      assert.lengthOf(calls, 2);
    }),
  );
});
