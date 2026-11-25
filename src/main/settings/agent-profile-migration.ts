import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { acpRegistryAgent } from "../../shared/agents/acp-registry";
import { antigravityAgent } from "../../shared/agents/antigravity";
import { claudeAgent } from "../../shared/agents/claude";
import {
  legacyAgentInstanceId,
  repairLegacyAcpInstanceId,
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
import { readStoredAcpInstances, type StoredAcpInstances } from "./acp-agent-environment";
import {
  readStoredAgentProfiles,
  toStoredProfile,
  type AgentProfileStorage,
} from "./agent-profile-store";
import { acpInstanceBuiltInAgent } from "../../shared/acp-agent-settings";

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
  return readStoredAgentProfiles(
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
}

/** Rebind only the affected ACP secrets. Native profile paths and installation receipts are explicit. */
export function migrateAcpInstanceIds(
  source: AgentProfileStorage,
  stored: StoredAcpInstances,
  changes: AgentSecretChanges,
  rekeyLegacyTable = false,
) {
  const rewritten = new Map<string, string>();
  const kind = acpRegistryAgent.settingsAnchor;
  let changed = false;
  const instances = stored.map((profile) => {
    const repaired = repairLegacyAcpInstanceId(profile.id);
    const id = rekeyLegacyTable ? legacyAgentInstanceId(kind, profile.id) : repaired;
    if (id === profile.id) return profile;
    changed = true;
    if (repaired !== profile.id) rewritten.set(profile.id, id);
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
  });
  return changed ? { instances: readStoredAcpInstances(instances), rewritten } : null;
}

/**
 * An ACP instance whose Agent is built into Nodex duplicates that Agent. One saved before built-in
 * Agents claimed their Registry identities becomes the built-in Agent's own: a connection that ran
 * agy with this computer's sign-in becomes the Antigravity profile that does the same, unless one
 * already does. Its chats keep their history and continue on the built-in Agent once chosen.
 * Returns null when nothing duplicates a built-in Agent.
 */
export function migrateBuiltInAcpInstances(
  source: AgentProfileStorage,
  previous: { readonly agent_instances?: unknown[] },
  instances: StoredAcpInstances,
  changes: AgentSecretChanges,
) {
  const duplicates = instances.filter((instance) => acpInstanceBuiltInAgent(instance));
  if (!duplicates.length) return null;
  const profiles = readStoredAgentProfiles(previous.agent_instances);
  const antigravity = profiles.filter(({ driver }) => driver === antigravityAgent.driver);
  const connection = duplicates.find(
    (instance) => acpInstanceBuiltInAgent(instance) === antigravityAgent,
  );
  const added =
    connection && !antigravity.some(({ settings }) => settings.authMethod === "computer")
      ? [
          // No profile uses this computer's sign-in, so a new one starts with it.
          toStoredProfile({
            ...createAgentProfile(antigravityAgent, undefined, antigravity),
            displayName: connection.displayName,
            enabled: connection.enabled,
          }),
        ]
      : [];
  for (const { environment } of duplicates)
    for (const variable of environment)
      if (variable.sensitive)
        changes.retire({ ...source, backend: acpRegistryAgent.settingsAnchor }, variable.secretRef);
  return {
    agent_instances: readStoredAgentProfiles([...profiles, ...added]),
    acp_agent_instances: instances.filter((instance) => !duplicates.includes(instance)),
  };
}
