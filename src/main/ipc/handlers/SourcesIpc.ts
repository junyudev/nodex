import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { updateSourceSettingsSchema } from "../../../shared/sources";
import { MainConfig } from "../../app/MainConfig";
import { rendererLocalCommitApply } from "../../core-client/types";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const sources = yield* SourceSupervisor;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const handlers = mapElectronIpcHandlers(
      ipc,
      (channel, handler) =>
        (event, ...args) =>
          Effect.try({
            try: () => {
              requireTrustedAppRendererSender(event, channel, config.rendererUrl);
              if (!windows.has(event.sender.id) || event.sender.isDestroyed())
                throw new Error("Inactive window");
            },
            catch: () =>
              new SourceSupervisorError({
                message: "Source settings require an active Nodex window",
              }),
          }).pipe(Effect.andThen(handler(event, ...args))),
    );
    yield* handlers.handleQuery("sources:automation-options", () => sources.automationOptions);
    yield* handlers.handleQuery("sources:settings", () => sources.snapshot);
    yield* handlers.handleLocalCommitCommand("sources:connect", () =>
      sources.connect.pipe(
        Effect.map((result) => ({
          ok: true as const,
          value: undefined,
          localCommit: rendererLocalCommitApply(result),
        })),
      ),
    );
    yield* handlers.handleLocalCommitCommand("sources:update", (_, input) =>
      Effect.gen(function* () {
        const parsed = updateSourceSettingsSchema.safeParse(input);
        if (!parsed.success)
          return yield* new SourceSupervisorError({ message: "Invalid Source settings" });
        const result = yield* sources.update(parsed.data);
        return {
          ok: true as const,
          value: undefined,
          localCommit: rendererLocalCommitApply(result),
        };
      }),
    );
    yield* handlers.handlePlainCommand("sources:retry", (_, sourceId) => {
      if (typeof sourceId !== "string" || sourceId.length > 512)
        return Effect.fail(new SourceSupervisorError({ message: "Invalid Source" }));
      return sources.retry(sourceId);
    });
  }),
);
