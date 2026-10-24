import type { OpenCodeAgentInstanceConfig } from "../../shared/opencode-agent-settings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AcpAgentInstanceConfig, ClaudeAgentInstanceConfig } from "../../shared/types";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";

export type AgentBackendResolution =
  | {
      readonly kind: "opencode";
      readonly binding: Extract<AgentBackendBinding, { kind: "opencode" }>;
      readonly displayName: string;
      readonly instance: OpenCodeAgentInstanceConfig;
    }
  | {
      readonly kind: "claude";
      readonly binding: Extract<AgentBackendBinding, { kind: "claude" }>;
      readonly displayName: string;
      readonly instance: ClaudeAgentInstanceConfig;
    }
  | {
      readonly kind: "codex";
      readonly binding: Extract<AgentBackendBinding, { readonly kind: "codex" }>;
      readonly displayName: "Codex";
    }
  | {
      readonly kind: "acp";
      readonly binding: {
        readonly kind: "acp";
        readonly agentDefinitionId: string;
        readonly instanceConfigId: string;
      };
      readonly displayName: string;
      readonly instance: AcpAgentInstanceConfig;
    };

export const AgentBackendRegistryFailureReason = Schema.Literals([
  "settings-unavailable",
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
    backendKind: Schema.Literals(["codex", "acp", "claude", "opencode"]),
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
  settings: Pick<ApplicationSettingsSnapshot, "acpAgents" | "claudeAgents" | "openCodeAgents">,
): AgentBackendResolution | AgentBackendRegistryError => {
  if (binding.kind === "codex") {
    return { kind: "codex", binding, displayName: "Codex" };
  }
  if (binding.kind === "claude") {
    const instance = settings.claudeAgents.instances.find(
      ({ id }) => id === binding.instanceConfigId,
    );
    if (!instance)
      return unavailable(binding, "instance-unavailable", "Claude instance is unavailable");
    if (!instance.enabled)
      return unavailable(binding, "instance-disabled", "Claude instance is disabled");
    return { kind: "claude", binding, displayName: instance.displayName, instance };
  }
  if (binding.kind === "opencode") {
    const instance = settings.openCodeAgents.instances.find(
      ({ id }) => id === binding.instanceConfigId,
    );
    if (!instance)
      return unavailable(binding, "instance-unavailable", "OpenCode instance is unavailable");
    if (!instance.enabled)
      return unavailable(binding, "instance-disabled", "OpenCode instance is disabled");
    return { kind: "opencode", binding, displayName: instance.displayName, instance };
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
  if (instance.agentDefinitionId !== binding.agentDefinitionId) {
    return unavailable(
      binding,
      "instance-definition-mismatch",
      "ACP Agent instance belongs to another Agent definition",
    );
  }
  return {
    kind: "acp",
    binding: {
      kind: "acp",
      agentDefinitionId: instance.agentDefinitionId,
      instanceConfigId: instance.id,
    },
    displayName: instance.displayName,
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
  const readSnapshot = (backendKind: AgentBackendBinding["kind"]) =>
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
        if (resolution.kind !== "acp") {
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
