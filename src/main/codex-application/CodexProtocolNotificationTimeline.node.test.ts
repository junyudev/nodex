import { CodexVisualizationState } from "./CodexVisualizationState";
import { assert, it } from "@effect/vitest";
import type { ThreadRealtimeItem } from "@nodex/codex-app-server-protocol/v2";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexCanonicalTimelineEntry } from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import { MainConfig, testLayer as mainConfigTestLayer } from "../app/MainConfig";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationDeltaBufferRuntime } from "./CodexConversationDeltaBufferRuntime";
import { CodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { make } from "./CodexProtocolNotificationEffects";
import { CodexProtocolNotificationProjection } from "./CodexProtocolNotificationProjection";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadDurableProjection } from "./CodexThreadDurableProjection";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadTitleReconsideration } from "./CodexThreadTitleReconsideration";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

const fixture = Effect.fn("notificationTimelineTest.fixture")(function* (
  options: {
    readonly hostId?: string;
    readonly stateHostId?: string;
    readonly version?: string;
    readonly enabled?: boolean;
    readonly capabilityHostId?: string;
    readonly capabilityGeneration?: number;
    readonly holdCapability?: boolean;
  } = {},
) {
  const hostId = options.hostId ?? "local";
  const registry = makeConversationEntityStateRegistry();
  const entity = registry.acquire("thread");
  entity.acceptCanonicalState(
    createCodexCanonicalHydratedConversationState(
      {
        ...buildAgentActivityV2CorpusThread([]),
        id: "thread",
        cliVersion: "0.162.0-alpha.17.2",
        turns: [],
      },
      {
        hostId: options.stateHostId ?? hostId,
        model: "test",
        reasoningEffort: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace"],
      },
    ),
  );
  let generation = 7;
  let role: ConversationStreamRole = { role: "owner" };
  const manager = {
    hostId,
    get generation() {
      return generation;
    },
    stream: { getRole: () => role },
  };
  const requested = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  let capabilityReads = 0;
  const consequences: string[] = [];
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: options.capabilityHostId ?? hostId,
    generation: options.capabilityGeneration ?? generation,
    userAgent: `codex/${options.version ?? "0.162.0-alpha.17.2"}`,
  });
  const config = Context.get(
    yield* Layer.buildWithScope(
      mainConfigTestLayer({
        environment:
          options.enabled === false
            ? {}
            : { NODEX_DEV_ENABLED_FEATURES: "thread-timeline-history" },
      }),
      yield* Scope.Scope,
    ),
    MainConfig,
  );
  const service = yield* make
    .pipe(
      Effect.provideService(
        CodexVisualizationState,
        CodexVisualizationState.of({
          read: () => Effect.succeed(null),
          write: () => Effect.die("unused"),
          writeInteraction: () => Effect.die("unused"),
          readPassiveContext: () => Effect.succeed(undefined),
          readUnsentPassiveContext: () => Effect.succeed(undefined),
          markPassiveContextSent: () => Effect.void,
          clearThread: () => Effect.succeed([]),
        }),
      ),
    )
    .pipe(
      Effect.provideService(MainConfig, config),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: (requestedHost: string) =>
          Effect.gen(function* () {
            assert.strictEqual(requestedHost, hostId);
            capabilityReads += 1;
            yield* Deferred.succeed(requested, undefined);
            if (options.holdCapability) yield* Deferred.await(released);
            return capability;
          }),
      } as unknown as CodexAppServerCapabilities["Service"]),
      Effect.provideService(CodexMainConversationManagers, {
        current: () => manager,
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(ConversationEntityMap, {
        current: registry.current,
        readThreadMetadata: registry.readThreadMetadata,
      } as unknown as ConversationEntityMap["Service"]),
      Effect.provideService(CodexApplicationEventHub, {
        events: Stream.empty,
        publish: (event) => consequences.push(event.kind),
      }),
      Effect.provideService(CodexProtocolNotificationProjection, {
        observe: () => Effect.succeed(false),
      }),
      Effect.provideService(CodexSubagentDirectory, {
        observeNotification: () =>
          Effect.sync(() => {
            consequences.push("subagents");
          }),
      } as unknown as CodexSubagentDirectory["Service"]),
      Effect.provideService(CodexThreadDurableProjection, {
        acceptsTerminalObservation: () => Effect.succeed(true),
        observe: () =>
          Effect.sync(() => {
            consequences.push("durable");
          }),
      }),
      Effect.provideService(CodexThreadTitleReconsideration, { observe: () => Effect.void }),
      Effect.provideService(RemoteHostedPipRuntime, {
        observeCodexOccurrence: () =>
          Effect.sync(() => {
            consequences.push("pip");
          }),
      } as unknown as RemoteHostedPipRuntime["Service"]),
      Effect.provideService(CodexConversationDeltaBufferRuntime, {
        drainBeforeCompletion: () => {},
      } as unknown as CodexConversationDeltaBufferRuntime["Service"]),
      Effect.provideService(CodexManualCompactionRuntime, {
        consumeSource: () => "automatic",
      } as unknown as CodexManualCompactionRuntime["Service"]),
      Effect.provideService(
        CodexConversationLifecycle,
        {} as CodexConversationLifecycle["Service"],
      ),
      Effect.provideService(
        CodexConversationProjection,
        {} as CodexConversationProjection["Service"],
      ),
      Effect.provideService(
        CodexPendingServerRequestRuntime,
        {} as CodexPendingServerRequestRuntime["Service"],
      ),
      Effect.provideService(CodexQueuedFollowUps, {} as CodexQueuedFollowUps["Service"]),
      Effect.provideService(CodexThreadGoalRuntime, {} as CodexThreadGoalRuntime["Service"]),
      Effect.provideService(
        CodexUserInputAutoResolution,
        {} as CodexUserInputAutoResolution["Service"],
      ),
      Effect.provideService(BrowserUseRuntime, {} as BrowserUseRuntime["Service"]),
    );
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.releaseAll()));
  return {
    entity,
    consequences,
    registry,
    requested,
    released,
    capabilityReads: () => capabilityReads,
    setRole: (next: ConversationStreamRole) => {
      role = next;
    },
    reset: () => {
      generation += 1;
    },
    apply: (notification: CodexServerNotification) =>
      service.apply({
        hostId,
        generation: 7,
        notification,
        occurrenceId: `${hostId}:7:1`,
        occurrenceToken: 1,
      }),
  };
});

const transcript = (text: string): ThreadRealtimeItem => ({
  type: "transcriptSegment",
  id: "segment",
  realtimeSessionId: "session",
  role: "assistant",
  text,
});
const started: CodexServerNotification = {
  method: "thread/realtime/item/started",
  params: { threadId: "thread", item: transcript("first") },
};

it.effect(
  "Main notification ownership streams and completes native rows without changing their timeline identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.apply(started);
      yield* f.apply({
        method: "thread/realtime/item/transcript/delta",
        params: { threadId: "thread", itemId: "segment", delta: " delta" },
      });
      assert.deepEqual(
        f.entity.readCanonicalState()?.realtimeItems?.segment?.item,
        transcript("first delta"),
      );
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: transcript("final") },
      });
      yield* f.apply(started);
      const item: ThreadRealtimeItem = {
        type: "bemItemPromoted",
        id: "receipt",
        realtimeSessionId: "session",
        turnId: "missing-turn",
        itemId: "missing-item",
        presentation: { type: "wholeItem" },
      };
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item },
      });
      assert.deepEqual(f.entity.readCanonicalState()?.itemTimeline?.entries, [
        { type: "realtime", position: 1, item: transcript("final") },
        { type: "realtime", position: 2, item },
      ]);
      assert.deepEqual(f.entity.readCanonicalState()?.realtimeItems?.segment, {
        item: transcript("final"),
        completed: true,
      });
      assert.deepEqual(f.entity.readCanonicalState()?.turns, []);
      const plan = { type: "plan" as const, id: "plan", text: "Next" };
      yield* f.apply({
        method: "item/started",
        params: { threadId: "thread", turnId: "turn", item: plan, startedAtMs: 1 },
      });
      yield* f.apply({
        method: "item/completed",
        params: { threadId: "thread", turnId: "turn", item: plan, completedAtMs: 2 },
      });
      assert.deepEqual(f.entity.readCanonicalState()?.itemTimeline?.entries.at(-1), {
        type: "item",
        position: 3,
        turnId: "turn",
        item: { id: "plan", type: "plan", completed: true },
      });
    }),
);

it.effect.each([
  { enabled: false },
  { version: "0.149.0" },
  { hostId: "durable" },
  { capabilityHostId: "other" },
  { capabilityGeneration: 8 },
  { stateHostId: "other" },
])("Main timeline mutation rejects disabled or nonmatching physical policy %#", (options) =>
  Effect.gen(function* () {
    const f = yield* fixture(options);
    const before = f.entity.readCanonicalState();
    yield* f.apply(started);
    assert.strictEqual(f.entity.readCanonicalState(), before);
  }),
);

it.effect.each(["reset", "follower", "retire"] as const)(
  "Main capability acquisition fences a concurrent %s before committing the native row",
  (change) =>
    Effect.gen(function* () {
      const completed: CodexServerNotification = {
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          completedAtMs: 1,
          item: { type: "plan", id: "plan", text: "Next" },
        },
      };
      for (const notification of [started, completed]) {
        const f = yield* fixture({ holdCapability: true });
        const before = f.entity.readCanonicalState();
        const fiber = yield* Effect.forkScoped(f.apply(notification));
        yield* Deferred.await(f.requested);
        if (change === "reset") f.reset();
        if (change === "follower") f.setRole({ role: "follower", ownerClientId: "renderer" });
        if (change === "retire") f.registry.releaseGeneration("thread", f.entity.generation);
        yield* Deferred.succeed(f.released, undefined);
        yield* Fiber.join(fiber);
        if (change !== "retire") assert.strictEqual(f.entity.readCanonicalState(), before);
        else assert.isNull(f.registry.current("thread"));
        assert.strictEqual(f.capabilityReads(), 1);
        assert.deepEqual(f.consequences, []);
      }
    }),
);

it.effect(
  "a renderer-owned follower receives no second Main timeline mutation or capability read",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setRole({ role: "follower", ownerClientId: "renderer" });
      const before = f.entity.readCanonicalState();
      yield* f.apply(started);
      assert.strictEqual(f.entity.readCanonicalState(), before);
      assert.strictEqual(f.capabilityReads(), 0);
    }),
);

it.effect("Main sparse append and completion reuse the admitted 10,000-row identity index", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let residentItemReads = 0;
    const entries: CodexCanonicalTimelineEntry[] = Array.from({ length: 10_000 }, (_, index) => {
      const item: ThreadRealtimeItem = Object.freeze({
        ...transcript(String(index)),
        id: String(index),
      });
      return Object.freeze({
        type: "realtime" as const,
        position: index + 1,
        get item() {
          residentItemReads += 1;
          return item;
        },
      });
    });
    f.entity.acceptCanonicalState({
      ...f.entity.readCanonicalState()!,
      itemTimeline: Object.freeze({
        activeRealtimeSessionAtPageStart: null,
        entries: Object.freeze(entries),
      }),
    });
    yield* f.apply({
      method: "thread/realtime/item/completed",
      params: { threadId: "thread", item: { ...transcript("prime"), id: "0" } },
    });
    assert.isAtLeast(residentItemReads, 10_000);
    residentItemReads = 0;
    yield* f.apply(started);
    yield* f.apply({
      method: "thread/realtime/item/transcript/delta",
      params: { threadId: "thread", itemId: "segment", delta: " delta" },
    });
    yield* f.apply({
      method: "thread/realtime/item/completed",
      params: { threadId: "thread", item: transcript("final") },
    });
    yield* f.apply({
      method: "thread/realtime/item/completed",
      params: { threadId: "thread", item: { ...transcript("last revised"), id: "9999" } },
    });
    // Only the exact resident entry being completed may be read; no history-wide scan is allowed.
    assert.isAtMost(residentItemReads, 4);
    const timeline = f.entity.readCanonicalState()?.itemTimeline;
    assert.strictEqual(timeline?.entries.length, 10_001);
    assert.deepEqual(timeline?.entries.at(-1), {
      type: "realtime",
      position: 10_001,
      item: transcript("final"),
    });
    assert.deepEqual(timeline?.entries[9999], {
      type: "realtime",
      position: 10_000,
      item: { ...transcript("last revised"), id: "9999" },
    });
  }),
);

it.effect(
  "Main history replacement rebuilds native identity positions before the next completion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.apply(started);
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: transcript("old final") },
      });
      f.entity.mutateCanonicalState((draft) => {
        draft.itemTimeline!.entries = [
          { type: "realtime", position: 0, item: { ...transcript("older"), id: "older" } },
          ...draft.itemTimeline!.entries,
        ];
      }, 2);
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: transcript("new final") },
      });
      assert.deepEqual(f.entity.readCanonicalState()?.itemTimeline?.entries, [
        { type: "realtime", position: 0, item: { ...transcript("older"), id: "older" } },
        { type: "realtime", position: 1, item: transcript("new final") },
      ]);
    }),
);
