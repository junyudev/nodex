import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ClaudeUsageSnapshot } from "../../../shared/agent-runtime-api";
import { AgentRuntimeClaudeUsage } from "../../agent-runtime/AgentRuntimeClaudeUsage";
import { testLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ClaudeUsageIpc";

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Effect.Effect<unknown, unknown>;

const signedOut: ClaudeUsageSnapshot = { status: "ready", providers: [], reason: null };

const setup = Effect.gen(function* () {
  const handlers = new Map<string, Handler>();
  const snapshot = yield* SubscriptionRef.make<ClaudeUsageSnapshot>({
    status: "loading",
    providers: null,
    reason: null,
  });
  const logouts: (readonly string[])[] = [];
  const delivered = new Map<number, unknown[]>();
  const window = (id: number) => ({
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel === "agent-runtime:claude-usage-changed")
          delivered.set(id, [...(delivered.get(id) ?? []), payload]);
      },
    },
  });
  yield* Layer.build(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentRuntimeClaudeUsage, {
            snapshot,
            refresh: SubscriptionRef.get(snapshot),
            reread: Effect.void,
            logout: (instanceIds) =>
              Effect.sync(() => logouts.push(instanceIds)).pipe(Effect.as(signedOut)),
          }),
          Layer.succeed(
            ElectronIpc,
            makeTestElectronIpc({
              handle: (channel, handler) =>
                Effect.sync(() => {
                  handlers.set(channel, handler as Handler);
                }),
              on: () => Effect.void,
            }),
          ),
          Layer.succeed(WindowRuntime, {
            has: (id: number) => id === 1 || id === 2,
            all: () => [window(1), window(2)],
          } as never),
          testLayer(),
        ),
      ),
    ),
  );
  const frame = { url: "app://-/index.html" };
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    getType: () => "window",
    isDestroyed: () => false,
  });
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
    discard: true,
  });
  return { handlers, snapshot, logouts, delivered, event, settle };
});

it.effect("every window hears each change to the one Claude usage snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.settle;
      const read: ClaudeUsageSnapshot = {
        status: "unavailable",
        providers: null,
        reason: "Agent execution could not start",
      };
      yield* SubscriptionRef.set(fixture.snapshot, read);
      yield* fixture.settle;
      assert.deepEqual(fixture.delivered.get(1)?.at(-1), read);
      assert.deepEqual(fixture.delivered.get(2)?.at(-1), read);
      assert.deepEqual(
        yield* fixture.handlers.get("agent-runtime:claude-usage:read")!(fixture.event),
        read,
      );
    }),
  ),
);

it.effect("signs out only well-formed Claude Agents", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const logout = fixture.handlers.get("agent-runtime:claude-usage:logout")!;
      assert.deepEqual(yield* logout(fixture.event, { instanceIds: ["claude_a"] }), signedOut);
      const rejected = yield* logout(fixture.event, { instanceIds: [] }).pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      assert.deepEqual(fixture.logouts, [["claude_a"]]);
    }),
  ),
);
