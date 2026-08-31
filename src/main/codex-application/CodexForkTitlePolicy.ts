import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  resolveCodexForkChildThreadTitleFromCatalog,
  resolveCodexForkSourceConversationTitle,
  type CodexForkTitleThread,
} from "../../shared/codex-thread-title";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";

export interface CodexForkTitleSource {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly forkedFromId: string | null;
  readonly threadName: string | null;
  readonly canonical: CodexCanonicalConversationState;
  readonly pendingForks?: readonly CodexForkTitleThread[];
}

export interface CodexForkTitles {
  readonly sourceTitle: string | null;
  readonly childTitle: string | null;
}

export class CodexForkTitlePolicyError extends Data.TaggedError("CodexForkTitlePolicyError")<{
  readonly threadId: string;
  readonly cause: unknown;
}> {}

export class CodexForkTitlePolicy extends Context.Service<
  CodexForkTitlePolicy,
  {
    readonly derive: (
      source: CodexForkTitleSource,
    ) => Effect.Effect<CodexForkTitles, CodexForkTitlePolicyError>;
  }
>()("nodex/main/codex-application/CodexForkTitlePolicy") {}

/**
 * Fork titles are cosmetic. Their sibling scan must never turn a constant-time fork into an
 * unbounded Project traversal; an incomplete catalog simply leaves the child title unset.
 */
export const CODEX_FORK_TITLE_PAGE_SIZE = 200;
export const CODEX_FORK_TITLE_MAX_PAGES = 4;
export const CODEX_FORK_TITLE_MAX_RESULTS = 800;
export const CODEX_FORK_TITLE_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const CODEX_FORK_TITLE_MAX_RESULT_BYTES = 512 * 1024;
export const CODEX_FORK_TITLE_CATALOG_DEADLINE = "250 millis";

/** Derives one fork title against durable and pending siblings from the same source lineage. */
export const make: Effect.Effect<CodexForkTitlePolicy["Service"], never, CoreModules> = Effect.gen(
  function* () {
    const core = yield* CoreModules;

    const derive = Effect.fn("CodexForkTitlePolicy.derive")(function* (
      source: CodexForkTitleSource,
    ) {
      const sourceTitle = resolveCodexForkSourceConversationTitle({
        explicitTitle: source.threadName,
        firstTurnInput: source.canonical.turns[0]?.sidecar.params?.input,
        firstTurnCommentAttachments: source.canonical.turns[0]?.sidecar.params?.commentAttachments,
      });
      const scanCatalog = Effect.gen(function* () {
        const known: CodexForkTitleThread[] = [];
        const seenCursors = new Set<string>();
        let after: string | null = null;
        let knownBytes = 0;

        for (let page = 0; page < CODEX_FORK_TITLE_MAX_PAGES; page += 1) {
          const response = yield* core.workspace
            .read({
              kind: "task_window",
              project_id: source.projectId,
              include_archived: false,
              window: { after, first: CODEX_FORK_TITLE_PAGE_SIZE },
            })
            .pipe(Effect.timeoutOption(CODEX_FORK_TITLE_CATALOG_DEADLINE));
          if (Option.isNone(response)) return null;
          const snapshot: ProjectWorkspaceReadSnapshot = response.value;
          if (snapshot.value.kind !== "task_window") return null;
          const tasks = snapshot.value.tasks.items;
          if (
            tasks.length > CODEX_FORK_TITLE_PAGE_SIZE ||
            cappedApproximateValueBytes(tasks, CODEX_FORK_TITLE_MAX_PAGE_BYTES) >
              CODEX_FORK_TITLE_MAX_PAGE_BYTES
          ) {
            return null;
          }
          for (const task of tasks) {
            if (!task.thread) continue;
            const candidate: CodexForkTitleThread = {
              conversationId: task.thread.thread_id,
              forkedFromId: task.thread.forked_from_id ?? null,
              title: task.thread.thread_name ?? null,
            };
            if (known.length >= CODEX_FORK_TITLE_MAX_RESULTS) return null;
            const candidateBytes = cappedApproximateValueBytes(
              candidate,
              CODEX_FORK_TITLE_MAX_RESULT_BYTES - knownBytes,
            );
            if (candidateBytes > CODEX_FORK_TITLE_MAX_RESULT_BYTES - knownBytes) return null;
            known.push(candidate);
            knownBytes += candidateBytes;
          }
          const next: string | null = snapshot.value.tasks.next_cursor ?? null;
          if (!next) {
            return resolveCodexForkChildThreadTitleFromCatalog({
              source: {
                conversationId: source.threadId,
                forkedFromId: source.forkedFromId,
                title: source.threadName,
              },
              storedThreads: known,
              activeThreads: [],
              pendingForks: source.pendingForks ?? [],
            });
          }
          if (seenCursors.has(next)) return null;
          seenCursors.add(next);
          after = next;
        }
        return null;
      });
      const title = yield* scanCatalog.pipe(
        Effect.timeoutOption(CODEX_FORK_TITLE_CATALOG_DEADLINE),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      return { sourceTitle, childTitle: Option.isSome(title) ? title.value : null };
    });

    return CodexForkTitlePolicy.of({ derive });
  },
);
