import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { isPlausiblePageKeyPrefixDraft, normalizePageKeyPrefixInput } from "../../shared/page-key";
import type { DatabasePageKeyPrefixPreviewV2 } from "../../shared/database-module-v2";
import { previewDatabasePageKeyPrefix } from "./database-page-key-runtime";
import { queryKeys } from "./query-keys";

const MANUAL_PREVIEW_DELAY_MS = 180;

export type PageKeyPrefixPreviewState =
  | { readonly kind: "local"; readonly prefix: string }
  | { readonly kind: "checking"; readonly prefix: string }
  | ({ readonly kind: "available" | "current" } & DatabasePageKeyPrefixPreviewV2)
  | ({ readonly kind: "reserved" } & DatabasePageKeyPrefixPreviewV2)
  | {
      readonly kind: "error";
      readonly prefix: string;
      readonly error: Error;
    };

interface PageKeyPrefixPreviewOptions {
  readonly enabled: boolean;
  readonly projectId?: string;
  readonly databaseId?: string;
  readonly nameHint: string;
  readonly readPreview?: PageKeyPrefixPreviewReader;
  readonly requestedPrefix?: string;
}

export type PageKeyPrefixPreviewReader = (input: {
  readonly projectId?: string;
  readonly databaseId?: string;
  readonly nameHint: string;
  readonly requestedPrefix?: string;
}) => Promise<DatabasePageKeyPrefixPreviewV2>;

export function usePageKeyPrefixPreview({
  enabled,
  projectId,
  databaseId,
  nameHint,
  readPreview = previewDatabasePageKeyPrefix,
  requestedPrefix,
}: PageKeyPrefixPreviewOptions): PageKeyPrefixPreviewState {
  const normalizedRequestedPrefix =
    requestedPrefix === undefined ? undefined : normalizePageKeyPrefixInput(requestedPrefix);
  const prefix = normalizedRequestedPrefix ?? "";
  const valid = normalizedRequestedPrefix === undefined || isPlausiblePageKeyPrefixDraft(prefix);
  // Once a person supplies a valid prefix, availability and its alternative
  // are a function of that prefix, not of later Project-name edits.
  const effectiveNameHint = normalizedRequestedPrefix ?? nameHint;
  const liveRequest = {
    projectId,
    databaseId,
    nameHint: effectiveNameHint,
    requestedPrefix: normalizedRequestedPrefix,
  };
  const liveSignature = JSON.stringify(liveRequest);
  const [debouncedRequest, setDebouncedRequest] = useState(liveRequest);
  const debouncedSignature = JSON.stringify(debouncedRequest);
  const readPreviewRef = useRef(readPreview);
  readPreviewRef.current = readPreview;

  useEffect(() => {
    if (!enabled || !valid) return;
    const timeout = window.setTimeout(
      () =>
        setDebouncedRequest({
          projectId,
          databaseId,
          nameHint: effectiveNameHint,
          requestedPrefix: normalizedRequestedPrefix,
        }),
      normalizedRequestedPrefix === undefined ? 0 : MANUAL_PREVIEW_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [databaseId, effectiveNameHint, enabled, normalizedRequestedPrefix, projectId, valid]);

  const debouncedProjectId = debouncedRequest.projectId;
  const debouncedDatabaseId = debouncedRequest.databaseId;
  const debouncedNameHint = debouncedRequest.nameHint;
  const debouncedRequestedPrefix = debouncedRequest.requestedPrefix;

  // The reader is an injectable transport, not part of the server-state identity.
  const query = useQuery({
    queryKey: queryKeys.pageKeys.prefixPreview(
      debouncedProjectId,
      debouncedDatabaseId,
      debouncedNameHint,
      debouncedRequestedPrefix,
    ),
    queryFn: async () =>
      await readPreviewRef.current({
        projectId: debouncedProjectId,
        databaseId: debouncedDatabaseId,
        nameHint: debouncedNameHint,
        requestedPrefix: debouncedRequestedPrefix,
      }),
    enabled: enabled && valid && liveSignature === debouncedSignature,
    staleTime: 0,
    retry: false,
  });

  if (!enabled || !valid) return { kind: "local", prefix };
  if (liveSignature !== debouncedSignature || query.isPending) {
    return { kind: "checking", prefix };
  }
  if (query.error) {
    return {
      kind: "error",
      prefix,
      error:
        query.error instanceof Error ? query.error : new Error("Page-key prefix preview failed"),
    };
  }
  if (!query.data) return { kind: "checking", prefix };
  return { kind: query.data.availability, ...query.data };
}
