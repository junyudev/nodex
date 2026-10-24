import { z } from "zod";
import type { AcpMethod, AcpOperations } from "../acp-api";
const id = z.string().trim().min(1).max(256);
const instance = { instanceId: id };
const target = { ...instance, projectId: z.string().min(1).max(128).nullable().optional() };
const flow = { ...instance, flowId: id };
const operation = z.object({ operationId: id }).strict();
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
export const AcpInputSchemas = {
  "acp.registry.search": z.object({ query: z.string().trim().max(120) }).strict(),
  "acp.inspect": z.object(instance).strict(),
  "acp.install.preview": z
    .object({ agentId: id, distribution: z.enum(["auto", "binary", "npx", "uvx"]).optional() })
    .strict(),
  "acp.install.start": z
    .object({
      operationId: id,
      agentId: id,
      distribution: z.enum(["auto", "binary", "npx", "uvx"]).optional(),
      expectedInstallationId: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict(),
  "acp.registry.uninstall": z.object({ agentId: id }).strict(),
  "acp.connection.start": z.object({ ...target, operationId: id }).strict(),
  "acp.operation.read": operation,
  "acp.operation.cancel": operation,
  "acp.auth.read": z.object(instance).strict(),
  "acp.auth.start": z.object({ ...instance, methodId: id.optional() }).strict(),
  "acp.auth.respond": z.object({ ...flow, interactionId: id, response }).strict(),
  "acp.auth.complete": z
    .object({ ...flow, callbackUrl: z.string().trim().min(1).max(16384) })
    .strict(),
  "acp.auth.cancel": z.object(flow).strict(),
  "acp.auth.logout": z.object(instance).strict(),
  "acp.urlAuth.accept": z.object({ ...instance, elicitationId: id }).strict(),
  "acp.sessions.list": z.object({ ...target, cursor: z.string().max(8192).optional() }).strict(),
  "acp.sessions.prepareImport": z.object({ ...target, sessionId: id }).strict(),
  "acp.sessions.import": z
    .object({ ...target, sessionId: id, requestId: id, acceptedAt: z.number().int().nonnegative() })
    .strict(),
  "acp.sessions.delete": z.object({ ...target, sessionId: id }).strict(),
  "acp.modelProviders.list": z.object(target).strict(),
  "acp.modelProviders.set": z
    .object({
      ...target,
      providerId: id,
      apiType: z.string().trim().min(1).max(64),
      baseUrl: z
        .url()
        .max(2048)
        .refine((value) => {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
        }),
      headers: z
        .record(z.string().min(1).max(128), z.string().max(8192))
        .refine((values) => Object.keys(values).length <= 64)
        .optional(),
    })
    .strict(),
  "acp.modelProviders.disable": z.object({ ...target, providerId: id }).strict(),
} satisfies { readonly [Method in AcpMethod]: z.ZodType<AcpOperations[Method]["input"]> };
