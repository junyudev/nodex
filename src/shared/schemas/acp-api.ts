import { z } from "zod";
import type { AcpMethod, AcpOperations } from "../acp-api";
const id = z.string().trim().min(1).max(256);
const nativeSessionId = z.string().min(1).max(1024);
const instance = { instanceId: id };
const target = { ...instance, projectId: z.string().min(1).max(128).nullable().optional() };
const operation = z.object({ operationId: id }).strict();
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
  "acp.urlAuth.accept": z.object({ ...instance, elicitationId: id }).strict(),
  "acp.sessions.list": z.object({ ...target, cursor: z.string().max(8192).optional() }).strict(),
  "acp.sessions.prepareImport": z.object({ ...target, sessionId: nativeSessionId }).strict(),
  "acp.sessions.import": z
    .object({
      ...target,
      sessionId: nativeSessionId,
      requestId: id,
      acceptedAt: z.number().int().nonnegative(),
    })
    .strict(),
  "acp.sessions.delete": z.object({ ...target, sessionId: nativeSessionId }).strict(),
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
