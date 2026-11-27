import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { rpcError } from "../../../host/mobile/rpc";
import {
  MINI_COMPANION_METHODS,
  type MiniCompanionMethod,
  type MiniCompanionResult,
} from "../../../shared/mini";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { MainConfig } from "../../app/MainConfig";
import { MiniCompanion } from "../../mini/MiniCompanion";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime, type WindowRuntimeService } from "../../window-runtime/WindowRuntime";
import type { WindowRuntimeAuxiliaryRole } from "../../window-runtime/window-runtime-lifecycle";

const methods: ReadonlySet<string> = new Set(MINI_COMPANION_METHODS);

const hasMiniRole = (windows: Pick<WindowRuntimeService, "hasAuxiliaryRole">, senderId: number) =>
  (["mini", "capture"] as readonly WindowRuntimeAuxiliaryRole[]).some((role) =>
    windows.hasAuxiliaryRole(senderId, role),
  );

export const makeInvoke = (
  windows: Pick<WindowRuntimeService, "hasAuxiliaryRole">,
  rendererUrl: string | null,
  companion: MiniCompanion["Service"],
) =>
  Effect.fn("MiniCompanionIpc.invoke")(function* (
    event: IpcMainInvokeEvent,
    method: unknown,
    params: unknown,
  ): Effect.fn.Return<MiniCompanionResult> {
    const { sender, senderFrame } = event;
    const url = senderFrame?.url ?? "";
    if (
      sender.isDestroyed() ||
      rendererSpaceParameter(url) !== null ||
      !isTrustedAppRendererIpcSender({
        developmentOrigin: rendererUrl,
        hasOwnerWindow: hasMiniRole(windows, sender.id),
        senderType: sender.getType(),
        senderUrl: url,
        isMainFrame: senderFrame === sender.mainFrame,
      })
    )
      return { ok: false, error: rpcError("rejected", "This request requires the Mini panel.") };
    if (typeof method !== "string" || !methods.has(method))
      return { ok: false, error: rpcError("unknown_method", "This method is unavailable.") };
    return yield* companion.invoke(sender, method as MiniCompanionMethod, params).pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true, value }) as const,
        onFailure: (error) => ({ ok: false, error }) as const,
      }),
    );
  });

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const config = yield* MainConfig;
    const companion = yield* MiniCompanion;
    yield* ipc.handlePlainCommand(
      "mini:companion:invoke",
      makeInvoke(windows, config.rendererUrl, companion),
    );
  }),
);
