import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { NodexAccount } from "../../nodex-account/NodexAccount";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class NodexAccountIpcError extends Schema.TaggedError<NodexAccountIpcError>()(
  "NodexAccountIpcError",
  {},
) {}

/** Only the owned top-level application renderer receives account capabilities and public snapshots. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const account = yield* NodexAccount;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const trusted = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Nodex account", config.rendererUrl);
          if (!windows.has(event.sender.id)) throw new Error();
        },
        catch: () => new NodexAccountIpcError(),
      });
    yield* ipc.handleQuery("nodex-account:read", (event) =>
      trusted(event).pipe(Effect.andThen(account.read)),
    );
    yield* ipc.handlePlainCommand("nodex-account:sign-in", (event) =>
      trusted(event).pipe(Effect.andThen(account.signIn)),
    );
    yield* ipc.handlePlainCommand("nodex-account:cancel-sign-in", (event) =>
      trusted(event).pipe(Effect.andThen(account.cancelSignIn)),
    );
    yield* ipc.handlePlainCommand("nodex-account:sign-out", (event) =>
      trusted(event).pipe(Effect.andThen(account.signOut)),
    );
    yield* ipc.handlePlainCommand("nodex-account:refresh", (event) =>
      trusted(event).pipe(Effect.andThen(account.refresh)),
    );
    yield* account.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => {
          safeBroadcastToWindows(windows.all(), "nodex-account:changed", [snapshot]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
