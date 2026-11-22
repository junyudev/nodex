import { z } from "zod";
import {
  AGENT_ENVIRONMENT_LIMIT,
  createAgentEnvironmentInputSchema,
  type AgentEnvironmentInput,
  type AgentEnvironmentVariable,
} from "../agent-environment.ts";
import { newAgentInstanceId } from "./instance-id.ts";
import type { AgentProfileDefinition, AgentProfileField } from "./profile-definition.ts";
import {
  profileAgentDefinition,
  profileAgentDefinitions,
  type ProfileAgentDefinition,
  type ProfileAgentDriver,
} from "./registry.ts";

type ProfileFieldValue<Field, Secret> = Field extends {
  control: "custom";
  schema: infer Schema extends z.ZodType;
}
  ? z.output<Schema>
  : Field extends { control: "select"; options: readonly { value: infer Value }[] }
    ? Value
    : Field extends { control: "secret" }
      ? Secret
      : Field extends { empty: "null" }
        ? string | null
        : string;

type FieldsFor<Driver extends ProfileAgentDriver> = Extract<
  ProfileAgentDefinition,
  { driver: Driver }
>["profile"]["fields"];

type Profile<
  Driver extends ProfileAgentDriver,
  Secret,
  Environment,
> = Driver extends ProfileAgentDriver
  ? {
      readonly driver: Driver;
      readonly id: string;
      readonly displayName: string;
      readonly enabled: boolean;
      readonly binaryPath: string;
      readonly settings: {
        [Key in keyof FieldsFor<Driver>]: ProfileFieldValue<FieldsFor<Driver>[Key], Secret>;
      };
      readonly environment?: Environment[];
    }
  : never;

export type AgentProfile<Driver extends ProfileAgentDriver = ProfileAgentDriver> = Profile<
  Driver,
  null,
  AgentEnvironmentVariable
> & { readonly savedSecrets: readonly string[] };

export type AgentProfileInput<Driver extends ProfileAgentDriver = ProfileAgentDriver> = Profile<
  Driver,
  string | null,
  AgentEnvironmentInput
>;

export interface AgentProfilesUpdate {
  readonly driver: ProfileAgentDriver;
  readonly instances: readonly AgentProfileInput[];
}

export const AGENT_PROFILE_LIMIT = 32;
export const agentProfileCommonFields = {
  id: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u),
  displayName: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
};

export const profileExecutableSchema = (definition: AgentProfileDefinition) =>
  z
    .string()
    .trim()
    .min(definition.executable.allowEmpty ? 0 : 1)
    .max(4096);

const profilePathIsAbsolute = (value: string) =>
  value.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\");

export const uniqueNames = (values: readonly { name: string }[]) =>
  new Set(values.map(({ name }) => name)).size === values.length;

const httpUrl = (value: string): boolean => {
  const url = URL.parse(value);
  return (
    url !== null && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
  );
};

function profileFieldSchema(
  field: AgentProfileField,
  secret: z.ZodType,
  storedAbsolutePath?: (value: string) => boolean,
): z.ZodType {
  if (field.control === "custom") return field.schema.default(field.defaultValue);
  if (field.control === "secret") return secret;
  if (field.control === "select")
    return z.enum(field.options.map(({ value }) => value)).default(field.defaultValue);
  const trimmed = z.string().trim();
  const bounded = field.maxLength === undefined ? trimmed : trimmed.max(field.maxLength);
  const text = bounded.refine(
    (value) => {
      if (field.control === "path")
        return (
          (value === "" && field.empty !== "null") ||
          (storedAbsolutePath
            ? storedAbsolutePath(value)
            : value.startsWith("~/") || profilePathIsAbsolute(value))
        );
      return field.format !== "http-url" || httpUrl(value);
    },
    field.control === "path"
      ? "Use an absolute path or a path starting with ~/."
      : "Use an HTTP or HTTPS server URL without credentials.",
  );
  return field.empty === "null"
    ? text.nullable().default(field.defaultValue)
    : text.default(field.defaultValue);
}

export const profileSettingsFields = (
  definition: AgentProfileDefinition,
  secretSchema: (maxLength: number) => z.ZodType,
  storedAbsolutePath?: (value: string) => boolean,
) =>
  Object.fromEntries(
    Object.entries(definition.fields).map(([key, field]) => [
      key,
      profileFieldSchema(
        field,
        field.control === "secret" ? secretSchema(field.maxLength) : z.never(),
        storedAbsolutePath,
      ),
    ]),
  );

const environmentPolicies = new Map(
  profileAgentDefinitions.flatMap((definition) => {
    const profile: AgentProfileDefinition = definition.profile;
    if (!profile.environment) return [];
    return [
      [
        definition.driver,
        {
          ...profile.environment,
          limit: AGENT_ENVIRONMENT_LIMIT,
          inputSchema: createAgentEnvironmentInputSchema(profile.environment.nameError),
        },
      ] as const,
    ];
  }),
);

export const agentProfileEnvironment = (driver: ProfileAgentDriver) =>
  environmentPolicies.get(driver);

const updateSchemas = new Map(
  profileAgentDefinitions.map((definition) => {
    const profile: AgentProfileDefinition = definition.profile;
    const environment = agentProfileEnvironment(definition.driver);
    const instances = z
      .array(
        z
          .object({
            ...agentProfileCommonFields,
            driver: z.literal(definition.driver),
            binaryPath: profileExecutableSchema(profile),
            settings: z.strictObject(
              profileSettingsFields(profile, (maxLength) =>
                z
                  .string()
                  .trim()
                  .max(maxLength)
                  .refine((value) => !value.includes("\0"))
                  .nullable()
                  .default(null),
              ),
            ),
            environment: environment
              ? z
                  .array(environment.inputSchema)
                  .max(environment.limit)
                  .refine(uniqueNames)
                  .default([])
              : z.never().optional(),
          })
          .strict(),
      )
      .max(AGENT_PROFILE_LIMIT)
      .refine(
        (values) => new Set(values.map(({ id }) => id)).size === values.length,
        "Duplicate Agent profile identity.",
      );
    return [
      definition.driver,
      z.strictObject({ driver: z.literal(definition.driver), instances }),
    ] as const;
  }),
);

export function parseAgentProfileDriver(value: unknown): ProfileAgentDriver {
  const definition = profileAgentDefinition(value);
  if (!definition) throw new Error("Unknown Agent profile driver.");
  return definition.driver;
}

export function parseAgentProfilesUpdate(input: unknown): AgentProfilesUpdate {
  const envelope = z.object({ driver: z.unknown() }).parse(input);
  const driver = parseAgentProfileDriver(envelope.driver);
  const parsed = updateSchemas.get(driver)?.safeParse(input);
  if (!parsed?.success)
    throw new Error(`Invalid ${profileAgentDefinition(driver)?.label} settings.`);
  // The schema and the discriminated wire type are built from the same fields.
  return parsed.data as unknown as AgentProfilesUpdate;
}

/** Narrow by the matching registry driver without reinterpreting the profile's values. */
export function agentProfilesFor<Driver extends ProfileAgentDriver>(
  instances: readonly AgentProfile[],
  driver: Driver,
): AgentProfile<Driver>[] {
  return instances.filter((profile) => profile.driver === driver) as AgentProfile<Driver>[];
}

export function createAgentProfile<Driver extends ProfileAgentDriver>(
  definition: ProfileAgentDefinition & { readonly driver: Driver },
  id = newAgentInstanceId(definition.driver),
): AgentProfile<Driver> {
  const profile: AgentProfileDefinition = definition.profile;
  return {
    id,
    driver: definition.driver,
    displayName: profile.defaultName,
    enabled: true,
    binaryPath: profile.executable.defaultValue,
    settings: Object.fromEntries(
      Object.entries(profile.fields).map(([key, field]) => [key, field.defaultValue]),
    ),
    ...(profile.environment ? { environment: [] } : {}),
    savedSecrets: [],
  } as unknown as AgentProfile<Driver>;
}

export const initialAgentProfiles = (): AgentProfile[] =>
  profileAgentDefinitions.flatMap((definition) => {
    const { initialId } = definition.profile as AgentProfileDefinition;
    return initialId ? [createAgentProfile(definition, initialId)] : [];
  });

/** Only write values; saved-secret indicators are presentation state. */
export function agentProfileInput<Driver extends ProfileAgentDriver>(
  profile: AgentProfileInput<Driver> & {
    readonly driver: Driver;
    readonly savedSecrets: readonly string[];
  },
): AgentProfileInput<Driver> {
  const { savedSecrets: _, ...input } = profile;
  return input as unknown as AgentProfileInput<Driver>;
}
