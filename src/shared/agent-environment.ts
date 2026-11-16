import { defineMessages, type MessageDescriptor } from "./i18n/messages";
import { z } from "zod";

export type FormatEnvironmentValidation = (
  message: MessageDescriptor,
  values?: { name: string },
) => string;

export const AGENT_ENVIRONMENT_NAME_MESSAGES = defineMessages({
  invalid: {
    id: "shared.agentEnvironment.invalidName",
    defaultMessage: "Use a valid environment variable name.",
  },
  claudeConfig: {
    id: "shared.agentEnvironment.claudeConfig",
    defaultMessage: "Use Config directory to select a Claude configuration.",
  },
  claudeManaged: {
    id: "shared.agentEnvironment.claudeManaged",
    defaultMessage: "{name} is managed by the Claude launcher.",
  },
  openCodeManaged: {
    id: "shared.agentEnvironment.openCodeManaged",
    defaultMessage: "{name} is managed by the OpenCode profile.",
  },
  acpManaged: {
    id: "shared.agentEnvironment.acpManaged",
    defaultMessage: "{name} is managed by the Agent profile.",
  },
});

export const AGENT_ENVIRONMENT_LIMIT = 64;
export const ENVIRONMENT_VALUE_LIMIT = 32_768;
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type AgentEnvironmentInput =
  | { name: string; sensitive: false; value: string }
  | { name: string; sensitive: true; value: string | null };
/** A null secret value retains its saved ciphertext; reads never contain plaintext secrets. */
export type AgentEnvironmentVariable =
  | { name: string; sensitive: false; value: string }
  | { name: string; sensitive: true; value: null };

export const AgentEnvironmentValueSchema = z
  .string()
  .max(ENVIRONMENT_VALUE_LIMIT)
  .refine((value) => !value.includes("\0"), "Environment values cannot contain a null character.");

export function createAgentEnvironmentInputSchema(nameError: (name: string) => string | null) {
  const name = z
    .string()
    .trim()
    .superRefine((value, context) => {
      const message = nameError(value);
      if (message) context.addIssue({ code: "custom", message });
    });
  return z.discriminatedUnion("sensitive", [
    z.object({ name, sensitive: z.literal(false), value: AgentEnvironmentValueSchema }).strict(),
    z
      .object({ name, sensitive: z.literal(true), value: AgentEnvironmentValueSchema.nullable() })
      .strict(),
  ]);
}
