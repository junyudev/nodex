/* oxlint-disable effecttsgo/strict-effect-provide -- Each managed test provides the complete isolated capability graph. */
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
        if (options.retirement === "epoch") snapshot = { ...snapshot, sourceEpoch: "replacement" };
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
