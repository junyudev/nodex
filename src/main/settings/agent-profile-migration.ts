import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { acpRegistryAgent } from "../../shared/agents/acp-registry";
import { antigravityAgent } from "../../shared/agents/antigravity";
import { claudeAgent } from "../../shared/agents/claude";
import {
  legacyAgentInstanceId,
  type LegacyAgentProfileKind,
} from "../../shared/agents/legacy-identity";
import { openCodeAgent } from "../../shared/agents/opencode";
import type { AgentProfileDefinition } from "../../shared/agents/profile-definition";
import { createAgentProfile } from "../../shared/agents/profiles";
import type { ProfileAgentDefinition } from "../../shared/agents/registry";
import { AgentEnvironmentValueSchema } from "../../shared/agent-environment";
import {
  migrateAgentSecret,
  storedAgentEnvironmentSchema,
  type AgentSecretChanges,
  type StoredAgentEnvironment,
} from "./agent-environment-storage";
import { readStoredAcpInstances } from "./acp-agent-environment";
import { readStoredAgentProfiles, type AgentProfileStorage } from "./agent-profile-store";

interface LegacyProfileTables {
  readonly agent_instance_identity_version?: number;
  readonly claude_agent_instances?: unknown[];
  readonly opencode_agent_instances?: unknown[];
  readonly antigravity_agent_instances?: unknown[];
  readonly acp_agent_instances?: unknown[];
}

const legacyDrivers = [
  { kind: claudeAgent.settingsAnchor, definition: claudeAgent, table: "claude_agent_instances" },
  {
    kind: openCodeAgent.settingsAnchor,
    definition: openCodeAgent,
    table: "opencode_agent_instances",
  },
  {
    kind: antigravityAgent.settingsAnchor,
    definition: antigravityAgent,
    table: "antigravity_agent_instances",
  },
] as const;

const agentEnvironmentName = z.string().trim();
const inlineSecret = z.strictObject({
  name: agentEnvironmentName,
  sensitive: z.literal(true),
  value: AgentEnvironmentValueSchema,
});
const legacyEnvironment = z
  .array(z.union([storedAgentEnvironmentSchema(agentEnvironmentName), inlineSecret]))
  .default([]);

const legacyProfile = z
  .object({
    id: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
    displayName: z.string(),
    binaryPath: z.string(),
    environment: legacyEnvironment,
    apiKeyRef: z.uuid().nullable().optional(),
    apiKey: AgentEnvironmentValueSchema.nullable().optional(),
  })
  .loose();

const openCodeData = (source: AgentProfileStorage) =>
  path.join(path.dirname(source.settingsPath), "agents", openCodeAgent.driver);
const implicitOpenCodeHome = (source: AgentProfileStorage) =>
  path.join(openCodeData(source), "opencode-default");

export const hasLegacyAgentProfiles = (
  source: AgentProfileStorage,
  previous: LegacyProfileTables,
) =>
  legacyDrivers.some(({ table }) => previous[table] !== undefined) ||
  previous.acp_agent_instances !== undefined ||
  (!previous.agent_instance_identity_version && existsSync(implicitOpenCodeHome(source)));

function migrateLegacyEnvironment(
  changes: AgentSecretChanges,
  source: AgentProfileStorage,
  kind: LegacyAgentProfileKind,
  driver: string,
  oldId: string,
  id: string,
  environment: z.output<typeof legacyEnvironment>,
): StoredAgentEnvironment[] {
  const oldSource = { ...source, backend: kind };
  const nextSource = { ...source, backend: driver };
  return environment.map((entry) => {
    if (!entry.sensitive) return entry;
    const { name } = entry;
    const secretRef =
      "secretRef" in entry
        ? migrateAgentSecret(
            changes,
            { source: oldSource, id: oldId, name, ref: entry.secretRef },
            { source: nextSource, id, name },
          )!
        : changes.stage(nextSource, id, name, entry.value);
    return { name, sensitive: true, secretRef };
  });
}

function rowsFor(
  source: AgentProfileStorage,
  previous: LegacyProfileTables,
  { table, definition }: (typeof legacyDrivers)[number],
) {
  if (previous[table] !== undefined) return z.array(legacyProfile).parse(previous[table]);
  const { initialId } = definition.profile as AgentProfileDefinition;
  if (!initialId) return [];
  const { id, displayName, enabled, binaryPath, settings } = createAgentProfile(
    definition,
    initialId,
  );
  return [
    legacyProfile.parse({
      ...settings,
      id,
      displayName,
      enabled,
      binaryPath,
      ...(definition === openCodeAgent &&
      !previous.agent_instance_identity_version &&
      existsSync(implicitOpenCodeHome(source))
        ? { id: "opencode-default" }
        : {}),
    }),
  ];
}

function migrateSettings(
  changes: AgentSecretChanges,
  source: AgentProfileStorage,
  definition: ProfileAgentDefinition,
  kind: LegacyAgentProfileKind,
  row: z.output<typeof legacyProfile>,
  id: string,
) {
  const { fields } = definition.profile as AgentProfileDefinition;
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, field]) => {
      if (field.control !== "secret") {
        const value = row[key];
        if (definition === openCodeAgent && key === "profileDirectory" && !value && row.id !== id) {
          const home = /^[A-Za-z0-9_-]+$/u.test(row.id)
            ? path.join(openCodeData(source), row.id)
            : null;
          if (home && existsSync(home)) return [[key, home]];
        }
        return [[key, value]];
      }
      // The legacy key was bound to its unqualified name in the same encrypted store.
      const name = `settings.${key}`;
      const target =
        field.when && !field.when({ authMethod: "oauth-personal", ...row })
          ? null
          : { source: { ...source, backend: definition.driver }, id, name };
      const ref = row.apiKeyRef
        ? migrateAgentSecret(
            changes,
            { source: { ...source, backend: kind }, id: row.id, name: key, ref: row.apiKeyRef },
            target,
          )
        : target && row.apiKey
          ? changes.stage(target.source, id, name, row.apiKey)
          : undefined;
      return ref ? [[key, { secretRef: ref }]] : [];
    }),
  );
}

export function migrateLegacyAgentProfiles(
  source: AgentProfileStorage,
  previous: LegacyProfileTables,
  changes: AgentSecretChanges,
) {
  const agent_instances = readStoredAgentProfiles(
    legacyDrivers.flatMap((legacy) => {
      const { kind, definition, table } = legacy;
      return rowsFor(source, previous, legacy).map((row) => {
        const id =
          previous.agent_instance_identity_version === 1 ||
          (previous[table] === undefined && row.id !== "opencode-default")
            ? row.id
            : legacyAgentInstanceId(kind, row.id);
        return {
          id,
          driver: definition.driver,
          display_name: row.displayName,
          enabled: row.enabled,
          settings: {
            ...migrateSettings(changes, source, definition, kind, row, id),
            binaryPath: row.binaryPath,
          },
          ...("environment" in definition.profile
            ? {
                environment: migrateLegacyEnvironment(
                  changes,
                  source,
                  kind,
                  definition.driver,
                  row.id,
                  id,
                  row.environment,
                ),
              }
            : {}),
        };
      });
    }),
  );
  const acp_agent_instances =
    previous.acp_agent_instances && previous.agent_instance_identity_version !== 1
      ? readStoredAcpInstances(previous.acp_agent_instances).map((profile) => {
          // ACP keeps its own records and secret namespace.
          const kind = acpRegistryAgent.settingsAnchor;
          const id = legacyAgentInstanceId(kind, profile.id);
          return {
            ...profile,
            id,
            environment: migrateLegacyEnvironment(
              changes,
              source,
              kind,
              kind,
              profile.id,
              id,
              profile.environment,
            ),
          };
        })
      : previous.acp_agent_instances;
  return { agent_instances, acp_agent_instances };
}
