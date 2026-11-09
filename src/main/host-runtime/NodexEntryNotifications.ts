import {
  NotificationIntentPresentation,
  make as makeIntents,
  live as intentDelivery,
} from "../../host/NotificationIntents";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopNotificationPayload, ThreadNotificationTurnMode } from "../../shared/types";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";

export const turnNotification = (
  input: {
    spaceId: string;
    memberId: string;
    pageId: string;
    episode: string;
    title: string;
    body: string;
    blocking: boolean;
  },
  mode: ThreadNotificationTurnMode,
  requestEnabled: boolean,
  foreground: boolean,
): DesktopNotificationPayload | null => {
  if (
    input.blocking
      ? !requestEnabled || foreground
      : mode === "off" || (mode === "unfocused" && foreground)
  )
    return null;
  return {
    id: JSON.stringify(["turn", input.spaceId, input.memberId, input.pageId, input.episode]),
    kind: "nodex",
    title: input.title,
    body: input.body,
    actions: [{ id: "open", title: "Open", actionType: "open" }],
  };
};
export const presentation = Layer.effect(
  NotificationIntentPresentation,
  Effect.gen(function* () {
    const spaceId = (yield* CoreAuthority).identity.libraryId;
    const settings = yield* ApplicationSettings;
    const presentation = yield* CodexRendererPresentationRegistry;
    const notifications = yield* DesktopNotificationRuntime;
    const windows = yield* WindowRuntime;
    const clients = yield* RendererClientRuntime;
    return {
      available: Effect.succeed(true),
      publish: (intent, row) =>
        Effect.gen(function* () {
          const preferences = (yield* settings.snapshot().pipe(Effect.orDie)).notifications;
          const payload = turnNotification(
            {
              spaceId,
              memberId: intent.member_id,
              pageId: intent.page_id,
              episode: intent.episode,
              title: row.title,
              body: row.body,
              blocking:
                row.turn?.turn.reason === "question" || row.turn?.turn.reason === "approval",
            },
            preferences.turnMode,
            preferences.questionsEnabled,
            row.turn?.turn.reason === "question" || row.turn?.turn.reason === "approval"
              ? presentation.isPresentedInForeground(row.turn.active_chat?.thread_id ?? "")
              : presentation.hasForegroundClient(),
          );
          const target = windows.getLastFocused();
          if (!payload || !target || target.isDestroyed()) return;
          const clientId = clients.getClientIdForWebContentsId(target.webContents.id);
          if (!clientId) return;
          yield* Effect.sync(() =>
            notifications.show(payload, target.webContents, (action) => {
              if (action.actionType !== "open" || target.isDestroyed()) return;
              if (target.isMinimized()) target.restore();
              target.show();
              target.focus();
              // The Inbox entry navigation owner falls back to the Page when the row has left.
              clients.sendToClient(clientId, "desktop-notification:action", {
                ...action,
                spaceId,
                hostId: "local",
                conversationId: null,
                navigationPath: null,
                activateTabId: null,
                requestId: null,
                inboxEntry: {
                  pageId: intent.page_id,
                  turnEpisode: intent.episode,
                  scope: { kind: "all" },
                },
              });
            }),
          );
        }),
    };
  }),
);

/** Composes shared intent delivery with the Desktop presentation policy. */
export const make = makeIntents.pipe(Effect.provide(presentation));

/** Desktop consumers deliver this Member’s intents through the OS presentation port. */
export const live = intentDelivery.pipe(Layer.provide(presentation));
