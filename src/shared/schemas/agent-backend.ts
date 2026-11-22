import { PROVIDER_SLUG_MAX_CHARS, PROVIDER_SLUG_PATTERN } from "@nodex/agent-runtime/contracts";
import { z } from "zod";
import type { AgentBackendBinding } from "../agent-backend";

const providerSlug = z.string().min(1).max(PROVIDER_SLUG_MAX_CHARS).regex(PROVIDER_SLUG_PATTERN);

export const AgentBackendBindingSchema = z.strictObject({
  driver: providerSlug,
  instanceId: providerSlug,
}) satisfies z.ZodType<AgentBackendBinding>;
