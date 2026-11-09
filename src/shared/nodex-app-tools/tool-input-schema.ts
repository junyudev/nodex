import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  flattenToolInputSchema,
  toolInputSchemaProblem,
} from "@nodex/agent-runtime/tool-input-schema";
import { z } from "zod";

/**
 * The input schema a Nodex tool advertises to every Agent: one object, even when the tool's own
 * validator accepts several exact shapes.
 */
export function toolInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const advertised = flattenToolInputSchema(z.toJSONSchema(schema, { io: "input" }));
  const problem = toolInputSchemaProblem(advertised);
  if (problem !== undefined) throw new Error(`A Nodex tool input schema ${problem}.`);
  return advertised as Tool["inputSchema"];
}
