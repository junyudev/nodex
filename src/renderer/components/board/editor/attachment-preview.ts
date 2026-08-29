import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readManagedAssetPreview } from "@/lib/assets";
import {
  createManagedTextPreview,
  MAX_MANAGED_PREVIEW_BYTES,
  type ManagedFolderManifest,
} from "../../../../shared/managed-assets";
import { parsePageFileSource } from "../../../../shared/page-files";
import { usePageFileReadSnapshot, type PageFilePlacementRuntime } from "./page-file-runtime";

export interface AttachmentPreviewInput {
  readonly kind: "text" | "file" | "folder";
  readonly mode: "materialized" | "link";
  readonly source: string;
  readonly mimeType?: string;
}

export type AttachmentPreviewData =
  | { readonly type: "text"; readonly content: string; readonly truncated: boolean }
  | { readonly type: "folder"; readonly manifest: ManagedFolderManifest };

export type AttachmentPreviewState =
  | { readonly status: "unavailable" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: AttachmentPreviewData }
  | { readonly status: "failed" };

type LoadableAttachmentPreviewState = Exclude<AttachmentPreviewState, { status: "unavailable" }>;

interface AttachmentPreviewEntry {
  readonly key: string;
  readonly state: LoadableAttachmentPreviewState;
}

const UNAVAILABLE_PREVIEW_STATE = { status: "unavailable" } as const;
const LOADING_PREVIEW_STATE = { status: "loading" } as const;

export function isTextLikeMimeType(mimeType: string): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/sql" ||
    mimeType === "application/toml" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml"
  );
}

const canPreviewAttachment = (
  input: AttachmentPreviewInput,
  pageFileRuntime: PageFilePlacementRuntime | null,
): boolean => {
  if (input.mode !== "materialized") return false;
  const isOwnedFile = parsePageFileSource(input.source) !== null;
  if (!input.source.startsWith("nodex://assets/") && !(isOwnedFile && pageFileRuntime)) {
    return false;
  }
  if (input.kind === "folder" || input.kind === "text") return true;
  return isTextLikeMimeType(input.mimeType ?? "");
};

const attachmentPreviewKey = (
  input: AttachmentPreviewInput,
  pageFileRuntime: PageFilePlacementRuntime | null,
): string | null => {
  if (!canPreviewAttachment(input, pageFileRuntime)) return null;
  if (parsePageFileSource(input.source)) return null;
  return JSON.stringify(["managed-asset", input.source, input.kind, input.mimeType ?? ""]);
};

const loadAttachmentPreview = async (
  input: AttachmentPreviewInput,
): Promise<AttachmentPreviewData> => {
  if (!input.source.startsWith("nodex://assets/")) {
    throw new Error("Attachment preview source is unavailable");
  }
  const preview = await readManagedAssetPreview({
    source: input.source,
    kind: input.kind === "folder" ? "folder" : "text",
  });
  return preview.kind === "folder"
    ? { type: "folder", manifest: preview.manifest }
    : {
        type: "text",
        content: preview.content,
        truncated: preview.truncated,
      };
};

const previewFromPageFileBytes = (
  bytes: Uint8Array,
): Extract<AttachmentPreviewData, { readonly type: "text" }> => {
  const previewBytes = bytes.subarray(0, MAX_MANAGED_PREVIEW_BYTES);
  const decoded = new TextDecoder().decode(previewBytes, {
    stream: bytes.byteLength > MAX_MANAGED_PREVIEW_BYTES,
  });
  const preview = createManagedTextPreview(decoded);
  return {
    type: "text",
    content: preview.content,
    truncated: preview.truncated || bytes.byteLength > MAX_MANAGED_PREVIEW_BYTES,
  };
};

/**
 * Owns one attachment preview for the lifetime of its inline chip. The semantic
 * resource key, rather than React object identity or Popover mounting, controls
 * invalidation and stale async results can never replace a newer resource.
 */
export function useAttachmentPreview(
  input: AttachmentPreviewInput,
  pageFileRuntime: PageFilePlacementRuntime | null,
  active: boolean,
): { readonly state: AttachmentPreviewState; readonly preload: () => void } {
  const pageFileId = parsePageFileSource(input.source);
  const previewable = canPreviewAttachment(input, pageFileRuntime);
  const pageFileSnapshot = usePageFileReadSnapshot(pageFileRuntime, input.source, {
    content: Boolean(pageFileId && previewable && active),
  });
  const pageFilePreview = useMemo(
    () => (pageFileSnapshot.bytes ? previewFromPageFileBytes(pageFileSnapshot.bytes.bytes) : null),
    [pageFileSnapshot.bytes],
  );
  const previewKey = attachmentPreviewKey(input, pageFileRuntime);
  const [entry, setEntry] = useState<AttachmentPreviewEntry | null>(null);
  const entryRef = useRef<AttachmentPreviewEntry | null>(null);
  const currentKeyRef = useRef(previewKey);
  const requestIdRef = useRef(0);
  currentKeyRef.current = previewKey;

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const preload = useCallback(() => {
    if (pageFileId) {
      if (previewable) pageFileRuntime?.preload(input.source, { content: true });
      return;
    }
    if (!previewKey) return;
    const currentEntry = entryRef.current;
    if (currentEntry?.key === previewKey && currentEntry.state.status !== "failed") return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const loadingEntry: AttachmentPreviewEntry = {
      key: previewKey,
      state: LOADING_PREVIEW_STATE,
    };
    entryRef.current = loadingEntry;
    setEntry(loadingEntry);

    void loadAttachmentPreview({
      kind: input.kind,
      mode: input.mode,
      source: input.source,
      mimeType: input.mimeType,
    }).then(
      (preview) => {
        if (requestIdRef.current !== requestId || currentKeyRef.current !== previewKey) return;
        const readyEntry: AttachmentPreviewEntry = {
          key: previewKey,
          state: { status: "ready", preview },
        };
        entryRef.current = readyEntry;
        setEntry(readyEntry);
      },
      () => {
        if (requestIdRef.current !== requestId || currentKeyRef.current !== previewKey) return;
        const failedEntry: AttachmentPreviewEntry = {
          key: previewKey,
          state: { status: "failed" },
        };
        entryRef.current = failedEntry;
        setEntry(failedEntry);
      },
    );
  }, [
    input.kind,
    input.mimeType,
    input.mode,
    input.source,
    pageFileId,
    pageFileRuntime,
    previewable,
    previewKey,
  ]);

  useEffect(() => {
    if (!active) return;
    preload();
  }, [active, preload]);

  if (pageFileId) {
    if (!previewable) return { state: UNAVAILABLE_PREVIEW_STATE, preload };
    if (pageFilePreview) {
      return { state: { status: "ready", preview: pageFilePreview }, preload };
    }
    return {
      state: pageFileSnapshot.contentError ? { status: "failed" } : LOADING_PREVIEW_STATE,
      preload,
    };
  }
  if (!previewKey) {
    return { state: UNAVAILABLE_PREVIEW_STATE, preload };
  }
  if (entry?.key === previewKey) {
    return { state: entry.state, preload };
  }
  return { state: LOADING_PREVIEW_STATE, preload };
}
