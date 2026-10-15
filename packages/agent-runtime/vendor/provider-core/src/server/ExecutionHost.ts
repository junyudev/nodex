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
  readonly nativeDriver?: import("@t3tools/contracts").ProviderDriverKind;
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

/** Providers without causal tool metadata expose their real Session incarnation, with no invented Run. */
export type HostNativeSessionIdentity = Omit<HostTurnIdentity, "runId" | "attemptId"> & {
  readonly source: "native-session";
  readonly runId: null;
  readonly attemptId: null;
  readonly incarnationId: string;
};
export type HostExecutionIdentity = HostTurnIdentity | HostNativeSessionIdentity;

export class ExecutionHostError extends Schema.TaggedError<ExecutionHostError>()(
  "ExecutionHostError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** Private account material, obtained anew from the configured account owner. */
export const ProviderAuthentication = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("api-key"), key: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("chatgpt"),
    accessToken: Schema.String,
    accountId: Schema.String,
    planType: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("external") }),
]);
export type ProviderAuthentication = typeof ProviderAuthentication.Type;

/** A host may admit a Turn and supply trusted CLI/skill context before native execution. */
export class ExecutionHost extends Context.Reference<{
  /** Physical host generation fences persisted observations across process restarts. */
  readonly runtimeGeneration?: string;
  /** A product host adopts ordinary Sessions before their first Run is admitted. */
  readonly threadCreationOwner?: "host" | "execution";
  readonly readProviderAuth?: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly refresh: boolean;
    readonly previousAccountId: string | null;
  }) => Effect.Effect<ProviderAuthentication, ExecutionHostError>;
  readonly registerNativeSession?: (identity: {
    readonly credentialId: string;
    readonly providerSessionId: ProviderSessionId;
    readonly nativeGeneration: number;
  }) => Effect.Effect<void, never, Scope.Scope>;
  /** Attached host toolsets; omitted by hosts that own the complete tool registry. */
  readonly toolAvailability?: { readonly browser: boolean; readonly device: boolean };
  readonly orchestrationInstructions?: string;
  readonly captureNativeToolCall?: (input: {
    readonly identity: HostTurnIdentity;
    readonly nativeCallId: string;
    readonly nativeThreadId?: string;
    readonly nativeTurnId?: string;
  }) => Effect.Effect<string, ExecutionHostError>;
  readonly releaseNativeToolCall?: (token: string) => Effect.Effect<void>;
  readonly prepareTurn: (
    identity: HostTurnIdentity,
  ) => Effect.Effect<{ readonly instructions?: string; readonly identity?: HostTurnIdentity }, ExecutionHostError>;
}>("@t3tools/provider-core/server/ExecutionHost", {
  defaultValue: () => ({ prepareTurn: () => Effect.succeed({}) }),
}) {}

/** Captured at authenticated MCP ingress; native execution identities cannot drift. */
export class McpTurnAdmission extends Context.Reference<{
  readonly actor: (HostExecutionIdentity & { readonly runtimeId: string; readonly runtimeGeneration: string; readonly nativeCallId?: string; readonly nativeCallKey?: string }) | undefined;
  readonly requestId: string | number | undefined;
  readonly assertCurrent: () => Effect.Effect<void, ExecutionHostError>;
} | undefined>("@t3tools/provider-core/server/McpTurnAdmission", { defaultValue: () => undefined }) {}
