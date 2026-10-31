import type { ImageEditSubmissionIntent } from "@/lib/content-image";

export type ImageEditComposerChannelId = string;

export interface ImageEditComposerComment {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export interface ImageEditComposerAttachment {
  readonly comments: readonly ImageEditComposerComment[];
  readonly asset: {
    readonly hostId: string | null;
    readonly localPath: string | null;
    readonly managedSource: string | null;
    readonly src: string;
  };
  readonly filename: string;
  readonly id: string;
  readonly imageSource: "generated" | "uploaded";
}

export interface ImageEditComposerDraftSnapshot {
  readonly attachments: readonly ImageEditComposerAttachment[];
  readonly mode: "comment" | "selection" | null;
  readonly revision: number;
}

export interface ImageEditComposerSubmitRequest {
  readonly intent?: ImageEditSubmissionIntent;
  readonly source: "single" | "canvas";
}

export type ImageEditComposerSubmitResult =
  | { readonly status: "submitted" | "queued" }
  | {
      readonly status: "unavailable";
      readonly reason: "asset-unresolvable" | "composer-unmounted" | "image-input-unsupported";
    }
  | {
      /** The Composer owns and has already presented this failure. */
      readonly status: "failed";
      readonly reason: "materialization" | "transport";
    };

type ImageEditComposerSubmitHandler = (
  request: ImageEditComposerSubmitRequest,
) => Promise<ImageEditComposerSubmitResult> | ImageEditComposerSubmitResult;

const EMPTY_SNAPSHOT: ImageEditComposerDraftSnapshot = Object.freeze({
  attachments: Object.freeze([]),
  mode: null,
  revision: 0,
});

const snapshotsByChannelId = new Map<ImageEditComposerChannelId, ImageEditComposerDraftSnapshot>();
const draftListenersByChannelId = new Map<ImageEditComposerChannelId, Set<() => void>>();
const handlersByChannelId = new Map<ImageEditComposerChannelId, ImageEditComposerSubmitHandler>();

function normalizeChannelId(channelId: ImageEditComposerChannelId): string {
  return channelId.trim();
}

function notifyDraft(channelId: ImageEditComposerChannelId): void {
  const listeners = draftListenersByChannelId.get(channelId);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function publishDraft(
  channelId: ImageEditComposerChannelId,
  input: Omit<ImageEditComposerDraftSnapshot, "revision">,
): void {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return;
  if (input.mode === null && input.attachments.length === 0) {
    if (snapshotsByChannelId.delete(normalizedChannelId)) {
      notifyDraft(normalizedChannelId);
    }
    return;
  }

  const current = snapshotsByChannelId.get(normalizedChannelId) ?? EMPTY_SNAPSHOT;
  snapshotsByChannelId.set(
    normalizedChannelId,
    Object.freeze({
      attachments: Object.freeze(
        input.attachments.map((attachment) =>
          Object.freeze({
            ...attachment,
            asset: Object.freeze({ ...attachment.asset }),
            comments: Object.freeze(
              attachment.comments.map((comment) => Object.freeze({ ...comment })),
            ),
          }),
        ),
      ),
      mode: input.mode,
      revision: current.revision + 1,
    }),
  );
  notifyDraft(normalizedChannelId);
}

export function registerImageEditComposerChannel(
  channelId: ImageEditComposerChannelId,
  handler: ImageEditComposerSubmitHandler,
): () => void {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return () => undefined;
  handlersByChannelId.set(normalizedChannelId, handler);
  return () => {
    if (handlersByChannelId.get(normalizedChannelId) !== handler) return;
    handlersByChannelId.delete(normalizedChannelId);
  };
}

export async function requestImageEditComposerSubmit(
  channelId: ImageEditComposerChannelId,
  request: ImageEditComposerSubmitRequest,
): Promise<ImageEditComposerSubmitResult> {
  const handler = handlersByChannelId.get(normalizeChannelId(channelId));
  if (!handler) {
    return { status: "unavailable", reason: "composer-unmounted" };
  }
  return handler(request);
}

export function replaceImageEditComposerDraft(
  channelId: ImageEditComposerChannelId,
  input: Omit<ImageEditComposerDraftSnapshot, "revision">,
): void {
  publishDraft(channelId, input);
}

export function removeImageEditComposerAttachment(
  channelId: ImageEditComposerChannelId,
  attachmentId: string,
): void {
  const normalizedChannelId = normalizeChannelId(channelId);
  const current = snapshotsByChannelId.get(normalizedChannelId);
  if (!current) return;
  const attachments = current.attachments.filter((attachment) => attachment.id !== attachmentId);
  if (attachments.length === current.attachments.length) return;
  publishDraft(normalizedChannelId, {
    attachments,
    mode: attachments.length > 0 ? current.mode : null,
  });
}

export function clearImageEditComposerDraft(channelId: ImageEditComposerChannelId): void {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!snapshotsByChannelId.delete(normalizedChannelId)) return;
  notifyDraft(normalizedChannelId);
}

export function getImageEditComposerDraftSnapshot(
  channelId: ImageEditComposerChannelId,
): ImageEditComposerDraftSnapshot {
  return snapshotsByChannelId.get(normalizeChannelId(channelId)) ?? EMPTY_SNAPSHOT;
}

export function subscribeImageEditComposerDraft(
  channelId: ImageEditComposerChannelId,
  listener: () => void,
): () => void {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return () => undefined;
  const listeners = draftListenersByChannelId.get(normalizedChannelId) ?? new Set<() => void>();
  listeners.add(listener);
  draftListenersByChannelId.set(normalizedChannelId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      draftListenersByChannelId.delete(normalizedChannelId);
    }
  };
}

export function isImageEditComposerAttachmentId(id: string): boolean {
  return id.startsWith("image-playground:");
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatPercent(value: number, locales?: string | readonly string[]): string {
  return new Intl.NumberFormat(locales, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(clampUnit(value));
}

/** Compiles Composer-owned image comments at the final submission seam. */
export function compileImageEditComposerPrompt(args: {
  readonly draft: ImageEditComposerDraftSnapshot;
  readonly generalInstructions: string;
  readonly locales?: string | readonly string[];
}): string {
  if (args.draft.mode !== "comment") return args.generalInstructions;
  const commented = args.draft.attachments.filter((attachment) => attachment.comments.length > 0);
  if (commented.length === 0) return args.generalInstructions;
  const sections = commented.map((attachment, imageIndex) =>
    [
      `Image ${imageIndex + 1}:`,
      ...attachment.comments.map(
        (comment, commentIndex) =>
          `${commentIndex + 1}. (x: ${formatPercent(comment.x, args.locales)}, y: ${formatPercent(comment.y, args.locales)}) ${comment.text}`,
      ),
    ].join("\n"),
  );
  const generalInstructions = args.generalInstructions.trim();
  if (generalInstructions) {
    sections.push(`Additional instructions:\n${generalInstructions}`);
  }
  return sections.join("\n\n");
}
