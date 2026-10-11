import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { InboxSettings } from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";
import { ClaudeTextGeneration } from "../agent-backend/ClaudeTextGeneration";
import { MainConfig } from "../app/MainConfig";
import { CodexStructuredThreadTitle } from "../codex-application/CodexStructuredThreadTitle";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import type { CoreInboxDispatchContext } from "../core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { InboxApplication, InboxRuntimeError } from "./InboxApplication";
import {
  INBOX_SUGGESTION_BATCH,
  INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
  INBOX_SUGGESTION_OUTPUT_SCHEMA,
  INBOX_SUGGESTION_TIMEOUT_MS,
  InboxSuggestionOutput,
  buildInboxSuggestionPrompt,
  describeInboxRuntimeFailure,
  parseInboxSuggestionOutput,
  validateInboxSuggestions,
  type InboxSuggestionOutput as Output,
} from "./inbox-suggestions";

/** Captured messages often arrive in bursts; one batch lets the Agent group them. */
const SETTLE_DELAY_MS = 1_500;
const SAFETY_POLL = "60 seconds";
const MAX_BATCHES_PER_DRAIN = 8;
const CODEX_SUGGESTION_EFFORT = "medium";

const describeAgent = (settings: InboxSettings): string => {
  const runtime = settings.suggestionAgent.kind === "codex" ? "Codex" : "Claude";
  return settings.suggestionModel ? `${runtime} · ${settings.suggestionModel}` : runtime;
};

/**
 * Turns pending Inbox entries into dispatch suggestions. It holds no execution authority: its
 * only write is `ProposeInboxDispatch`, and every target is validated against Core context.
 */
export const live: Layer.Layer<
  never,
  never,
  | ApplicationSettings
  | ClaudeTextGeneration
  | CodexStructuredThreadTitle
  | DatabaseNotifierRuntime
  | InboxApplication
  | MainConfig
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbox = yield* InboxApplication;
    const settings = yield* ApplicationSettings;
    const codex = yield* CodexStructuredThreadTitle;
    const claude = yield* ClaudeTextGeneration;
    const notifier = yield* DatabaseNotifierRuntime;
    const config = yield* MainConfig;
    const logger = getLogger({ component: "inbox-dispatcher" });
    const lane = yield* Semaphore.make(1);

    const generate = (
      current: InboxSettings,
      prompt: string,
    ): Effect.Effect<Output | null, InboxRuntimeError> => {
      if (current.suggestionAgent.kind === "claude") {
        return claude
          .structured({
            instanceConfigId: current.suggestionAgent.instanceConfigId,
            cwd: config.nodexHome,
            prompt,
            schema: InboxSuggestionOutput,
            ...(current.suggestionModel ? { model: current.suggestionModel } : {}),
            effort: "low",
            maxOutputBytes: INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
            timeoutMs: INBOX_SUGGESTION_TIMEOUT_MS,
          })
          .pipe(Effect.mapError((error) => new InboxRuntimeError({ message: error.message })));
      }
      return codex
        .generateStructured({
          hostId: CODEX_APP_LOCAL_HOST_ID,
          prompt,
          cwd: null,
          threadSource: "inbox_dispatch_suggestion",
          outputSchema: INBOX_SUGGESTION_OUTPUT_SCHEMA as never,
          parseResult: parseInboxSuggestionOutput,
          ...(current.suggestionModel ? { model: current.suggestionModel } : {}),
          reasoningEffort: CODEX_SUGGESTION_EFFORT,
          maxOutputBytes: INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
          timeoutMs: INBOX_SUGGESTION_TIMEOUT_MS,
        })
        .pipe(Effect.mapError((error) => new InboxRuntimeError({ message: error.message })));
    };

    const suggestBatch = Effect.fn("InboxDispatcher.suggestBatch")(function* (
      current: InboxSettings,
    ) {
      const entries = yield* inbox.pendingSuggestions(INBOX_SUGGESTION_BATCH);
      if (entries.length === 0) return false;
      const pageIds = entries.map((entry) => entry.page_id);
      const outcome = yield* Effect.gen(function* () {
        const context: CoreInboxDispatchContext = yield* inbox.dispatchContext(pageIds);
        const output = yield* generate(
          current,
          buildInboxSuggestionPrompt({ context, instructions: current.instructions }),
        );
        if (!output) {
          return yield* new InboxRuntimeError({ message: "The Agent returned no suggestion" });
        }
        return validateInboxSuggestions(output, context, context.entries);
      }).pipe(Effect.result);

      if (outcome._tag === "Failure") {
        logger.info("Inbox suggestion failed", { error: outcome.failure.message });
        yield* inbox.recordSuggestionFailure(
          pageIds,
          describeInboxRuntimeFailure(outcome.failure.message, "suggestion"),
        );
        return true;
      }
      const basisByPage = new Map(entries.map((entry) => [entry.page_id, entry.basis]));
      // Naming happens first so each proposal is fenced by the Page as it will stay.
      for (const [pageId, title] of outcome.success.titles) {
        const basis = basisByPage.get(pageId);
        if (!basis) continue;
        const named = yield* inbox.nameEntry({ basis, title }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.info("Inbox message was not named", { error: error.message });
              return null;
            }),
          ),
        );
        if (named) basisByPage.set(pageId, named);
      }
      for (const suggestion of outcome.success.suggestions) {
        yield* inbox
          .propose({
            proposalId: createUuidV7(),
            pageIds: suggestion.pageIds,
            basis: suggestion.pageIds.flatMap((pageId) => {
              const basis = basisByPage.get(pageId);
              return basis ? [basis] : [];
            }),
            action: suggestion.action,
            kind: suggestion.kind,
            summary: suggestion.summary,
            rationale: suggestion.rationale,
            producedBy: describeAgent(current),
          })
          .pipe(
            // A message edited while the Agent was thinking stays pending for a fresh pass.
            Effect.catch((error) =>
              Effect.sync(() =>
                logger.info("Inbox suggestion was not recorded", { error: error.message }),
              ),
            ),
          );
      }
      if (outcome.success.unresolvedPageIds.length > 0) {
        yield* inbox.recordSuggestionFailure(
          outcome.success.unresolvedPageIds,
          "No valid suggestion was produced",
        );
      }
      return true;
    });

    const drain = lane.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* settings.snapshot();
        if (!snapshot.inbox.suggestionsEnabled) return;
        for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
          if (!(yield* suggestBatch(snapshot.inbox))) return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => logger.warn("Inbox suggestion pass failed", { cause })),
        ),
      ),
    );

    const triggers = Stream.merge(
      notifier.inboxInvalidations.pipe(
        Stream.filter((event) => event.reason === "inbox"),
        Stream.map(() => undefined),
      ),
      Stream.fromSchedule(Schedule.spaced(SAFETY_POLL)).pipe(Stream.map(() => undefined)),
    );
    yield* triggers.pipe(
      Stream.debounce(`${SETTLE_DELAY_MS} millis`),
      Stream.runForEach(() => drain),
      Effect.forkScoped,
    );
    yield* Effect.sleep(`${SETTLE_DELAY_MS} millis`).pipe(Effect.andThen(drain), Effect.forkScoped);
  }),
);
