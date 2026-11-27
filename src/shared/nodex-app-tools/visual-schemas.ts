import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { toolInputSchema } from "./tool-input-schema";
import { VISUAL_LIMITS } from "../visual/contract";

const blockId = z.string().min(1).max(512);
export const visualCheckSchema = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(VISUAL_LIMITS.textBytes)
    .describe("Raw JSX source inside the visual fence"),
  blockId: blockId.optional().describe("Use this Block's Page for File and table sources"),
});

export const visualSnapshotSchema = z.strictObject({
  blockId,
  theme: z.enum(["light", "dark"]).optional().describe("Defaults to both appearances"),
});

export const visualToolCatalog = [
  {
    name: "visual_check",
    description:
      "Check a Visual before writing it. Returns contract errors and render warnings with source locations, plus light and dark PNG screenshots when renderable. Fix errors and review measured overlaps and clipping, then write the Visual once.",
    inputSchema: toolInputSchema(visualCheckSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "visual_snapshot",
    description:
      "Render the current Visual Block to PNG and self-contained SVG in either or both appearances. Resolves only the Block's own Page sources. Returns the snapshots without writing a Page File.",
    inputSchema: toolInputSchema(visualSnapshotSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const satisfies readonly Tool[];
