import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const identity = z.string().min(1).max(512);
const panelId = z.enum(["right", "bottom"]);
const base = { observationId: z.string().uuid(), operationId: identity.optional() };
const group = { panelId, groupId: identity };
const side = z.enum(["left", "right", "up", "down"]);
const openTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("page"), pageId: identity }),
  z.strictObject({ kind: z.literal("view"), viewId: identity }),
  z.strictObject({ kind: z.literal("canvas"), canvasId: identity }),
  z.strictObject({
    kind: z.literal("browser"),
    url: z
      .string()
      .max(16_384)
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  }),
  z.strictObject({ kind: z.literal("files"), path: z.string().min(1).max(4_096).optional() }),
  z.strictObject({ kind: z.literal("review") }),
  z.strictObject({ kind: z.literal("terminal") }),
]);
export const workbenchControlSchemas = {
  open_tab: z.strictObject({ ...base, ...group, target: openTarget }),
  activate_tab: z.strictObject({ ...base, tabId: identity }),
  close_tab: z.strictObject({ ...base, tabId: identity }),
  move_tab: z.strictObject({
    ...base,
    ...group,
    tabId: identity,
    index: z.number().int().min(0).max(2_048),
    splitSide: side.optional(),
  }),
  reorder_tabs: z.strictObject({
    ...base,
    ...group,
    tabIds: z
      .array(identity)
      .max(2_048)
      .refine((items) => new Set(items).size === items.length, "Tab handles must be unique"),
  }),
  split_tab_group: z.strictObject({ ...base, ...group, side, tabId: identity.optional() }),
  merge_tab_group: z.strictObject({ ...base, ...group }),
  set_panel_state: z
    .strictObject({
      ...base,
      panelId,
      collapsed: z.boolean().optional(),
      maximizedGroupId: identity.nullable().optional(),
      size: z
        .strictObject({
          widthPx: z.number().finite().min(180).max(8_192).optional(),
          heightPx: z.number().finite().min(120).max(8_192).optional(),
          fullWidth: z.boolean().optional(),
        })
        .optional(),
    })
    .refine(
      (input) =>
        input.collapsed !== undefined ||
        input.maximizedGroupId !== undefined ||
        input.size !== undefined,
      "Specify a panel change",
    ),
};

const descriptions: Record<keyof typeof workbenchControlSchemas, string> = {
  open_tab:
    "Open a semantic Page, View, Canvas, Browser URL, Files, Review or Terminal target in a group returned by list_tab_groups. Nodex resolves runtime identities and checks content access. Does not navigate another window or expose arbitrary saved layout/configuration fields.",
  activate_tab: "Select an observed tab through the normal Workbench lifecycle.",
  close_tab:
    "Close an observed tab, saving its content and releasing its view attachment through the normal Workbench lifecycle. Protected primary tabs cannot close.",
  move_tab:
    "Move an observed tab to an existing group and index, optionally splitting at that edge. Protected primary placement and transient-tab constraints are preserved.",
  reorder_tabs:
    "Replace the complete observed order of one tab group. Include every tab handle in that group exactly once.",
  split_tab_group:
    "Split an existing group at an edge, optionally moving one observed tab into the new group.",
  merge_tab_group: "Merge a group with its sibling through the existing Workbench layout rules.",
  set_panel_state:
    "Change a panel's collapse, size or maximized group. This does not replace the complete layout.",
};
export const workbenchControlToolCatalog: readonly Tool[] = Object.entries(
  workbenchControlSchemas,
).map(([name, schema]) => ({
  name,
  description: `${descriptions[name as keyof typeof descriptions]} Use observation-scoped handles. Commands check the observed revision atomically; refresh context after a successful change. Reuse operationId only for an exact retry.`,
  inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}));
