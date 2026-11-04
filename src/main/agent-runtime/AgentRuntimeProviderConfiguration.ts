import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type {
  AcpAgentConfigurationStatus,
  AcpAgentInstanceConfig,
} from "../../shared/acp-agent-settings";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
export type ProviderConfigurationResult = AgentRuntimeOperations["providers.configure"]["output"];

export function acpConfigurationStatus(
  instances: readonly Pick<AcpAgentInstanceConfig, "id" | "agentDefinitionId">[],
  result: ProviderConfigurationResult | null,
): AcpAgentConfigurationStatus {
  if (result === null) return { configurationStatus: "failed", deferredInstanceIds: [] };
  const deferred = new Set(result.deferredInstanceIds);
  const deferredInstanceIds = [
    ...new Set(
      instances
        .filter((instance) =>
          deferred.has(
            agentRuntimeProviderId({
              kind: "acp",
              agentDefinitionId: instance.agentDefinitionId,
              instanceConfigId: instance.id,
            })!,
          ),
        )
        .map(({ id }) => id),
    ),
  ];
  return {
    deferredInstanceIds,
    configurationStatus: deferredInstanceIds.length ? "deferred" : "applied",
  };
}

export class AgentRuntimeProviderConfigurationError extends Schema.TaggedError<AgentRuntimeProviderConfigurationError>()(
  "AgentRuntimeProviderConfigurationError",
  { cause: Schema.Defect() },
) {}

/** Refreshes a running engine; reading or saving settings never starts an idle engine. */
export class AgentRuntimeProviderConfiguration extends Context.Service<
  AgentRuntimeProviderConfiguration,
  {
    readonly refresh: Effect.Effect<
      ProviderConfigurationResult,
      AgentRuntimeProviderConfigurationError
    >;
  }
>()("nodex/main/agent-runtime/AgentRuntimeProviderConfiguration") {}

/** How long an account change waits for execution to confirm it dropped retired models. */
const MODEL_RETIREMENT_TIMEOUT = "30 seconds";

/**
 * Account changes wait here inside their uninterruptible lane, and credentials are released only
 * afterwards, so a silent process cannot hold sign-out open: retirement that execution does not
 * confirm in time stops the process instead. The refresh itself stays interruptible for the bound.
 */
export const confirmModelRetirement = <E, R, E2, R2>(input: {
  readonly refresh: Effect.Effect<unknown, E, R>;
  readonly stop: Effect.Effect<void, E2, R2>;
}): Effect.Effect<void, E2, R | R2> =>
  input.refresh.pipe(
    Effect.interruptible,
    Effect.timeout(MODEL_RETIREMENT_TIMEOUT),
    Effect.asVoid,
    Effect.catchCause(() => input.stop),
  );

/**
 * Applies changed provider settings to the execution process. A process that is starting read
 * its configuration before the change, so it is configured once it is ready rather than left
 * with the old providers; an idle process reads the new settings when it next starts.
 * Each refresh reads settings inside the same lane, so a slow older read cannot overwrite a newer save.
 */
export const makeProviderSettingsRefresh = <Connection, A, E, R>(input: {
  /** The current connection state followed by every transition. */
  readonly states: Stream.Stream<AgentRuntimeConnectionState>;
  /** A passive lookup; this boundary has no capability to launch a process. */
  readonly current: Effect.Effect<Connection | null>;
  readonly apply: (connection: Connection) => Effect.Effect<A, E, R>;
}): Effect.Effect<Effect.Effect<A | undefined, E, R>> =>
  Semaphore.make(1).pipe(
    Effect.map((lane) =>
      lane.withPermit(
        input.states.pipe(
          // Unresponsive is not excluded: its process may be healthy apart from one stuck read, and
          // a silent one simply holds this request until it answers or the bound above stops it.
          Stream.filter((state) => state.status !== "starting" && state.status !== "restarting"),
          Stream.runHead,
          Effect.flatMap((state) => (Option.isNone(state) ? Effect.succeed(null) : input.current)),
          Effect.flatMap((connection) =>
            connection === null ? Effect.succeed(undefined) : input.apply(connection),
          ),
        ),
      ),
    ),
  );
