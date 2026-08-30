import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";

import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { StructuralClipboardRuntime } from "../../host-runtime/StructuralClipboardRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./StructuralClipboardIpc";

it.effect("owns exactly the structural clipboard lifecycle ingress", () =>
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
            mainConfigLayer(),
            Layer.succeed(RendererClientRuntime, {} as unknown as RendererClientRuntime["Service"]),
            Layer.succeed(
              StructuralClipboardRuntime,
              {} as unknown as StructuralClipboardRuntime["Service"],
            ),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.deepEqual([...channels].sort(), [
      "clipboard:structural-await",
      "clipboard:structural-begin",
      "clipboard:structural-publish",
      "clipboard:structural-settle",
    ]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
