import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainEvent } from "electron";
import { vi } from "vite-plus/test";
import type { RendererInitializationReport } from "../../../shared/app-startup";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { layer as mainShutdownLayer } from "../../app/MainShutdown";
import { ApplicationInitializationRuntime } from "../../host-runtime/ApplicationInitializationRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ApplicationWindowShellRuntime } from "../../window-runtime/ApplicationWindowShellRuntime";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ApplicationBootstrapIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));

it.effect("owns only the trusted bootstrap handlers before Core is ready", () =>
  Effect.gen(function* () {
    const channels = new Set<string>();
    const register = (channel: string) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          channels.add(channel);
        }),
        () => Effect.sync(() => channels.delete(channel)),
      );
    const ipc = makeTestElectronIpc({
      handle: (channel: string) => register(channel),
      on: (channel: string) => register(channel),
    });
    const initialization = ApplicationInitializationRuntime.of({
      awaitDone: Effect.void,
      current: Effect.succeed({ phase: "done" }),
      reportRenderer: () => Effect.succeed(true),
    } as unknown as ApplicationInitializationRuntime["Service"]);
    const shell = ApplicationWindowShellRuntime.of({
      awaitActivation: () => Effect.void,
      reportRenderer: () => undefined,
    } as unknown as ApplicationWindowShellRuntime["Service"]);
    const windows = WindowRuntime.of({
      acknowledgeClose: () => undefined,
      has: () => true,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationInitializationRuntime, initialization),
            Layer.succeed(ApplicationWindowShellRuntime, shell),
            Layer.succeed(ElectronIpc, ipc),
            mainShutdownLayer,
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );
    assert.deepStrictEqual([...channels].sort(), [
      "app:await-initialization",
      "app:flush-before-close:done",
      "app:renderer-initialization-finished",
      "app:restart",
      "window-sessions:bootstrap",
      "window-sessions:save-layout",
      "window-sessions:update-bounds",
    ]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);

it.effect(
  "validates renderer timings before recording readiness or advancing window activation",
  () =>
    Effect.gen(function* () {
      type Handler = (event: IpcMainEvent, input: unknown) => Effect.Effect<unknown, unknown>;
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: () => Effect.void,
        on: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
      });
      const reportRenderer = vi.fn((_id: number, _report: RendererInitializationReport) =>
        Effect.succeed(true),
      );
      const advanceActivation = vi.fn();
      const failActivation = vi.fn();
      const initialization = ApplicationInitializationRuntime.of({
        reportRenderer,
      } as unknown as ApplicationInitializationRuntime["Service"]);
      const shell = ApplicationWindowShellRuntime.of({
        reportRenderer: advanceActivation,
        failActivation,
      } as unknown as ApplicationWindowShellRuntime["Service"]);
      const windows = WindowRuntime.of({
        has: () => true,
      } as unknown as WindowRuntime["Service"]);
      const scope = yield* Scope.Scope;
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ApplicationInitializationRuntime, initialization),
              Layer.succeed(ApplicationWindowShellRuntime, shell),
              Layer.succeed(ElectronIpc, ipc),
              mainShutdownLayer,
              mainConfigLayer(),
              Layer.succeed(WindowRuntime, windows),
            ),
          ),
        ),
        scope,
      );
      const frame = { url: "app://-/index.html" };
      const event = {
        sender: { id: 7, getType: () => "window", mainFrame: frame },
        senderFrame: frame,
      } as unknown as IpcMainEvent;
      const report = handlers.get("app:renderer-initialization-finished")!;
      const ready = {
        durationMs: 230,
        outcome: "ready",
        timingsMs: { native: 0, modules: 200 },
      } as const;
      yield* report(event, ready);
      assert.deepEqual(reportRenderer.mock.calls, [[7, ready]]);
      assert.deepEqual(advanceActivation.mock.calls, [[7]]);

      for (const timingsMs of [
        { unexpected: 1 },
        { native: -1 },
        { native: Number.NaN },
        { native: Number.POSITIVE_INFINITY },
        { native: 600_001 },
        { native: "1" },
        null,
        [],
      ]) {
        yield* report(event, { ...ready, timingsMs });
      }
      assert.strictEqual(reportRenderer.mock.calls.length, 1);
      assert.strictEqual(advanceActivation.mock.calls.length, 1);
      assert.strictEqual(failActivation.mock.calls.length, 0);

      const failed = {
        durationMs: 10,
        outcome: "failed",
        timingsMs: { native: 10 },
      } as const;
      yield* report(event, failed);
      assert.deepEqual(reportRenderer.mock.calls[1], [7, failed]);
      assert.strictEqual(advanceActivation.mock.calls.length, 1);
      assert.strictEqual(failActivation.mock.calls.length, 1);
      assert.strictEqual(failActivation.mock.calls[0]?.[0], 7);
      assert.instanceOf(failActivation.mock.calls[0]?.[1], Error);
    }),
);
