import {
  codexImageFileIdFromSource,
  codexImageInputSource,
} from "../../../../../../shared/codex-image-input";
import { parseAssetSource } from "../../../../../../shared/assets";

export type ComposerImageAttachmentOrigin =
  | "picker"
  | "paste"
  | "drop"
  | "browser"
  | "image-editor"
  | "restored";

export type ComposerImageAttachmentMaterialization = {
  readonly hostId: string;
} & (
  | {
      readonly localPath: string;
      readonly managedSource: string | null;
    }
  | {
      readonly localPath: null;
      readonly managedSource: string;
    }
  | {
      readonly localPath: null;
      readonly managedSource: null;
      readonly fileId: string;
    }
);

export interface ComposerImageAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly src: string;
  readonly origin: ComposerImageAttachmentOrigin;
  readonly materialization: ComposerImageAttachmentMaterialization | null;
  readonly materializationStatus: "pending" | "ready" | "failed";
  readonly uploadStatus: "idle" | "uploading" | "failed";
  readonly uploadProgress?: number;
  readonly generation: number;
}

export interface ResolvedComposerImageInput {
  readonly id?: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly src: string;
  readonly origin: Extract<
    ComposerImageAttachmentOrigin,
    "browser" | "image-editor" | "picker" | "restored"
  >;
  readonly localPath?: string | null;
  readonly managedSource?: string | null;
  readonly hostId?: string | null;
}

export interface ComposerImagePromptInput {
  readonly source: string;
  readonly caption: string;
}

export function resolveComposerImageAttachmentSize(
  hasVisibleNonImageAttachments: boolean,
): 80 | 54 {
  return hasVisibleNonImageAttachments ? 54 : 80;
}

export function isValidComposerImageSource(source: string): boolean {
  const normalized = source.trim();
  if (!normalized) return false;
  return (
    normalized.startsWith("data:image/") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    isManagedComposerImageSource(normalized) ||
    normalized.startsWith("file-service://") ||
    normalized.startsWith("sediment://") ||
    isAbsoluteComposerImagePath(normalized)
  );
}

export function isPortableComposerImagePromptSource(source: string): boolean {
  const normalized = source.trim();
  return (
    normalized.startsWith("data:image/") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://")
  );
}

export function isAbsoluteComposerImagePath(source: string): boolean {
  const normalized = source.trim();
  return (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/u.test(normalized) ||
    /^\\\\[^\\]+\\[^\\]+/u.test(normalized)
  );
}

export function isManagedComposerImageSource(source: string): boolean {
  return parseAssetSource(source.trim()) !== null;
}

export function selectComposerImagePromptSource(
  attachment: ComposerImageAttachment,
  executionHostId: string | null,
): string | null {
  const materialization = attachment.materialization;
  if (materialization && executionHostId !== null && materialization.hostId === executionHostId) {
    if ("fileId" in materialization) {
      return codexImageInputSource({ type: "image", fileId: materialization.fileId });
    }
    const localPath = materialization.localPath?.trim() ?? "";
    if (isAbsoluteComposerImagePath(localPath)) return localPath;
    const managedSource = materialization.managedSource?.trim() ?? "";
    if (isManagedComposerImageSource(managedSource)) return managedSource;
  }

  const source = attachment.src.trim();
  if (isPortableComposerImagePromptSource(source)) return source;
  return null;
}

export function buildComposerImagePromptInputs(
  attachments: readonly ComposerImageAttachment[],
  executionHostId: string | null,
): readonly ComposerImagePromptInput[] {
  return attachments.flatMap((attachment) => {
    const source = selectComposerImagePromptSource(attachment, executionHostId);
    if (!source || !isValidComposerImageSource(source)) return [];
    return [{ source, caption: attachment.filename }];
  });
}

export function createResolvedComposerImageAttachment(input: {
  readonly value: ResolvedComposerImageInput;
  readonly id: string;
  readonly generation: number;
}): ComposerImageAttachment | null {
  const src = input.value.src.trim();
  if (!isValidComposerImageSource(src)) return null;
  const rawLocalPath = input.value.localPath?.trim() ?? "";
  const localPath = isAbsoluteComposerImagePath(rawLocalPath) ? rawLocalPath : null;
  const hostId = input.value.hostId?.trim() ?? "";
  const candidateManagedSource = input.value.managedSource?.trim() || rawLocalPath;
  const managedSource = isManagedComposerImageSource(candidateManagedSource)
    ? candidateManagedSource
    : null;
  const fileId = codexImageFileIdFromSource(src);
  const materialization: ComposerImageAttachmentMaterialization | null = (() => {
    if (!hostId) return null;
    if (localPath) return { hostId, localPath, managedSource };
    if (managedSource) return { hostId, localPath: null, managedSource };
    if (fileId) return { hostId, localPath: null, managedSource: null, fileId };
    return null;
  })();

  return {
    id: input.value.id?.trim() || input.id,
    filename: input.value.filename.trim() || "Image",
    mimeType: input.value.mimeType?.trim() || "image/png",
    src,
    origin: input.value.origin,
    materialization,
    materializationStatus: materialization ? "ready" : "failed",
    uploadStatus: "idle",
    generation: input.generation,
  };
}
