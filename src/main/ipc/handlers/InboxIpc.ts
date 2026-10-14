import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  IpcQueryChannel,
  PlainResultCommandChannel,
} from "../../../shared/ipc-endpoint-policy";
import { MainConfig } from "../../app/MainConfig";
import { InboxApplication, InboxApplicationError } from "../../inbox-application/InboxApplication";
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
    const command = <Channel extends PlainResultCommandChannel>(
      channel: Channel,
      task: Handler<Channel>,
    ) => invokeIpc.handlePlainCommand(channel, task);

    yield* query("inbox:summary", (_, input) => inbox.summary(input));
    yield* query("inbox:counts", () => inbox.counts);
    yield* query("inbox:window", (_, input) => inbox.window(input));
    yield* command("inbox:send", (_, input) => inbox.send(input));
    yield* command("inbox:confirm", (_, input) => inbox.confirm(input));
    yield* command("inbox:dispatch", (_, input) => inbox.dispatch(input));
    yield* command("inbox:keep", (_, input) => inbox.keep(input));
    yield* command("inbox:delete", (_, input) => inbox.delete(input));
    yield* command("inbox:set-state", (_, input) => inbox.setState(input));
    yield* command("inbox:set-kind", (_, input) => inbox.setKind(input));
    yield* command("inbox:request-suggestion", (_, input) => inbox.requestSuggestion(input));
    yield* command("inbox:retry-dispatch", (_, input) => inbox.retryDispatch(input));
  }),
);
