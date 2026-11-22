import { AgentBackendBindingSchema } from "./agent-backend";
import { z } from "zod";
import type { AgentAccountOperations } from "../agent-accounts-api";

const id = z.string().trim().min(1).max(256);
const target = {
  backend: AgentBackendBindingSchema,
};
const flow = { ...target, flowId: id };
const response = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser"), action: z.enum(["accept", "decline"]) }).strict(),
  z
    .object({
      type: z.literal("terminal"),
      data: z.string().max(4096),
      size: z
        .object({ cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(200) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("credentials"),
      values: z
        .record(z.string().min(1).max(128), z.string().max(16384))
        .refine((values) => Object.keys(values).length <= 16),
    })
    .strict(),
]);
export const AgentAccountInputSchemas = {
  read: z.object(target).strict(),
  start: z.object({ ...target, methodId: id.optional() }).strict(),
  respond: z.object({ ...flow, interactionId: id, response }).strict(),
  complete: z.object({ ...flow, callbackUrl: z.string().trim().min(1).max(16384) }).strict(),
  cancel: z.object(flow).strict(),
  logout: z.object(target).strict(),
} satisfies {
  readonly [Action in keyof AgentAccountOperations]: z.ZodType<
    AgentAccountOperations[Action]["input"]
  >;
};
