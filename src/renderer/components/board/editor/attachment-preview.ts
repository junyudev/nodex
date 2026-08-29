import { useCallback, useEffect, useRef, useState } from "react";

import { readManagedAssetPreview } from "@/lib/assets";
import { contentAccessContextKey } from "../../../../shared/content-access-context";
import {
  createManagedTextPreview,
  MAX_MANAGED_PREVIEW_BYTES,
  type ManagedFolderManifest,
} from "../../../../shared/managed-assets";
import { parsePageFileSource } from "../../../../shared/page-files";
import type { PageFilePlacementRuntime } from "./page-file-runtime";

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

  const fileId = parsePageFileSource(input.source);
  if (fileId && pageFileRuntime) {
    return JSON.stringify([
      "page-file",
      pageFileRuntime.authority.storeEpoch,
      contentAccessContextKey(pageFileRuntime.authority.contentAccessContext),
      pageFileRuntime.authority.pageId,
      pageFileRuntime.readAuthorityEpoch,
      fileId,
      input.kind,
      input.mimeType ?? "",
    ]);
  }

  return JSON.stringify(["managed-asset", input.source, input.kind, input.mimeType ?? ""]);
};

const loadAttachmentPreview = async (
  input: AttachmentPreviewInput,
  pageFileRuntime: PageFilePlacementRuntime | null,
): Promise<AttachmentPreviewData> => {
  const fileId = parsePageFileSource(input.source);
  if (fileId && pageFileRuntime) {
    const file = await pageFileRuntime.read(input.source);
    const previewBytes = file.bytes.subarray(0, MAX_MANAGED_PREVIEW_BYTES);
    const decoded = new TextDecoder().decode(previewBytes, {
      stream: file.bytes.byteLength > MAX_MANAGED_PREVIEW_BYTES,
    });
    const preview = createManagedTextPreview(decoded);
    return {
      type: "text",
      content: preview.content,
      truncated: preview.truncated || file.bytes.byteLength > MAX_MANAGED_PREVIEW_BYTES,
    };
  }

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

    void loadAttachmentPreview(
      {
        kind: input.kind,
        mode: input.mode,
        source: input.source,
        mimeType: input.mimeType,
      },
      pageFileRuntime,
    ).then(
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
  }, [input.kind, input.mimeType, input.mode, input.source, pageFileRuntime, previewKey]);

  useEffect(() => {
    if (!active) return;
    preload();
  }, [active, preload]);

  if (!previewKey) {
    return { state: UNAVAILABLE_PREVIEW_STATE, preload };
  }
  if (entry?.key === previewKey) {
    return { state: entry.state, preload };
  }
  return { state: LOADING_PREVIEW_STATE, preload };
}
