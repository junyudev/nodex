import { z } from "zod";

export type BrowserAnnotationAnchorKind = "element" | "text" | "region";

export const BROWSER_ANNOTATION_DESIGN_PROPERTIES = [
  "color",
  "backgroundColor",
  "fontSize",
  "borderRadius",
  "opacity",
] as const;

export type BrowserAnnotationDesignProperty = (typeof BROWSER_ANNOTATION_DESIGN_PROPERTIES)[number];

export interface BrowserAnnotationComputedStyle {
  color: string;
  backgroundColor: string;
  fontSize: string;
  borderRadius: string;
  opacity: string;
}

export interface BrowserAnnotationDesignChange {
  anchorId: string;
  property: BrowserAnnotationDesignProperty;
  before: string;
  after: string;
}

export interface BrowserAnnotationAnchor {
  id: string;
  kind: BrowserAnnotationAnchorKind;
  pageUrl: string;
  frameUrl?: string;
  framePath?: string[];
  elementPath?: string;
  selector?: string;
  textExcerpt?: string;
  nearbyText?: string;
  computedStyle?: BrowserAnnotationComputedStyle;
  viewportSize?: {
    width: number;
    height: number;
  };
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BrowserAnnotationSelectionEvent {
  sessionId: string;
  multiSelect: boolean;
  anchor: BrowserAnnotationAnchor;
}

export interface BrowserAnnotationRoutedSelectionEvent {
  browserConversationId: string;
  browserViewScopeId: string;
  browserTabId: string;
  selection: BrowserAnnotationSelectionEvent;
}

export interface BrowserAnnotationAnchorUpdateEvent {
  sessionId: string;
  anchor: BrowserAnnotationAnchor;
}

export interface BrowserAnnotationRoutedAnchorUpdateEvent {
  browserConversationId: string;
  browserViewScopeId: string;
  browserTabId: string;
  update: BrowserAnnotationAnchorUpdateEvent;
}

export interface BrowserAnnotationAttachmentEvidence {
  attachmentId: string;
  mimeType: "image/png" | "image/jpeg";
  source: string;
  width: number;
  height: number;
}

export interface BrowserAnnotationAttachment {
  schemaVersion: 1;
  id: string;
  browserTabId: string;
  createdAt: number;
  intent?: "comment" | "designChange";
  designChange?: BrowserAnnotationDesignChange;
  note: string;
  pageTitle: string;
  pageUrl: string;
  anchors: BrowserAnnotationAnchor[];
  evidence?: BrowserAnnotationAttachmentEvidence;
}

const FiniteCoordinateSchema = z.number().finite().min(-100_000).max(100_000);
const BoundedStyleValueSchema = z.string().max(512);

export const BrowserAnnotationDesignPropertySchema = z.enum(BROWSER_ANNOTATION_DESIGN_PROPERTIES);

export const BrowserAnnotationComputedStyleSchema = z
  .object({
    color: BoundedStyleValueSchema,
    backgroundColor: BoundedStyleValueSchema,
    fontSize: BoundedStyleValueSchema,
    borderRadius: BoundedStyleValueSchema,
    opacity: BoundedStyleValueSchema,
  })
  .strict() satisfies z.ZodType<BrowserAnnotationComputedStyle>;

export const BrowserAnnotationAnchorSchema = z
  .object({
    id: z.string().min(1).max(512),
    kind: z.enum(["element", "text", "region"]),
    pageUrl: z.string().max(16_384),
    frameUrl: z.string().max(16_384).optional(),
    framePath: z.array(z.string().max(8_192)).max(16).optional(),
    elementPath: z.string().max(8_192).optional(),
    selector: z.string().max(8_192).optional(),
    textExcerpt: z.string().max(2_048).optional(),
    nearbyText: z.string().max(2_048).optional(),
    computedStyle: BrowserAnnotationComputedStyleSchema.optional(),
    viewportSize: z
      .object({
        width: z.number().finite().positive().max(100_000),
        height: z.number().finite().positive().max(100_000),
      })
      .strict()
      .optional(),
    rect: z
      .object({
        x: FiniteCoordinateSchema,
        y: FiniteCoordinateSchema,
        width: FiniteCoordinateSchema.nonnegative().max(100_000),
        height: FiniteCoordinateSchema.nonnegative().max(100_000),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<BrowserAnnotationAnchor>;

export const BrowserAnnotationSelectionEventSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    multiSelect: z.boolean(),
    anchor: BrowserAnnotationAnchorSchema,
  })
  .strict() satisfies z.ZodType<BrowserAnnotationSelectionEvent>;

export const BrowserAnnotationAnchorUpdateEventSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    anchor: BrowserAnnotationAnchorSchema,
  })
  .strict() satisfies z.ZodType<BrowserAnnotationAnchorUpdateEvent>;

export const BrowserAnnotationDesignChangeSchema = z
  .object({
    anchorId: z.string().min(1).max(512),
    property: BrowserAnnotationDesignPropertySchema,
    before: BoundedStyleValueSchema,
    after: BoundedStyleValueSchema,
  })
  .strict() satisfies z.ZodType<BrowserAnnotationDesignChange>;

export const BrowserAnnotationEvidenceCaptureInputSchema = z
  .object({
    browserConversationId: z.string().min(1).max(512),
    browserViewScopeId: z.string().min(1).max(512),
    browserTabId: z.string().min(1).max(512),
    anchors: z.array(BrowserAnnotationAnchorSchema).min(1).max(32),
  })
  .strict();
export type BrowserAnnotationEvidenceCaptureInput = z.infer<
  typeof BrowserAnnotationEvidenceCaptureInputSchema
>;

export const BrowserAnnotationAttachmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(512),
    browserTabId: z.string().min(1).max(512),
    createdAt: z.number().int().nonnegative(),
    intent: z.enum(["comment", "designChange"]).default("comment"),
    designChange: BrowserAnnotationDesignChangeSchema.optional(),
    note: z.string().max(10_000),
    pageTitle: z.string().max(2_048),
    pageUrl: z.string().max(16_384),
    anchors: z.array(BrowserAnnotationAnchorSchema).min(1).max(32),
    evidence: z
      .object({
        attachmentId: z.string().min(1).max(512),
        mimeType: z.enum(["image/png", "image/jpeg"]),
        source: z.string().min(1).max(16_384),
        width: z.number().int().positive().max(16_384),
        height: z.number().int().positive().max(16_384),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<BrowserAnnotationAttachment>;

export const BROWSER_ANNOTATIONS_ADDITIONAL_CONTEXT_KEY = "browser-annotations";

function formatAnchorForPrompt(anchor: BrowserAnnotationAnchor, index: number): string {
  const label = `${index + 1}. ${anchor.kind}`;
  const target =
    anchor.textExcerpt?.trim() ||
    anchor.selector?.trim() ||
    `rect(${anchor.rect.x}, ${anchor.rect.y}, ${anchor.rect.width}, ${anchor.rect.height})`;
  return `${label}: ${target}`;
}

export function serializeBrowserAnnotationAttachmentForPrompt(
  attachment: BrowserAnnotationAttachment,
): string {
  const parsed = BrowserAnnotationAttachmentSchema.parse(attachment);
  const heading = parsed.pageTitle.trim() || parsed.pageUrl;
  const note = parsed.note.trim();
  return [
    `[Browser ${parsed.intent === "designChange" ? "design change" : "annotation"}: ${heading}]`,
    `URL: ${parsed.pageUrl}`,
    ...parsed.anchors.map(formatAnchorForPrompt),
    ...(parsed.designChange
      ? [
          `Design property: ${parsed.designChange.property}`,
          `Before: ${parsed.designChange.before}`,
          `After: ${parsed.designChange.after}`,
        ]
      : []),
    ...(note ? [`Comment: ${note}`] : []),
    ...(parsed.evidence ? [`Screenshot evidence: ${parsed.evidence.attachmentId}`] : []),
  ].join("\n");
}

export function serializeBrowserAnnotationAttachmentsForAdditionalContext(
  attachments: readonly BrowserAnnotationAttachment[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    attachments: attachments.map((attachment) =>
      BrowserAnnotationAttachmentSchema.parse(attachment),
    ),
  });
}
