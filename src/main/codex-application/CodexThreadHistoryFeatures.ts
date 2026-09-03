import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  CodexThreadHistoryFeature,
  CodexThreadHistoryFeatureUnavailable,
} from "../../shared/codex-thread-history-features";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexThreadHistoryFeatureAvailable {
  readonly status: "available";
  readonly feature: CodexThreadHistoryFeature;
  readonly threadId: string;
  readonly historyMode: "paginated";
  readonly capability: CodexAppServerCapabilitySnapshot;
}

export type CodexThreadHistoryFeatureResolution =
  | CodexThreadHistoryFeatureAvailable
  | CodexThreadHistoryFeatureUnavailable;

export class CodexThreadHistoryFeaturesError extends Schema.TaggedError<CodexThreadHistoryFeaturesError>()(
  "CodexThreadHistoryFeaturesError",
  {
    threadId: Schema.String,
    feature: Schema.Literals(["prompt-rail", "persisted-search"]),
    reason: Schema.Literals(["conversation-missing", "request-failed", "stale-generation"]),
    cause: Schema.Defect(),
  },
) {}

export class CodexThreadHistoryFeatures extends Context.Service<
  CodexThreadHistoryFeatures,
  {
    readonly resolve: (
      threadId: string,
      feature: CodexThreadHistoryFeature,
    ) => Effect.Effect<CodexThreadHistoryFeatureResolution, CodexThreadHistoryFeaturesError>;
  }
>()("nodex/main/codex-application/CodexThreadHistoryFeatures") {}

const unavailableReason = (
  capability: CodexAppServerCapabilitySnapshot,
): CodexThreadHistoryFeatureUnavailable["reason"] =>
  capability.version === null || capability.version === "0.0.0"
    ? "capability-unproven"
    : "host-unsupported";

const supportsFeature = (
  capability: CodexAppServerCapabilitySnapshot,
  feature: CodexThreadHistoryFeature,
): boolean =>
  capability.flags.paginatedHistory &&
  (feature !== "persisted-search" || capability.flags.searchOccurrences);

export const make: Effect.Effect<
  CodexThreadHistoryFeatures["Service"],
  never,
  CodexAppServerCapabilities | ConversationEntityMap
> = Effect.gen(function* () {
  const capabilities = yield* CodexAppServerCapabilities;
  const conversations = yield* ConversationEntityMap;

  const resolve = Effect.fn("CodexThreadHistoryFeatures.resolve")(function* (
    threadId: string,
    feature: CodexThreadHistoryFeature,
  ) {
    const canonical = conversations.current(threadId)?.readCanonicalState() ?? null;
    if (!canonical) {
      return yield* new CodexThreadHistoryFeaturesError({
        threadId,
        feature,
        reason: "conversation-missing",
        cause: new Error("Persisted-history feature requires a canonical conversation"),
      });
    }

    const capability = yield* capabilities.forThread(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new CodexThreadHistoryFeaturesError({
            threadId,
            feature,
            reason: "request-failed",
            cause,
          }),
      ),
    );
    const current = yield* capabilities.isCurrent(capability).pipe(
      Effect.mapError(
        (cause) =>
          new CodexThreadHistoryFeaturesError({
            threadId,
            feature,
            reason: "request-failed",
            cause,
          }),
      ),
    );
    if (!current) {
      return yield* new CodexThreadHistoryFeaturesError({
        threadId,
        feature,
        reason: "stale-generation",
        cause: new Error("App-server generation changed while resolving persisted history"),
      });
    }

    const historyMode = canonical.protocol.historyMode;
    if (historyMode !== "paginated" || !supportsFeature(capability, feature)) {
      const resolution = {
        status: "unavailable" as const,
        feature,
        reason: historyMode === "legacy" ? "thread-history-legacy" : unavailableReason(capability),
        threadId,
        hostId: capability.hostId,
        hostGeneration: capability.generation,
        sourceEpoch: capability.sourceEpoch ?? null,
        appServerVersion: capability.version,
        historyMode,
      };
      yield* Effect.logDebug("Optional persisted Thread history feature is unavailable").pipe(
        Effect.annotateLogs({
          feature,
          reason: resolution.reason,
          threadId,
          hostId: capability.hostId,
          hostGeneration: capability.generation,
          sourceEpoch: capability.sourceEpoch ?? null,
          appServerVersion: capability.version,
          historyMode,
        }),
      );
      return resolution;
    }

    return {
      status: "available" as const,
      feature,
      threadId,
      historyMode,
      capability,
    };
  });

  return CodexThreadHistoryFeatures.of({ resolve });
});
