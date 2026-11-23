import path from "node:path";
import { z } from "zod";
import {
  AGENT_ENVIRONMENT_LIMIT,
  createAgentEnvironmentNameSchema,
} from "../../shared/agent-environment";
import type { AgentProfileDefinition } from "../../shared/agents/profile-definition";
import {
  AGENT_PROFILE_LIMIT,
  agentProfileCommonFields,
  initialAgentProfiles,
  parseAgentProfilesUpdate,
  profileExecutableSchema,
  profileSettingsFields,
  uniqueNames,
  type AgentProfile,
  type AgentProfileInput,
} from "../../shared/agents/profiles";
import {
  profileAgentDefinition,
  profileAgentDefinitions,
  type ProfileAgentDriver,
} from "../../shared/agents/registry";
import {
  presentAgentEnvironment,
  resolveAgentEnvironment,
  storedAgentEnvironmentSchema,
  writeAgentEnvironments,
  type AgentEnvironmentStorage,
  type StoredAgentEnvironment,
} from "./agent-environment-storage";

export type AgentProfileStorage = Omit<AgentEnvironmentStorage, "backend">;
const secretReference = z.strictObject({ secretRef: z.uuid() });
const profileSecretName = (key: string) => `settings.${key}`;

const storedSchemas = new Map(
  profileAgentDefinitions.map((definition) => {
    const profile: AgentProfileDefinition = definition.profile;
    return [
      definition.driver,
      z.strictObject({
        id: agentProfileCommonFields.id,
        display_name: agentProfileCommonFields.displayName,
        enabled: agentProfileCommonFields.enabled,
        driver: z.literal(definition.driver),
        settings: z.strictObject({
          ...profileSettingsFields(profile, () => secretReference.optional(), path.isAbsolute),
          binaryPath: profileExecutableSchema(profile),
        }),
        environment: profile.environment
          ? z
              .array(
                storedAgentEnvironmentSchema(
                  createAgentEnvironmentNameSchema(profile.environment.nameError),
                ),
              )
              .max(AGENT_ENVIRONMENT_LIMIT)
              .refine(uniqueNames)
              .default([])
          : z.never().optional(),
      }),
    ] as const;
  }),
);

export interface StoredAgentProfile {
  readonly id: string;
  readonly driver: ProfileAgentDriver;
  readonly display_name: string;
  readonly enabled: boolean;
  readonly settings: Readonly<Record<string, unknown>> & { readonly binaryPath: string };
  readonly environment?: StoredAgentEnvironment[];
}

function definitionFor(driver: ProfileAgentDriver): AgentProfileDefinition {
  return profileAgentDefinition(driver)!.profile;
}

export function toStoredProfile(
  profile: AgentProfile,
  environment: StoredAgentEnvironment[] = [],
): StoredAgentProfile {
  const { id, driver, displayName, enabled, binaryPath, settings } = profile;
  const definition = definitionFor(driver);
  return {
    id,
    driver,
    display_name: displayName,
    enabled,
    settings: {
      ...Object.fromEntries(
        Object.entries(settings).filter(([key]) => definition.fields[key]?.control !== "secret"),
      ),
      binaryPath,
    },
    ...(definition.environment ? { environment } : {}),
  };
}

export function readStoredAgentProfiles(value: unknown): StoredAgentProfile[] {
  if (value === undefined) return initialAgentProfiles().map((profile) => toStoredProfile(profile));
  const rows = z.array(z.object({ driver: z.unknown() }).loose()).parse(value);
  const countByDriver = new Map<ProfileAgentDriver, number>();
  const ids = new Set<string>();
  return rows.map((row) => {
    const definition = profileAgentDefinition(row.driver);
    const parsed = definition && storedSchemas.get(definition.driver)?.safeParse(row);
    if (!parsed?.success) throw new Error("Invalid saved Agent profile.");
    const profile: StoredAgentProfile = parsed.data;
    const count = (countByDriver.get(profile.driver) ?? 0) + 1;
    if (count > AGENT_PROFILE_LIMIT || ids.has(profile.id))
      throw new Error("Invalid saved Agent profile list.");
    countByDriver.set(profile.driver, count);
    ids.add(profile.id);
    return profile;
  });
}

function profileSecrets(profile: StoredAgentProfile): StoredAgentEnvironment[] {
  return Object.entries(definitionFor(profile.driver).fields).flatMap(([key, field]) => {
    if (field.control !== "secret") return [];
    const ref = secretReference.safeParse(profile.settings[key]);
    return ref.success
      ? [{ name: profileSecretName(key), sensitive: true, secretRef: ref.data.secretRef }]
      : [];
  });
}

function presentAgentProfile(profile: StoredAgentProfile): AgentProfile {
  const {
    id,
    driver,
    display_name: displayName,
    enabled,
    settings: { binaryPath, ...values },
    environment,
  } = profile;
  const secretKeys = Object.entries(definitionFor(driver).fields)
    .filter(([, field]) => field.control === "secret")
    .map(([key]) => key);
  const saved = new Set(profileSecrets(profile).map(({ name }) => name));
  // The stored settings were checked against this driver's definition.
  return {
    id,
    driver,
    displayName,
    enabled,
    binaryPath,
    settings: { ...values, ...Object.fromEntries(secretKeys.map((key) => [key, null])) },
    savedSecrets: secretKeys.filter((key) => saved.has(profileSecretName(key))),
    ...(environment ? { environment: presentAgentEnvironment(environment) } : {}),
  } as unknown as AgentProfile;
}

export const presentAgentProfiles = (profiles: readonly StoredAgentProfile[]) =>
  profiles.map(presentAgentProfile);

const secureValues = (profile: StoredAgentProfile) => ({
  id: profile.id,
  environment: [...(profile.environment ?? []), ...profileSecrets(profile)],
});

function normalizedSettings(profile: AgentProfileInput, source: AgentProfileStorage) {
  const definition = definitionFor(profile.driver);
  return Object.fromEntries(
    Object.entries(profile.settings).flatMap(([key, value]): [string, unknown][] => {
      const field = definition.fields[key];
      if (field?.control === "secret") return [];
      if (field?.control !== "path" || typeof value !== "string" || !value) return [[key, value]];
      if (value.startsWith("~/")) {
        if (!source.hostHomeDirectory)
          throw new Error("The host home directory is unavailable. Use an absolute profile path.");
        return [[key, path.resolve(source.hostHomeDirectory, value.slice(2))]];
      }
      if (!path.isAbsolute(value))
        throw new Error("Use an absolute profile path or a path starting with ~/.");
      return [[key, value]];
    }),
  );
}

export function writeAgentProfiles(
  source: AgentProfileStorage,
  input: unknown,
  previous: StoredAgentProfile[],
  publish: (next: StoredAgentProfile[]) => void,
): void {
  const { driver, instances } = parseAgentProfilesUpdate(input);
  const others = previous.filter((profile) => profile.driver !== driver);
  const occupied = new Set(others.map(({ id }) => id));
  if (instances.some(({ id }) => occupied.has(id)))
    throw new Error("Duplicate Agent profile identity.");
  const definition = definitionFor(driver);
  const old = previous.filter((profile) => profile.driver === driver).map(secureValues);
  const prepared = instances.map((profile) => {
    const saved = old.find(({ id }) => id === profile.id);
    const values: Readonly<Record<string, unknown>> = profile.settings;
    const secrets = Object.entries(definition.fields).flatMap(([key, field]) => {
      if (field.control !== "secret" || (field.when && !field.when(values))) return [];
      const value = values[key] as string | null;
      const name = profileSecretName(key);
      return value === "" ||
        (value === null && !saved?.environment.some((entry) => entry.name === name))
        ? []
        : [{ name, sensitive: true as const, value }];
    });
    return {
      id: profile.id,
      driver,
      display_name: profile.displayName,
      enabled: profile.enabled,
      settings: { ...normalizedSettings(profile, source), binaryPath: profile.binaryPath },
      environment: [...(profile.environment ?? []), ...secrets],
    };
  });
  writeAgentEnvironments({ ...source, backend: driver }, prepared, old, (next) => {
    const updated = next.map(({ environment, ...profile }) => ({
      ...profile,
      settings: {
        ...profile.settings,
        ...Object.fromEntries(
          environment.flatMap((entry) =>
            entry.sensitive && entry.name.startsWith("settings.")
              ? [[entry.name.slice("settings.".length), { secretRef: entry.secretRef }]]
              : [],
          ),
        ),
      },
      ...(definition.environment
        ? { environment: environment.filter(({ name }) => !name.startsWith("settings.")) }
        : {}),
    }));
    const preceding = previous.findIndex((profile) => profile.driver === driver);
    const insertion = preceding < 0 ? others.length : preceding;
    publish([...others.slice(0, insertion), ...updated, ...others.slice(insertion)]);
  });
}

export function resolveAgentProfile<Driver extends ProfileAgentDriver>(
  source: AgentProfileStorage,
  profiles: readonly StoredAgentProfile[],
  driver: Driver,
  instanceId: string,
) {
  const stored = profiles.find((profile) => profile.driver === driver && profile.id === instanceId);
  if (!stored?.enabled)
    throw new Error(
      `${profileAgentDefinition(driver)?.label} instance is unavailable or disabled.`,
    );
  const backend = { ...source, backend: driver };
  const settings = stored.settings;
  const fields = definitionFor(driver).fields;
  const credentials = profileSecrets(stored).filter(({ name }) => {
    const field = fields[name.slice("settings.".length)];
    return field?.control === "secret" && (!field.when || field.when(settings));
  });
  return {
    profile: presentAgentProfile(stored) as AgentProfile<Driver>,
    environment: resolveAgentEnvironment(backend, {
      id: stored.id,
      environment: stored.environment ?? [],
    }),
    secrets: Object.fromEntries(
      Object.entries(
        resolveAgentEnvironment(backend, { id: stored.id, environment: credentials }),
      ).map(([key, value]) => [key.slice("settings.".length), value]),
    ),
  };
}
