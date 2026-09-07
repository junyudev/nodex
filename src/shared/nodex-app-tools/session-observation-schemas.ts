import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const listSchema = z.strictObject({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const sessionObservationSchemas = {
  wait_sessions: z.strictObject({
    targets: z
      .array(
        z.strictObject({
          sessionId: z.string().trim().min(1).max(512),
          afterCursor: z.string().min(1).max(4096).optional(),
        }),
      )
      .min(1)
      .max(8)
      .refine(
        (targets) => new Set(targets.map((target) => target.sessionId)).size === targets.length,
        "Session targets must be unique",
      ),
    timeoutMs: z.number().int().min(0).max(120000).default(120000),
  }),
  list_sessions: listSchema,
  list_archived_sessions: listSchema,
  read_session: z.strictObject({
    sessionId: z.string().trim().min(1).max(512).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    turnLimit: z.number().int().min(1).max(20).default(3),
    includeOutputs: z.boolean().default(false),
    maxOutputCharsPerItem: z.number().int().min(0).max(8000).default(300),
  }),
};

export const sessionObservationToolCatalog: readonly Tool[] = [
  {
    name: "wait_sessions",
    description:
      "Wait for the first of up to eight authorized Sessions to complete or need attention, with per-target errors. Use timeoutMs: 0 for an immediate snapshot. Pass each returned cursor as afterCursor to avoid repeating unchanged completion/history. Waits use backend and Workspace events, return compact status on timeout, and end when the calling Turn is cancelled. An unloaded backend is explicitly unavailable; it is not resumed by observation.",
    inputSchema: z.toJSONSchema(sessionObservationSchemas.wait_sessions) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  ...(["list_sessions", "list_archived_sessions"] as const).map((name): Tool => ({
    name,
    description: `List ${name === "list_sessions" ? "active" : "archived"} Sessions across the current Profile, including projectless Sessions, in pinned-first recency order. Returns bounded metadata and explicit direct/inherited sidebar placement, not conversation bodies. Continue with nextCursor; discovery does not grant transcript access.`,
    inputSchema: z.toJSONSchema(listSchema) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })),
  {
    name: "read_session",
    description:
      "Read bounded Session status and recent conversation history without opening a window. Omit sessionId for your calling Session. Project-scoped callers can read their Project; verified Full access permits other Sessions in the same Profile. Drafts return empty history; an unloaded ACP backend returns explicit unavailability. Reuse nextCursor for older turns; reduce limits if the result exceeds its budget.",
    inputSchema: z.toJSONSchema(sessionObservationSchemas.read_session) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];
