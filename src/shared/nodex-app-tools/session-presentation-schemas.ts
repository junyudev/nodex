import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WorkbenchWindowReferenceSchema } from "./workbench";

const identity = z.string().min(1).max(512);
const path = z.string().min(1).max(4_096);
const webUrl = z
  .string()
  .max(16_384)
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const common = {
  window: WorkbenchWindowReferenceSchema.optional(),
  operationId: identity.optional(),
};
export const sessionPresentationSchemas = {
  navigate_to_session: z.strictObject({ ...common, sessionId: identity }),
  open_in_nodex: z.strictObject({
    ...common,
    sessionId: identity.optional(),
    placement: z.enum(["right", "bottom"]).default("right"),
    target: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("file"),
        path,
        line: z.number().int().min(1).max(10_000_000).optional(),
      }),
      z
        .strictObject({
          kind: z.literal("browser"),
          url: webUrl.optional(),
          tabId: identity.optional(),
        })
        .refine(
          (input) => Number(input.url !== undefined) + Number(input.tabId !== undefined) === 1,
          "Choose a URL or an existing Browser tab identity",
        ),
      z.strictObject({ kind: z.literal("terminal"), terminalId: identity.optional() }),
      z
        .strictObject({
          kind: z.literal("review"),
          view: z.enum(["last-turn", "branch", "unstaged", "staged"]).optional(),
          baseBranch: identity.optional(),
          path: path.optional(),
        })
        .refine(
          (input) =>
            input.baseBranch === undefined || input.view === undefined || input.view === "branch",
          "A base branch requires branch review",
        ),
      z.strictObject({ kind: z.literal("page"), pageId: identity }),
      z.strictObject({ kind: z.literal("view"), viewId: identity }),
      z.strictObject({ kind: z.literal("canvas"), canvasId: identity }),
    ]),
  }),
};

const descriptions: Record<keyof typeof sessionPresentationSchemas, string> = {
  navigate_to_session:
    "Show an authorized Session in the calling Turn's submission window and wait for its navigation receipt. An explicit window must be a current window reference returned by Workbench context. Never infers global focus.",
  open_in_nodex:
    "Open a file (optionally at a line), Browser URL or existing Browser tab, Terminal, Review, Page, View or Canvas in the calling Session's panel. Set sessionId only for an explicitly requested other Session. Hidden Sessions retain the opened tab without navigating there. Existing Browser and Terminal identities must belong to that Session. Local workspace targets require a local Session. Returns the exact window and Scene receipt; this opens presentation and does not read file contents or execute shell commands on behalf of the Agent.",
};
export const sessionPresentationToolCatalog: readonly Tool[] = Object.entries(
  sessionPresentationSchemas,
).map(([name, schema]) => ({
  name,
  description: `${descriptions[name as keyof typeof descriptions]} Without a submission window, supply an explicit returned window reference. Reuse operationId only for an exact retry.`,
  inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}));
