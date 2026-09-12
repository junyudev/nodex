import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { IpcEvents } from "../../shared/ipc-api";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexFreshThreadLaunchRuntime } from "../codex-application/CodexFreshThreadLaunchRuntime";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { CodexUserInputAutoResolution } from "../codex-application/CodexUserInputAutoResolution";
import { safeBroadcastToWindows } from "../ipc-safe-send";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { codexRequestTraceCoordinator } from "../codex-runtime/CodexRequestTraceCoordinator";
import { codexRequestConversationId } from "../../shared/codex-request-lifecycle";
import { runMainTraceSpan } from "../observability/sentry-main";

export const live: Layer.Layer<
  never,
  never,
  | CodexApplicationEventHub
  | CodexFreshThreadLaunchRuntime
  | CodexRendererPresentationRegistry
  | CodexUserInputAutoResolution
  | RendererClientRuntime
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* CodexApplicationEventHub;
    const freshThreadLaunch = yield* CodexFreshThreadLaunchRuntime;
    const presentation = yield* CodexRendererPresentationRegistry;
    const rendererClients = yield* RendererClientRuntime;
    const userInputAutoResolution = yield* CodexUserInputAutoResolution;
    const windows = yield* WindowRuntime;
    const releasePresentation = Effect.fn("CodexRendererProjectionRuntime.releasePresentation")(
      function* (clientId: string) {
        const conversationIds = presentation.handleClientDisposed(clientId);
        freshThreadLaunch.releaseRenderer(
          clientId,
          new Error("Fresh thread renderer became unavailable"),
        );
        yield* Effect.forEach(
          conversationIds,
          (conversationId) => userInputAutoResolution.reevaluatePresentation(conversationId),
          { discard: true },
        );
      },
    );
    yield* userInputAutoResolution.changes.pipe(
      Stream.runForEach((change) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "codex:user-input:auto-resolution:changed", [
            change,
          ]),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* rendererClients.events.pipe(
      Stream.runForEach((event) =>
        event.kind === "connected"
          ? Effect.sync(() => presentation.handleClientConnected(event.clientId))
          : Effect.sync(() => codexRequestTraceCoordinator.dropWindow(event.webContentsId)).pipe(
              Effect.andThen(releasePresentation(event.clientId)),
            ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* windows.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.kind !== "renderer-changed") return;
          const clientId = rendererClients.getClientIdForWebContentsId(event.window.webContentsId);
          if (!clientId) return;
          if (event.reason !== "navigation-committed") yield* releasePresentation(clientId);
          if (event.window.rendererGeneration === null) return;
          presentation.handleClientConnected(clientId);
          presentation.setClientForegrounded(clientId, event.window.focused);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const broadcastWindows = <Channel extends keyof IpcEvents>(
      channel: Channel,
      payload: IpcEvents[Channel],
    ): void => {
      safeBroadcastToWindows(windows.all(), channel, [payload]);
    };
    yield* events.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.kind === "queuedMessageStateChanged") {
            rendererClients.broadcast("codex:event", { type: "queuedMessageStateChanged" });
            return;
          }
          if (event.kind === "codex") {
            rendererClients.broadcast("codex:event", event.value);
            if (event.value.type === "scheduledAutomationChanged") {
              broadcastWindows("codex:scheduled-automations:changed", event.value.event);
            }
            if (event.value.type === "automationRunsUpdated") {
              broadcastWindows("codex:automation-runs:updated", event.value.event);
            }
            return;
          }
          if (event.kind === "hostMessage") {
            if (event.value.type === "nativeNotification") {
              const physicalReceivedAtMs = event.value.receivedAtMs ?? Date.now();
              const delivery = codexRequestTraceCoordinator.takeNotificationDelivery(
                codexRequestConversationId(event.value.notification.params),
                event.value.notification.method,
                physicalReceivedAtMs,
              );
              const { receivedAtMs: _receivedAtMs, trace: _trace, ...baseMessage } = event.value;
              for (const clientId of rendererClients.getClientIds()) {
                const webContentsId = rendererClients.getWebContentsIdForClientId(clientId);
                const recipient =
                  webContentsId === null ? undefined : delivery?.recipients.get(webContentsId);
                if (!recipient) {
                  rendererClients.sendToClient(clientId, "codex:host-message", baseMessage);
                  continue;
                }
                runMainTraceSpan(
                  {
                    name: "electron.notification_delivery",
                    op: "codex.app_server.notification_delivery",
                    trace: recipient.link ? null : recipient.trace,
                    links: recipient.link ? [recipient.trace] : undefined,
                    root: recipient.link,
                    startTimeMs: physicalReceivedAtMs,
                    attributes: { "app_server.method": event.value.notification.method },
                  },
                  (activeTrace) =>
                    rendererClients.sendToClient(clientId, "codex:host-message", {
                      ...baseMessage,
                      receivedAtMs: Date.now(),
                      trace: activeTrace ?? recipient.trace,
                    }),
                );
              }
              return;
            }
            rendererClients.broadcast("codex:host-message", event.value);
            return;
          }
          if (event.kind === "pendingWorktreesChanged") {
            broadcastWindows("codex:pending-worktrees:changed", event.value);
            return;
          }
          if (event.kind === "pendingWorktreeWarning") {
            broadcastWindows("codex:pending-worktree:warning", event.value);
            return;
          }
          if (event.kind === "agentImportProgress") {
            broadcastWindows("agent-import:progress", event.value);
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
