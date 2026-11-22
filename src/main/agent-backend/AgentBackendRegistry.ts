import type { AgentProfile } from "../../shared/agents/profiles";
import { agentDefinition } from "../../shared/agents/registry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AcpAgentInstanceConfig } from "../../shared/types";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";

export type AgentBackendResolution =
  | {
      readonly kind: "profile";
      readonly binding: AgentBackendBinding;
      readonly displayName: string;
      readonly instance: AgentProfile;
    }
  | {
      readonly kind: "codex";
      readonly binding: AgentBackendBinding;
      readonly displayName: "Codex";
    }
  | {
      readonly kind: "acp";
      readonly binding: AgentBackendBinding;
      readonly displayName: string;
      readonly instance: AcpAgentInstanceConfig;
    };

export const AgentBackendRegistryFailureReason = Schema.Literals([
  "settings-unavailable",
  "instance-unavailable",
  "instance-disabled",
  "unsupported-driver",
]);

export type AgentBackendRegistryFailureReason = typeof AgentBackendRegistryFailureReason.Type;

export class AgentBackendRegistryError extends Schema.TaggedError<AgentBackendRegistryError>()(
  "AgentBackendRegistryError",
  {
    message: Schema.String,
    reason: AgentBackendRegistryFailureReason,
    driver: Schema.String,
    instanceId: Schema.optionalKey(Schema.String),
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
    driver: binding.driver,
    instanceId: binding.instanceId,
  });

/** Resolves supported metadata and explicit Profile configuration; it never starts a process. */
export const resolveAgentBackendBinding = (
  binding: AgentBackendBinding,
  settings: Pick<ApplicationSettingsSnapshot, "acpAgents" | "agentProfiles">,
): AgentBackendResolution | AgentBackendRegistryError => {
  const definition = agentDefinition(binding.driver);
  const { driver } = definition;
  if (driver === "codex") {
    return { kind: "codex", binding, displayName: "Codex" };
  }
  if (definition.profile) {
    const instance = settings.agentProfiles.find(
      (profile) => profile.driver === driver && profile.id === binding.instanceId,
    );
    if (!instance)
      return unavailable(
        binding,
        "instance-unavailable",
        `${definition.label} instance is unavailable`,
      );
    if (!instance.enabled)
      return unavailable(binding, "instance-disabled", `${definition.label} instance is disabled`);
    return { kind: "profile", binding, displayName: instance.displayName, instance };
  }
  if (driver !== "acpRegistry") {
    return unavailable(binding, "unsupported-driver", "This Agent is unavailable.");
  }
  const instance = settings.acpAgents.instances.find(({ id }) => id === binding.instanceId);
  if (instance === undefined) {
    return unavailable(binding, "instance-unavailable", "This Agent was removed from Settings.");
  }
  if (!instance.enabled) {
    return unavailable(
      binding,
      "instance-disabled",
      "This Agent is turned off. Turn it on in Settings.",
    );
  }
  return {
    kind: "acp",
    binding,
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
  const resolve = (binding: AgentBackendBinding) =>
    Effect.gen(function* () {
      const snapshot = yield* settings.snapshot().pipe(
        Effect.mapError(
          (cause) =>
            new AgentBackendRegistryError({
              message: "Agent backend settings are unavailable",
              reason: "settings-unavailable",
              driver: binding.driver,
              instanceId: binding.instanceId,
              cause,
            }),
        ),
      );
      const resolution = resolveAgentBackendBinding(binding, snapshot);
      if (resolution instanceof AgentBackendRegistryError) return yield* resolution;
      return resolution;
    });
  return AgentBackendRegistry.of({
    resolve,
    resolveAcpInstance: (instanceId) =>
      Effect.gen(function* () {
        const binding = { driver: "acpRegistry", instanceId };
        const resolution = yield* resolve(binding);
        if (resolution.kind !== "acp")
          return yield* unavailable(binding, "unsupported-driver", "This Agent is unavailable.");
        return resolution;
      }),
  });
});

export const live: Layer.Layer<AgentBackendRegistry, never, ApplicationSettings> = Layer.effect(
  AgentBackendRegistry,
  make,
);
