import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { CodexSshExecutionHostConfig } from "../../../shared/types";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ExecutionHostRuntime } from "../../codex-application/ExecutionHostRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ExecutionHostIpc";

it.effect("registers execution host settings ingress against its owning module", () =>
  Effect.gen(function* () {
    const channels = new Set<string>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            channels.add(channel);
          }),
          () => Effect.sync(() => channels.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const activeSshHosts = yield* SubscriptionRef.make<
      ReadonlyMap<string, CodexSshExecutionHostConfig>
    >(new Map());
    const executionHosts = ExecutionHostRuntime.of({
      activeSshHosts,
      hosts: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
      resolve: () => Effect.die("unused"),
      updateLocalManagedRoot: () => Effect.void,
      settings: Effect.succeed({ sshHosts: [] }),
      reconcile: () => Effect.void,
      updateSettings: () => Effect.succeed({ sshHosts: [] }),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ExecutionHostRuntime, executionHosts),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.deepEqual([...channels].sort(), [
      "worktrees:execution-hosts:get",
      "worktrees:execution-hosts:update",
    ]);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
