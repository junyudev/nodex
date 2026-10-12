import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  extractCodexThreadSubagentMetadata,
  hasCodexSubagentSource,
} from "../../shared/codex-subagent-metadata";
import {
  isInternalThreadSourceValue,
  parseThreadSourceValue,
} from "./CodexThreadCatalogProjection";

export type CodexInternalThreadKind = "structured-title" | "non-sidebar";

interface InternalThreadEntry {
  structuredTitleLeases: number;
  observedKind: CodexInternalThreadKind | null;
}

export class CodexInternalThreadRegistry extends Context.Service<
  CodexInternalThreadRegistry,
  {
    /** Suppresses a structured-title helper from request acceptance through its scoped release. */
    readonly leaseStructuredTitle: (threadId: string) => Effect.Effect<void, never, Scope.Scope>;
    /** Permanently classifies a protocol-started helper for the lifetime of that Thread. */
    readonly observeStarted: (thread: Thread) => CodexInternalThreadKind | null;
    readonly classification: (threadId: string) => CodexInternalThreadKind | null;
    readonly shouldSuppress: (threadId: string | null) => boolean;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexInternalThreadRegistry") {}

const normalizeThreadId = (threadId: string): string | null => {
  const normalized = threadId.trim();
  return normalized.length > 0 ? normalized : null;
};

const classifyStartedThread = (thread: Thread): CodexInternalThreadKind | null => {
  const threadSource = parseThreadSourceValue(thread.threadSource);
  if (thread.ephemeral && threadSource === "system") return "structured-title";
  if (thread.ephemeral && threadSource === "composer_predictions") return "non-sidebar";

  const subagent = extractCodexThreadSubagentMetadata(thread);
  if (subagent.parentThreadId) return null;
  return isInternalThreadSourceValue(threadSource) || hasCodexSubagentSource(thread.source)
    ? "non-sidebar"
    : null;
};

/** Owns internal helper identity independently of visible conversation projection. */
export const make: Effect.Effect<CodexInternalThreadRegistry["Service"], never, Scope.Scope> =
  Effect.gen(function* () {
    const entries = new Map<string, InternalThreadEntry>();

    const entry = (threadId: string): InternalThreadEntry => {
      const current = entries.get(threadId);
      if (current) return current;
      const created: InternalThreadEntry = { structuredTitleLeases: 0, observedKind: null };
      entries.set(threadId, created);
      return created;
    };

    const releaseStructuredTitle = (threadId: string): void => {
      const current = entries.get(threadId);
      if (!current) return;
      current.structuredTitleLeases = Math.max(0, current.structuredTitleLeases - 1);
      if (current.structuredTitleLeases === 0 && current.observedKind === null) {
        entries.delete(threadId);
      }
    };

    yield* Effect.addFinalizer(() => Effect.sync(() => entries.clear()));

    return CodexInternalThreadRegistry.of({
      leaseStructuredTitle: (rawThreadId) =>
        Effect.gen(function* () {
          const threadId = normalizeThreadId(rawThreadId);
          if (!threadId) return;
          entry(threadId).structuredTitleLeases += 1;
          yield* Effect.addFinalizer(() => Effect.sync(() => releaseStructuredTitle(threadId)));
        }),
      observeStarted: (thread) => {
        const threadId = normalizeThreadId(thread.id);
        if (!threadId) return null;
        const kind = classifyStartedThread(thread);
        if (kind) entry(threadId).observedKind = kind;
        return kind;
      },
      classification: (rawThreadId) => {
        const threadId = normalizeThreadId(rawThreadId);
        if (!threadId) return null;
        const current = entries.get(threadId);
        if (!current) return null;
        return (
          current.observedKind ?? (current.structuredTitleLeases > 0 ? "structured-title" : null)
        );
      },
      shouldSuppress: (rawThreadId) => {
        const threadId = rawThreadId ? normalizeThreadId(rawThreadId) : null;
        if (!threadId) return false;
        const current = entries.get(threadId);
        return Boolean(
          current && (current.structuredTitleLeases > 0 || current.observedKind !== null),
        );
      },
      clear: (rawThreadId) => {
        const threadId = normalizeThreadId(rawThreadId);
        if (threadId) entries.delete(threadId);
      },
    });
  });
