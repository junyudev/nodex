import { z } from "zod";
import type { ANTIGRAVITY_AUTH_METHODS } from "../../packages/agent-runtime/vendor/contracts/src/settings";

export type AntigravityAuthMethod = (typeof ANTIGRAVITY_AUTH_METHODS)[number]["value"];
// Runtime settings carry Effect schemas; keep this renderer boundary Effect-free and exhaustive.
const authMethods = {
  "oauth-personal": true,
  "oauth-business": true,
  "gemini-api-key": true,
  "agent-platform": true,
} satisfies Record<AntigravityAuthMethod, true>;
export const AntigravityAgentInstanceFields = {
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  displayName: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  authMethod: z
    .enum(Object.keys(authMethods) as [AntigravityAuthMethod, ...AntigravityAuthMethod[]])
    .default("oauth-personal"),
  gcpProject: z.string().trim().max(4096),
  gcpLocation: z.string().trim().max(4096),
  binaryPath: z.string().trim().max(4096),
};
export const AntigravityAgentSettingsUpdateSchema = z
  .object({
    instances: z
      .array(
        z
          .object({
            ...AntigravityAgentInstanceFields,
            // null keeps the saved key; empty string removes it.
            apiKey: z
              .string()
              .trim()
              .max(32768)
              .refine((value) => !value.includes("\0"))
              .nullable(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .refine(
    ({ instances }) => new Set(instances.map(({ id }) => id)).size === instances.length,
    "Duplicate Antigravity instance identity",
  );
export type UpdateAntigravityAgentSettingsInput = z.input<
  typeof AntigravityAgentSettingsUpdateSchema
>;
export type AntigravityAgentInstanceConfig = Omit<
  z.output<typeof AntigravityAgentSettingsUpdateSchema>["instances"][number],
  "apiKey"
> & {
  readonly apiKey: null;
  readonly hasApiKey: boolean;
};
export interface AntigravityAgentSettings {
  instances: AntigravityAgentInstanceConfig[];
}
