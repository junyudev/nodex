import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type {
  DesktopNotificationActionInvocation,
  DesktopNotificationActionPayload,
  DesktopNotificationPayload,
} from "../../shared/types";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { ApplicationWindowRuntime } from "../window-runtime/ApplicationWindowRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { resolveNotificationTargetClient } from "./notification-target";

export class WorkbenchNotificationDelivery extends Context.Service<
  WorkbenchNotificationDelivery,
  {
    readonly show: (
      notification: DesktopNotificationPayload,
      spaceId: string,
      resolveAction: (
        action: DesktopNotificationActionPayload,
      ) => DesktopNotificationActionInvocation | null,
    ) => void;
  }
>()("nodex/main/host-runtime/WorkbenchNotificationDelivery") {}

/** Native delivery is independent of Workbench. Only a person's action needs a renderer. */
export const live = Layer.effect(
  WorkbenchNotificationDelivery,
  Effect.gen(function* () {
    const application = yield* ApplicationWindowRuntime;
    const windows = yield* WindowRuntime;
    const clients = yield* RendererClientRuntime;
    const presentation = yield* CodexRendererPresentationRegistry;
    const native = yield* DesktopNotificationRuntime;
    const pending = new Map<number, DesktopNotificationActionInvocation[]>();
    let accepting = true;

    const flush = (webContentsId: number) => {
      if (!windows.isRendererInitialized(webContentsId)) return;
      const actions = pending.get(webContentsId);
      if (!actions) return;
      pending.delete(webContentsId);
      const clientId = clients.getClientIdForWebContentsId(webContentsId);
      if (!clientId) return;
      for (const action of actions)
        clients.sendToClient(clientId, "desktop-notification:action", action);
    };

    yield* application.rendererLoaded.pipe(
      Stream.runForEach((webContentsId) => Effect.sync(() => flush(webContentsId))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* windows.events.pipe(
      Stream.filter(({ kind }) => kind === "released"),
      Stream.runForEach(({ window }) => Effect.sync(() => pending.delete(window.webContentsId))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        accepting = false;
        pending.clear();
      }),
    );

    return WorkbenchNotificationDelivery.of({
      show: (notification, spaceId, resolveAction) => {
        const clientId = notification.conversationId
          ? resolveNotificationTargetClient(
              notification.conversationId,
              presentation,
              windows,
              clients,
            )
          : null;
        const webContentsId = clientId ? clients.getWebContentsIdForClientId(clientId) : null;
        const origin =
          (webContentsId === null ? null : windows.get(webContentsId)) ?? windows.getLastFocused();

        native.show(notification, origin?.webContents ?? null, (action) => {
          if (!accepting) return;
          const invocation = resolveAction(action);
          if (!invocation) return;
          const liveOrigin = origin && !origin.isDestroyed() ? origin : null;
          const target =
            liveOrigin ?? (action.actionType === "open" ? application.focusPersonal() : null);
          if (!target || target.isDestroyed()) return;
          if (liveOrigin && action.actionType === "open") {
            if (target.isMinimized()) target.restore();
            target.show();
            target.focus();
          }
          const targetId = target.webContents.id;
          const scoped = { ...invocation, spaceId };
          const queued = pending.get(targetId);
          if (queued) queued.push(scoped);
          else pending.set(targetId, [scoped]);
          flush(targetId);
        });
      },
    });
  }),
);
