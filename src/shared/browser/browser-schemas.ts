import { z } from "zod";
import { BROWSER_SITE_PERMISSION_NAMES } from "./browser-permissions";
import { parseAssetSource } from "../assets";
import type {
  BrowserBrowsingDataKind,
  BrowserLocalServerPreferencesUpdate,
  BrowserSidebarCommand,
  BrowserSidebarContextMenuActionEvent,
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarImageDragStateEvent,
  BrowserSidebarLocalServerThumbnailRequest,
  BrowserSidebarOpenNewTabRequest,
  BrowserSidebarTabIdentity,
  BrowserSidebarWebviewDestroyed,
  BrowserSidebarWebviewHostCreated,
} from "../browser-sidebar";

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 2_048;
const MAX_TEXT_LENGTH = 8_192;
const MAX_BROWSER_IPC_BYTES = 64 * 1024;

const BrowserIdSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
const BrowserUrlSchema = z.string();
const BrowserManagedAssetSourceSchema = BrowserUrlSchema.refine(
  (source) => parseAssetSource(source) !== null,
  "Expected a managed Browser image asset",
);
const BrowserTitleSchema = z.string().max(MAX_TITLE_LENGTH);
const BrowserTextSchema = z.string().max(MAX_TEXT_LENGTH);
const FiniteNumberSchema = z.number().finite();
const BrowserDimensionSchema = z.number().int().min(1).max(4_096);
const BrowserZoomSchema = z.number().finite().min(25).max(500);
const BrowserThemeVariantSchema = z.enum(["light", "dark"]);

export const BrowserSidebarTabIdentitySchema = z
  .object({
    browserConversationId: BrowserIdSchema,
    browserViewScopeId: BrowserIdSchema,
    browserTabId: BrowserIdSchema,
  })
  .strict() satisfies z.ZodType<BrowserSidebarTabIdentity>;

export const BrowserSidebarOpenNewTabRequestSchema = BrowserSidebarTabIdentitySchema.extend({
  url: BrowserUrlSchema,
  background: z.boolean(),
  openInNewWindow: z.boolean().optional(),
  browserSurface: z.enum(["downloads", "history"]).optional(),
}).strict() satisfies z.ZodType<BrowserSidebarOpenNewTabRequest>;

export const BrowserSidebarImageDragStateEventSchema = BrowserSidebarTabIdentitySchema.extend({
  isActive: z.boolean(),
}).strict() satisfies z.ZodType<BrowserSidebarImageDragStateEvent>;

export const BrowserGuestImageDragStartedSchema = z
  .object({
    sourceUrl: BrowserUrlSchema,
  })
  .strict();

const BrowserContextMenuPointSchema = z
  .object({
    x: FiniteNumberSchema.min(-100_000).max(100_000),
    y: FiniteNumberSchema.min(-100_000).max(100_000),
  })
  .strict();

export const BrowserSidebarContextMenuActionEventSchema = z.discriminatedUnion("action", [
  BrowserSidebarTabIdentitySchema.extend({
    action: z.literal("annotate"),
    point: BrowserContextMenuPointSchema,
  }).strict(),
  BrowserSidebarTabIdentitySchema.extend({
    action: z.literal("quick-annotate"),
    point: BrowserContextMenuPointSchema,
  }).strict(),
  BrowserSidebarTabIdentitySchema.extend({
    action: z.literal("image-attached"),
    attachment: z
      .object({
        id: BrowserIdSchema,
        fileName: BrowserIdSchema,
        source: BrowserManagedAssetSourceSchema,
      })
      .strict(),
  }).strict(),
  BrowserSidebarTabIdentitySchema.extend({
    action: z.literal("error"),
    message: BrowserTextSchema,
  }).strict(),
]) satisfies z.ZodType<BrowserSidebarContextMenuActionEvent>;

export const BrowserSidebarLocalServerThumbnailRequestSchema =
  BrowserSidebarTabIdentitySchema.extend({
    projectId: BrowserIdSchema,
    url: BrowserUrlSchema,
  }).strict() satisfies z.ZodType<BrowserSidebarLocalServerThumbnailRequest>;

export const BrowserLocalServerPreferencesUpdateSchema = z
  .object({
    showMode: z.enum(["online", "all", "hidden"]).optional(),
    sortMode: z.enum(["recently-used", "origin"]).optional(),
    expandedProjectIds: z.array(BrowserIdSchema).max(1_000).optional(),
  })
  .strict() satisfies z.ZodType<BrowserLocalServerPreferencesUpdate>;

const BrowserSidebarViewportSchema = z
  .object({
    width: BrowserDimensionSchema,
    height: BrowserDimensionSchema,
    zoomPercent: BrowserZoomSchema,
    presetId: BrowserIdSchema,
  })
  .strict();

const BrowserSidebarSizeSchema = z
  .object({
    width: BrowserDimensionSchema,
    height: BrowserDimensionSchema,
  })
  .strict();

export const BrowserSidebarDeviceToolbarStateSchema = z
  .object({
    responsiveViewportSize: BrowserSidebarSizeSchema.nullable(),
    toolbarState: z
      .object({
        isEnabled: z.boolean(),
        presetId: BrowserIdSchema,
        width: BrowserDimensionSchema,
        height: BrowserDimensionSchema,
      })
      .strict(),
  })
  .strict();

const BrowserSidebarLocalServerRouteSchema = z
  .object({
    id: BrowserIdSchema,
    path: BrowserUrlSchema,
    title: BrowserTitleSchema,
    lastSeenAt: z.number().finite().nonnegative(),
    hidden: z.boolean(),
  })
  .strict();

const BrowserSidebarLocalServerSchema = z
  .object({
    id: BrowserIdSchema,
    origin: BrowserUrlSchema,
    host: BrowserIdSchema,
    port: z.number().int().min(1).max(65_535),
    protocol: z.enum(["http:", "https:"]),
    lastSeenAt: z.number().finite().nonnegative(),
    online: z.boolean(),
    hidden: z.boolean(),
    routes: z.array(BrowserSidebarLocalServerRouteSchema).max(1_000),
  })
  .strict();

const BrowserUseTabStateSchema = BrowserSidebarTabIdentitySchema.extend({
  codexSessionId: BrowserIdSchema,
  projectId: BrowserIdSchema.nullable(),
  title: BrowserTitleSchema,
  url: BrowserUrlSchema,
  webContentsId: z.number().int().positive().nullable(),
  viewport: BrowserSidebarViewportSchema,
  captureActive: z.boolean(),
  released: z.boolean(),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const BrowserUseCursorStateSchema = BrowserSidebarTabIdentitySchema.extend({
  animateMovement: z.boolean().optional(),
  moveSequence: z.number().int().positive(),
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  visible: z.boolean(),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

const BrowserUseViewportEventSchema = BrowserSidebarTabIdentitySchema.extend({
  viewportSize: BrowserSidebarSizeSchema.nullable(),
}).strict();

const BrowserUseCaptureSurfaceEventSchema = BrowserSidebarTabIdentitySchema.extend({
  surfaceSize: BrowserSidebarSizeSchema.nullable(),
}).strict();

const BrowserUsePresentationResultSchema = BrowserSidebarTabIdentitySchema.extend({
  requestId: BrowserIdSchema,
  outcome: z.enum(["accepted", "unavailable", "stale"]),
  message: BrowserTextSchema.max(1_024).optional(),
}).strict();

const TargetedCommandSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  BrowserSidebarTabIdentitySchema.extend(shape).strict();

export const BrowserSidebarCommandSchema = z.union([
  TargetedCommandSchema({
    type: z.literal("respond-permission"),
    promptId: BrowserIdSchema,
    mountGeneration: z.number().int().positive(),
    action: z.enum(["allow", "allow-this-time", "deny", "dismiss"]),
    geolocationAccuracy: z.enum(["approximate", "precise"]).optional(),
  }).refine(
    (value) =>
      value.geolocationAccuracy === undefined ||
      value.action === "allow" ||
      value.action === "allow-this-time",
  ),
  TargetedCommandSchema({
    type: z.literal("open-permission-system-settings"),
    promptId: BrowserIdSchema,
    mountGeneration: z.number().int().positive(),
  }),
  TargetedCommandSchema({
    type: z.literal("reset-site-permissions"),
    origin: z.string().url(),
    permission: z.enum(BROWSER_SITE_PERMISSION_NAMES).optional(),
  }),
  z
    .object({
      type: z.literal("register-renderer-session"),
      browserViewScopeId: BrowserIdSchema,
      rendererInstanceId: BrowserIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("sync-theme"),
      themeVariant: BrowserThemeVariantSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("capture-browser-use-route"),
      browserConversationId: BrowserIdSchema,
      browserViewScopeId: BrowserIdSchema,
      codexSessionId: BrowserIdSchema,
      projectId: BrowserIdSchema.nullable(),
    })
    .strict(),
  TargetedCommandSchema({
    type: z.literal("register-host"),
    browserStorageId: BrowserIdSchema,
    rendererInstanceId: BrowserIdSchema,
    hostGeneration: z.number().int().positive(),
    mountGeneration: z.number().int().positive(),
    hostKind: z.enum(["panel", "background", "retained"]),
    pagePersistence: z.enum(["durable", "browser-use"]),
    themeVariant: BrowserThemeVariantSchema,
  }),
  TargetedCommandSchema({
    type: z.literal("sync-host"),
    rendererInstanceId: BrowserIdSchema,
    hostGeneration: z.number().int().positive(),
    mountGeneration: z.number().int().positive(),
    hostKind: z.enum(["panel", "background", "retained"]),
    presented: z.boolean(),
    themeVariant: BrowserThemeVariantSchema,
    visible: z.boolean(),
  }),
  TargetedCommandSchema({
    type: z.literal("register-tab"),
    projectId: BrowserIdSchema.nullable(),
    initialUrl: BrowserUrlSchema.optional(),
    title: BrowserTitleSchema.optional(),
    faviconUrl: BrowserUrlSchema.optional(),
    deviceToolbarVisible: z.boolean().optional(),
    deviceToolbarState: BrowserSidebarDeviceToolbarStateSchema.optional(),
    browserStorageId: BrowserIdSchema.optional(),
  }),
  TargetedCommandSchema({
    type: z.literal("navigate"),
    url: BrowserUrlSchema,
    hostId: BrowserIdSchema.optional(),
    source: z.enum(["manual", "local-server", "browser-use"]).optional(),
    initiator: BrowserTextSchema.optional(),
    originalUrl: BrowserUrlSchema.optional(),
  }),
  TargetedCommandSchema({ type: z.literal("go-back") }),
  TargetedCommandSchema({ type: z.literal("go-forward") }),
  TargetedCommandSchema({
    type: z.literal("reload"),
    ignoreCache: z.boolean().optional(),
  }),
  TargetedCommandSchema({ type: z.literal("stop") }),
  z
    .object({
      type: z.literal("open-external"),
      fromErrorPage: z.boolean().optional(),
      url: BrowserUrlSchema,
    })
    .strict(),
  TargetedCommandSchema({
    type: z.literal("open-external"),
    fromErrorPage: z.boolean().optional(),
    url: z.undefined().optional(),
  }),
  TargetedCommandSchema({ type: z.literal("close-tab") }),
  TargetedCommandSchema({
    type: z.literal("set-title"),
    title: BrowserTitleSchema,
  }),
  TargetedCommandSchema({
    type: z.literal("set-favicon"),
    faviconUrl: BrowserUrlSchema.optional(),
  }),
  TargetedCommandSchema({
    type: z.literal("step-zoom"),
    delta: FiniteNumberSchema.min(-300).max(300),
    showBanner: z.boolean().optional(),
  }),
  TargetedCommandSchema({
    type: z.literal("set-zoom-percent"),
    zoomPercent: BrowserZoomSchema,
    showBanner: z.boolean().optional(),
  }),
  TargetedCommandSchema({
    type: z.literal("reset-zoom"),
    showBanner: z.boolean().optional(),
  }),
  TargetedCommandSchema({
    type: z.literal("set-device-toolbar-visible"),
    visible: z.boolean(),
  }),
  TargetedCommandSchema({
    type: z.literal("set-viewport"),
    viewport: BrowserSidebarViewportSchema,
  }),
  TargetedCommandSchema({
    type: z.literal("set-interaction-mode"),
    mode: z.enum(["browse", "comment"]),
  }),
  TargetedCommandSchema({
    type: z.literal("quick-annotate"),
    sessionId: BrowserIdSchema,
    point: BrowserContextMenuPointSchema,
  }),
  TargetedCommandSchema({ type: z.literal("open-find") }),
  TargetedCommandSchema({ type: z.literal("close-find") }),
  TargetedCommandSchema({
    type: z.literal("set-find-query"),
    query: BrowserTextSchema,
    caseSensitive: z.boolean().optional(),
  }),
  TargetedCommandSchema({ type: z.literal("find-next") }),
  TargetedCommandSchema({ type: z.literal("find-previous") }),
  TargetedCommandSchema({ type: z.literal("capture-screenshot") }),
  TargetedCommandSchema({ type: z.literal("print") }),
  TargetedCommandSchema({ type: z.literal("attach-dragged-image") }),
  TargetedCommandSchema({
    type: z.literal("browser-use-cursor-arrived"),
    moveSequence: z.number().int().positive(),
  }),
  z
    .object({
      type: z.literal("local-servers-refresh"),
      projectId: BrowserIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hide-local-server"),
      projectId: BrowserIdSchema,
      server: BrowserSidebarLocalServerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("unhide-local-server"),
      projectId: BrowserIdSchema,
      url: BrowserUrlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-local-server-route"),
      projectId: BrowserIdSchema,
      serverUrl: BrowserUrlSchema,
      routeUrl: BrowserUrlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("browser-use-upsert-tab"),
      tab: BrowserUseTabStateSchema,
    })
    .strict(),
  TargetedCommandSchema({ type: z.literal("browser-use-release-tab") }),
  z
    .object({
      type: z.literal("browser-use-set-active-tab"),
      browserConversationId: BrowserIdSchema,
      browserViewScopeId: BrowserIdSchema,
      browserTabId: BrowserIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser-use-resolve-presentation"),
      result: BrowserUsePresentationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("browser-use-set-cursor"),
      cursor: BrowserUseCursorStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("browser-use-set-viewport"),
      event: BrowserUseViewportEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("browser-use-set-capture-surface"),
      event: BrowserUseCaptureSurfaceEventSchema,
    })
    .strict(),
]) satisfies z.ZodType<BrowserSidebarCommand>;

export const BrowserBrowsingDataKindSchema = z.enum([
  "cookies",
  "cache",
  "site-data",
  "history",
  "downloads",
]) satisfies z.ZodType<BrowserBrowsingDataKind>;

export const BrowserSidebarWebviewHostCreatedSchema = BrowserSidebarTabIdentitySchema.extend({
  browserStorageId: BrowserIdSchema.optional(),
  rendererInstanceId: BrowserIdSchema,
  hostGeneration: z.number().int().positive(),
  projectId: BrowserIdSchema.nullable(),
  hostKind: z.enum(["panel", "background", "retained"]),
  mountGeneration: z.number().int().positive(),
  webContentsId: z.number().int().positive(),
  initialUrl: BrowserUrlSchema,
  title: BrowserTitleSchema.optional(),
}).strict() satisfies z.ZodType<BrowserSidebarWebviewHostCreated>;

export const BrowserSidebarWebviewDestroyedSchema = BrowserSidebarTabIdentitySchema.extend({
  mountGeneration: z.number().int().positive(),
  reason: z.enum(["closed", "reset", "replaced", "stale", "unmounted", "suspend"]),
  teardownId: BrowserIdSchema,
  disposition: z.enum(["destroyed", "rejected", "cancelled"]),
  webContentsId: z.number().int().positive().optional(),
}).strict() satisfies z.ZodType<BrowserSidebarWebviewDestroyed>;

export const BrowserSidebarDestroyWebviewRequestSchema = BrowserSidebarTabIdentitySchema.extend({
  mountGeneration: z.number().int().positive(),
  reason: z.enum(["closed", "reset", "replaced", "stale", "unmounted", "suspend"]),
  teardownId: BrowserIdSchema,
}).strict() satisfies z.ZodType<BrowserSidebarDestroyWebviewRequest>;

function assertBrowserIpcPayloadBudget(value: unknown): void {
  let json: string;
  try {
    // URL admission is owned by the entry point, not by a global transport size limit.
    const urlFields = new Set([
      "url",
      "initialUrl",
      "pendingUrl",
      "faviconUrl",
      "sourceUrl",
      "origin",
      "path",
    ]);
    json = JSON.stringify(value, (key, item: unknown) =>
      urlFields.has(key) && typeof item === "string" ? "" : item,
    );
  } catch {
    throw new Error("Browser IPC payload must be JSON serializable");
  }
  if (new TextEncoder().encode(json).byteLength > MAX_BROWSER_IPC_BYTES) {
    throw new Error(`Browser IPC payload exceeds ${MAX_BROWSER_IPC_BYTES} bytes`);
  }
}

export function parseBrowserSidebarCommand(value: unknown): BrowserSidebarCommand {
  assertBrowserIpcPayloadBudget(value);
  return BrowserSidebarCommandSchema.parse(value);
}

export function parseBrowserSidebarWebviewHostCreated(
  value: unknown,
): BrowserSidebarWebviewHostCreated {
  assertBrowserIpcPayloadBudget(value);
  return BrowserSidebarWebviewHostCreatedSchema.parse(value);
}

export function parseBrowserSidebarWebviewDestroyed(
  value: unknown,
): BrowserSidebarWebviewDestroyed {
  assertBrowserIpcPayloadBudget(value);
  return BrowserSidebarWebviewDestroyedSchema.parse(value);
}
