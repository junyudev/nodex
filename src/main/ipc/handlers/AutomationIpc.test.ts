import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { AutomationApplication } from "../../automation-application/AutomationApplication";
import { AutomationExecution } from "../../automation-application/AutomationExecution";
import { ConversationCommands } from "../../codex-application/ConversationCommands";
import type { RendererClientRuntimeService } from "../../codex/renderer-client-runtime-contracts";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ScheduledAutomationRuntime } from "../../host-runtime/ScheduledAutomationRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AutomationIpc";

it.effect("owns calendar and scheduled automation ingress with the Main Scope", () =>
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
            Layer.succeed(
              ConversationCommands,
              ConversationCommands.of({
                unarchive: () => Effect.die("unused"),
              } as unknown as ConversationCommands["Service"]),
            ),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(RendererClientRuntime, {} as RendererClientRuntimeService),
            mainConfigLayer(),
            Layer.succeed(AutomationApplication, {} as AutomationApplication["Service"]),
            Layer.succeed(AutomationExecution, {} as AutomationExecution["Service"]),
            Layer.succeed(ScheduledAutomationRuntime, {} as ScheduledAutomationRuntime["Service"]),
            Layer.succeed(WindowRuntime, {
              has: () => true,
              all: () => [],
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.strictEqual(channels.size, 17);
    assert.isTrue(channels.has("calendar:occurrences"));
    assert.isTrue(channels.has("codex:scheduled-automations:run-now"));
    assert.isTrue(channels.has("codex:automation-runs:mark-all-read"));

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);
