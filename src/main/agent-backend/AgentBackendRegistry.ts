import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ACP_AGENT_DEFINITIONS,
  type AcpAgentDefinitionId,
} from "../../shared/acp-agent-definitions";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AcpAgentInstanceConfig } from "../../shared/types";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";

type SupportedAcpAgentDefinition = (typeof ACP_AGENT_DEFINITIONS)[number];

export type AgentBackendResolution =
  | {
      readonly kind: "codex";
      readonly binding: Extract<AgentBackendBinding, { readonly kind: "codex" }>;
      readonly displayName: "Codex";
    }
  | {
      readonly kind: "acp";
      readonly binding: {
        readonly kind: "acp";
        readonly agentDefinitionId: AcpAgentDefinitionId;
        readonly instanceConfigId: string;
      };
      readonly displayName: string;
      readonly definition: SupportedAcpAgentDefinition;
      readonly instance: AcpAgentInstanceConfig;
    };

export const AgentBackendRegistryFailureReason = Schema.Literals([
  "settings-unavailable",
  "definition-unavailable",
  "instance-required",
  "instance-unavailable",
  "instance-disabled",
  "instance-definition-mismatch",
]);

export type AgentBackendRegistryFailureReason = typeof AgentBackendRegistryFailureReason.Type;

export class AgentBackendRegistryError extends Schema.TaggedError<AgentBackendRegistryError>()(
  "AgentBackendRegistryError",
  {
    message: Schema.String,
    reason: AgentBackendRegistryFailureReason,
    backendKind: Schema.Literals(["codex", "acp"]),
    agentDefinitionId: Schema.optionalKey(Schema.String),
    instanceConfigId: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const unavailable = (
  binding: AgentBackendBinding,
  reason: Exclude<AgentBackendRegistryFailureReason, "settings-unavailable">,
  message: string,
): AgentBackendRegistryError =>
  new AgentBackendRegistryError({
    message,
    reason,
    backendKind: binding.kind,
    ...(binding.kind === "acp"
      ? {
          agentDefinitionId: binding.agentDefinitionId,
          ...(binding.instanceConfigId === null
            ? {}
            : { instanceConfigId: binding.instanceConfigId }),
        }
      : {}),
  });

/** Resolves supported metadata and explicit Profile configuration; it never starts a process. */
export const resolveAgentBackendBinding = (
  binding: AgentBackendBinding,
  settings: Pick<ApplicationSettingsSnapshot, "acpAgents">,
): AgentBackendResolution | AgentBackendRegistryError => {
  if (binding.kind === "codex") {
    return { kind: "codex", binding, displayName: "Codex" };
  }
  const definition = ACP_AGENT_DEFINITIONS.find(({ id }) => id === binding.agentDefinitionId);
  if (definition === undefined) {
    return unavailable(
      binding,
      "definition-unavailable",
      `ACP Agent definition is not supported: ${binding.agentDefinitionId}`,
    );
  }
  if (binding.instanceConfigId === null) {
    return unavailable(
      binding,
      "instance-required",
      "ACP backend binding requires an Agent instance configuration",
    );
  }
  const instance = settings.acpAgents.instances.find(({ id }) => id === binding.instanceConfigId);
  if (instance === undefined) {
    return unavailable(
      binding,
      "instance-unavailable",
      `ACP Agent instance is unavailable: ${binding.instanceConfigId}`,
    );
  }
  if (!instance.enabled) {
    return unavailable(
      binding,
      "instance-disabled",
      `ACP Agent instance is disabled: ${binding.instanceConfigId}`,
    );
  }
  if (instance.agentDefinitionId !== definition.id) {
    return unavailable(
      binding,
      "instance-definition-mismatch",
      "ACP Agent instance belongs to another supported definition",
    );
  }
  return {
    kind: "acp",
    binding: {
      kind: "acp",
      agentDefinitionId: definition.id,
      instanceConfigId: instance.id,
    },
    displayName: definition.title,
    definition,
    instance,
  };
};

export class AgentBackendRegistry extends Context.Service<
  AgentBackendRegistry,
  {
    readonly resolve: (
      binding: AgentBackendBinding,
    ) => Effect.Effect<AgentBackendResolution, AgentBackendRegistryError>;
    readonly resolveAcpInstance: (
      instanceConfigId: string,
    ) => Effect.Effect<
      Extract<AgentBackendResolution, { readonly kind: "acp" }>,
      AgentBackendRegistryError
    >;
  }
>()("nodex/main/agent-backend/AgentBackendRegistry") {}

export const make = Effect.gen(function* () {
  const settings = yield* ApplicationSettings;
  const readSnapshot = (backendKind: "codex" | "acp") =>
    settings.snapshot().pipe(
      Effect.mapError(
        (cause) =>
          new AgentBackendRegistryError({
            message: "Agent backend settings are unavailable",
            reason: "settings-unavailable",
            backendKind,
            cause,
          }),
      ),
    );
  return AgentBackendRegistry.of({
    resolve: (binding) =>
      Effect.gen(function* () {
        const snapshot = yield* readSnapshot(binding.kind).pipe(
          Effect.mapError((error) =>
            binding.kind !== "acp"
              ? error
              : new AgentBackendRegistryError({
                  message: error.message,
                  reason: error.reason,
                  backendKind: error.backendKind,
                  ...(error.cause === undefined ? {} : { cause: error.cause }),
                  agentDefinitionId: binding.agentDefinitionId,
                  ...(binding.instanceConfigId === null
                    ? {}
                    : { instanceConfigId: binding.instanceConfigId }),
                }),
          ),
        );
        const resolution = resolveAgentBackendBinding(binding, snapshot);
        if (resolution instanceof AgentBackendRegistryError) return yield* resolution;
        return resolution;
      }),
    resolveAcpInstance: (instanceConfigId) =>
      Effect.gen(function* () {
        const snapshot = yield* readSnapshot("acp");
        const instance = snapshot.acpAgents.instances.find(({ id }) => id === instanceConfigId);
        if (instance === undefined) {
          return yield* new AgentBackendRegistryError({
            message: `ACP Agent instance is unavailable: ${instanceConfigId}`,
            reason: "instance-unavailable",
            backendKind: "acp",
            instanceConfigId,
          });
        }
        const resolution = resolveAgentBackendBinding(
          {
            kind: "acp",
            agentDefinitionId: instance.agentDefinitionId,
            instanceConfigId,
          },
          snapshot,
        );
        if (resolution instanceof AgentBackendRegistryError) return yield* resolution;
        if (resolution.kind === "codex") {
          return yield* new AgentBackendRegistryError({
            message: "ACP instance resolved to the native backend",
            reason: "instance-definition-mismatch",
            backendKind: "acp",
            instanceConfigId,
          });
        }
        return resolution;
      }),
  });
});

export const live: Layer.Layer<AgentBackendRegistry, never, ApplicationSettings> = Layer.effect(
  AgentBackendRegistry,
  make,
);
