import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

const id = z.string().trim().min(1).max(512);
const windowFields = {
  after: z.string().max(4096).nullable().optional(),
  first: z.number().int().min(1).max(100).default(20),
};
const operationFields = {
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
};
const revisionFields = { sectionId: id, expectedRevision: z.number().int().positive() };
export const sidebarSchemas = {
  list_sidebar_sections: z.strictObject(windowFields),
  list_sidebar_section_items: z.strictObject({ sectionId: id, ...windowFields }),
  list_sidebar_order: z.strictObject({
    sectionId: id,
    itemKind: z.enum(["project", "session"]),
    ...windowFields,
  }),
  reorder_sidebar_projects: z.strictObject({
    ...operationFields,
    sectionId: id,
    projectIds: z.array(id).max(10_000),
    expectedOrderRevision: id,
  }),
  reorder_section: z.union([
    z.strictObject({
      ...operationFields,
      sectionId: id,
      items: z
        .array(
          z.strictObject({
            placementId: id,
            expectedRevision: z.number().int().positive(),
            expectedRankKey: z.number().int().nonnegative(),
          }),
        )
        .max(10_000),
    }),
    z.strictObject({
      ...operationFields,
      sectionId: id,
      sessionIds: z.array(id).max(10_000),
      expectedOrderRevision: id,
    }),
  ]),
  create_sidebar_section: z.strictObject({
    ...operationFields,
    name: z.string().trim().min(1).max(256),
  }),
  rename_sidebar_section: z.strictObject({
    ...operationFields,
    ...revisionFields,
    name: z.string().trim().min(1).max(256),
  }),
  delete_sidebar_section: z.strictObject({ ...operationFields, ...revisionFields }),
  move_project_to_sidebar_section: z.strictObject({
    ...operationFields,
    projectId: id,
    sectionId: id.nullable(),
  }),
  move_session_to_sidebar_section: z.strictObject({
    ...operationFields,
    sessionId: id,
    sectionId: id.nullable(),
  }),
  reorder_sidebar_sections: z.strictObject({
    ...operationFields,
    sectionIds: z.array(id).max(100),
  }),
};

const descriptions: Record<keyof typeof sidebarSchemas, string> = {
  list_sidebar_order:
    "Read one complete built-in Sidebar order lane using a canonical Section ID. Projects accepts itemKind project; Pinned accepts project or session. Pinned Sessions include drafts and ACP Sessions. Follow every page and retain the orderRevision before reordering. Membership or ordering changes invalidate continuations.",
  reorder_sidebar_projects:
    "Move the listed Projects to the front of the built-in Projects or Pinned Section in the supplied order; unlisted Projects retain their relative order. Supply unique current projectIds and the orderRevision from list_sidebar_order. An empty list leaves the order unchanged. Concurrent membership or order changes reject the whole command. Reuse operationId and identical arguments to reconcile retries.",
  list_sidebar_section_items:
    "List a custom Sidebar Section's direct Project and Session placements in mixed order, including archived items. Follow every page before reordering. Returns placementId, revision and rankKey for each item; Project-inherited Sessions are not separate placements.",
  reorder_section:
    "Atomically reorder every direct Project and Session placement in a custom Sidebar Section. Read all list_sidebar_section_items pages first, then supply every placementId exactly once in desired order with its observed revision as expectedRevision and rankKey as expectedRankKey. Concurrent placement changes reject the whole command; reread before trying a new order. Reuse operationId and identical arguments to reconcile an uncertain result. For the built-in Pinned Section, use sessionIds and expectedOrderRevision instead of items after reading all list_sidebar_order pages for itemKind session. Include every pinned Session, including drafts and ACP Sessions, exactly once. Pages and Chats have no manual item order.",
  list_sidebar_sections:
    "List active Sidebar Sections with canonical IDs, kinds, revisions and a pagination cursor. Use these IDs for organization commands.",
  create_sidebar_section:
    "Create a custom Sidebar Section. Returns the section and operation receipt. Reuse a returned operationId to reconcile a retry.",
  rename_sidebar_section:
    "Rename a custom Sidebar Section at its observed revision. Use list_sidebar_sections to obtain its current revision.",
  delete_sidebar_section:
    "Delete a custom Sidebar Section at its observed revision. Its Projects, Sessions and content remain available.",
  move_project_to_sidebar_section:
    "Move a Project to an exact Sidebar Section ID returned by list_sidebar_sections, or null for the default placement. Does not change content access.",
  move_session_to_sidebar_section:
    "Move a Session, including a Session without a Thread or using ACP, to an exact Sidebar Section ID or null for the default placement. Does not change its Project or content access.",
  reorder_sidebar_sections:
    "Reorder custom Sidebar Sections. Include every active custom section ID exactly once.",
};

export const sidebarToolCatalog: readonly Tool[] = Object.entries(sidebarSchemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof descriptions],
    inputSchema: { ...z.toJSONSchema(schema), type: "object" } as Tool["inputSchema"],
    annotations: {
      readOnlyHint:
        name === "list_sidebar_sections" ||
        name === "list_sidebar_section_items" ||
        name === "list_sidebar_order",
      destructiveHint: false,
      openWorldHint: false,
    },
  }),
);
