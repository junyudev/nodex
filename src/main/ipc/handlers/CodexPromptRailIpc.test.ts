import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type {
  CodexPromptRailIndex,
  CodexPromptRailReveal,
} from "../../../shared/codex-prompt-rail-history";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexPromptRailHistory } from "../../codex-application/CodexPromptRailHistory";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./CodexPromptRailIpc";

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

const index: CodexPromptRailIndex = {
  threadId: "thread-a",
  hostId: "host-a",
  generation: 7,
  shells: [
    {
      turnId: "turn-a",
      pageBackwardsCursor: "cursor:newer",
      descendingOffset: 0,
    },
  ],
  complete: false,
  truncatedBy: "page-budget",
  approximateBytes: 80,
  loadedAtMs: 1_000,
};

it.effect("routes typed shell and known-Turn requests and cancels only the owning renderer", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const revealTargets: string[] = [];
    let slowStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let slowInterrupted = false;
    let slowRevealStarted: (() => void) | undefined;
    const revealStarted = new Promise<void>((resolve) => {
      slowRevealStarted = resolve;
    });
    let slowRevealInterrupted = false;
    let committedRevealStarted: (() => void) | undefined;
    const revealCommitted = new Promise<void>((resolve) => {
      committedRevealStarted = resolve;
    });
    const committedReveal: CodexPromptRailReveal = {
      threadId: "thread-a",
      hostId: "host-a",
      generation: 7,
      turnId: "committed-turn",
      topologyGeneration: 12,
      previews: [],
      mutation: {} as never,
    };
    const history = CodexPromptRailHistory.of({
      loadIndex: (threadId) =>
        threadId === "slow-thread"
          ? Effect.callback<never>(() => {
              slowStarted?.();
              return Effect.sync(() => {
                slowInterrupted = true;
              });
            })
          : Effect.succeed(index),
      reveal: (input) => {
        if (input.shell.turnId === "committed-turn") {
          return Effect.sync(() => {
            input.onCommitted?.(committedReveal);
            committedRevealStarted?.();
          }).pipe(Effect.andThen(Effect.never));
        }
        if (input.shell.turnId === "slow-turn") {
          return Effect.callback<never>(() => {
            slowRevealStarted?.();
            return Effect.sync(() => {
              slowRevealInterrupted = true;
            });
          });
        }
        revealTargets.push(`shell:${input.shell.turnId}`);
        return Effect.succeed({} as never);
      },
      revealKnownTurn: (input) => {
        revealTargets.push(`known:${input.turnId}`);
        return Effect.succeed({} as never);
      },
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({ authorizeSender: () => true }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(CodexPromptRailHistory, history),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );
    assert.strictEqual(handlers.size, 3);

    const sender = Object.assign(new EventEmitter(), {
      id: 41,
      isDestroyed: () => false,
    });
    const otherSender = Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: () => false,
    });
    const event = { sender } as unknown as IpcMainInvokeEvent;
    const otherEvent = { sender: otherSender } as unknown as IpcMainInvokeEvent;
    const loadIndex = handlers.get("codex:thread:prompt-rail:index");
    const reveal = handlers.get("codex:thread:prompt-rail:reveal");
    const cancel = handlers.get("codex:thread:prompt-rail:cancel");
    assert.isDefined(loadIndex);
    assert.isDefined(reveal);
    assert.isDefined(cancel);

    const loaded = yield* loadIndex(event, {
      requestId: "index-1",
      threadId: "thread-a",
      expectedTopologyGeneration: 11,
    });
    assert.deepStrictEqual(loaded, {
      status: "completed",
      requestId: "index-1",
      expectedTopologyGeneration: 11,
      index,
    });

    yield* reveal(event, {
      requestId: "reveal-shell",
      threadId: "thread-a",
      hostId: "host-a",
      generation: 7,
      expectedTopologyGeneration: 11,
      target: { kind: "shell", shell: index.shells[0] },
    });
    yield* reveal(event, {
      requestId: "reveal-known",
      threadId: "thread-a",
      hostId: "host-a",
      generation: 7,
      expectedTopologyGeneration: 11,
      target: { kind: "knownTurn", turnId: "turn-1001" },
    });
    assert.deepStrictEqual(revealTargets, ["shell:turn-a", "known:turn-1001"]);

    const slow = yield* Effect.forkChild(
      loadIndex(event, {
        requestId: "slow-1",
        threadId: "slow-thread",
        expectedTopologyGeneration: 11,
      }),
    );
    yield* Effect.promise(() => started);
    assert.isFalse(yield* cancel(otherEvent, "slow-1"));
    assert.isTrue(yield* cancel(event, "slow-1"));
    assert.deepStrictEqual(yield* Fiber.join(slow), {
      status: "cancelled",
      requestId: "slow-1",
    });
    assert.isTrue(slowInterrupted);

    const slowReveal = yield* Effect.forkChild(
      reveal(event, {
        requestId: "slow-reveal",
        threadId: "thread-a",
        hostId: "host-a",
        generation: 7,
        expectedTopologyGeneration: 11,
        target: {
          kind: "shell",
          shell: {
            turnId: "slow-turn",
            pageBackwardsCursor: "cursor:slow",
            descendingOffset: 0,
          },
        },
      }),
    );
    yield* Effect.promise(() => revealStarted);
    assert.isTrue(yield* cancel(event, "slow-reveal"));
    assert.deepStrictEqual(yield* Fiber.join(slowReveal), {
      status: "cancelled",
      requestId: "slow-reveal",
    });
    assert.isTrue(slowRevealInterrupted);

    const committed = yield* Effect.forkChild(
      reveal(event, {
        requestId: "committed-reveal",
        threadId: "thread-a",
        hostId: "host-a",
        generation: 7,
        expectedTopologyGeneration: 11,
        target: {
          kind: "shell",
          shell: {
            turnId: "committed-turn",
            pageBackwardsCursor: "cursor:committed",
            descendingOffset: 0,
          },
        },
      }),
    );
    yield* Effect.promise(() => revealCommitted);
    assert.isTrue(yield* cancel(event, "committed-reveal"));
    assert.deepStrictEqual(yield* Fiber.join(committed), {
      status: "completed",
      requestId: "committed-reveal",
      expectedTopologyGeneration: 11,
      reveal: committedReveal,
    });

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);

it.effect("rejects a forged shell offset before the History and host RPC boundary", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    let historyCalls = 0;
    const history = CodexPromptRailHistory.of({
      loadIndex: () => Effect.die("unused"),
      reveal: () =>
        Effect.sync(() => {
          historyCalls += 1;
          return {} as never;
        }),
      revealKnownTurn: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({ authorizeSender: () => true }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(CodexPromptRailHistory, history),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );
    const reveal = handlers.get("codex:thread:prompt-rail:reveal");
    assert.isDefined(reveal);
    const sender = Object.assign(new EventEmitter(), {
      id: 51,
      isDestroyed: () => false,
    });

    const exit = yield* Effect.exit(
      reveal({ sender } as unknown as IpcMainInvokeEvent, {
        requestId: "forged-offset",
        threadId: "thread-a",
        hostId: "host-a",
        generation: 7,
        expectedTopologyGeneration: 11,
        target: {
          kind: "shell",
          shell: {
            turnId: "turn-a",
            pageBackwardsCursor: "cursor:newer",
            descendingOffset: 2 ** 53,
          },
        },
      }),
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.strictEqual(historyCalls, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);
