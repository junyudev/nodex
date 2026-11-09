import { setExecutionHoldInputSchema } from "../../../shared/work-application";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CoreModules } from "../../core-runtime/CoreModules";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import type { CoreLocalCommitResult } from "../../../shared/core-result";
import {
  acceptWorkInputSchema,
  startWorkInputSchema,
  type StartWorkResult,
} from "../../../shared/work-application";
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
    const core = yield* CoreModules;
    const runtime = yield* AgentRuntimeApplication;
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
                message: "Work commands require an active Nodex window",
              }),
          }).pipe(Effect.andThen(handler(event, ...args))),
    );
    yield* handlers.handleQuery("work:holds", () =>
      Effect.gen(function* () {
        const holds: import("../../../shared/work-application").ExecutionHold[] = [];
        let after: string | null = null;
        do {
          const result: import("../../core-client/types").ProjectWorkspaceReadSnapshot =
            yield* core.workspace.read(
              { kind: "execution_holds", after_key: after, limit: 100 },
              undefined,
              null,
            );
          if (result.value.kind !== "execution_holds")
            return yield* new WorkApplicationError({ message: "Invalid execution holds" });
          holds.push(...result.value.holds);
          after = result.value.next_key ?? null;
        } while (after);
        return holds;
      }),
    );
    yield* handlers.handleQuery("work:effective-hold", (_, target) => effectiveHolds(core, target));
    yield* handlers.handleLocalCommitCommand("work:set-hold", (_, input) =>
      Effect.gen(function* () {
        const parsed = setExecutionHoldInputSchema.safeParse(input);
        if (!parsed.success)
          return {
            ok: false as const,
            error: {
              code: "invalid_input" as const,
              message: "Pause requires a scope and operation identity",
              retryable: false,
              recovery: { kind: "none" as const },
            },
          };
        return yield* core.workspace
          .apply(
            {
              operationId: parsed.data.operationId,
              intent: {
                kind: parsed.data.paused ? "pause_work" : "resume_work",
                scope: parsed.data.scope,
              },
            },
            undefined,
            null,
          )
          .pipe(
            Effect.map((apply) => ({
              ok: true as const,
              value: undefined,
              localCommit: rendererLocalCommitApply(apply),
            })),
            Effect.catch((cause) => {
              const rejection = coreRejection(cause);
              return rejection
                ? Effect.succeed({ ok: false as const, error: rejection.coreError })
                : Effect.fail(new WorkApplicationError({ message: cause.message }));
            }),
          );
      }),
    );
    yield* handlers.handleQuery("work:turn", (_, pageId) =>
      core.workspace.read({ kind: "page_turn", page_id: pageId }, undefined, null).pipe(
        Effect.flatMap((read) =>
          read.value.kind === "page_turn"
            ? Effect.succeed({
                turn: read.value.turn,
                activeChat: read.value.active_chat ?? null,
                storeEpoch: read.store_epoch,
                commitSeq: read.commit_head,
              })
            : Effect.fail(new WorkApplicationError({ message: "Invalid Page Turn" })),
        ),
      ),
    );
    yield* handlers.handleQuery("work:workspace", (_, pageId) =>
      core.workspace
        .read({ kind: "page_workspace", page_id: pageId }, undefined, null)
        .pipe(
          Effect.flatMap((read) =>
            read.value.kind === "page_workspace"
              ? Effect.succeed(read.value)
              : Effect.fail(new WorkApplicationError({ message: "Invalid Page Workspace" })),
          ),
        ),
    );
    yield* handlers.handlePlainCommand("work:refresh-workspace", (_, pageId) =>
      runtime.refreshPageWorkspace(pageId),
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
    yield* handlers.handleLocalCommitCommand("work:accept", (_, input) =>
      Effect.gen(function* () {
        const parsed = acceptWorkInputSchema.safeParse(input);
        if (!parsed.success)
          return {
            ok: false as const,
            error: {
              code: "invalid_input" as const,
              message: "Accept requires a Page and operation identity",
              retryable: false,
              recovery: { kind: "none" as const },
            },
          };
        return yield* work.acceptWork(parsed.data).pipe(
          Effect.map(({ apply }) => ({
            ok: true as const,
            value: undefined,
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
