import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  CoreLocalCommitCommandChannel,
  IpcQueryChannel,
} from "../../../shared/ipc-endpoint-policy";
import type { CoreLocalCommitResult } from "../../../shared/core-result";
import { MainConfig } from "../../app/MainConfig";
import { CoreModuleResponseError } from "../../core-client/core-client";
import { rendererLocalCommitApply } from "../../core-client/types";
import { CoreRuntimeError } from "../../core-runtime/CoreRuntimeError";
import { InboxApplication, InboxApplicationError } from "../../inbox-application/InboxApplication";
import type { ProjectWorkspaceCommandResult } from "../../project-application/ProjectWorkspace";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class InboxIpcError extends Schema.TaggedError<InboxIpcError>()("InboxIpcError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A Core rejection whose message is safe and useful to show, such as a changed suggestion. */
export class InboxCommandRejected extends Schema.TaggedError<InboxCommandRejected>()(
  "InboxCommandRejected",
  { message: Schema.String },
) {}

type Handler<Channel extends keyof IpcApi> = (
  event: IpcMainInvokeEvent,
  ...args: IpcApi[Channel]["args"]
) => Effect.Effect<IpcApi[Channel]["result"], unknown>;

const coreRejection = (cause: unknown): CoreModuleResponseError | null => {
  if (cause instanceof CoreModuleResponseError) return cause;
  if (Schema.is(InboxApplicationError)(cause) && cause.mayHaveCommitted) return null;
  if (cause instanceof InboxApplicationError || Schema.is(CoreRuntimeError)(cause))
    return coreRejection(cause.cause);
  return null;
};

/** Preserve the durable receipt and typed rejection across the renderer boundary. */
const committed = <Value>(
  task: Effect.Effect<ProjectWorkspaceCommandResult<Value>, InboxApplicationError>,
): Effect.Effect<CoreLocalCommitResult<Value>, InboxApplicationError> =>
  task.pipe(
    Effect.map(({ value, apply }) => ({
      ok: true as const,
      value,
      localCommit: rendererLocalCommitApply(apply),
    })),
    Effect.catch((cause) => {
      const rejection = coreRejection(cause);
      if (!rejection) return Effect.fail(cause);
      return Effect.succeed({ ok: false as const, error: rejection.coreError });
    }),
  );

/** Trusted-window ingress for the Inbox application Interface. */
export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | InboxApplication | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const inbox = yield* InboxApplication;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Inbox", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Inbox access requires an active Nodex window");
          }
        },
        catch: (cause) => new InboxIpcError({ operation: "authorize-renderer", cause }),
      });
    const invokeIpc = mapElectronIpcHandlers(
      ipc,
      (channel, task) =>
        (event, ...args) =>
          authorize(event).pipe(
            Effect.andThen(
              task(event, ...args).pipe(
                // Preserve Core's user-facing reason, such as a changed suggestion.
                Effect.mapError((cause) =>
                  cause instanceof InboxApplicationError
                    ? new InboxCommandRejected({ message: cause.message })
                    : new InboxIpcError({ operation: channel, cause }),
                ),
              ),
            ),
          ),
    );
    const query = <Channel extends IpcQueryChannel>(channel: Channel, task: Handler<Channel>) =>
      invokeIpc.handleQuery(channel, task);
    const command = <Channel extends CoreLocalCommitCommandChannel>(
      channel: Channel,
      task: Handler<Channel>,
    ) => invokeIpc.handleLocalCommitCommand(channel, task);

    yield* query("inbox:summary", (_, input) => inbox.summary(input));
    yield* query("inbox:counts", () => inbox.counts);
    yield* query("inbox:window", (_, input) => inbox.window(input));
    yield* query("inbox:prepare-confirmation", (_, input) => inbox.prepareConfirmation(input));
    yield* query("inbox:chat-targets", (_, input) => inbox.chatTargets(input));
    yield* command("inbox:send", (_, input) => committed(inbox.send(input)));
    yield* command("inbox:edit", (_, input) => committed(inbox.edit(input)));
    yield* command("inbox:confirm", (_, input) => committed(inbox.confirm(input)));
    yield* command("inbox:dispatch", (_, input) => committed(inbox.dispatch(input)));
    yield* command("inbox:keep", (_, input) => committed(inbox.keep(input)));
    yield* command("inbox:delete", (_, input) => committed(inbox.delete(input)));
    yield* command("inbox:set-state", (_, input) => committed(inbox.setState(input)));
    yield* command("inbox:set-kind", (_, input) => committed(inbox.setKind(input)));
    yield* command("inbox:set-important", (_, input) => committed(inbox.setImportant(input)));
    yield* command("inbox:request-suggestion", (_, input) =>
      committed(inbox.requestSuggestion(input)),
    );
    yield* command("inbox:retry-dispatch", (_, input) => committed(inbox.retryDispatch(input)));
    yield* command("inbox:undo", (_, input) => committed(inbox.undo(input)));
  }),
);
