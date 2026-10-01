// @effect-diagnostics strictEffectProvide:off
import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AgentBackendIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));
vi.mock("../../agent-backend/AgentBackendApplication", async () => {
  const Context = await import("effect/Context");
  return {
    AgentBackendApplication: class extends Context.Service<unknown, unknown>()(
      "test/AgentBackendApplication",
    ) {},
  };
});
type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, object>;
const requestId = "01991e60-b800-7000-8000-000000000012";
const input = {
  scope: { kind: "project", instanceConfigId: "claude-default", projectId: "project" },
  requestId,
};
const makeEvent = (id: number) => {
  const mainFrame = { url: "http://localhost:5173/index.html" };
  let destroyed = false;
  const sender = Object.assign(new EventEmitter(), {
    id,
    mainFrame,
    getType: () => "window",
    isDestroyed: () => destroyed,
  });
  return {
    event: { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
    sender,
    destroy: () => {
      destroyed = true;
      sender.emit("destroyed");
    },
  };
};

it.effect(
  "typed discovery cancellation enforces viewer identity and window destruction releases the query",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      const firstAdmitted = yield* Deferred.make<void>();
      const secondAdmitted = yield* Deferred.make<void>();
      let acquisitions = 0;
      let releases = 0;
      const application = AgentBackendApplication.of({
        claudeDiscovery: () =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              acquisitions++;
              yield* Deferred.succeed(
                acquisitions === 1 ? firstAdmitted : secondAdmitted,
                undefined,
              );
            }),
            () =>
              Effect.sync(() => {
                releases++;
              }),
          ).pipe(Effect.andThen(Effect.never), Effect.scoped),
        changes: Stream.empty,
        observeAgentSession: () => Effect.void,
        unobserveAgentSession: () => Effect.void,
      } as unknown as AgentBackendApplication["Service"]);
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AgentBackendApplication, application),
              Layer.succeed(ElectronIpc, ipc),
              mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
              Layer.succeed(
                WindowRuntime,
                WindowRuntime.of({
                  has: (id: number) => id === 1 || id === 2,
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
        ),
        yield* Effect.scope,
      );
      const discover = handlers.get("agent-backend:claude:discover")!;
      const cancel = handlers.get("agent-backend:claude:cancel-discovery")!;
      const first = makeEvent(1);
      const second = makeEvent(2);
      expect(Exit.isFailure(yield* Effect.exit(cancel(makeEvent(3).event, { requestId })))).toBe(
        true,
      );
      const query = yield* Effect.forkChild(discover(first.event, input));
      yield* Deferred.await(firstAdmitted);
      yield* cancel(second.event, { requestId });
      expect(releases).toBe(0);
      yield* cancel(first.event, { requestId });
      expect(Exit.isFailure(yield* Fiber.await(query))).toBe(true);
      expect(releases).toBe(1);
      expect(first.sender.listenerCount("destroyed")).toBe(0);
      const restarted = yield* Effect.forkChild(discover(first.event, input));
      yield* Deferred.await(secondAdmitted);
      first.destroy();
      expect(Exit.isFailure(yield* Fiber.await(restarted))).toBe(true);
      expect(releases).toBe(2);
      expect(first.sender.listenerCount("destroyed")).toBe(0);
    }).pipe(Effect.scoped),
);
