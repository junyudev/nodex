import { useEffect, useMemo, useRef, useState } from "react";

import { readManagedAssetPreview } from "@/lib/assets";
import {
  createManagedTextPreview,
  MAX_MANAGED_PREVIEW_BYTES,
  type ManagedFolderManifest,
} from "../../../../shared/managed-assets";
import { parseFileSource } from "../../../../shared/file-resources";
import { useFileReadSnapshot, type FilePlacementRuntime } from "./file-runtime";

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
  fileRuntime: FilePlacementRuntime | null,
): boolean => {
  if (input.mode !== "materialized") return false;
  const isOwnedFile = parseFileSource(input.source) !== null;
  if (!input.source.startsWith("nodex://assets/") && !(isOwnedFile && fileRuntime)) {
    return false;
  }
  if (input.kind === "folder" || input.kind === "text") return true;
  return isTextLikeMimeType(input.mimeType ?? "");
};

const attachmentPreviewKey = (
  input: AttachmentPreviewInput,
  fileRuntime: FilePlacementRuntime | null,
): string | null => {
  if (!canPreviewAttachment(input, fileRuntime)) return null;
  if (parseFileSource(input.source)) return null;
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

const previewFromFileBytes = (
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
 * Reads only while the preview is active. Library File demand owns its cache
 * lifetime; managed assets retain a resource-keyed result in the inline chip.
 * Stale async results can never replace a newer resource.
 */
export function useAttachmentPreview(
  input: AttachmentPreviewInput,
  fileRuntime: FilePlacementRuntime | null,
  active: boolean,
): AttachmentPreviewState {
  const pageFileId = parseFileSource(input.source);
  const previewable = canPreviewAttachment(input, fileRuntime);
  const fileSnapshot = useFileReadSnapshot(fileRuntime, input.source, {
    content: Boolean(pageFileId && previewable && active),
  });
  const pageFilePreview = useMemo(
    () => (fileSnapshot.bytes ? previewFromFileBytes(fileSnapshot.bytes.bytes) : null),
    [fileSnapshot.bytes],
  );
  const previewKey = attachmentPreviewKey(input, fileRuntime);
  const [entry, setEntry] = useState<AttachmentPreviewEntry | null>(null);
  const entryRef = useRef<AttachmentPreviewEntry | null>(null);
  const requestIdRef = useRef(0);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      if (entryRef.current?.state.status === "loading") entryRef.current = null;
    },
    [previewKey],
  );

  useEffect(() => {
    if (!active || !previewKey) return;
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
        if (requestIdRef.current !== requestId) return;
        const readyEntry: AttachmentPreviewEntry = {
          key: previewKey,
          state: { status: "ready", preview },
        };
        entryRef.current = readyEntry;
        setEntry(readyEntry);
      },
      () => {
        if (requestIdRef.current !== requestId) return;
        const failedEntry: AttachmentPreviewEntry = {
          key: previewKey,
          state: { status: "failed" },
        };
        entryRef.current = failedEntry;
        setEntry(failedEntry);
      },
    );
  }, [active, input.kind, input.mimeType, input.mode, input.source, previewKey]);

  if (pageFileId) {
    if (!previewable) return UNAVAILABLE_PREVIEW_STATE;
    if (pageFilePreview) {
      return { status: "ready", preview: pageFilePreview };
    }
    return fileSnapshot.contentError ? { status: "failed" } : LOADING_PREVIEW_STATE;
  }
  if (!previewKey) {
    return UNAVAILABLE_PREVIEW_STATE;
  }
  if (entry?.key === previewKey) {
    return entry.state;
  }
  return LOADING_PREVIEW_STATE;
}
