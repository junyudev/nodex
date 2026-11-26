import { CHAT_ATTENTION_LANES } from "../chat-attention-lane";
import { sessionExecutionSchema } from "./session-execution-target";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SESSION_HISTORY_CURSOR_MAX_CHARS } from "./session-history";
import { sessionWaitLimits } from "@nodex/app-tools-mcp/manifest";

import { sessionScopeSchema } from "./session-scope";
import { toolInputSchema } from "./tool-input-schema";

const listArchivedSchema = z
  .strictObject({
    scope: sessionScopeSchema,
    cursor: z
      .string()

      .min(1)
      .max(4096)
      .optional(),
    limit: z.number().int().min(1).default(20),
    includeSubagents: z.boolean().default(true),
    projectId: z
      .string()
      .regex(/\S/, "Must contain a non-whitespace character")
      .min(1)
      .max(512)
      .optional(),
    query: z
      .string()
      .regex(/\S/, "Must contain a non-whitespace character")
      .min(1)
      .max(200)
      .optional(),
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
  })
  .refine((input) => input.scope !== "profile" || input.projectId === undefined, {
    message: "Choose a Project or Profile scope, not both",
    path: ["projectId"],
  });

const listSchema = listArchivedSchema.safeExtend({
  lanes: z.array(z.enum(CHAT_ATTENTION_LANES)).max(CHAT_ATTENTION_LANES.length).optional(),
  order: z.enum(["recency", "attention"]).default("recency"),
});

const waitSchema = z
  .strictObject({
    targets: z
      .array(
        z.strictObject({
          sessionId: z
            .string()
            .regex(/\S/, "Must contain a non-whitespace character")
            .min(1)
            .max(512),
          execution: sessionExecutionSchema.optional(),
          runId: z
            .string()
            .regex(/\S/, "Must contain a non-whitespace character")
            .min(1)
            .max(512)
            .optional(),
          afterCursor: z
            .string()

            .min(1)
            .max(4096)
            .optional(),
        }),
      )
      .min(1)
      .max(8)
      .describe("Each Session and execution.threadId pair must be unique"),
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
    const identities = input.targets.map((target) =>
      JSON.stringify([target.sessionId, target.execution?.threadId ?? null]),
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Session targets must be unique",
      });
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
  list_sessions: listSchema,
  list_archived_sessions: listArchivedSchema,
  read_session: z
    .strictObject({
      execution: sessionExecutionSchema.optional(),
      runId: z
        .string()
        .regex(/\S/, "Must contain a non-whitespace character")
        .min(1)
        .max(512)
        .optional(),
      itemId: z
        .string()
        .regex(/\S/, "Must contain a non-whitespace character")
        .min(1)
        .max(4096)
        .optional(),
      sourceThreadId: z
        .string()
        .regex(/\S/, "Must contain a non-whitespace character")
        .min(1)
        .max(4096)
        .optional(),
      textOffset: z.number().int().min(0).optional(),
      sessionId: z
        .string()
        .regex(/\S/, "Must contain a non-whitespace character")
        .min(1)
        .max(512)
        .optional(),
      cursor: z
        .string()

        .min(1)
        .max(SESSION_HISTORY_CURSOR_MAX_CHARS)
        .optional(),
      view: z.enum(["messages", "activity"]).optional(),
      order: z.enum(["newest_first", "oldest_first"]).optional(),
      runLimit: z.number().int().min(1).default(10),
      runCursor: z
        .string()

        .min(1)
        .max(4096)
        .optional(),
      limit: z.number().int().min(1).default(20),
      maxCharsPerItem: z.number().int().min(1).default(2000),
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
    name: "wait_sessions",
    description:
      "Wait for the first of up to eight Sessions in the current Profile to reach a terminal state, become unavailable, or start waiting on its person: a live question, secret or approval, with per-target errors. Asynchronous questions do not end a wait while work continues. Answer questions with session_question; approvals need the user. execution.threadId selects a Runtime child within its Session. One target defaults to ten minutes and supports up to one hour; multiple targets retain a two-minute default and maximum. Each target pins the latest Run when the call starts, or pass runId for a specific Run. Automatic restart continuations stay in the same wait; unrelated newer Runs never replace it. Results return selectedRunId and the resolved runId. Use timeoutMs: 0 for an immediate snapshot. Pass each returned cursor as afterCursor to avoid repeating unchanged completion, attention or progress. Core, native and Runtime events drive the same observer for every caller. Results include compact status, latest reply text with its read_session continuation and latest tool status. Progress coverage and response-budget deferral are explicit. Waits end when the calling Turn is cancelled. An unloaded backend is explicitly unavailable; it is not resumed by observation.",
    inputSchema: toolInputSchema(waitSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_sessions",
    description:
      'List chats in conversation-recency order by default. Use scope: "profile" for every Project or projectId for one Project. Use includeSubagents: false for chat roots only. Each row has the calling Member’s attention, including lane, waitingOn, working and unread. Working lane: {scope:"profile", lanes:["working"]}. Snoozed soonest first: {scope:"profile", lanes:["snoozed"], order:"attention"}. To review what’s on the person’s plate: {scope:"profile", lanes:["active","working","snoozed"], order:"attention"}. Pins have their own lane, so inspect attention.working or attention.waitingOn across lanes to include them. Filter by title/preview query or status. Continue short or empty pages until nextCursor is null. If a source is unavailable, retry later.',
    inputSchema: toolInputSchema(listSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_archived_sessions",
    description:
      'List archived chats in conversation-recency order. Use scope: "profile" for every Project or projectId for one Project. Use includeSubagents: false for chat roots only. Filter by title/preview query or status. Each row has the calling Member’s attention marks and a null lane. Continue short or empty pages until nextCursor is null. If a source is unavailable, retry later.',
    inputSchema: toolInputSchema(listArchivedSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "read_session",
    description:
      "Read a Session without opening or resuming it; omit sessionId for your calling Session. The attention block describes the whole chat for the calling Member, including when reading a child execution. messages returns messages and plans; activity returns complete typed JSON including tools, file changes and attachments. Default newest_first pages older items; oldest_first reads forward and its tailCursor resumes future appends. Preserve history.page.nextCursor separately from each content.nextCursor for exact text/JSON continuation. Execution metadata includes provenance, lineage, counts and recent Runs; execution.runsPage.nextCursor continues Run summaries via runCursor. Pass itemId and optional sourceThreadId/runId/textOffset to read a search hit directly. Sources without point lookup return page.locating and a nextCursor until found. execution.threadId selects a Runtime child within this Session. Positive quantity budgets normalize to safe limits, and the complete response budget remains fixed. Changed content reports cursor_stale. A direct parent reading a complete terminal child result acknowledges its task delivery.",
    inputSchema: toolInputSchema(sessionObservationSchemas.read_session),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

/** Quantity budgets normalize after shape validation; they never add hidden input constraints. */
export const normalizeSessionObservationArguments = <T extends Record<string, unknown>>(
  input: T,
): T => ({
  ...input,
  ...Object.fromEntries(
    Object.entries({ limit: 50, runLimit: 50, maxCharsPerItem: 8000 }).flatMap(
      ([field, maximum]) =>
        typeof input[field] === "number" ? [[field, Math.min(input[field], maximum)]] : [],
    ),
  ),
});
