import { z } from "zod";
import {
  AGENT_ENVIRONMENT_LIMIT,
  ENVIRONMENT_NAME_PATTERN,
  createAgentEnvironmentInputSchema,
  type AgentEnvironmentVariable,
} from "./agent-environment";

export const OPENCODE_ENVIRONMENT_LIMIT = AGENT_ENVIRONMENT_LIMIT;
export const OPENCODE_MANAGED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TEST_HOME",
  "OPENCODE_AUTH_CONTENT",
]);
export const openCodeEnvironmentNameError = (name: string): string | null => {
  if (name.length > 128 || !ENVIRONMENT_NAME_PATTERN.test(name))
    return "Use a valid environment variable name.";
  if (OPENCODE_MANAGED_ENVIRONMENT_NAMES.has(name.toUpperCase()))
    return `${name} is managed by the OpenCode profile.`;
  return null;
};
export const OpenCodeEnvironmentInputSchema = createAgentEnvironmentInputSchema(
  openCodeEnvironmentNameError,
);
const profileDirectory = z
  .string()
  .trim()
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("~/") ||
      /^[A-Za-z]:[\\/]/u.test(value) ||
      value.startsWith("\\\\"),
    "Use an absolute path or a path starting with ~/.",
  )
  .nullable();
export const OpenCodeAgentInstanceFields = {
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  displayName: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  binaryPath: z.string().trim().min(1).max(4096),
  profileDirectory,
  serverUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    }, "Use an HTTP or HTTPS server URL without credentials.")
    .nullable(),
};
export const OpenCodeAgentSettingsUpdateSchema = z
  .object({
    instances: z
      .array(
        z
          .object({
            ...OpenCodeAgentInstanceFields,
            environment: z
              .array(OpenCodeEnvironmentInputSchema)
              .max(OPENCODE_ENVIRONMENT_LIMIT)
              .refine(
                (values) => new Set(values.map(({ name }) => name)).size === values.length,
                "Each environment variable name must be unique.",
              ),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .refine(
    ({ instances }) => new Set(instances.map(({ id }) => id)).size === instances.length,
    "Duplicate OpenCode instance identity",
  );
export type UpdateOpenCodeAgentSettingsInput = z.infer<typeof OpenCodeAgentSettingsUpdateSchema>;
export type OpenCodeAgentInstanceConfig = Omit<
  UpdateOpenCodeAgentSettingsInput["instances"][number],
  "environment"
> & { environment: AgentEnvironmentVariable[] };
export interface OpenCodeAgentSettings {
  instances: OpenCodeAgentInstanceConfig[];
}
export const defaultOpenCodeInstance = (): OpenCodeAgentInstanceConfig => ({
  id: "opencode-default",
  displayName: "OpenCode",
  enabled: false,
  binaryPath: "opencode",
  profileDirectory: null,
  serverUrl: null,
  environment: [],
});
