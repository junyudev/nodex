import { automationNotificationDecision } from "../../shared/automation-notification-policy";
import type { CodexHeartbeatDecision } from "../../shared/codex-turn-notification";
import { CodexHeartbeatTurnCompletion } from "./CodexHeartbeatTurnCompletion";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseCodexAutomationInboxItemDirective } from "../codex-scheduled-automation-runtime";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";

const BACKGROUND_CORE_REQUEST = { class: "background" } as const;

export class CodexAutomationTurnCompletion extends Context.Service<
  CodexAutomationTurnCompletion,
  {
    readonly complete: (
      threadId: string,
      turn: Turn,
    ) => Effect.Effect<CodexHeartbeatDecision | null>;
  }
>()("nodex/main/codex-application/CodexAutomationTurnCompletion") {}

const directive = (turn: Turn) => {
  const markdown = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage")
    ?.text.trim();
  return markdown ? parseCodexAutomationInboxItemDirective(markdown) : null;
};

/** Commits the terminal Turn consequence into the canonical Automation Run. */
export const live: Layer.Layer<
  CodexAutomationTurnCompletion,
  never,
  AutomationRoutingIndex | CodexApplicationEventHub | CoreModules | CodexHeartbeatTurnCompletion
> = Layer.effect(
  CodexAutomationTurnCompletion,
  Effect.gen(function* () {
    const routing = yield* AutomationRoutingIndex;
    const events = yield* CodexApplicationEventHub;
    const core = yield* CoreModules;
    const heartbeat = yield* CodexHeartbeatTurnCompletion;
    return CodexAutomationTurnCompletion.of({
      complete: (threadId, turn) =>
        Effect.gen(function* () {
          const heartbeatDecision = yield* heartbeat.notificationDecision(
            threadId,
            turn.id,
            turn.status,
          );
          if (heartbeatDecision !== null) return heartbeatDecision.decision;
          const snapshot = yield* core.automation.read(
            { kind: "run", thread_id: threadId },
            BACKGROUND_CORE_REQUEST,
          );
          if (snapshot.value.kind !== "run") {
            return yield* Effect.die(
              new Error("Core returned the wrong Automation Run read variant"),
            );
          }
          const current = snapshot.value.item;
          if (!current) return null;
          if (current.status !== "IN_PROGRESS" && current.status !== "PENDING_REVIEW") return null;
          const definition = yield* core.automation.read(
            { kind: "definition", automation_id: current.automation_id },
            BACKGROUND_CORE_REQUEST,
          );
          const decision = automationNotificationDecision(
            definition.value.kind === "definition"
              ? definition.value.item?.notification_policy
              : null,
            turn.status,
          );
          if (current.status !== "IN_PROGRESS") return decision;
          const inbox = directive(turn);
          return yield* Effect.gen(function* () {
            const committed = yield* core.automation.apply(
              {
                operationId: createOperationId("automation-turn.complete"),
                intent: {
                  kind: "complete_run_for_review",
                  thread_id: threadId,
                  expected_revision: current.run_revision,
                  inbox_title: inbox?.title ?? null,
                  inbox_summary: inbox?.summary ?? null,
                },
              },
              BACKGROUND_CORE_REQUEST,
            );
            const run = committed.outcome.runs.find(
              (candidate) => candidate.thread_id === threadId,
            );
            if (!run) {
              return yield* Effect.die(
                new Error("Core Automation completion omitted its updated Run"),
              );
            }
            routing.commit({ runs: { upsert: [run] } });
            events.publish({
              kind: "codex",
              value: {
                type: "automationRunsUpdated",
                event: {
                  automationId: run.automation_id,
                  threadId,
                  reason: "turn-completed",
                },
              },
            });
            return decision;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not commit Automation Run completion").pipe(
                Effect.annotateLogs({ cause, threadId, turnId: turn.id }),
                Effect.as(decision),
              ),
            ),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not complete Codex Automation Run").pipe(
              Effect.annotateLogs({ cause, threadId, turnId: turn.id }),
              Effect.as(null),
            ),
          ),
        ),
    });
  }),
);
