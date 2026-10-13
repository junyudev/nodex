import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexCreatedThreadResolveInput,
  CodexCreatedThreadResolution as Resolution,
} from "../../shared/codex-child-thread-summary";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { CodexThreadTargets, CodexThreadTargetError } from "./CodexThreadTargets";

const identifier = Schema.Trimmed.check(Schema.isMinLength(1));
const inputSchema = Schema.Union([
  Schema.Struct({ threadId: identifier, expectedHostId: Schema.optional(identifier) }),
  Schema.Struct({ clientThreadId: identifier, expectedHostId: Schema.optional(identifier) }),
]);

/** Pending readiness comes from the launch owner; persisted identities only supply coordinates. */
export class CodexCreatedThreadResolution extends Context.Service<
  CodexCreatedThreadResolution,
  {
    readonly read: (
      input: CodexCreatedThreadResolveInput,
    ) => Effect.Effect<Resolution | null, CodexThreadTargetError>;
  }
>()("nodex/main/codex-application/CodexCreatedThreadResolution") {}

export const make = Effect.gen(function* () {
  const targets = yield* CodexThreadTargets;
  const identity = yield* CodexClientThreadIdentity;
  const pending = yield* CodexPendingWorktreeRuntime;
  return CodexCreatedThreadResolution.of({
    read: Effect.fn("CodexCreatedThreadResolution.read")(function* (raw) {
      const input = yield* Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: "error" })(
        raw,
      ).pipe(Effect.mapError((cause) => new CodexThreadTargetError({ operation: "read", cause })));
      if ("threadId" in input)
        return yield* targets.resolveKnown(input.threadId, input.expectedHostId);
      const entries = pending
        .list()
        .filter(
          (candidate) =>
            candidate.launchMode !== "create-stable-worktree" &&
            candidate.clientThreadId === input.clientThreadId,
        );
      if (entries.length > 1) return null;
      const entry = entries[0];
      const pendingState = pending.resolveThread(input.clientThreadId);
      const forkSource =
        entry?.launchMode === "fork-conversation"
          ? yield* targets.resolveKnown(entry.sourceConversationId)
          : null;
      const pendingHostId =
        entry?.launchMode === "start-conversation"
          ? (entry.threadStartHostId ?? entry.hostId)
          : forkSource?.hostId;
      if (
        pendingHostId !== undefined &&
        input.expectedHostId !== undefined &&
        pendingHostId !== input.expectedHostId
      )
        return null;
      const candidates = yield* identity
        .candidates(input.clientThreadId, pendingHostId ?? input.expectedHostId)
        .pipe(Effect.mapError((cause) => new CodexThreadTargetError({ operation: "read", cause })));
      const admitted: Resolution[] = [];
      for (const candidate of candidates) {
        const resolved = yield* targets.resolveKnown(candidate.threadId, candidate.hostId);
        if (
          resolved &&
          !admitted.some(
            (value) => value.hostId === resolved.hostId && value.threadId === resolved.threadId,
          )
        )
          admitted.push(resolved);
      }
      if (admitted.length > 1) return null;
      const resolved = admitted[0];
      if (pendingState?.state === "succeeded" && resolved?.threadId !== pendingState.threadId)
        return null;
      const pendingWorktreeId =
        entry?.id ??
        (pendingState && "pendingWorktreeId" in pendingState
          ? pendingState.pendingWorktreeId
          : undefined);
      // A mapping published during a still-active launch must not open its incomplete route.
      if (entry || (pendingState && pendingState.state !== "succeeded"))
        return pendingHostId || resolved
          ? {
              hostId: pendingHostId ?? resolved!.hostId,
              threadId: resolved?.threadId ?? null,
              clientThreadId: input.clientThreadId,
              ...(pendingWorktreeId ? { pendingWorktreeId } : {}),
              ready: false,
              parentThreadId: resolved?.parentThreadId ?? null,
            }
          : null;
      return resolved ? { ...resolved, clientThreadId: input.clientThreadId } : null;
    }),
  });
});

export const live = Layer.effect(CodexCreatedThreadResolution, make);
