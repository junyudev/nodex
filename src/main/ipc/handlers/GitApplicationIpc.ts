import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  IpcControlChannel,
  IpcQueryChannel,
  PlainResultCommandChannel,
} from "../../../shared/ipc-endpoint-policy";
import { MainConfig } from "../../app/MainConfig";
import { GitActions } from "../../git-application/GitActions";
import { readGitRepositoryIdentity } from "../../git-repository-identity-service";
import {
  createGhPr,
  createGhPrComment,
  mergeGhPr,
  readGhCliStatus,
  readGhPrChecks,
  readGhPrComments,
  readGhPrDiff,
  readGhPrStatus,
  updateGhPr,
} from "../../github-pr-service";
import type { GitActionOperationRuntimeError } from "../../host-runtime/GitActionOperationRuntime";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class GitApplicationIpcError extends Schema.TaggedError<GitApplicationIpcError>()(
  "GitApplicationIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | GitActions | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const gitActions = yield* GitActions;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Git", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Git access requires an active Nodex window");
          }
        },
        catch: (cause) => new GitApplicationIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A>(operation: string, task: () => A | Promise<A>) =>
      Effect.tryPromise({
        try: () => Promise.resolve(task()),
        catch: (cause) => new GitApplicationIpcError({ operation, cause }),
      });
    const authorizedIpc = mapElectronIpcHandlers(
      ipc,
      (_channel, handler) =>
        (event, ...args) =>
          authorize(event).pipe(Effect.andThen(handler(event, ...args))),
    );
    const invokeQuery = <Channel extends IpcQueryChannel>(
      channel: Channel,
      task: (
        ...args: IpcApi[Channel]["args"]
      ) => IpcApi[Channel]["result"] | Promise<IpcApi[Channel]["result"]>,
    ) => authorizedIpc.handleQuery(channel, (_event, ...args) => run(channel, () => task(...args)));
    const invokePlainCommand = <Channel extends PlainResultCommandChannel>(
      channel: Channel,
      task: (
        ...args: IpcApi[Channel]["args"]
      ) => IpcApi[Channel]["result"] | Promise<IpcApi[Channel]["result"]>,
    ) =>
      authorizedIpc.handlePlainCommand(channel, (_event, ...args) =>
        run(channel, () => task(...args)),
      );
    const invokeEffectPlainCommand = <Channel extends PlainResultCommandChannel>(
      channel: Channel,
      task: (
        ...args: IpcApi[Channel]["args"]
      ) => Effect.Effect<IpcApi[Channel]["result"], GitActionOperationRuntimeError>,
    ) => authorizedIpc.handlePlainCommand(channel, (_event, ...args) => task(...args));
    const invokeEffectControl = <Channel extends IpcControlChannel>(
      channel: Channel,
      task: (
        ...args: IpcApi[Channel]["args"]
      ) => Effect.Effect<IpcApi[Channel]["result"], GitActionOperationRuntimeError>,
    ) => authorizedIpc.handleControl(channel, (_event, ...args) => task(...args));
    yield* invokeQuery("git:repository:identity", readGitRepositoryIdentity);
    yield* invokeEffectPlainCommand("git:action:commit-message:generate", (input) =>
      gitActions.generateCommitMessage(input),
    );
    yield* invokeEffectPlainCommand("git:action:pull-request-message:generate", (input) =>
      gitActions.generatePullRequestMessage(input),
    );
    yield* invokeEffectPlainCommand("git:action:commit", (input) => gitActions.commit(input));
    yield* invokeEffectPlainCommand("git:action:push", (input) => gitActions.push(input));
    yield* invokeEffectControl("git:action:cancel", (input) => gitActions.cancel(input));
    yield* invokeQuery("gh-cli-status", readGhCliStatus);
    yield* invokeQuery("gh-pr-status", readGhPrStatus);
    yield* invokeQuery("gh-pr-checks", readGhPrChecks);
    yield* invokeQuery("gh-pr-comments", readGhPrComments);
    yield* invokeQuery("gh-pr-diff", readGhPrDiff);
    yield* invokePlainCommand("gh-pr-comment", createGhPrComment);
    yield* invokePlainCommand("gh-pr-merge", mergeGhPr);
    yield* invokePlainCommand("gh-pr-update", updateGhPr);
    yield* invokePlainCommand("gh-pr-create", createGhPr);
  }),
);
