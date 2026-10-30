import { z } from "zod";
import type { AgentBackendBinding } from "../agent-backend";

// A new backend must supply a boundary decoder before it can become a durable binding.
const runtimeInstanceId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,127}$/u)
  .optional();
const variants = {
  codex: z.object({ kind: z.literal("codex"), runtimeInstanceId }).strict(),
  claude: z
    .object({
      kind: z.literal("claude"),
      runtimeInstanceId,
      instanceConfigId: z.string().trim().min(1).max(512),
    })
    .strict(),
  opencode: z
    .object({
      kind: z.literal("opencode"),
      runtimeInstanceId,
      instanceConfigId: z.string().trim().min(1).max(128),
    })
    .strict(),
  acp: z
    .object({
      kind: z.literal("acp"),
      runtimeInstanceId,
      agentDefinitionId: z.string().trim().min(1).max(512),
      instanceConfigId: z.string().trim().min(1).max(512).nullable(),
    })
    .strict(),
} satisfies {
  [Kind in AgentBackendBinding["kind"]]: z.ZodType<Extract<AgentBackendBinding, { kind: Kind }>>;
};

const { codex, ...otherVariants } = variants;
export const AgentBackendBindingSchema = z.discriminatedUnion("kind", [
  codex,
  ...Object.values(otherVariants),
]);
