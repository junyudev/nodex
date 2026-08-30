import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexPermissions } from "../../codex-application/CodexPermissions";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./CodexPermissionsIpc";

it.effect("registers the permission ingress against its owning module", () =>
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
    const permissions = CodexPermissions.of({
      snapshot: () => Effect.die("unused"),
      resolve: () => Effect.die("unused"),
      resolveAutomation: () => Effect.die("unused"),
      setMode: () => Effect.die("unused"),
      setConfigValue: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexPermissions, permissions),
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
      "codex:permission:config-value:set",
      "codex:permission:mode:get",
      "codex:permission:mode:set",
      "codex:permission:state:get",
    ]);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
