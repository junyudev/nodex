import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CoreLocalCommitResult } from "../../../shared/core-result";
import { MainConfig } from "../../app/MainConfig";
import { CoreModuleResponseError } from "../../core-client/core-client";
import { rendererLocalCommitApply } from "../../core-client/types";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const coreRejection = (cause: unknown): CoreModuleResponseError | null => {
  if (cause instanceof CoreModuleResponseError) return cause;
  if (typeof cause === "object" && cause !== null && "cause" in cause)
    return coreRejection(cause.cause);
  return null;
};
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const work = yield* WorkApplication;
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
              new WorkApplicationError({
              }),
          }).pipe(Effect.andThen(handler(event, ...args))),
    );
    yield* handlers.handleLocalCommitCommand("work:start", (_, input) =>
      Effect.gen(function* (): Effect.fn.Return<
        CoreLocalCommitResult<StartWorkResult>,
        WorkApplicationError
      > {
        const parsed = startWorkInputSchema.safeParse(input);
        if (!parsed.success || !parsed.data.operationId)
          return {
            ok: false,
            error: {
              code: "invalid_input",
              message: "Work start requires a Page and operation identity",
              retryable: false,
              recovery: { kind: "none" },
            },
          };
        return yield* work.startWork(parsed.data).pipe(
          Effect.map(({ value, apply }) => ({
            ok: true as const,
            value,
            localCommit: rendererLocalCommitApply(apply),
          })),
          Effect.catch((cause) => {
            const rejection = coreRejection(cause);
            if (rejection)
              return Effect.succeed({ ok: false as const, error: rejection.coreError });
            return Effect.fail(new WorkApplicationError({ message: cause.message }));
          }),
        );
      }),
    );
  }),
);
