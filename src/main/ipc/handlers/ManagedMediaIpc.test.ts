import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronClipboard } from "../../platform/electron/ElectronClipboard";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { ProfileAssets } from "../../local-store/ProfileAssets";
import { makeProfileAssets } from "../../local-store/assets";
import { live } from "./ManagedMediaIpc";

it.effect("owns managed asset, clipboard, and composer ingress with the Main Scope", () =>
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
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(ElectronClipboard, {} as ElectronClipboard["Service"]),
            mainConfigLayer(),
            Layer.succeed(
              ProfileAssets,
              ProfileAssets.of(makeProfileAssets({ assetsRootPath: "/tmp/nodex-test/assets" })),
            ),
            Layer.succeed(ElectronDesktop, {} as ElectronDesktop["Service"]),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.strictEqual(channels.size, 11);
    assert.isTrue(channels.has("asset:preview:read"));
    assert.isTrue(channels.has("clipboard:read-paste"));
    assert.isTrue(channels.has("composer:pick-files"));

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
