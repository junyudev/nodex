import { z } from "zod";
import type {
  WindowRestoreSettings,
  WindowSessionBounds,
  WindowSessionBootstrap,
  WindowSessionCatalog,
  WindowSessionLifecycle,
  WindowSessionNewWindowRequest,
  WindowSessionRecord,
  WindowSessionSaveLayoutInput,
} from "../window-session";
import { WorkbenchLayoutSnapshotSchema } from "./workbench-layout";

export const WindowRestorePolicySchema = z.enum(["all", "last-window", "none"]);

export const WindowRestoreSettingsSchema = z.object({
  policy: WindowRestorePolicySchema.catch("all"),
}) satisfies z.ZodType<WindowRestoreSettings>;

export const WindowSessionBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  mode: z.enum(["normal", "maximized", "fullscreen"]).catch("normal"),
}) satisfies z.ZodType<WindowSessionBounds>;

export const WindowSessionNewWindowRequestSchema = z
  .object({
    activeProjectSessionId: z.string().min(1).nullable().optional(),
    activeProjectId: z.string().min(1).nullable().optional(),
    browserUrl: z.url({ protocol: /^https?$/ }).optional(),
  })
  .strict() satisfies z.ZodType<WindowSessionNewWindowRequest>;

export const WindowSessionSaveLayoutInputSchema = z
  .object({
    sessionId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    layout: WorkbenchLayoutSnapshotSchema,
  })
  .strict() satisfies z.ZodType<WindowSessionSaveLayoutInput>;

export const WindowSessionLifecycleSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("open"),
    })
    .strict(),
  z
    .object({
      state: z.literal("closed"),
      closedAt: z.string().min(1),
    })
    .strict(),
]) satisfies z.ZodType<WindowSessionLifecycle>;

export const WindowSessionRecordSchema = z.object({
  id: z.string().min(1),
  lifecycle: WindowSessionLifecycleSchema,
  layoutRevision: z.number().int().nonnegative(),
  layout: WorkbenchLayoutSnapshotSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  focusedAt: z.string(),
  bounds: WindowSessionBoundsSchema.optional().catch(undefined),
}) satisfies z.ZodType<WindowSessionRecord>;

export const WindowSessionCatalogSchema = z.object({
  version: z.literal(3),
  lastActiveSessionId: z.string(),
  sessions: z.array(WindowSessionRecordSchema),
}) satisfies z.ZodType<WindowSessionCatalog>;

const LegacyWindowSessionRecordV2Schema = z
  .object({
    id: z.string().min(1),
    layoutRevision: z.number().int().nonnegative(),
    layout: WorkbenchLayoutSnapshotSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    focusedAt: z.string(),
    bounds: WindowSessionBoundsSchema.optional().catch(undefined),
  })
  .strict();

export const LegacyWindowSessionCatalogV2Schema = z
  .object({
    version: z.literal(2),
    lastActiveSessionId: z.string().min(1),
    sessions: z.array(LegacyWindowSessionRecordV2Schema),
  })
  .strict();

export const LegacyWindowSessionCatalogV1Schema = z
  .object({
    version: z.literal(1),
    lastActiveSessionId: z.string().min(1),
    sessions: z.array(
      z
        .object({
          id: z.string().min(1),
          layout: WorkbenchLayoutSnapshotSchema,
          createdAt: z.string(),
          updatedAt: z.string(),
          focusedAt: z.string(),
          bounds: WindowSessionBoundsSchema.optional().catch(undefined),
        })
        .strict(),
    ),
  })
  .strict();

export const WindowSessionBootstrapSchema = z.object({
  session: WindowSessionRecordSchema,
}) satisfies z.ZodType<WindowSessionBootstrap>;
