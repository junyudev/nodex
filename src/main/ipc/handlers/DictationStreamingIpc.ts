import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainEvent } from "electron";
import { DICTATION_STREAM_CONNECT_CHANNEL } from "../../../shared/dictation-stream-transport";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { CodexMedia } from "../../codex-application/CodexMedia";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { connectDictationStreamingRpc } from "../../platform/electron/DictationStreamingRpc";
import { ElectronSyncIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

/** Each trusted renderer attempt owns a port Scope, including pending auth and native socket work. */
export const live = (
  options: {
    readonly authorize?: typeof requireTrustedAppRendererSender;
    readonly connect?: typeof connectDictationStreamingRpc;
  } = {},
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const ipc = yield* ElectronSyncIpc;
      const config = yield* MainConfig;
      const windows = yield* WindowRuntime;
      const dictation = yield* DictationRuntime;
      const media = yield* CodexMedia;
      const callbacks = yield* ScopedCallbackRuntime;
      const scope = yield* Scope.Scope;
      const authorize = options.authorize ?? requireTrustedAppRendererSender;
      const connect = options.connect ?? connectDictationStreamingRpc;
      const attempts = new Map<number, Set<() => void>>();

      yield* ipc.on(DICTATION_STREAM_CONNECT_CHANNEL, (event: IpcMainEvent, ...args: unknown[]) => {
        const closePorts = (): void => {
          for (const port of event.ports) port.close();
        };
        try {
          authorize(event, "Dictation streaming connection", config.rendererUrl);
          if (args.length > 1 || (args.length === 1 && args[0] !== undefined))
            throw new Error("Dictation streaming accepts only a transferred port");
          if (event.ports.length !== 1) throw new Error("Dictation streaming requires one port");
          const global = dictation.ownsGlobalRenderer(event.sender.id);
          if (!global && !windows.has(event.sender.id)) throw new Error("Unknown Nodex window");
          const active = attempts.get(event.sender.id) ?? new Set<() => void>();
          const port = event.ports[0];
          if (!port) return;
          let child: Scope.Closeable | undefined;
          let connection: ReturnType<typeof connect> | undefined;
          let closed = false;
          const release = (): void => {
            if (closed) return;
            closed = true;
            active.delete(release);
            if (active.size === 0) attempts.delete(event.sender.id);
            event.sender.removeListener("destroyed", release);
            event.sender.removeListener("render-process-gone", release);
            event.sender.removeListener("did-start-navigation", navigation);
            port.removeListener("close", release);
            connection?.dispose();
            port.close();
            if (child) callbacks.fork(Scope.close(child, Exit.void));
          };
          const navigation = (
            _event: unknown,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
          ): void => {
            if (isMainFrame && !isInPlace) release();
          };
          attempts.set(event.sender.id, active);
          active.add(release);
          event.sender.once("destroyed", release);
          event.sender.once("render-process-gone", release);
          event.sender.on("did-start-navigation", navigation);
          port.once("close", release);
          const admitted = callbacks.fork(
            Effect.gen(function* () {
              child = yield* Scope.fork(scope, "sequential");
              yield* Scope.addFinalizer(child, Effect.sync(release));
              if (closed) return yield* Scope.close(child, Exit.void);
              yield* Effect.try(() => {
                connection = connect(
                  port,
                  media,
                  callbacks,
                  child!,
                  global ? "global" : "composer",
                );
              });
            }).pipe(Effect.catch(() => Effect.sync(release))),
          );
          if (admitted === null) release();
        } catch {
          closePorts();
        }
      });
    }),
  );
