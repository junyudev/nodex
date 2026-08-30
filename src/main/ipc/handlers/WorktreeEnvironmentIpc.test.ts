import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { WorktreeEnvironmentRuntime } from "../../host-runtime/WorktreeEnvironmentRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./WorktreeEnvironmentIpc";

it.effect("owns every worktree environment ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const channels = new Set<string>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string) =>
        Effect.acquireRelease(
          Effect.sync(() => channels.add(channel)),
          () => Effect.sync(() => channels.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const environments = WorktreeEnvironmentRuntime.of({
      listProjectOptions: () => Effect.succeed([]),
      listProjectConfigs: () => Effect.succeed([]),
      listWorkspaceConfigs: () => Effect.succeed([]),
      readProjectConfig: () => Effect.die("unused"),
      saveProjectConfig: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(WorktreeEnvironmentRuntime, environments),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.deepStrictEqual([...channels].sort(), [
      "worktrees:environments:config:read",
      "worktrees:environments:config:save",
      "worktrees:environments:configs:list",
      "worktrees:environments:configs:list-for-workspace",
      "worktrees:environments:list",
    ]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
