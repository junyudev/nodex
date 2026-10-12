import { CLIENT_REQUEST_PARAMS } from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexHistoryTimelineReadInput,
  CodexHistoryTimelineReadPage,
} from "../../shared/codex-history-timeline-read";
import { isDevelopmentFeatureEnabled } from "../../shared/development-features";
import { MainConfig } from "../app/MainConfig";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { canUseCodexThreadTimeline } from "./CodexThreadTimelinePolicy";

const inputSchema = Schema.Struct({
  hostId: Schema.Trimmed.check(Schema.isMinLength(1)),
  hostGeneration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sourceEpoch: Schema.Trimmed.check(Schema.isMinLength(1)),
  params: CLIENT_REQUEST_PARAMS["thread/timeline/list"],
  options: Schema.optional(
    Schema.Struct({
      priority: Schema.optional(Schema.Literals(["background", "interactive", "critical"])),
      source: Schema.optional(Schema.String),
      timeoutMs: Schema.optional(
        Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      ),
      trace: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            traceparent: Schema.optional(Schema.NullOr(Schema.String)),
            tracestate: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});

export class CodexHistoryTimelineError extends Schema.TaggedError<CodexHistoryTimelineError>()(
  "CodexHistoryTimelineError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "unsupported-capability",
      "stale-generation",
      "request-failed",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class CodexHistoryTimelineAdapter extends Context.Service<
  CodexHistoryTimelineAdapter,
  {
    readonly read: (
      input: CodexHistoryTimelineReadInput,
    ) => Effect.Effect<CodexHistoryTimelineReadPage, CodexHistoryTimelineError>;
  }
>()("nodex/main/codex-application/CodexHistoryTimelineAdapter") {}

/** Main admits timeline reads from the actual Thread binding and negotiated host policy. */
export const live: Layer.Layer<
  CodexHistoryTimelineAdapter,
  never,
  CodexGateway | CodexAppServerCapabilities | MainConfig
> = Layer.effect(
  CodexHistoryTimelineAdapter,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const capabilities = yield* CodexAppServerCapabilities;
    const config = yield* MainConfig;

    const currentSnapshot = Effect.fn("CodexHistoryTimelineAdapter.currentSnapshot")(function* (
      input: CodexHistoryTimelineReadInput,
    ) {
      const snapshot = yield* capabilities
        .forThread(input.params.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexHistoryTimelineError({ reason: "request-failed", cause }),
          ),
        );
      if (
        snapshot.hostId !== input.hostId ||
        snapshot.generation !== input.hostGeneration ||
        snapshot.sourceEpoch !== input.sourceEpoch
      )
        return yield* new CodexHistoryTimelineError({
          reason: "stale-generation",
          cause: new Error("Timeline read belongs to an unavailable Thread host generation"),
        });
      return snapshot;
    });

    const assertCurrent = Effect.fn("CodexHistoryTimelineAdapter.assertCurrent")(function* (
      input: CodexHistoryTimelineReadInput,
      snapshot: CodexAppServerCapabilitySnapshot,
    ) {
      yield* currentSnapshot(input);
      const current = yield* capabilities
        .isCurrent(snapshot)
        .pipe(
          Effect.mapError(
            (cause) => new CodexHistoryTimelineError({ reason: "request-failed", cause }),
          ),
        );
      if (current) return;
      return yield* new CodexHistoryTimelineError({
        reason: "stale-generation",
        cause: new Error("Timeline host context retired during history read"),
      });
    });

    const read = Effect.fn("CodexHistoryTimelineAdapter.read")(function* (
      rawInput: CodexHistoryTimelineReadInput,
    ) {
      const input = yield* Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: "error" })(
        rawInput,
      ).pipe(
        Effect.mapError(
          (cause) => new CodexHistoryTimelineError({ reason: "invalid-input", cause }),
        ),
      );
      const snapshot = yield* currentSnapshot(input);
      if (
        !canUseCodexThreadTimeline(
          snapshot,
          isDevelopmentFeatureEnabled("thread-timeline-history", config.environment),
        )
      )
        return yield* new CodexHistoryTimelineError({
          reason: "unsupported-capability",
          cause: new Error("Thread timeline history is unavailable for this host policy"),
        });
      yield* assertCurrent(input, snapshot);
      const response = yield* gateway
        .requestForThread(input.params.threadId, "thread/timeline/list", input.params, {
          priority: input.options?.priority ?? "interactive",
          source: input.options?.source ?? "thread_hydration",
          timeoutMs: input.options?.timeoutMs,
          wireTrace: input.options?.trace,
          ...codexGatewayGenerationFence(snapshot),
        })
        .pipe(
          Effect.mapError(
            (cause) => new CodexHistoryTimelineError({ reason: "request-failed", cause }),
          ),
        );
      yield* assertCurrent(input, snapshot);
      return {
        threadId: input.params.threadId,
        hostId: snapshot.hostId,
        hostGeneration: snapshot.generation,
        sourceEpoch: input.sourceEpoch,
        response,
      } satisfies CodexHistoryTimelineReadPage;
    });
    return CodexHistoryTimelineAdapter.of({ read });
  }),
);
