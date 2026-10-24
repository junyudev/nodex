export type NativeSessionBackendKind = "claude" | "codex";

/** Catalog labels fit the durable Session title bound without splitting a Unicode character. */
export function nativeSessionCatalogTitle(
  value: string,
  fallback = "Untitled conversation",
): string {
  const title = value.trim().slice(0, 2000);
  if (!title) return fallback;
  const last = title.charCodeAt(title.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? title.slice(0, -1) : title;
}

export interface NativeSessionCatalogInput {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
  readonly cursor?: string;
}

export interface NativeSessionCatalogEntry {
  readonly nativeSessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly cwdAvailable?: boolean;
  readonly updatedAt: number;
  readonly importedThreadId?: string;
  readonly importedSessionId?: string;
}

export interface NativeSessionCatalogPage {
  readonly nativeHome: string;
  readonly entries: readonly NativeSessionCatalogEntry[];
  readonly nextCursor: string | null;
}

export interface NativeConversationImportPreviewInput {
  readonly reference: string;
  readonly backendKind?: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
}

export interface NativeConversationImportPreview {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
  readonly importedThreadId?: string;
  readonly importedSessionId?: string;
  readonly nativeSessionId: string;
  readonly nativeHome: string;
  readonly title: string;
  readonly cwd: string;
  readonly cwdAvailable: boolean;
  readonly updatedAt: number;
}

export interface NativeConversationImportPreviewResult {
  readonly matches: readonly NativeConversationImportPreview[];
}

/** A retry retains its request identity and all selected import parameters. */
export interface NativeConversationImportInput {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly nativeSessionId: string;
  readonly expectedHome: string;
  readonly projectId: string | null;
  readonly cwd: string;
}

export interface NativeConversationImportResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly projectId: string | null;
}

/** Only a proved refusal before destination admission releases an accepted retry identity. */
export type NativeConversationImportOutcome =
  | (NativeConversationImportResult & { readonly kind: "imported" })
  | { readonly kind: "not_admitted"; readonly message: string };
