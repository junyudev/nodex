import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";

const BACKGROUND_CORE_REQUEST = { class: "background" } as const;

export interface CodexAutomationInboxItem {
  readonly id: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly threadId: string | null;
}

export interface CodexAutomationInboxRequestIdentity {
  readonly occurrenceId: string;
  readonly occurrenceToken: number;
}

export class CodexAutomationInbox extends Context.Service<
  CodexAutomationInbox,
  {
    readonly create: (
      params: unknown,
      identity: CodexAutomationInboxRequestIdentity,
    ) => Effect.Effect<{ readonly items: readonly CodexAutomationInboxItem[] }>;
  }
>()("nodex/main/codex-application/CodexAutomationInbox") {}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const string = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

/**
 * Commits app-server Automation inbox directives directly into canonical Core state. One request
 * occurrence owns stable mutation identities, so replay cannot create a second semantic commit.
 */
export const live: Layer.Layer<
  CodexAutomationInbox,
  never,
  AutomationRoutingIndex | CodexApplicationEventHub | CoreModules
> = Layer.effect(
  CodexAutomationInbox,
  Effect.gen(function* () {
    const routing = yield* AutomationRoutingIndex;
    const events = yield* CodexApplicationEventHub;
    const core = yield* CoreModules;

    const commitItem = Effect.fn("CodexAutomationInbox.commitItem")(function* (
      item: CodexAutomationInboxItem,
      identity: CodexAutomationInboxRequestIdentity,
      index: number,
    ) {
      if (!item.threadId) return;
      const snapshot = yield* core.automation.read(
        { kind: "run", thread_id: item.threadId },
        BACKGROUND_CORE_REQUEST,
      );
      if (snapshot.value.kind !== "run") {
        return yield* Effect.die(new Error("Core returned the wrong Automation Run read variant"));
      }
      const current = snapshot.value.item;
      if (!current) return;
      const committed = yield* core.automation.apply(
        {
          operationId: `codex:inbox-item:${index}:${item.threadId}:${identity.occurrenceId}`,
          intent: {
            kind: "set_run_inbox_item",
            thread_id: item.threadId,
            expected_revision: current.run_revision,
            inbox_title: item.title,
            inbox_summary: item.description,
          },
        },
        BACKGROUND_CORE_REQUEST,
      );
      const run = committed.outcome.runs.find((candidate) => candidate.thread_id === item.threadId);
      if (!run) {
        return yield* Effect.die(new Error("Core Automation commit omitted its updated Run"));
      }
      routing.commit({ runs: { upsert: [run] } });
      events.publish({
        kind: "codex",
        value: {
          type: "automationRunsUpdated",
          event: {
            automationId: run.automation_id,
            threadId: run.thread_id,
            reason: "turn-completed",
          },
        },
      });
    });

    return CodexAutomationInbox.of({
      create: (params, identity) => {
        const payload = record(params);
        if (!payload || !Array.isArray(payload.items)) {
          return Effect.succeed({ items: [] });
        }
        const candidates = payload.items;
        const conversationId = string(payload.conversationId);
        const turnId = string(payload.turnId);
        const fallbackId = conversationId ?? turnId ?? `inbox-${identity.occurrenceToken}`;
        const items = candidates.flatMap((candidate, index) => {
          const input = record(candidate);
          if (!input) return [];
          const id =
            string(input.id) ?? (candidates.length > 1 ? `${fallbackId}-${index + 1}` : fallbackId);
          const description =
            string(input.description) ?? string(input.summary) ?? string(input.subtitle);
          return [
            {
              id,
              title: string(input.title),
              description,
              threadId: string(input.threadId) ?? conversationId ?? id,
            } satisfies CodexAutomationInboxItem,
          ];
        });
        return Effect.forEach(
          items,
          (item, index) =>
            commitItem(item, identity, index).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not commit Codex Automation inbox item").pipe(
                  Effect.annotateLogs({ cause, threadId: item.threadId }),
                ),
              ),
            ),
          { discard: true },
        ).pipe(Effect.as({ items }));
      },
    });
  }),
);
