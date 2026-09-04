import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
  CodexQueuedFollowUp,
  CodexSteerTurnInput,
} from "../../shared/types";
import {
  CODEX_ENDED_STEER_REASON,
  CODEX_INTERRUPTED_STEER_REASON,
} from "../../shared/codex-queued-follow-up-state";
import { CoreModules } from "../core-runtime/CoreModules";
import { RendererClientRuntime } from "../host-runtime/RendererClientRuntime";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexInputAssets, type CodexQueuedFollowUpDurableEntry } from "./CodexInputAssets";
import { make } from "./CodexQueuedFollowUps";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import { CodexTurnCommandError, CodexTurnCommands } from "./CodexTurnCommands";
import {
  ConversationEntityMap,
  live as conversationEntityMapLive,
} from "./internal/ConversationEntityMap";

interface DurableLedger {
  revision: number;
  entries: readonly Record<string, unknown>[];
}

interface DurableTestState {
  ledger: DurableLedger;
  payloads: Map<string, CodexQueuedFollowUp>;
}

const threadId = "thread-queue";

const snapshot = (): CodexConversationSnapshot =>
  ({
    threadId,
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
  }) as unknown as CodexConversationSnapshot;

const canonical = (activeTurnId: string | null): CodexCanonicalConversationState =>
  ({
    turns: activeTurnId
      ? [{ protocol: { id: activeTurnId, status: "inProgress" }, sidecar: {} }]
      : [],
  }) as unknown as CodexCanonicalConversationState;

const payloadStore = (state: DurableTestState): CodexInputAssets["Service"] =>
  CodexInputAssets.of({
    retainPrepared: (_threadId, _submissionId, prepared) => Effect.succeed(prepared),
    publish: () => Effect.succeed([]),
    freeze: (row) =>
      Effect.sync(() => {
        const payloadRef = {
          schemaVersion: 2 as const,
          assetUri: `nodex://assets/queued-follow-up-v1-${row.followUpId}.json`,
          sha256: "a".repeat(64),
          byteLength: 128,
        };
        const frozen = { ...row, payloadRef };
        state.payloads.set(payloadRef.assetUri, frozen);
        return frozen;
      }),
    hydrate: (entry: CodexQueuedFollowUpDurableEntry) =>
      Effect.sync(() => {
        const payload = state.payloads.get(entry.payloadRef.assetUri);
        if (!payload) throw new Error("Missing queued payload fixture");
        return { ...payload, pause: entry.pause, payloadRef: entry.payloadRef };
      }),
  });

const coreModules = (state: DurableTestState): CoreModules["Service"] =>
  CoreModules.of({
    workspace: {
      read: () =>
        Effect.succeed({
          value: {
            kind: "queued_follow_up_ledger",
            ledger: state.ledger,
          },
        }),
      apply: (input: { readonly intent: Record<string, unknown> }) =>
        Effect.sync(() => {
          const expectedRevision = input.intent.expected_revision;
          if (expectedRevision !== state.ledger.revision) {
            throw new Error("stale queued ledger revision");
          }
          const entries = input.intent.entries as readonly Record<string, unknown>[];
          state.ledger = { revision: state.ledger.revision + 1, entries };
          return {
            outcome: {
              queued_follow_up_ledger: {
                thread_id: threadId,
                revision: state.ledger.revision,
              },
            },
          };
        }),
    },
  } as unknown as CoreModules["Service"]);

const rendererClients = RendererClientRuntime.of({
  request: () => Effect.die("No renderer owner is installed in this test"),
} as unknown as RendererClientRuntime["Service"]);

const makeHarness = (
  state: DurableTestState,
  options: {
    readonly activeTurnId?: string | null;
    readonly ownerClientId?: string;
    readonly submit?: (row: {
      readonly threadId: string;
      readonly prompt: string;
    }) => Effect.Effect<void, CodexTurnCommandError>;
  } = {},
) =>
  Effect.gen(function* () {
    let activeTurnId = options.activeTurnId ?? null;
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(conversationEntityMapLive, scope);
    const conversations = Context.get(context, ConversationEntityMap);
    conversations.entity(threadId).installSnapshot(snapshot());
    const registry = makeCodexRendererConversationRegistryState();
    if (options.ownerClientId) registry.setOwner(threadId, options.ownerClientId);
    const submit = options.submit ?? (() => Effect.void);
    const turns = CodexTurnCommands.of({
      start: (id: string, prompt: string) =>
        submit({ threadId: id, prompt }).pipe(
          Effect.as({
            threadId: id,
            turnId: "turn-started",
            status: "inProgress" as const,
            itemIds: [],
          }),
        ),
      startRendererOwned: () => Effect.die("unused"),
      startAutomation: () => Effect.die("unused"),
      acceptPreparedRendererTurn: () => Effect.die("unused"),
      steer: ({ threadId: id, prompt }: CodexSteerTurnInput) =>
        submit({ threadId: id, prompt }).pipe(Effect.as({ turnId: "turn-active" })),
      continueGoal: () => Effect.die("unused"),
    } as unknown as CodexTurnCommands["Service"]);
    const projection = CodexConversationProjection.of({
      read: () =>
        Effect.succeed({
          canonical: canonical(activeTurnId),
          snapshot: conversations.current(threadId)?.readSnapshot() ?? null,
        }),
    } as unknown as CodexConversationProjection["Service"]);
    const queued = yield* make.pipe(
      Effect.provideService(CoreModules, coreModules(state)),
      Effect.provideService(CodexInputAssets, payloadStore(state)),
      Effect.provideService(CodexRendererConversationRegistry, registry),
      Effect.provideService(RendererClientRuntime, rendererClients),
      Effect.provideService(CodexTurnCommands, turns),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(Scope.Scope, scope),
    );
    return {
      conversations,
      queued,
      scope,
      setActiveTurnId: (turnId: string | null) => {
        activeTurnId = turnId;
      },
    };
  });

const emptyState = (): DurableTestState => ({
  ledger: { revision: 0, entries: [] },
  payloads: new Map(),
});

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

it.effect("hydrates the same durable order and interruption pause in a replacement Module", () =>
  Effect.gen(function* () {
    const state = emptyState();
    const first = yield* makeHarness(state, { activeTurnId: "turn-active" });
    yield* first.queued.enqueue({
      threadId,
      prompt: "first",
      pause: { kind: "interrupted", reason: "Interrupted before the steer was accepted." },
    });
    yield* first.queued.enqueue({
      threadId,
      prompt: "second",
      pause: { kind: "interrupted", reason: "Interrupted before the steer was accepted." },
    });
    yield* close(first.scope);

    const replacement = yield* makeHarness(state, { activeTurnId: "turn-active" });
    const projection = yield* replacement.queued.read(threadId);
    assert.deepEqual(
      projection.entries.map((entry) => entry.prompt),
      ["first", "second"],
    );
    assert.deepEqual(
      projection.entries.map((entry) => entry.pause?.kind),
      ["interrupted", "interrupted"],
    );
    assert.strictEqual(projection.ledgerRevision, 2);
    yield* close(replacement.scope);
  }),
);

it.effect("hydrates a resume replica without contacting a transitioning renderer owner", () =>
  Effect.gen(function* () {
    const state = emptyState();
    const harness = yield* makeHarness(state, { ownerClientId: "renderer-transitioning" });

    const projection = yield* harness.queued.read(threadId, { projectionTarget: "replica" });

    assert.strictEqual(projection.status, "ready");
    assert.deepEqual(
      harness.conversations.current(threadId)?.readSnapshot()?.queuedFollowUps,
      projection,
    );
    yield* close(harness.scope);
  }),
);

it.effect("replaces an edited row in place only at the captured ledger revision", () =>
  Effect.gen(function* () {
    const state = emptyState();
    const harness = yield* makeHarness(state, { activeTurnId: "turn-active" });
    const firstId = yield* harness.queued.enqueue({ threadId, prompt: "first" });
    const secondId = yield* harness.queued.enqueue({ threadId, prompt: "second" });
    const before = yield* harness.queued.read(threadId);
    const firstBefore = before.entries[0];
    assert.isNotNull(firstBefore);

    const replaced = yield* harness.queued.replace(threadId, firstId, before.ledgerRevision, {
      prompt: "first edited",
    });
    const staleReplace = yield* harness.queued.replace(threadId, secondId, before.ledgerRevision, {
      prompt: "second stale edit",
    });
    const after = yield* harness.queued.read(threadId);

    assert.isTrue(replaced);
    assert.isFalse(staleReplace);
    assert.deepEqual(
      after.entries.map((entry) => [entry.followUpId, entry.prompt]),
      [
        [firstId, "first edited"],
        [secondId, "second"],
      ],
    );
    assert.strictEqual(after.entries[0]?.clientUserMessageId, firstBefore?.clientUserMessageId);
    yield* close(harness.scope);
  }),
);

it.effect(
  "keeps a selected row visible and in flight until transport and Core removal succeed",
  () =>
    Effect.gen(function* () {
      const state = emptyState();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness(state, {
        submit: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid,
          ),
      });
      yield* harness.queued.enqueue({ threadId, prompt: "hold me" });
      yield* Deferred.await(started);
      const pending = harness.conversations.current(threadId)?.readQueuedFollowUpProjection();
      assert.strictEqual(pending?.entries[0]?.prompt, "hold me");
      assert.strictEqual(pending?.inFlightFollowUpId, pending?.entries[0]?.followUpId);

      yield* Deferred.succeed(release, undefined);
      while (harness.queued.list(threadId).length > 0) yield* Effect.yieldNow;
      assert.deepEqual(harness.queued.list(threadId), []);
      assert.strictEqual(state.ledger.entries.length, 0);
      yield* close(harness.scope);
    }),
);

it.effect("replays a dispatch wake-up that arrives while the previous delivery is settling", () =>
  Effect.gen(function* () {
    const state = emptyState();
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const submitted: string[] = [];
    const harness = yield* makeHarness(state, {
      submit: ({ prompt }) =>
        Effect.sync(() => {
          submitted.push(prompt);
        }).pipe(
          Effect.andThen(
            prompt === "first"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void,
          ),
          Effect.asVoid,
        ),
    });
    const interrupted = {
      kind: "interrupted" as const,
      reason: CODEX_INTERRUPTED_STEER_REASON,
    };
    yield* harness.queued.enqueue({ threadId, prompt: "first", pause: interrupted });
    yield* harness.queued.enqueue({ threadId, prompt: "second", pause: interrupted });

    yield* harness.queued.resumeInterrupted(threadId);
    yield* Deferred.await(firstStarted);
    yield* harness.queued.requestDispatch(threadId);
    yield* Deferred.succeed(releaseFirst, undefined);

    while (harness.queued.list(threadId).length > 0) yield* Effect.yieldNow;
    assert.deepEqual(submitted, ["first", "second"]);
    yield* close(harness.scope);
  }),
);

it.effect("commits a transport failure onto the same row and blocks automatic retry", () =>
  Effect.gen(function* () {
    const state = emptyState();
    let submissions = 0;
    const harness = yield* makeHarness(state, {
      submit: () =>
        Effect.sync(() => {
          submissions += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new CodexTurnCommandError({
                operation: "start",
                threadId,
                cause: new Error("gateway unavailable"),
              }),
            ),
          ),
        ),
    });
    yield* harness.queued.enqueue({ threadId, prompt: "retry me" });
    while (harness.queued.list(threadId)[0]?.pause?.kind !== "failed") yield* Effect.yieldNow;
    const [failed] = harness.queued.list(threadId);
    assert.strictEqual(failed?.prompt, "retry me");
    assert.strictEqual(failed?.pause?.kind, "failed");
    assert.strictEqual(
      harness.conversations.current(threadId)?.readQueuedFollowUpProjection().inFlightFollowUpId,
      null,
    );
    yield* harness.queued.requestDispatch(threadId);
    yield* Effect.yieldNow;
    assert.strictEqual(submissions, 1);
    yield* close(harness.scope);
  }),
);

it.effect("interrupting the scoped delivery fiber leaves the durable row retryable", () =>
  Effect.gen(function* () {
    const state = emptyState();
    const started = yield* Deferred.make<void>();
    const harness = yield* makeHarness(state, {
      submit: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* harness.queued.enqueue({ threadId, prompt: "survive shutdown" });
    yield* Deferred.await(started);
    yield* close(harness.scope);
    assert.strictEqual(state.ledger.entries.length, 1);

    const replacement = yield* makeHarness(state, { activeTurnId: "turn-active" });
    const projection = yield* replacement.queued.read(threadId);
    assert.strictEqual(projection.entries[0]?.prompt, "survive shutdown");
    assert.strictEqual(projection.inFlightFollowUpId, null);
    yield* close(replacement.scope);
  }),
);

it.effect("freezes recovered steers and pauses every unfailed row in one terminal commit", () =>
  Effect.gen(function* () {
    const state = emptyState();
    const harness = yield* makeHarness(state, { activeTurnId: "turn-active" });
    yield* harness.queued.enqueue({ threadId, prompt: "already queued" });
    const recovered: CodexQueuedFollowUp = {
      followUpId: "follow-up-recovered",
      clientUserMessageId: "client-recovered",
      threadId,
      prompt: "unaccepted steer",
      promptInput: { text: "unaccepted steer" },
      createdAtMs: 1,
      collaborationMode: null,
      serviceTier: null,
      summary: null,
      pause: null,
      payloadRef: null,
    };
    yield* harness.queued.acceptTerminalOutcomeInCurrentLane({
      threadId,
      rows: [recovered],
      interrupted: true,
    });
    const projection = harness.conversations.current(threadId)?.readQueuedFollowUpProjection();
    assert.deepEqual(
      projection?.entries.map((entry) => [entry.prompt, entry.pause?.kind]),
      [
        ["unaccepted steer", "interrupted"],
        ["already queued", "interrupted"],
      ],
    );
    assert.strictEqual(state.ledger.entries.length, 2);
    yield* close(harness.scope);
  }),
);

it.effect("keeps a steer that loses the terminal race as a failed queue head", () =>
  Effect.gen(function* () {
    const state = emptyState();
    let submissions = 0;
    const harness = yield* makeHarness(state, {
      activeTurnId: "turn-active",
      submit: () =>
        Effect.sync(() => {
          submissions += 1;
        }),
    });
    yield* harness.queued.enqueue({ threadId, prompt: "already queued" });
    const recovered: CodexQueuedFollowUp = {
      followUpId: "follow-up-final-response-race",
      clientUserMessageId: "client-final-response-race",
      threadId,
      prompt: "steer during the final response",
      promptInput: { text: "steer during the final response" },
      createdAtMs: 1,
      collaborationMode: null,
      serviceTier: null,
      summary: null,
      pause: null,
      payloadRef: null,
    };

    yield* harness.queued.acceptTerminalOutcomeInCurrentLane({
      threadId,
      rows: [recovered],
      interrupted: false,
    });
    harness.setActiveTurnId(null);
    yield* harness.queued.requestDispatch(threadId);
    yield* Effect.yieldNow;

    const projection = harness.conversations.current(threadId)?.readQueuedFollowUpProjection();
    assert.deepEqual(
      projection?.entries.map((entry) => [entry.prompt, entry.pause]),
      [
        ["steer during the final response", { kind: "failed", reason: CODEX_ENDED_STEER_REASON }],
        ["already queued", null],
      ],
    );
    assert.strictEqual(submissions, 0);
    assert.strictEqual(state.ledger.entries.length, 2);
    yield* close(harness.scope);
  }),
);
