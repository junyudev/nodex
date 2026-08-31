import type { ServerNotification as CodexServerNotification } from "@nodex/codex-app-server-protocol";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type {
  CodexBackgroundSubagentThreadsHydrateInput,
  CodexSubagentPanelHydrateInput,
  CodexThreadSummary,
} from "../../shared/types";
import { CodexConversationRelationships } from "./CodexConversationRelationships";
import {
  CODEX_SUBAGENT_DISCOVERY_MAX_REQUEST_IDS,
  CODEX_SUBAGENT_DISCOVERY_MAX_RESULTS,
  CodexThreadDirectory,
} from "./CodexThreadDirectory";

const BACKGROUND_DELTA_METHODS = new Set<CodexServerNotification["method"]>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
] satisfies readonly CodexServerNotification["method"][]);

/** Bounded LRU metadata is enough to decide whether a background delta needs projection. */
export const CODEX_SUBAGENT_CATALOG_MAX_ENTRIES = CODEX_SUBAGENT_DISCOVERY_MAX_RESULTS;

export class CodexSubagentCatalogError extends Data.TaggedError("CodexSubagentCatalogError")<{
  readonly operation: "discover" | "hydrate";
  readonly cause: unknown;
}> {}

export class CodexSubagentCatalog extends Context.Service<
  CodexSubagentCatalog,
  {
    readonly hydrateBackground: (
      input: CodexBackgroundSubagentThreadsHydrateInput,
    ) => Effect.Effect<readonly CodexThreadSummary[], CodexSubagentCatalogError>;
    readonly hydratePanel: (
      input: CodexSubagentPanelHydrateInput,
    ) => Effect.Effect<readonly CodexThreadSummary[], CodexSubagentCatalogError>;
    readonly open: (threadId: string) => Effect.Effect<boolean>;
    readonly observe: (threadId: string) => void;
    readonly shouldDropDelta: (
      method: CodexServerNotification["method"],
      threadId: string | null,
    ) => boolean;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexSubagentCatalog") {}

const normalizeIds = (
  threadIds: readonly string[],
): { readonly ids: readonly string[]; readonly overflowed: boolean } => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawThreadId of threadIds) {
    const threadId = rawThreadId.trim();
    if (!threadId || seen.has(threadId)) continue;
    if (ids.length >= CODEX_SUBAGENT_DISCOVERY_MAX_REQUEST_IDS) {
      return { ids, overflowed: true };
    }
    seen.add(threadId);
    ids.push(threadId);
  }
  return { ids, overflowed: false };
};

export const make: Effect.Effect<
  CodexSubagentCatalog["Service"],
  never,
  CodexConversationRelationships | CodexThreadDirectory | Scope.Scope
> = Effect.gen(function* () {
  const relationships = yield* CodexConversationRelationships;
  const directory = yield* CodexThreadDirectory;
  const ownerScope = yield* Scope.Scope;
  /** `true` means a tail is hydrated; `false` means drop noisy background deltas for this child. */
  const known = new Map<string, boolean>();

  const rememberThread = (threadId: string, tailHydrated: boolean): boolean => {
    const normalized = threadId.trim();
    if (!normalized) return false;
    const existing = known.get(normalized) ?? false;
    known.delete(normalized);
    while (known.size >= CODEX_SUBAGENT_CATALOG_MAX_ENTRIES) {
      const oldest = known.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      known.delete(oldest);
    }
    known.set(normalized, existing || tailHydrated);
    return true;
  };

  const refreshRelationships = (rootThreadId: string): Effect.Effect<void> =>
    relationships.refresh(rootThreadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not refresh Codex conversation relationships").pipe(
          Effect.annotateLogs({ rootThreadId, cause }),
        ),
      ),
      Effect.asVoid,
    );

  const runOwned = <A>(
    operation: Effect.Effect<A, CodexSubagentCatalogError>,
  ): Effect.Effect<A, CodexSubagentCatalogError> =>
    Effect.acquireUseRelease(
      operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
      Fiber.join,
      Fiber.interrupt,
    );

  const observe = (threadId: string): void => {
    rememberThread(threadId, false);
  };

  const remember = (summaries: readonly CodexThreadSummary[], withTail: boolean) => {
    for (const summary of summaries) {
      rememberThread(summary.threadId, withTail);
    }
    return summaries;
  };

  const hydrateBackground = (
    input: CodexBackgroundSubagentThreadsHydrateInput,
  ): Effect.Effect<readonly CodexThreadSummary[], CodexSubagentCatalogError> =>
    runOwned(
      Effect.gen(function* () {
        const threadIds = normalizeIds(input.threadIds);
        if (threadIds.overflowed) {
          return yield* new CodexSubagentCatalogError({
            operation: "hydrate",
            cause: new Error(
              `Subagent hydration exceeds its ${CODEX_SUBAGENT_DISCOVERY_MAX_REQUEST_IDS}-Thread budget`,
            ),
          });
        }
        return yield* directory
          .descendants({
            rootThreadId: input.rootThreadId,
            threadIds: threadIds.ids,
            fidelity: input.includeTail === true ? "tail" : "metadata",
          })
          .pipe(
            Effect.map((entries) =>
              remember(
                entries.map((entry) => entry.summary),
                input.includeTail === true,
              ),
            ),
            Effect.tap(() => refreshRelationships(input.rootThreadId)),
            Effect.mapError(
              (cause) => new CodexSubagentCatalogError({ operation: "hydrate", cause }),
            ),
          );
      }),
    );

  const hydratePanel = (
    input: CodexSubagentPanelHydrateInput,
  ): Effect.Effect<readonly CodexThreadSummary[], CodexSubagentCatalogError> =>
    runOwned(
      Effect.gen(function* () {
        const threadIds = normalizeIds(input.threadIds ?? []);
        if (threadIds.overflowed) {
          return yield* new CodexSubagentCatalogError({
            operation: "discover",
            cause: new Error(
              `Subagent panel hydration exceeds its ${CODEX_SUBAGENT_DISCOVERY_MAX_REQUEST_IDS}-Thread budget`,
            ),
          });
        }
        return yield* directory
          .descendants({
            rootThreadId: input.rootThreadId,
            ...(input.threadIds === undefined ? {} : { threadIds: threadIds.ids }),
            fidelity: input.includeTail === true ? "tail" : "metadata",
          })
          .pipe(
            Effect.map((entries) =>
              remember(
                entries.map((entry) => entry.summary),
                input.includeTail === true,
              ),
            ),
            Effect.tap(() => refreshRelationships(input.rootThreadId)),
            Effect.mapError(
              (cause) => new CodexSubagentCatalogError({ operation: "discover", cause }),
            ),
          );
      }),
    );

  const clear = (threadId: string): void => {
    const normalized = threadId.trim();
    if (!normalized) return;
    known.delete(normalized);
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      known.clear();
    }),
  );

  return CodexSubagentCatalog.of({
    hydrateBackground,
    hydratePanel,
    open: (threadId) =>
      Effect.sync(() => {
        return rememberThread(threadId, true);
      }),
    observe,
    shouldDropDelta: (method, threadId) => {
      const normalized = threadId?.trim() ?? "";
      return (
        normalized.length > 0 &&
        BACKGROUND_DELTA_METHODS.has(method) &&
        known.get(normalized) === false
      );
    },
    clear,
  });
});
