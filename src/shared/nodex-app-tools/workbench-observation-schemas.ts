import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WorkbenchSceneReferenceSchema } from "./workbench";
import { FetchV3InputSchema } from "../nodex-agent-tools/v3-read-schemas";
import { PropertyIdSchema } from "../nodex-agent-tools/base-schemas";

const pageFields = {
  observationId: z.string().uuid(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  panelId: z.enum(["right", "bottom"]).optional(),
};

export const workbenchObservationSchemas = {
  get_session_context: z.strictObject({
    mode: z.enum(["anchored", "refresh"]).default("anchored"),
    target: WorkbenchSceneReferenceSchema.optional(),
  }),
  list_session_tabs: z.strictObject({
    ...pageFields,
    groupId: z.string().min(1).max(512).optional(),
  }),
  list_tab_groups: z.strictObject(pageFields),
  read_tab_content: z
    .strictObject({
      observationId: z.string().uuid(),
      tabId: z.string().min(1).max(512),
      format: FetchV3InputSchema.shape.format,
      page: FetchV3InputSchema.shape.page,
      view: z
        .strictObject({
          range: z.enum(["viewport", "loaded", "selected"]).default("viewport"),
          offset: z.number().int().min(0).max(100_000).default(0),
          limit: z.number().int().min(1).max(200).default(50),
          propertyIds: z.array(PropertyIdSchema).max(128).optional(),
        })
        .optional(),
    })
    .refine((input) => input.page === undefined || input.format === "blocks", {
      message: "page requires format=blocks",
      path: ["page"],
    }),
  query_displayed_view: z.strictObject({
    observationId: z.string().uuid(),
    tabId: z.string().min(1).max(512),
    propertyIds: z.array(PropertyIdSchema).max(128).optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
  }),
};

const descriptions: Record<keyof typeof workbenchObservationSchemas, string> = {
  get_session_context:
    "Read your execution identity and authorized Workbench presentation. Defaults to the Scene and selected targets captured when your Turn was submitted; reports subsequent changes without redirecting those targets. Use mode: refresh to explicitly inspect the submitting window's currently selected Scene, or provide an exact target returned by discovery. Multiple possible windows or Scenes return candidates. Presentation coordinates never grant content access. This reads metadata, not Page bodies.",
  list_session_tabs:
    "List authorized tab metadata and redacted restricted tabs from a get_session_context observation. Includes preview, persisted, selected and visible states. Page with nextCursor and optionally filter by panelId/groupId. An expired observation or changed renderer/presentation must be refreshed; a cursor never follows a new selected tab.",
  list_tab_groups:
    "List the existing Workbench tab groups from a get_session_context observation. Page with nextCursor; panelId optionally narrows the result. Group identities refer to the live layout and expire with the observation.",
  read_tab_content:
    "Read the exact tab returned by a Workbench observation. Page reads synchronize its mounted editor, then return canonical content and write validators; pending local edits or changed presentation require retry or a new observation. Never redirects to another selected tab. Use fetch for an explicit stable Page ID without a live-editor synchronization claim. Canvas returns metadata only. Markdown is complete or fails above 64 KiB; use bounded blocks for larger Pages.",
  query_displayed_view:
    "Query the effective rules of an observed Database View, including personal overrides and the captured search. Core verifies View/schema/preference revisions and exact content authority in one read snapshot. Select Property IDs and optionally limit the result; otherwise the result is complete or fails its budget. Returns SQL-style columns/rows/snapshot plus rule fingerprint and separate display coverage. No SQL cursor or frozen pagination session; separate calls are independent observations. Collapsed groups are included in effective-query results.",
};

export const workbenchObservationToolCatalog: readonly Tool[] = Object.entries(
  workbenchObservationSchemas,
).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
