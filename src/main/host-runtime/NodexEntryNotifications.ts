import {
  NotificationIntentPresentation,
  make as makeIntents,
  live as intentDelivery,
} from "../../host/NotificationIntents";
import { getMainIntl } from "../i18n/main-intl";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { MiniTurnRef } from "../../shared/mini";
import type { DesktopNotificationPayload, ThreadNotificationTurnMode } from "../../shared/types";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { MiniRuntime } from "../mini/MiniRuntime";
import { WorkbenchNotificationDelivery } from "./WorkbenchNotificationDelivery";

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
  presence: {
    readonly miniTurns?: readonly MiniTurnRef[];
    /** A Nodex window is focused. */
    foreground: boolean;
    /** The Turn's chat is in front of the person in a focused window. */
    seen: boolean;
  },
): DesktopNotificationPayload | null => {
  if (
    presence.miniTurns?.some(
      ({ pageId, episode }) => pageId === input.pageId && episode === input.episode,
    )
  )
    return null;
  if (
    input.blocking
      ? !requestEnabled || presence.seen
      : mode === "off" ||
        (mode === "background" && presence.foreground) ||
        (mode === "unseen" && presence.seen)
  )
    return null;
  return {
    id: JSON.stringify(["turn", input.spaceId, input.memberId, input.pageId, input.episode]),
    kind: "nodex",
    title: input.title,
    body: input.body,
    actions: [
      {
        id: "open",
        title: getMainIntl().formatMessage({
          id: "main.notification.inbox.open",
          defaultMessage: "Open",
        }),
        actionType: "open",
      },
    ],
  };
};
const makePresentation = (restingTurns: () => readonly MiniTurnRef[]) =>
  Effect.gen(function* () {
    const spaceId = (yield* CoreAuthority).identity.libraryId;
    const settings = yield* ApplicationSettings;
    const presentation = yield* CodexRendererPresentationRegistry;
    const delivery = yield* WorkbenchNotificationDelivery;
    const show = (payload: DesktopNotificationPayload, pageId: string, turnEpisode?: string) =>
      delivery.show(payload, spaceId, (action) => {
        if (action.actionType !== "open") return null;
        return {
          ...action,
          hostId: "local",
          conversationId: null,
          navigationPath: null,
          activateTabId: null,
          requestId: null,
          inboxEntry: { pageId, ...(turnEpisode ? { turnEpisode } : {}), scope: { kind: "all" } },
        };
      });
    return NotificationIntentPresentation.of({
      publishSnooze: (intent) =>
        Effect.gen(function* () {
          const { notifications: preferences } = yield* settings.snapshot().pipe(Effect.orDie);
          const payload = turnNotification(
            {
              spaceId,
              memberId: intent.member_id,
              pageId: intent.page_id,
              episode: intent.id,
              title: intent.title,
              body: getMainIntl().formatMessage({
                id: "main.notification.inbox.returned",
                defaultMessage: "Back in your Inbox",
              }),
              blocking: false,
            },
            preferences.turnMode,
            preferences.questionsEnabled,
            // A Page returning to the Inbox has no chat that could already be in view.
            { foreground: presentation.hasForegroundClient(), seen: false },
          );
          if (payload) yield* Effect.sync(() => show(payload, intent.page_id));
        }),
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
            {
              foreground: presentation.hasForegroundClient(),
              seen: presentation.isPresentedInForeground(row.turn?.active_chat?.thread_id ?? ""),
              miniTurns: restingTurns(),
            },
          );
          if (payload) yield* Effect.sync(() => show(payload, intent.page_id, intent.episode));
        }),
    });
  });

/** Mini shows the personal Space's work. Team Space Turns keep their own desktop delivery. */
export const presentation = Layer.effect(
  NotificationIntentPresentation,
  Effect.flatMap(MiniRuntime, (mini) => makePresentation(() => mini.restingCoverage().turns)),
);

const teamPresentation = Layer.effect(
  NotificationIntentPresentation,
  makePresentation(() => []),
);

/** Composes shared intent delivery with the Desktop presentation policy. */
export const make = makeIntents.pipe(Effect.provide(teamPresentation));

/** Desktop consumers deliver this Member’s intents through the OS presentation port. */
export const live = intentDelivery.pipe(Layer.provide(teamPresentation));
