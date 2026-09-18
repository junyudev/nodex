import { createContext, useContext, type ReactNode } from "react";
import type { DatabaseId } from "../../../shared/database-identities";
import type {
  ContentAccessContext,
  ContentCanvasNavigationTarget,
  ContentPageNavigationTarget,
} from "../../../shared/content-access-context";
import type { PortableRichText } from "../../../shared/block-documents/portable-rich-text";
import type { SurfaceHistoryControls } from "@/lib/surface-history/controls";

export interface BlockReferenceHostRuntime {
  /** Authority inherited by every nested content editor in this host chain. */
  readonly contentAccessContext: ContentAccessContext;
  readonly projectName: string | null;
  readonly projectWorkspacePath: string | null;
  readonly hostPageId: string | null;
  /**
   * Page Documents already open in this inline expansion chain, including
   * `hostPageId`. A reference may still open a matching Page in the Stage, but
   * must never mount its Document recursively inside this chain.
   */
  readonly ancestorPageIds: readonly string[];
  /**
   * Every independently synchronized owner already open in this inline
   * expansion chain. Unlike `ancestorPageIds`, this also includes Synced and
   * Template owners so reference cycles cannot recursively mount providers.
   */
  readonly ancestorDocumentOwnerBlockIds: readonly string[];
  readonly isActiveSurface: boolean;
  readonly documentSurfaceId?: string;
  /** Shared content history used by non-editing chrome inside nested owners. */
  readonly historyControls?: SurfaceHistoryControls;
  readonly openPage?: (input: ContentPageNavigationTarget) => void | Promise<void>;
  readonly openDatabase?: (databaseId: DatabaseId) => void | Promise<void>;
  readonly openCanvas?: (input: ContentCanvasNavigationTarget) => void | Promise<void>;
  readonly createCanvasAtEmptyParagraph?: (input: {
    readonly blockId: string;
    readonly displayName?: string;
  }) => Promise<{ readonly canvasBlockId: string }>;
  readonly createSubpageAtEmptyParagraph?: (input: {
    readonly blockId: string;
    readonly title: string;
  }) => Promise<{ readonly pageId: string }>;
  readonly createPageMention?: (input: {
    readonly pageId: string;
    readonly title: string;
    readonly blockId: string;
    readonly expectedContent: PortableRichText;
    readonly replacementContent: PortableRichText;
    readonly destinationPageId?: string;
  }) => Promise<{ readonly pageId: string }>;
  readonly renameCanvas?: (input: {
    readonly canvasBlockId: string;
    readonly displayName: string;
  }) => Promise<void>;
  readonly duplicateCanvasAfter?: (canvasBlockId: string) => Promise<void>;
  readonly deleteCanvas?: (canvasBlockId: string) => Promise<void>;
}

export const appendInlineCardAncestor = (
  ancestors: readonly string[],
  pageId: string | null | undefined,
): readonly string[] => {
  if (!pageId || ancestors.includes(pageId)) return ancestors;
  return [...ancestors, pageId];
};

export const appendInlineDocumentOwnerAncestor = (
  ancestors: readonly string[],
  ownerBlockId: string | null | undefined,
): readonly string[] => {
  if (!ownerBlockId || ancestors.includes(ownerBlockId)) return ancestors;
  return [...ancestors, ownerBlockId];
};

export const isInlineCardCycle = (ancestors: readonly string[], targetPageId: string): boolean =>
  ancestors.includes(targetPageId);

export const isInlineDocumentOwnerCycle = (
  ancestors: readonly string[],
  targetOwnerBlockId: string,
): boolean => ancestors.includes(targetOwnerBlockId);

const BlockReferenceRuntimeContext = createContext<BlockReferenceHostRuntime | null>(null);

export function BlockReferenceRuntimeProvider({
  value,
  children,
}: {
  readonly value: BlockReferenceHostRuntime;
  readonly children: ReactNode;
}) {
  return (
    <BlockReferenceRuntimeContext.Provider value={value}>
      {children}
    </BlockReferenceRuntimeContext.Provider>
  );
}

export const useBlockReferenceHostRuntime = (): BlockReferenceHostRuntime | null =>
  useContext(BlockReferenceRuntimeContext);
