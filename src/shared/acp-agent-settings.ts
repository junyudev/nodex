import { z } from "zod";
import {
  AGENT_ENVIRONMENT_LIMIT,
  ENVIRONMENT_NAME_PATTERN,
  createAgentEnvironmentInputSchema,
  type AgentEnvironmentVariable,
} from "./agent-environment";

export const ACP_AGENT_INSTANCE_LIMIT = 32;
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\0"));
const absolutePath = text(4096).refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"),
  "Use an absolute path.",
);
const executable = text(4096).refine(
  (value) =>
    !/[\\/]/u.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\"),
  "Use an absolute path or a command on PATH.",
);
export const ACP_MANAGED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
]);
export const acpEnvironmentNameError = (name: string): string | null => {
  if (name.length > 128 || !ENVIRONMENT_NAME_PATTERN.test(name))
    return "Use a valid environment variable name.";
  if (ACP_MANAGED_ENVIRONMENT_NAMES.has(name.toUpperCase()))
    return `${name} is managed by the Agent profile.`;
  return null;
};
export const isAcpProfileEnvironmentName = (name: string): boolean =>
  /_(?:CONFIG_DIR|HOME)$/iu.test(name);
export const AcpEnvironmentInputSchema = createAgentEnvironmentInputSchema(
  acpEnvironmentNameError,
).superRefine((variable, context) => {
  if (!isAcpProfileEnvironmentName(variable.name)) return;
  if (variable.sensitive)
    context.addIssue({ code: "custom", message: "Profile directory variables cannot be secrets." });
  else if (!absolutePath.safeParse(variable.value).success)
    context.addIssue({
      code: "custom",
      message: "Profile directory variables require an absolute path.",
    });
});
export const AcpAgentSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("local"),
      executable,
      args: z
        .array(
          z
            .string()
            .max(32768)
            .refine((value) => !value.includes("\0")),
        )
        .max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("registry"),
      agentId: text(256),
      distribution: z.enum(["auto", "binary", "npx", "uvx"]),
      installationId: text(256).optional(),
      executableOverride: executable.optional(),
    })
    .strict(),
]);
export const AcpAgentInstanceFields = {
  id: text(128),
  agentDefinitionId: text(256),
  displayName: text(128),
  enabled: z.boolean(),
  source: AcpAgentSourceSchema,
  credentials: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inherit-host-profile") }).strict(),
    z.object({ kind: z.literal("isolated-home"), home: absolutePath }).strict(),
  ]),
  proxy: z.enum(["inherit-host", "isolated"]),
  authMethodId: text(256).optional(),
  customModels: z
    .array(text(256))
    .max(128)
    .refine((values) => new Set(values).size === values.length),
};
export const AcpAgentSettingsUpdateSchema = z
  .object({
    instances: z
      .array(
        z
          .object({
            ...AcpAgentInstanceFields,
            environment: z
              .array(AcpEnvironmentInputSchema)
              .max(AGENT_ENVIRONMENT_LIMIT)
              .refine(
                (values) =>
                  new Set(values.map(({ name }) => name.toUpperCase())).size === values.length,
                "Each environment variable name must be unique.",
              ),
          })
          .strict(),
      )
      .max(ACP_AGENT_INSTANCE_LIMIT),
  })
  .strict()
  .refine(
    ({ instances }) => new Set(instances.map(({ id }) => id)).size === instances.length,
    "Duplicate ACP instance identity",
  );
export type UpdateAcpAgentSettingsInput = z.infer<typeof AcpAgentSettingsUpdateSchema>;
export type AcpAgentInstanceInput = UpdateAcpAgentSettingsInput["instances"][number];
export type AcpAgentInstanceConfig = Omit<AcpAgentInstanceInput, "environment"> & {
  environment: AgentEnvironmentVariable[];
};
export interface AcpAgentSettings {
  instances: AcpAgentInstanceConfig[];
}
/** Execution application status is read from the running owner, never persisted as settings. */
export interface AcpAgentConfigurationStatus {
  readonly deferredInstanceIds: readonly string[];
  readonly configurationStatus: "applied" | "deferred" | "failed";
}
export interface AcpAgentSettingsUpdateResult
  extends AcpAgentSettings, AcpAgentConfigurationStatus {}
