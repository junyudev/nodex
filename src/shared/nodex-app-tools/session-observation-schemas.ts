import { sessionExecutionSchema } from "./session-execution-target";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SESSION_HISTORY_CURSOR_MAX_CHARS } from "./session-history";
import { sessionWaitLimits } from "@nodex/app-tools-mcp/manifest";

import { sessionScopeSchema } from "./session-scope";

const listSchema = z
  .strictObject({
    scope: sessionScopeSchema,
    cursor: z.string().min(1).max(4096).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .transform((value) => Math.min(value, 50))
      .default(20),
    includeSubagents: z.boolean().default(true),
    projectId: z.string().trim().min(1).max(512).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    statuses: z
      .array(
        z.enum([
          "idle",
          "active",
          "notLoaded",
          "systemError",
          "queued",
          "preparing",
          "starting",
          "running",
          "waiting",
          "completed",
          "failed",
          "interrupted",
          "cancelled",
          "rolled_back",
        ]),
      )
      .max(10)
      .optional(),
    settled: z.boolean().optional(),
    snoozed: z.boolean().optional(),
  })
  .refine((input) => input.scope !== "profile" || input.projectId === undefined, {
    message: "Choose a Project or Profile scope, not both",
    path: ["projectId"],
  });
const searchSchema = z
  .strictObject({
    scope: sessionScopeSchema,
    query: z.string().trim().min(2).max(200),
    projectId: z.string().trim().min(1).max(512).optional(),
    archived: z.boolean().default(false),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .transform((value) => Math.min(value, 50))
      .default(20),
  })
  .refine((input) => input.scope !== "profile" || input.projectId === undefined, {
    message: "Choose a Project or Profile scope, not both",
    path: ["projectId"],
  });

const waitSchema = z
  .strictObject({
    targets: z
      .array(
        z.strictObject({
          sessionId: z.string().trim().min(1).max(512),
          execution: sessionExecutionSchema.optional(),
          runId: z.string().trim().min(1).max(512).optional(),
          afterCursor: z.string().min(1).max(4096).optional(),
        }),
      )
      .min(1)
      .max(8)
      .refine(
        (targets) =>
          new Set(
            targets.map((target) =>
              JSON.stringify([target.sessionId, target.execution?.threadId ?? null]),
            ),
          ).size === targets.length,
        "Session targets must be unique",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(sessionWaitLimits(1).maximumMs)
      .describe(
        "One target: default 600000, max 3600000 ms. Multiple targets: default/max 120000 ms.",
      )
      .optional(),
  })
  .superRefine((input, context) => {
    if (
      input.timeoutMs !== undefined &&
      input.timeoutMs > sessionWaitLimits(input.targets.length).maximumMs
    )
      context.addIssue({
        code: "custom",
        path: ["timeoutMs"],
        message: "Multiple Session waits support at most 120000 ms.",
      });
  })
  .transform((input) => ({
    ...input,
    timeoutMs: input.timeoutMs ?? sessionWaitLimits(input.targets.length).defaultMs,
  }));

export const sessionObservationSchemas = {
  wait_sessions: waitSchema,
  search_sessions: searchSchema,
  list_sessions: listSchema,
  list_archived_sessions: listSchema,
  read_session: z
    .strictObject({
      execution: sessionExecutionSchema.optional(),
      runId: z.string().trim().min(1).max(512).optional(),
      itemId: z.string().trim().min(1).max(4096).optional(),
      sourceThreadId: z.string().trim().min(1).max(4096).optional(),
      textOffset: z.number().int().min(0).optional(),
      sessionId: z.string().trim().min(1).max(512).optional(),
      cursor: z.string().min(1).max(SESSION_HISTORY_CURSOR_MAX_CHARS).optional(),
      view: z.enum(["messages", "activity"]).optional(),
      order: z.enum(["newest_first", "oldest_first"]).optional(),
      runLimit: z
        .number()
        .int()
        .min(1)
        .transform((value) => Math.min(value, 50))
        .default(10),
      runCursor: z.string().min(1).max(4096).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .transform((value) => Math.min(value, 50))
        .default(20),
      maxCharsPerItem: z
        .number()
        .int()
        .min(1)
        .transform((value) => Math.min(value, 8000))
        .default(2000),
    })
    .superRefine((input, context) => {
      if (
        input.cursor !== undefined &&
        (input.itemId !== undefined ||
          input.runId !== undefined ||
          input.sourceThreadId !== undefined ||
          input.textOffset !== undefined)
      )
        context.addIssue({ code: "custom", message: "Use a cursor or an item address, not both" });
      if (
        input.itemId === undefined &&
        (input.runId !== undefined ||
          input.sourceThreadId !== undefined ||
          input.textOffset !== undefined)
      )
        context.addIssue({
          code: "custom",
          message: "runId, sourceThreadId and textOffset require itemId",
        });
    }),
};

export const sessionObservationToolCatalog: readonly Tool[] = [
  {
    name: "search_sessions",
    description:
      "Search Session titles, branches, pull requests, Projects and historical user/assistant messages in the calling Project or projectless lane. Use scope: profile for every Project, or projectId for an explicit Project. Returns ranked matches, exact item coordinates, current placement, source coverage and continuation. A preparing response retains its query; unavailable sources remain retryable. Pass a match's sessionId, itemId and sourceThreadId to read_session for full content.",
    inputSchema: z.toJSONSchema(searchSchema, { io: "input" }) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "wait_sessions",
    description:
      "Wait for the first of up to eight Sessions in the current Profile to reach a terminal state or become unavailable, with per-target errors. Active Runs awaiting approval or a plan keep waiting. execution.threadId selects a Runtime child within its Session. One target defaults to ten minutes and supports up to one hour; multiple targets retain a two-minute default and maximum. Each target pins the latest Run when the call starts, or pass runId for a specific Run. Automatic restart continuations stay in the same wait; unrelated newer Runs never replace it. Results return selectedRunId and the resolved runId. Use timeoutMs: 0 for an immediate snapshot. Pass each returned cursor as afterCursor to avoid repeating unchanged completion/progress. Core, native and Runtime events drive the same observer for every caller. Results include compact status, latest reply text with its read_session continuation and latest tool status. Progress coverage and response-budget deferral are explicit. Waits end when the calling Turn is cancelled. An unloaded backend is explicitly unavailable; it is not resumed by observation.",
    inputSchema: z.toJSONSchema(waitSchema, { io: "input" }) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  ...(["list_sessions", "list_archived_sessions"] as const).map((name): Tool => ({
    name,
    description: `List ${name === "list_sessions" ? "active" : "archived"} Sessions in the calling Project, or its projectless lane, in conversation-recency order. Use scope: profile for every Project, or projectId for an explicit Project. Runtime child executions are included by default; set includeSubagents: false for roots. Filter by title/preview query. Results include bounded previews, placement, source availability and a continuation cursor. A short or empty page may still have nextCursor; continue until null. If a source is unavailable, stop and retry later.`,
    inputSchema: z.toJSONSchema(listSchema, { io: "input" }) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })),
  {
    name: "read_session",
    description:
      "Read a Session without opening or resuming it; omit sessionId for your calling Session. messages returns messages and plans; activity returns complete typed JSON including tools, file changes and attachments. Default newest_first pages older items; oldest_first reads forward and its tailCursor resumes future appends. Preserve history.page.nextCursor separately from each content.nextCursor for exact text/JSON continuation. Execution metadata includes provenance, lineage, counts and recent Runs; execution.runsPage.nextCursor continues Run summaries via runCursor. Pass itemId and optional sourceThreadId/runId/textOffset to read a search hit directly. Sources without point lookup return page.locating and a nextCursor until found. execution.threadId selects a Runtime child within this Session. Positive quantity budgets normalize to safe limits, and the complete response budget remains fixed. Changed content reports cursor_stale. A direct parent reading a complete terminal child result acknowledges its task delivery.",
    inputSchema: z.toJSONSchema(sessionObservationSchemas.read_session, {
      io: "input",
    }) as Tool["inputSchema"],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];
