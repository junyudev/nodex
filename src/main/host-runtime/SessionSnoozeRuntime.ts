import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { inboxSnoozeClock } from "../../host/InboxSnoozeClock";
import { DatabaseNotifierRuntime } from "./DatabaseNotifierRuntime";
import { make, snoozeOccurrence, snoozeTarget } from "../../host/SessionSnoozes";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { UserPresence } from "../../host/UserPresence";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createOperationId } from "../core-runtime/operation-identity";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { makeSetSessionUnread } from "../app-tools/NativeSessionTools";

export class SessionSnoozeRuntime extends Context.Service<
  SessionSnoozeRuntime,
  {
    readonly activate: Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/SessionSnoozeRuntime") {}

export const live = Layer.effect(
  SessionSnoozeRuntime,
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
          state.kind === "ready" ? workspace.nextSessionSnooze : Effect.succeed(null),
        ),
      ),
      consume: workspace.consumeSessionSnooze,
      // The desktop turns the chat unread itself, with its native Thread, before settling.
      complete: (sessionId, deliveryId) =>
        workspace.completeSessionSnooze(sessionId, deliveryId, false),
      defer: workspace.deferSessionSnooze,
      markUnread: (session) => setUnread(session, true, createOperationId("session.snooze.unread")),
      isPresented: (session) => presence.isSeen(snoozeTarget(session)),
      notify: (session, snoozedUntil, memberId) =>
        events.publish({
          kind: "threadNotification",
          value: snoozeOccurrence(session, snoozedUntil, memberId),
        }),
      changes: Stream.merge(
        events.events.pipe(Stream.filter((event) => event.kind === "sessionOrganizationChanged")),
        SubscriptionRef.changes(core.state),
      ),
    });
    const notifier = yield* DatabaseNotifierRuntime;
    const inboxSnoozes = yield* inboxSnoozeClock(
      SubscriptionRef.get(core.state).pipe(Effect.map((state) => state.kind === "ready")),
      Stream.merge(notifier.inboxInvalidations, SubscriptionRef.changes(core.state)),
    );
    yield* desktop.onPowerEvent("resume", Effect.andThen(owner.wake, inboxSnoozes.wake));
    return SessionSnoozeRuntime.of({ activate: owner.activate });
  }),
);
