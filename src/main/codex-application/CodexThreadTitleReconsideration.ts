import { extractCodexThreadSpawnMetadata } from "../../shared/codex-subagent-metadata";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { CodexStructuredThreadTitle } from "./CodexStructuredThreadTitle";
import { CodexThreadDescriptionPersistence } from "./CodexThreadDescriptionPersistence";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const THREAD_PURPOSE_CHANGED_SIGNAL = "::thread-purpose-changed{}";

interface ReconsiderationSignalState {
  readonly count: number;
  readonly ready: boolean;
}

export interface CodexThreadTitleReconsiderationObservation {
  readonly hostId: string;
  readonly threadId: string;
  readonly lastAgentMessage: string | null;
  readonly hasPendingContinuation: boolean;
}

export class CodexThreadTitleReconsideration extends Context.Service<
  CodexThreadTitleReconsideration,
  {
    readonly observe: (input: CodexThreadTitleReconsiderationObservation) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexThreadTitleReconsideration") {}

export function hasCodexThreadPurposeChangedSignal(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.split(/\r?\n/u).some((line) => line.trim() === THREAD_PURPOSE_CHANGED_SIGNAL);
}

export const make: Effect.Effect<
  CodexThreadTitleReconsideration["Service"],
  never,
  | CodexStructuredThreadTitle
  | CodexThreadDescriptionPersistence
  | CodexThreadTitlePersistence
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const structuredTitle = yield* CodexStructuredThreadTitle;
  const descriptions = yield* CodexThreadDescriptionPersistence;
  const titles = yield* CodexThreadTitlePersistence;
  const conversations = yield* ConversationEntityMap;
  const ownerScope = yield* Effect.scope;
  const signals = new Map<string, ReconsiderationSignalState>();

  const run = (input: CodexThreadTitleReconsiderationObservation) =>
    Effect.gen(function* () {
      const aggregate = conversations.current(input.threadId);
      const canonical = aggregate?.readCanonicalState();
      const snapshot = aggregate?.readSnapshot();
      if (!canonical || !snapshot || snapshot.ephemeral === true) return;
      if (extractCodexThreadSpawnMetadata(snapshot.source).parentThreadId) return;

      const currentTitle = canonical.title?.trim() ?? "";
      const generatedTitle = canonical.generatedTitle?.trim() ?? "";
      if (!currentTitle || generatedTitle !== currentTitle) return;

      const metadata = yield* structuredTitle.reconsiderTitle({
        hostId: input.hostId,
        sourceThreadId: input.threadId,
        currentTitle,
        cwd: canonical.cwd?.trim() || snapshot.cwd?.trim() || null,
        ...(snapshot.serviceName?.trim() ? { serviceName: snapshot.serviceName.trim() } : {}),
      });
      if (!metadata) return;

      const committed = yield* titles.set({
        threadId: input.threadId,
        name: metadata.title,
        normalization: "trim",
        expectedName: currentTitle,
        generated: true,
      });
      if (!committed || !metadata.description) return;
      yield* descriptions.set({
        threadId: input.threadId,
        description: metadata.description,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Automatic Thread title reconsideration failed").pipe(
          Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
        ),
      ),
    );

  const observe = (input: CodexThreadTitleReconsiderationObservation): Effect.Effect<void> =>
    Effect.sync(() => {
      const previous = signals.get(input.threadId) ?? { count: 0, ready: false };
      const signaled = hasCodexThreadPurposeChangedSignal(input.lastAgentMessage);

      if (!previous.ready && !signaled) {
        signals.delete(input.threadId);
        return false;
      }

      const count = previous.ready ? previous.count : Math.min(2, previous.count + 1);
      const ready = previous.ready || count >= 2;
      signals.set(input.threadId, { count, ready });
      if (!ready || input.hasPendingContinuation) return false;

      signals.delete(input.threadId);
      return true;
    }).pipe(
      Effect.flatMap((shouldRun) =>
        shouldRun
          ? Effect.forkIn(run(input), ownerScope, { startImmediately: true }).pipe(Effect.asVoid)
          : Effect.void,
      ),
    );

  return CodexThreadTitleReconsideration.of({ observe });
});
