import { z } from "zod";
import type { AgentBackendBinding } from "../agent-backend";

// A new backend must supply a boundary decoder before it can become a durable binding.
const variants = {
  codex: z.object({ kind: z.literal("codex") }).strict(),
  claude: z
    .object({ kind: z.literal("claude"), instanceConfigId: z.string().trim().min(1).max(512) })
    .strict(),
  acp: z
    .object({
      kind: z.literal("acp"),
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
