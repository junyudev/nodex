import { ReadbackRuntime } from "../../host/ReadbackRuntime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { makeSessionReader } from "../../host/RuntimeNotificationSessions";
import { UserPresence } from "../../host/UserPresence";
import { readbackId, type ReadbackEvent, type ReadbackWithdrawReason } from "../../shared/readback";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { runtimeSideChatTabId } from "../../shared/side-chat-tab";
import type { AgentRuntimeActivityTransition } from "../agent-runtime/AgentRuntimeSessionActivity";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { resolveNotificationTargetClient } from "./notification-target";

interface HeldReadback {
  readonly clientId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly runId: string;
}

export { ReadbackRuntime } from "../../host/ReadbackRuntime";

const logger = getLogger({ component: "readback-runtime" });

/** Profile-scoped admission and withdrawal. Windows alone own card timers and actions. */
export const live = Layer.effect(
  ReadbackRuntime,
  Effect.gen(function* () {
    const spaceId = (yield* CoreAuthority).identity.libraryId;
    const settings = yield* ApplicationSettings;
    const presence = yield* UserPresence;
    const events = yield* CodexApplicationEventHub;
    const presentation = yield* CodexRendererPresentationRegistry;
    const windows = yield* WindowRuntime;
    const clients = yield* RendererClientRuntime;
    const readSession = yield* makeSessionReader;
    const lock = yield* Semaphore.make(1);
    const held = new Map<string, HeldReadback>();
    const send = (clientId: string, event: ReadbackEvent) =>
      clients.sendToClient(clientId, "readback:event", { ...event, spaceId });
    const withdraw = (id: string, record: HeldReadback, reason: ReadbackWithdrawReason) => {
      send(record.clientId, { type: "withdraw", id, reason });
      held.delete(id);
    };
    const foreground = (clientId: string) => {
      const webContentsId = clients.getWebContentsIdForClientId(clientId);
      const window = webContentsId === null ? null : windows.get(webContentsId);
      return (
        !!window &&
        !window.isDestroyed() &&
        window.isFocused() &&
        !window.isMinimized() &&
        presentation.hasForegroundClient()
      );
    };
    const suppress = (sessionId: string, runId: string, reason: string) =>
      logger.debug("Readback suppressed", { sessionId, runId, reason });
    const observe = Effect.fn("ReadbackRuntime.observe")(
      (transition: AgentRuntimeActivityTransition) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              const { sessionId, rootThreadId, before, after, endedRun } = transition;
              for (const [id, record] of held) {
                if (record.sessionId !== sessionId || record.runId !== endedRun?.runId) continue;
                if (!foreground(record.clientId)) withdraw(id, record, "ended");
              }
              const opening = after?.readback;
              if (
                !opening ||
                opening.runId !== after.activeRunId ||
                before?.readback?.runId === opening.runId
              )
                return;
              // Recovery reads update the activity baseline, but must never create a new interruption.
              if (transition.replay) {
                suppress(sessionId, opening.runId, "replay");
                return;
              }
              if (!opening.startedByPerson) {
                suppress(sessionId, opening.runId, "not-person-started");
                return;
              }
              const preferences = (yield* settings.snapshot()).notifications;
              if (!preferences.readbackEnabled) {
                suppress(sessionId, opening.runId, "disabled");
                return;
              }
              const session = yield* readSession(sessionId);
              if (!session || session.archived) {
                suppress(sessionId, opening.runId, "removed");
                return;
              }
              const source = session.sideChatSource;
              if (source && !source.rootThreadId) {
                suppress(sessionId, opening.runId, "unresolved-side-chat-source");
                return;
              }
              if (
                presence.isSeen({
                  hostId: DEFAULT_CODEX_HOST_ID,
                  conversationId: rootThreadId,
                  sessionId,
                })
              ) {
                suppress(sessionId, opening.runId, "seen");
                return;
              }
              const clientId = resolveNotificationTargetClient(
                rootThreadId,
                presentation,
                windows,
                clients,
              );
              if (!clientId) {
                suppress(sessionId, opening.runId, "no-live-target");
                return;
              }
              const id = readbackId(sessionId, opening.runId);
              const navigationSessionId = source?.sessionId ?? sessionId;
              const navigationThreadId = source?.rootThreadId ?? rootThreadId;
              const createdAt = yield* Clock.currentTimeMillis;
              if (
                !send(clientId, {
                  type: "show",
                  readback: {
                    id,
                    sessionId,
                    threadId: rootThreadId,
                    runId: opening.runId,
                    itemId: opening.itemId,
                    text: opening.text,
                    title: session.title ?? "",
                    createdAt,
                    navigation: {
                      hostId: DEFAULT_CODEX_HOST_ID,
                      conversationId: rootThreadId,
                      navigationPath: `session:${encodeURIComponent(navigationSessionId)}/thread:${encodeURIComponent(navigationThreadId)}`,
                      activateTabId: source ? runtimeSideChatTabId(sessionId) : null,
                    },
                  },
                })
              ) {
                suppress(sessionId, opening.runId, "target-unavailable");
                return;
              }
              for (const [previousId, record] of held)
                if (record.sessionId === sessionId) held.delete(previousId);
              held.set(id, {
                clientId,
                sessionId,
                conversationId: rootThreadId,
                runId: opening.runId,
              });
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                logger.warn("Readback observation failed", {
                  sessionId: transition.sessionId,
                  cause,
                }),
              ),
            ),
          ),
    );
    yield* events.events.pipe(
      Stream.runForEach((event) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              if (event.kind === "conversationSeen") {
                for (const [id, record] of held)
                  if (record.conversationId === event.value) withdraw(id, record, "seen");
                return;
              }
              if (event.kind !== "sessionOrganizationChanged") return;
              for (const [id, record] of held) {
                const session = yield* readSession(record.sessionId);
                if (!session || session.archived) withdraw(id, record, "removed");
              }
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => logger.warn("Readback withdrawal failed", { cause })),
            ),
          ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* settings.threadNotificationSettingsChanges.pipe(
      Stream.runForEach((value) =>
        lock.withPermit(
          Effect.sync(() => {
            if (value.readbackEnabled) return;
            for (const [id, record] of held) withdraw(id, record, "disabled");
          }),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* clients.events.pipe(
      Stream.runForEach((event) =>
        lock.withPermit(
          Effect.sync(() => {
            if (event.kind !== "disposed") return;
            for (const [id, record] of held)
              if (record.clientId === event.clientId) held.delete(id);
          }),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => held.clear()));
    return ReadbackRuntime.of({ observe });
  }),
);
