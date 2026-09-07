import { z } from "zod";
import { parseDatabaseViewPreferencesOverride } from "../database-kernel";
import { ContentAccessContextSchema, WorkbenchSceneOwnerSchema } from "../schemas/workbench-scene";

const identity = z.string().min(1).max(512);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const occurrenceKey = z.string().min(1).max(8_192);
const preferencesOverride = z.unknown().transform((value, context) => {
  try {
    // Reuse Database's exact-key, transport-neutral boundary parser.
    return parseDatabaseViewPreferencesOverride(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid Database View preferences override" });
    return z.NEVER;
  }
});

export const WorkbenchCaptureViewRequestSchema = z.strictObject({
  kind: z.literal("capture_view"),
  sceneOwner: WorkbenchSceneOwnerSchema,
  tabId: identity,
  expectedPresentationRevision: revision,
  purpose: z.enum(["display", "effective_query"]),
  range: z.enum(["viewport", "loaded", "selected"]),
  offset: revision,
  limit: z.number().int().min(1).max(200),
});
export type WorkbenchCaptureViewRequest = z.infer<typeof WorkbenchCaptureViewRequestSchema>;

export const WorkbenchViewOccurrenceSchema = z.strictObject({
  displayKey: occurrenceKey,
  occurrenceKey: occurrenceKey.nullable(),
  pageId: identity,
  groupPath: z.array(identity.nullable()).max(2),
  ancestorPageIds: z.array(identity).max(128),
  mounted: z.boolean(),
  inViewport: z.boolean(),
  selected: z.boolean(),
  condition: z.strictObject({
    metadataRevision: revision,
    parentRevision: revision,
    documentId: identity,
    documentGeneration: revision,
    documentHeadSeq: revision,
    membershipId: identity,
    membershipRevision: revision,
    databaseValueRevisions: z.record(identity, revision),
    positionRevision: revision.nullable(),
    rankKey: z.string().max(2_000).nullable(),
  }),
});
export type WorkbenchViewOccurrence = z.infer<typeof WorkbenchViewOccurrenceSchema>;

export const WorkbenchViewSnapshotSchema = z.strictObject({
  status: z.literal("ready"),
  capturedAt: z.string().datetime(),
  layout: z.enum(["board", "list"]),
  libraryId: identity,
  accessContext: ContentAccessContextSchema,
  databaseId: identity,
  dataSourceId: identity,
  databaseViewId: identity,
  storeEpoch: identity,
  commitSeq: revision,
  viewRevision: revision,
  schemaRevision: revision,
  // Null means this surface renders the saved definition without Profile preferences.
  preferencesRevision: revision.nullable(),
  preferencesOverride,
  search: z.strictObject({
    current: z.string().max(4_096),
    deferred: z.string().max(4_096),
    pending: z.boolean(),
  }),
  pending: z.strictObject({
    preferences: z.boolean(),
    optimistic: z.boolean(),
    loading: z.boolean(),
    options: z.boolean(),
  }),
  selection: z.strictObject({
    allMatching: z.boolean(),
    selectedOccurrenceKeys: z.array(occurrenceKey).max(20_000),
    excludedOccurrenceKeys: z.array(occurrenceKey).max(20_000),
    anchorOccurrenceKey: occurrenceKey.nullable(),
    activeOccurrenceKey: occurrenceKey.nullable(),
  }),
  collapsedOccurrenceKeys: z.array(occurrenceKey).max(20_000),
  coverage: z.strictObject({
    range: z.enum(["viewport", "loaded", "selected"]),
    offset: revision,
    returnedCount: revision.max(200),
    rangeCount: revision,
    loadedOccurrenceCount: revision,
    mountedOccurrenceCount: revision,
    viewportOccurrenceCount: revision,
    totalOccurrenceCount: revision.nullable(),
    allRowsLoaded: z.boolean(),
    viewportKnown: z.boolean(),
    hasMoreInRange: z.boolean(),
  }),
  occurrences: z.array(WorkbenchViewOccurrenceSchema).max(200),
});
export type WorkbenchViewSnapshot = z.infer<typeof WorkbenchViewSnapshotSchema>;

export const WorkbenchCaptureViewResultSchema = z.union([
  WorkbenchViewSnapshotSchema,
  z.strictObject({
    status: z.enum([
      "stale_presentation",
      "surface_unavailable",
      "pending_presentation",
      "cancelled",
    ]),
  }),
]);
export type WorkbenchCaptureViewResult = z.infer<typeof WorkbenchCaptureViewResultSchema>;
