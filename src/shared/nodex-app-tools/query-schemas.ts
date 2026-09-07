import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { components } from "@nodex/core-protocol";
import sqlQueryArtifact from "@nodex/core-protocol/runtime-schemas/SqlQuery.schema.json";
import sqlScopeArtifact from "@nodex/core-protocol/runtime-schemas/SqlScope.schema.json";
import { z } from "zod";

const fromCoreSchema = <T>(artifact: unknown): z.ZodType<T> => {
  if (typeof artifact !== "object" || artifact === null || !("$schema" in artifact))
    throw new Error("Invalid generated Core schema artifact");
  return z.fromJSONSchema(artifact as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<T>;
};

// Generated TypeScript and runtime schemas share the Rust contract and codegen verification.
export const sqlQuerySchema = fromCoreSchema<components["schemas"]["SqlQuery"]>(sqlQueryArtifact);
const sqlScopeSchema = fromCoreSchema<components["schemas"]["SqlScope"]>(sqlScopeArtifact);
export const describeContentSchemaInput = z.strictObject({
  scope: sqlScopeSchema,
  relation: z.string().max(256).nullable().optional(),
});
export const queryContentInputSchema = { ...sqlQueryArtifact, type: "object" as const };
export const describeContentInputSchema = z.toJSONSchema(
  describeContentSchemaInput,
) as Tool["inputSchema"];
