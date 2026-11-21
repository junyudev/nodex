import type { AgentCapabilities, ProfileNativeHistory } from "./agents/definition";

/** Each kind of conversation history a person can copy into Nodex. */
export type NativeSessionBackendKind = NonNullable<AgentCapabilities["nativeHistory"]>;

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

/** A shared history names no profile; a profile history names the profile that reads it. */
export type NativeSessionSource =
  | {
      readonly backendKind: Exclude<NativeSessionBackendKind, ProfileNativeHistory>;
      readonly instanceConfigId?: never;
    }
  | { readonly backendKind: ProfileNativeHistory; readonly instanceConfigId: string };

export type NativeSessionCatalogInput = NativeSessionSource & {
  readonly cursor?: string;
};

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
  /** Canonical absolute path of the host history directory. */
  readonly nativeHome: string;
  readonly entries: readonly NativeSessionCatalogEntry[];
  readonly nextCursor: string | null;
}

export type NativeConversationImportPreviewInput = (
  | NativeSessionSource
  | { readonly backendKind?: undefined; readonly instanceConfigId?: string }
) & { readonly reference: string };

export type NativeConversationImportPreview = NativeSessionSource & {
  readonly importedThreadId?: string;
  readonly importedSessionId?: string;
  readonly nativeSessionId: string;
  readonly nativeHome: string;
  readonly title: string;
  readonly cwd: string;
  readonly cwdAvailable: boolean;
  readonly updatedAt: number;
};

export interface NativeConversationImportPreviewResult {
  readonly matches: readonly NativeConversationImportPreview[];
}

/** A retry retains its request identity and all selected import parameters. */
export type NativeConversationImportInput = NativeSessionSource & {
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly nativeSessionId: string;
  readonly expectedHome: string;
  readonly projectId: string | null;
  readonly cwd: string;
};

export interface NativeConversationImportResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly projectId: string | null;
}

/** Only a proved refusal before destination admission releases an accepted retry identity. */
export type NativeConversationImportOutcome =
  | (NativeConversationImportResult & { readonly kind: "imported" })
  | { readonly kind: "not_admitted"; readonly message: string };
