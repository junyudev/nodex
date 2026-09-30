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
  readonly updatedAt: number;
  readonly attachedThreadId?: string;
  readonly attachedSessionId?: string;
}

export interface NativeSessionCatalogPage {
  readonly nativeHome: string;
  readonly entries: readonly NativeSessionCatalogEntry[];
  readonly nextCursor: string | null;
}

export interface NativeSessionAttachInput {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
  readonly nativeSessionId: string;
  readonly expectedHome: string;
  readonly projectId: string | null;
}

export interface NativeSessionAttachResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly alreadyAttached: boolean;
}
