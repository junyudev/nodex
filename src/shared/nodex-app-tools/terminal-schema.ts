import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const readSessionTerminalSchema = z.strictObject({
  terminalId: z.string().min(1).max(512).optional(),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024)
    .default(16 * 1024),
});

export const readSessionTerminalTool: Tool = {
  name: "read_session_terminal",
  description:
    "Read a bounded terminal buffer attached to your calling Session or Thread. If several terminals exist, returns candidates; select their exact terminalId. Includes exited terminals while their owner retains them. Never reads another Session or redirects to a globally focused terminal.",
  inputSchema: z.toJSONSchema(readSessionTerminalSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
