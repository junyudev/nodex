import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type {
  CodexRealtimeVoiceStartSettings,
  CodexRealtimeVoiceTarget,
} from "../../shared/codex-realtime-voice";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { isCodexAppServerVersionAtLeast } from "../../shared/codex-app-server-version";
import { CodexMedia } from "./CodexMedia";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { RealtimeVoiceProductPolicy } from "../dictation/RealtimeVoicePolicyState";
import { resolveRealtimeVoiceStartSettings } from "./CodexRealtimeVoiceConfiguration";

export class CodexRealtimeVoicePolicyError extends Schema.TaggedError<CodexRealtimeVoicePolicyError>()(
  "CodexRealtimeVoicePolicyError",
  { reason: Schema.Literals(["unavailable", "changed"]), message: Schema.String },
) {}

export interface CodexPreparedRealtimeVoicePolicy extends CodexRealtimeVoiceTarget {
  readonly nativeStart: CodexRealtimeVoiceStartSettings;
  readonly bufferInputWhileConnecting: boolean;
  readonly productPolicy: RealtimeVoiceProductPolicy;
  readonly capabilities: CodexAppServerCapabilitySnapshot;
}

/** One account policy projection supplies startup settings and validates its captured revision. */
export class CodexRealtimeVoicePolicy extends Context.Service<
  CodexRealtimeVoicePolicy,
  {
    readonly changes: Stream.Stream<RealtimeVoiceProductPolicy>;
    readonly prepare: (
      target: CodexRealtimeVoiceTarget,
    ) => Effect.Effect<CodexPreparedRealtimeVoicePolicy, CodexRealtimeVoicePolicyError>;
    readonly assertCurrent: (
      prepared: CodexPreparedRealtimeVoicePolicy,
    ) => Effect.Effect<void, CodexRealtimeVoicePolicyError>;
    readonly isAvailable: (target: CodexRealtimeVoiceTarget) => Effect.Effect<boolean>;
  }
>()("nodex/main/codex-application/CodexRealtimeVoicePolicy") {}

const unavailable = () =>
  new CodexRealtimeVoicePolicyError({
    reason: "unavailable",
    message: "Voice is not available for this chat",
  });
const changed = () =>
  new CodexRealtimeVoicePolicyError({ reason: "changed", message: "Voice availability changed" });

/** Account and explicit-host inputs are observed independently and never default an unknown policy on. */
export const make = Effect.gen(function* () {
  const media = yield* CodexMedia;
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const entities = yield* ConversationEntityMap;
  const core = yield* CoreModules;
  const assertHost = Effect.fn("CodexRealtimeVoicePolicy.assertHost")(function* (
    target: CodexRealtimeVoiceTarget,
  ) {
    const canonical = entities.current(target.threadId)?.readCanonicalState();
    if (!canonical || canonical.hostId !== target.hostId) return yield* changed();
    const row = yield* core.workspace.read({ kind: "thread", thread_id: target.threadId }).pipe(
      Effect.flatMap((snapshot) =>
        snapshot.value.kind === "thread"
          ? Effect.succeed(snapshot.value.thread)
          : Effect.fail(changed()),
      ),
      Effect.catch((error) =>
        Schema.is(CoreRuntimeError)(error) &&
        error.cause instanceof CoreModuleResponseError &&
        error.cause.coreError.code === "not_found"
          ? Effect.succeed(null)
          : Effect.fail(changed()),
      ),
    );
    if (row && (row.backend_binding.kind !== "codex" || row.execution_host_id !== target.hostId))
      return yield* changed();
    if (entities.current(target.threadId)?.readCanonicalState()?.hostId !== target.hostId)
      return yield* changed();
    return canonical;
  });
  const featureEnabled = Effect.fn("CodexRealtimeVoicePolicy.featureEnabled")(function* (
    captured: CodexAppServerCapabilitySnapshot,
  ) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: ClientRequestResponsesByMethod["experimentalFeature/list"] = yield* gateway
        .requestOnHost(
          captured.hostId,
          "experimentalFeature/list",
          { cursor, limit: 100 },
          codexGatewayGenerationFence(captured),
        )
        .pipe(Effect.mapError(() => unavailable()));
      const feature = page.data.find((item) => item.name === "in_app_voice");
      if (feature) return feature.enabled !== false;
      cursor = page.nextCursor ?? null;
      if (cursor !== null && seen.has(cursor)) return yield* unavailable();
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return true;
  });
  const assertCurrent = Effect.fn("CodexRealtimeVoicePolicy.assertCurrent")(function* (
    prepared: CodexPreparedRealtimeVoicePolicy,
  ) {
    const product = yield* media.realtimeVoiceProductPolicy;
    if (
      product.status !== "ready" ||
      !product.entryPoint ||
      !product.accessAllowed ||
      product.accountId !== prepared.productPolicy.accountId ||
      product.userId !== prepared.productPolicy.userId
    )
      return yield* changed();
    if (
      !(yield* capabilities
        .isCurrent(prepared.capabilities)
        .pipe(Effect.orElseSucceed(() => false)))
    )
      return yield* changed();
    yield* assertHost(prepared);
    const after = yield* media.realtimeVoiceProductPolicy;
    if (
      after.status !== "ready" ||
      !after.entryPoint ||
      !after.accessAllowed ||
      after.accountId !== prepared.productPolicy.accountId ||
      after.userId !== prepared.productPolicy.userId
    )
      return yield* changed();
  });
  const prepare = Effect.fn("CodexRealtimeVoicePolicy.prepare")(function* (
    target: CodexRealtimeVoiceTarget,
  ) {
    const product = yield* media.realtimeVoiceProductPolicy;
    if (product.status !== "ready" || !product.entryPoint || !product.accessAllowed)
      return yield* unavailable();
    const canonical = yield* assertHost(target);
    if (
      canonical.threadSource !== "realtime_voice" &&
      product.config.existing_thread_voice_enabled !== true
    )
      return yield* unavailable();
    const captured = yield* capabilities
      .forHost(target.hostId)
      .pipe(Effect.mapError(() => unavailable()));
    if (
      !captured.version ||
      captured.version === "0.0.0" ||
      !isCodexAppServerVersionAtLeast(captured.version, "0.147.0-alpha.6")
    )
      return yield* unavailable();
    if (
      target.hostId === "durable" ||
      (product.clientOwnedCall &&
        isCodexAppServerVersionAtLeast(captured.version, "0.150.0-alpha.3"))
    )
      return yield* unavailable();
    if (!(yield* featureEnabled(captured))) return yield* unavailable();
    if (target.hostId !== gateway.localHostId) {
      const local = yield* capabilities
        .forHost(gateway.localHostId)
        .pipe(Effect.mapError(() => unavailable()));
      if (!(yield* featureEnabled(local))) return yield* unavailable();
    }
    const prepared: CodexPreparedRealtimeVoicePolicy = {
      ...target,
      productPolicy: product,
      capabilities: captured,
      nativeStart: resolveRealtimeVoiceStartSettings(product),
      bufferInputWhileConnecting: true,
    };
    yield* assertCurrent(prepared);
    return prepared;
  });
  return CodexRealtimeVoicePolicy.of({
    changes: media.realtimeVoicePolicyChanges,
    prepare,
    assertCurrent,
    isAvailable: (target) =>
      prepare(target).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
  });
});

export const live = Layer.effect(CodexRealtimeVoicePolicy, make);
