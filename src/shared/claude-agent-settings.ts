import { z } from "zod";

export const CLAUDE_ENVIRONMENT_LIMIT = 64;
export const ENVIRONMENT_VALUE_LIMIT = 32_768;
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// Account location has one authority; nested-session markers belong to the launcher.
const RESERVED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);

export const claudeEnvironmentNameError = (name: string): string | null => {
  if (name.length > 128 || !ENVIRONMENT_NAME_PATTERN.test(name))
    return "Use a valid environment variable name.";
  if (RESERVED_ENVIRONMENT_NAMES.has(name.toUpperCase()))
    return name.toUpperCase() === "CLAUDE_CONFIG_DIR"
      ? "Use Config directory to select a Claude configuration."
      : `${name} is managed by the Claude launcher.`;
  return null;
};

export const ClaudeEnvironmentNameSchema = z
  .string()
  .trim()
  .superRefine((name, context) => {
    const message = claudeEnvironmentNameError(name);
    if (message) context.addIssue({ code: "custom", message });
  });
export const ClaudeEnvironmentValueSchema = z
  .string()
  .max(ENVIRONMENT_VALUE_LIMIT)
  .refine((value) => !value.includes("\0"), "Environment values cannot contain a null character.");
export const ClaudeEnvironmentInputSchema = z.discriminatedUnion("sensitive", [
  z
    .object({
      name: ClaudeEnvironmentNameSchema,
      sensitive: z.literal(false),
      value: ClaudeEnvironmentValueSchema,
    })
    .strict(),
  z
    .object({
      name: ClaudeEnvironmentNameSchema,
      sensitive: z.literal(true),
      value: ClaudeEnvironmentValueSchema.nullable(),
    })
    .strict(),
]);
export type ClaudeEnvironmentInput = z.infer<typeof ClaudeEnvironmentInputSchema>;
/** Null means retain the saved secret on update. Plaintext secrets never appear in reads. */
export type ClaudeEnvironmentVariable =
  | { name: string; sensitive: false; value: string }
  | { name: string; sensitive: true; value: null };

export const ClaudeAgentInstanceFields = {
  id: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(128),
  binaryPath: z.string().trim().min(1).max(4096),
  configDirectory: z.string().trim().max(4096),
  enabled: z.boolean(),
};
export const ClaudeAgentSettingsUpdateSchema = z
  .object({
    instances: z
      .array(
        z
          .object({
            ...ClaudeAgentInstanceFields,
            environment: z
              .array(ClaudeEnvironmentInputSchema)
              .max(CLAUDE_ENVIRONMENT_LIMIT)
              .refine(
                (variables) => new Set(variables.map(({ name }) => name)).size === variables.length,
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
    "Duplicate Claude instance identity",
  );
export type UpdateClaudeAgentSettingsInput = z.infer<typeof ClaudeAgentSettingsUpdateSchema>;
export type ClaudeAgentInstanceConfig = Omit<
  UpdateClaudeAgentSettingsInput["instances"][number],
  "environment"
> & {
  environment: ClaudeEnvironmentVariable[];
};
export interface ClaudeAgentSettings {
  instances: ClaudeAgentInstanceConfig[];
}

export const defaultClaudeInstance = (): ClaudeAgentInstanceConfig => ({
  id: "claude-default",
  displayName: "Claude Code",
  binaryPath: "claude",
  configDirectory: "",
  enabled: true,
  environment: [],
});
