import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  WORKBENCH_AGENT_CANCEL_CHANNEL,
  WORKBENCH_AGENT_REQUEST_CHANNEL,
  WorkbenchAgentRequestSchema,
  WorkbenchAgentCancelSchema,
  type WorkbenchAgentReply,
  type WorkbenchAgentRequest,
  type WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import type { WindowRuntimeLifecycleEvent } from "../window-runtime/window-runtime-lifecycle";
import { make, WorkbenchAgentBridge } from "./WorkbenchAgentBridge";

const setup = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const events = yield* PubSub.sliding<WindowRuntimeLifecycleEvent>(32);
  const state = new Map(
    [11, 22].map((id) => [
      id,
      {
        generation: `document-${id}`,
        ownerId: null as string | null,
        windowSessionId: `window-${id}`,
      },
    ]),
  );
  const sent: Array<{ id: number; channel: string; value: WorkbenchAgentRequest }> = [];
  const runtime = WindowRuntime.of({
    events: Stream.fromPubSub(events),
    resolveSessionId: (id: number) => state.get(id)?.windowSessionId ?? null,
    resolveRendererGeneration: (id: number) => state.get(id)?.generation ?? null,
    claimPresentationGeneration: (id: number, ownerId: string) => {
      const entry = state.get(id);
      if (!entry) return null;
      if (entry.ownerId !== null && entry.ownerId !== ownerId) entry.generation += ":replacement";
      entry.ownerId = ownerId;
      return entry.generation;
    },
    get: (id: number) => ({ isDestroyed: () => !state.has(id), webContents: { id } }),
  } as unknown as WindowRuntime["Service"]);
  const context = yield* Layer.buildWithScope(
    Layer.effect(
      WorkbenchAgentBridge,
      make({
        maxPending: 2,
        maxPendingPerWindow: 1,
        timeoutMs: 1_000,
        send: (window, channel, args) => {
          assert.isNumber(window?.webContents.id);
          const schema =
            channel === WORKBENCH_AGENT_REQUEST_CHANNEL
              ? WorkbenchAgentRequestSchema
              : WorkbenchAgentCancelSchema;
          assert.isTrue(schema.safeParse(args?.[0]).success);
          sent.push({
            id: window!.webContents.id!,
            channel,
            value: args?.[0] as WorkbenchAgentRequest,
          });
          return true;
        },
      }),
    ).pipe(Layer.provide(Layer.succeed(WindowRuntime, runtime))),
    scope,
  );
  const bridge = Context.get(context, WorkbenchAgentBridge);
  const first = yield* bridge.register(11, "owner-11");
  const second = yield* bridge.register(22, "owner-22");
  const replace = (id: number) => {
    const entry = state.get(id)!;
    const previousRendererGeneration = entry.generation;
    entry.generation += ":next";
    PubSub.publishUnsafe(events, {
      kind: "renderer-changed",
      reason: "navigation-committed",
      previousRendererGeneration,
      revision: 1,
      window: {
        kind: "primary",
        webContentsId: id,
        windowId: id,
        windowSessionId: entry.windowSessionId,
        rendererGeneration: entry.generation,
        activeSessionId: null,
        layoutRevision: 0,
        focusSequence: null,
        focused: false,
      },
    });
  };
  return {
    bridge,
    scope,
    sent,
    first: { ...first, sceneOwner: { kind: "pages" as const } },
    second,
    replace,
    state,
  };
});

const response = (
  request: WorkbenchAgentRequest,
  reference: WorkbenchWindowReference = request,
): WorkbenchAgentReply => ({
  windowSessionId: reference.windowSessionId,
  rendererGeneration: reference.rendererGeneration,
  requestId: request.requestId,
  outcome: { ok: true, result: { kind: "observe", observation: null } },
});

it.effect("correlates observations to the exact window, renderer, and request kind", () =>
  Effect.gen(function* () {
    const subject = yield* setup;
    const request = yield* subject.bridge
      .request(subject.first, { kind: "observe", sceneOwner: { kind: "pages" } })
      .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
    yield* Effect.yieldNow;
    const message = subject.sent.find(
      (item) => item.channel === WORKBENCH_AGENT_REQUEST_CHANNEL,
    )!.value;
    assert.deepEqual(
      subject.sent.map((item) => item.id),
      [11],
    );
    assert.isFalse(yield* subject.bridge.reply(22, response(message)));
    assert.isFalse(yield* subject.bridge.reply(11, response(message, subject.second)));
    assert.isFalse(
      yield* subject.bridge.reply(11, {
        ...response(message),
        outcome: {
          ok: true,
          result: {
            kind: "discover",
            presentationRevision: 0,
            selectedSceneOwner: null,
            sceneOwners: [],
          },
        },
      }),
    );
    assert.isTrue(yield* subject.bridge.reply(11, response(message)));
    assert.deepEqual(yield* Fiber.join(request), { kind: "observe", observation: null });
    assert.isFalse(yield* subject.bridge.reply(11, response(message)));
    assert.equal(subject.sent.length, 1);
    yield* Scope.close(subject.scope, Exit.void);
  }),
);

it.effect(
  "withdraws pending work on renderer replacement and rejects delayed replies and release",
  () =>
    Effect.gen(function* () {
      const subject = yield* setup;
      const request = yield* subject.bridge
        .request(subject.first, { kind: "observe", sceneOwner: { kind: "pages" } })
        .pipe(Effect.flip, Effect.forkIn(subject.scope, { startImmediately: true }));
      yield* Effect.yieldNow;
      const message = subject.sent[0]!.value;
      subject.replace(11);
      assert.isNull(subject.bridge.referenceForSender(11));
      assert.isFalse(yield* subject.bridge.reply(11, response(message)));
      assert.equal((yield* Fiber.join(request)).reason, "stale_renderer");
      const replacement = yield* subject.bridge.register(11, "replacement-owner");
      yield* subject.bridge.release(11, subject.first);
      assert.deepEqual(subject.bridge.referenceForSender(11), replacement);
      assert.deepEqual(subject.bridge.referenceForSender(22), subject.second);
      assert.equal(
        (yield* subject.bridge
          .request(subject.first, { kind: "discover", sessionId: "session" })
          .pipe(Effect.flip)).reason,
        "stale_renderer",
      );
      const afterReload = yield* subject.bridge
        .request(replacement, { kind: "observe", sceneOwner: { kind: "pages" } })
        .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isTrue(yield* subject.bridge.reply(11, response(subject.sent.at(-1)!.value)));
      assert.deepEqual(yield* Fiber.join(afterReload), { kind: "observe", observation: null });
      yield* Scope.close(subject.scope, Exit.void);
    }),
);

it.effect("bounds pending requests and frees capacity on timeout and caller cancellation", () =>
  Effect.gen(function* () {
    const subject = yield* setup;
    const request = yield* subject.bridge
      .request(subject.first, { kind: "observe", sceneOwner: { kind: "pages" } })
      .pipe(Effect.flip, Effect.forkIn(subject.scope, { startImmediately: true }));
    yield* Effect.yieldNow;
    assert.equal(
      (yield* subject.bridge
        .request(subject.first, { kind: "discover", sessionId: "session" })
        .pipe(Effect.flip)).reason,
      "capacity",
    );
    yield* TestClock.adjust(1_000);
    assert.equal((yield* Fiber.join(request)).reason, "timeout");
    assert.equal(
      subject.sent.filter((item) => item.channel === WORKBENCH_AGENT_CANCEL_CHANNEL).length,
      1,
    );
    const cancelled = yield* subject.bridge
      .request(subject.first, { kind: "observe", sceneOwner: { kind: "pages" } })
      .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(cancelled);
    assert.equal(
      subject.sent.filter((item) => item.channel === WORKBENCH_AGENT_CANCEL_CHANNEL).length,
      2,
    );
    const finalRequest = yield* subject.bridge
      .request(subject.first, { kind: "observe", sceneOwner: { kind: "pages" } })
      .pipe(Effect.forkIn(subject.scope, { startImmediately: true }));
    yield* Effect.yieldNow;
    assert.isTrue(yield* subject.bridge.reply(11, response(subject.sent.at(-1)!.value)));
    yield* Fiber.join(finalRequest);
    yield* Scope.close(subject.scope, Exit.void);
    assert.deepEqual(subject.bridge.registered(), []);
    assert.equal(
      (yield* subject.bridge.register(11, "late-owner").pipe(Effect.flip)).reason,
      "closed",
    );
  }),
);
