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

/**
 * What a workspace's setup changed in its environment: variables it set and variables it
 * removed. A process started in that workspace applies both on top of its own environment.
 */
export interface HostWorkspaceEnvironment {
  readonly set: Readonly<Record<string, string>>;
  readonly exclude: readonly string[];
}

/**
 * The host's Desktop Tool runtime for a provider that connects MCP servers itself. The server is
 * launched exactly as given, because native tool peers verify its signed process ancestry.
 */
export interface HostDesktopTools {
  readonly server: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  /** Local plugin directories whose skills teach an agent to use the available tools. */
  readonly pluginRoots: readonly string[];
}

/** What a host contributes to a native thread as it starts, resumes or forks. */
export interface HostThreadPreparation {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly environment?: HostWorkspaceEnvironment;
  readonly desktopTools?: HostDesktopTools;
}

/** The environment with a workspace's setup changes applied. */
export const withWorkspaceEnvironment = (
  environment: NodeJS.ProcessEnv,
  workspace: HostWorkspaceEnvironment | undefined,
  isolateProviderCredentials = false,
): NodeJS.ProcessEnv => {
  if (workspace === undefined) return environment;
  const next = { ...environment };
  for (const name of workspace.exclude) delete next[name];
  const merged = { ...next, ...workspace.set };
  if (!isolateProviderCredentials) return merged;
  // Workspace setup can supply tools and project variables, but cannot redirect managed billing
  // or restore a native account home. Managed launch values remain authoritative.
  const reserved = (name: string) => /^(?:HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|XDG_CONFIG_HOME$|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|NODEX_GATEWAY_API_KEY$)/iu.test(name);
  return {
    ...Object.fromEntries(Object.entries(merged).filter(([name]) => !reserved(name))),
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => reserved(name))),
  };
};

export class ExecutionHostError extends Schema.TaggedError<ExecutionHostError>()(
  "ExecutionHostError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** A host may admit a Turn and supply trusted CLI/skill context before native execution. */
export class ExecutionHost extends Context.Reference<{
  /** Physical host generation fences persisted observations across process restarts. */
  readonly runtimeGeneration?: string;
  /** A product host adopts ordinary Sessions before their first Run is admitted. */
  readonly threadCreationOwner?: "host" | "execution";
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
  ) => Effect.Effect<
    {
      readonly instructions?: string;
      readonly identity?: HostTurnIdentity;
      /** Current Project Sources, resolved by the host after execution admission. */
      readonly sourceRoots?: readonly string[];
    },
    ExecutionHostError
  >;
  /**
   * Provider configuration the host contributes whenever a native thread starts, resumes or
   * forks, such as desktop tools that live outside the execution process, and the environment
   * its workspace setup prepared for the working directory.
   */
  readonly prepareThread?: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly nativeDriver: import("@t3tools/contracts").ProviderDriverKind;
    readonly cwd: string | null;
  }) => Effect.Effect<HostThreadPreparation, ExecutionHostError>;
  /** A host-owned native tool follows the provider's own Turns, which it addresses by native id. */
  readonly observeNativeTurn?: (input: {
    readonly identity: HostTurnIdentity;
    readonly nativeTurnId: string;
    readonly phase: "started" | "ended";
  }) => Effect.Effect<void>;
}>("@t3tools/provider-core/server/ExecutionHost", {
  defaultValue: () => ({ prepareTurn: () => Effect.succeed({}) }),
}) {}

/** Captured at authenticated MCP ingress; native execution identities cannot drift. */
export class McpTurnAdmission extends Context.Reference<{
  readonly actor: (HostExecutionIdentity & { readonly runtimeId: string; readonly runtimeGeneration: string; readonly nativeCallId?: string; readonly nativeCallKey?: string }) | undefined;
  readonly requestId: string | number | undefined;
  readonly assertCurrent: () => Effect.Effect<void, ExecutionHostError>;
  /** Completes when this captured execution is cancelled or its authority is replaced. */
  readonly awaitRevoked?: Effect.Effect<void>;
} | undefined>("@t3tools/provider-core/server/McpTurnAdmission", { defaultValue: () => undefined }) {}


/** Bind the actual tool handler, including work that outlives the provider's foreground call. */
export const withMcpTurnLifetime = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(McpTurnAdmission, (admission) => admission?.awaitRevoked === undefined
    ? effect
    : Effect.raceFirst(effect, admission.awaitRevoked.pipe(Effect.andThen(Effect.interrupt))));
