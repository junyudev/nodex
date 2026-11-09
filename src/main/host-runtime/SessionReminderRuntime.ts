import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { make, reminderOccurrence, reminderTarget } from "../../host/SessionReminders";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { UserPresence } from "../../host/UserPresence";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createOperationId } from "../core-runtime/operation-identity";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export class SessionReminderRuntime extends Context.Service<
  SessionReminderRuntime,
  {
    readonly activate: Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/SessionReminderRuntime") {}

export const live = Layer.effect(
  SessionReminderRuntime,
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const core = yield* CoreAuthority;
    const events = yield* CodexApplicationEventHub;
    const presence = yield* UserPresence;
    const desktop = yield* ElectronDesktop;
    const setUnread = yield* makeSetSessionUnread;
    const owner = yield* make({
      next: SubscriptionRef.get(core.state).pipe(
        Effect.flatMap((state) =>
          state.kind === "ready" ? workspace.nextSessionReminder : Effect.succeed(null),
        ),
      ),
      consume: workspace.consumeSessionReminder,
      // The desktop turns the chat unread itself, with its native Thread, before settling.
      complete: (sessionId, deliveryId) =>
        workspace.completeSessionReminder(sessionId, deliveryId, false),
      defer: workspace.deferSessionReminder,
      markUnread: (session) =>
        setUnread(session, true, createOperationId("session.reminder.unread")),
      isPresented: (session) => presence.isSeen(reminderTarget(session)),
      notify: (session, remindAt, memberId) =>
        events.publish({
          kind: "threadNotification",
          value: reminderOccurrence(session, remindAt, memberId),
        }),
      changes: Stream.merge(
        events.events.pipe(Stream.filter((event) => event.kind === "sessionOrganizationChanged")),
        SubscriptionRef.changes(core.state),
      ),
    });
    yield* desktop.onPowerEvent("resume", owner.wake);
    return SessionReminderRuntime.of({ activate: owner.activate });
  }),
);
