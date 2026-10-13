import type {
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** Exact admitted native session incarnation and Run; never inferred from a reusable bearer. */
export interface HostTurnIdentity {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly nativeGeneration: number;
  readonly nativeThreadRef: OrchestrationV2ProviderThread["nativeThreadRef"];
  readonly cwd: string | null;
}

export class ExecutionHostError extends Schema.TaggedError<ExecutionHostError>()(
  "ExecutionHostError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** A host may admit a Turn and supply trusted CLI/skill context before native execution. */
export class ExecutionHost extends Context.Reference<{
  readonly registerNativeSession?: (identity: {
    readonly credentialId: string;
    readonly providerSessionId: ProviderSessionId;
    readonly nativeGeneration: number;
  }) => Effect.Effect<void, never, Scope.Scope>;
  /** Attached host toolsets; omitted by hosts that own the complete tool registry. */
  readonly toolAvailability?: { readonly browser: boolean; readonly device: boolean };
  readonly orchestrationInstructions?: string;
  readonly prepareTurn: (
    identity: HostTurnIdentity,
  ) => Effect.Effect<{ readonly instructions?: string }, ExecutionHostError>;
}>("@t3tools/provider-core/server/ExecutionHost", {
  defaultValue: () => ({ prepareTurn: () => Effect.succeed({}) }),
}) {}

/** Captured at authenticated MCP ingress; native and foreground identities cannot drift. */
export class McpTurnAdmission extends Context.Reference<{
  readonly actor: (HostTurnIdentity & { readonly runtimeId: string; readonly runtimeGeneration: string }) | undefined;
  readonly requestId: string | number | undefined;
  readonly assertCurrent: () => Effect.Effect<void, ExecutionHostError>;
} | undefined>("@t3tools/provider-core/server/McpTurnAdmission", { defaultValue: () => undefined }) {}
