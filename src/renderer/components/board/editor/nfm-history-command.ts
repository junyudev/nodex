import type { SurfaceHistorySelectionPair } from "@blocknote/core/yjs";
import type { ContentAccessContext } from "../../../../shared/content-access-context";
import type {
  NodexClipboardEnvelopeV1,
  NodexStructuralClipboardDescriptorV1,
} from "../../../../shared/clipboard-paste";
import type {
  LibraryApplyOperation,
  LibraryModuleError,
  LibraryModuleApplyRequest,
  LibraryStructuralEditResult,
  LibraryStructuralHistoryToken,
  LibraryStructuralReplacementBlock,
  LibraryStructuralTurnIntoTarget,
} from "../../../../shared/library-module";
import type { DocumentHeadFence } from "../../../lib/block-document-surface-runtime";
import type { NfmBlockMoveRequest } from "../../../lib/nfm-block-move-runtime";
import type { PublicBlockTransferIntent } from "../../../../shared/block-transfer-transport";
import type { BlockTransferReceipt } from "../../../../shared/block-transfer";

/** A rejected content comparison may succeed after another surface restores its Blocks. */
export const canRetryNfmHistory = (error: LibraryModuleError): boolean =>
  error.retryable || error.code === "revision_conflict";

export interface NfmStructuralDocumentTarget {
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly parentBlockId?: string | null;
  readonly beforeBlockId?: string | null;
}

export interface NfmStructuralClipboardPresentation {
  readonly html: string;
  readonly text: string;
}

export type NfmStructuralPasteIntent =
  | { readonly kind: "replace"; readonly rootBlockIds: readonly string[] }
  | {
      readonly kind: "insert";
      readonly anchorBlockId: string;
      readonly parentBlockId: string | null;
      readonly beforeBlockId: string | null;
    };

export interface NfmStructuralTransferIntent {
  readonly mode: "move" | "copy";
  readonly rootBlockIds: readonly string[];
  readonly prepareHeads: () => Promise<{
    readonly sourceHead: DocumentHeadFence;
    readonly targetHead: DocumentHeadFence;
  }>;
  readonly target: {
    readonly parentBlockId: string | null;
    readonly beforeBlockId: string | null;
  };
  readonly preferredSelectionBlockId?: string;
}

/** Data Source Pages are ownership transfers, not selections in a source Document. */
export interface NfmReceivingPageTransferIntent {
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly mode: "move" | "copy";
  readonly rootBlockIds: readonly string[];
  readonly dataSourceId: string;
  readonly target: Extract<PublicBlockTransferIntent["target"], { kind: "page" | "document" }>;
}

type PageMentionOperation = Extract<LibraryApplyOperation, { kind: "create_page_mention" }>;
export interface NfmPageMentionIntent {
  readonly pageId: PageMentionOperation["pageId"];
  readonly title: string;
  readonly hostPageId: string;
  readonly blockId: PageMentionOperation["mentionHost"]["blockId"];
  readonly expectedContent: PageMentionOperation["mentionHost"]["expectedContent"];
  readonly replacementContent: PageMentionOperation["mentionHost"]["replacementContent"];
  readonly destinationPageId?: string;
}

/** Gestures carry immutable content/targets; asynchronous providers only read/fence authority. */
export type NfmHistoryCommand =
  | {
      readonly kind: "delete";
      readonly roots: readonly string[];
      readonly direction: "backward" | "forward";
    }
  | { readonly kind: "duplicate"; readonly roots: readonly string[] }
  | {
      readonly kind: "turn_into";
      readonly roots: readonly string[];
      readonly target: LibraryStructuralTurnIntoTarget;
    }
  | {
      readonly kind: "replace";
      readonly roots: readonly string[];
      readonly blocks: readonly LibraryStructuralReplacementBlock[];
    }
  | {
      readonly kind: "move_to_document";
      readonly roots: readonly string[];
      readonly prepareTarget: () => Promise<NfmStructuralDocumentTarget>;
    }
  | {
      readonly kind: "merge_backward";
      readonly sourceBlockId: string;
      readonly targetBlockId: string;
      readonly joinOffset: number;
    }
  | {
      readonly kind: "paste";
      readonly envelope: NodexClipboardEnvelopeV1;
      readonly target: NfmStructuralPasteIntent;
    }
  | {
      readonly kind: "paste_claim";
      readonly descriptor: NodexStructuralClipboardDescriptorV1;
      readonly portableBlocks: readonly LibraryStructuralReplacementBlock[];
      readonly target: NfmStructuralPasteIntent;
    }
  | {
      readonly kind: "clipboard";
      readonly action: "copy" | "cut";
      readonly roots: readonly string[];
      readonly presentation: NfmStructuralClipboardPresentation;
      readonly writeClaim: string;
    }
  | { readonly kind: "transfer"; readonly transfer: NfmStructuralTransferIntent }
  | { readonly kind: "receive_pages"; readonly transfer: NfmReceivingPageTransferIntent }
  | { readonly kind: "promotion"; readonly promotion: Omit<NfmBlockMoveRequest, "sourceHead"> }
  | { readonly kind: "page_mention"; readonly mention: NfmPageMentionIntent };

export type NfmHistoryInverse =
  | { readonly kind: "native"; readonly captureId: number }
  | {
      readonly kind: "structural";
      readonly token: LibraryStructuralHistoryToken;
      readonly selection?: SurfaceHistorySelectionPair;
    };

export interface NfmHistoryPresentation {
  readonly focusRevision: number;
  readonly preferredBlockId?: string;
  readonly selection?: SurfaceHistorySelectionPair;
  readonly merge?: {
    readonly sourceBlockId: string;
    readonly targetBlockId: string;
    readonly joinOffset: number;
  };
  readonly cutClaim?: string;
  readonly clipboardFallback?: string;
}

/** Only typed requests cross the durable submission seam; callbacks never enter exact attempts. */
export interface NfmLibraryHistoryRequest {
  readonly kind: "library";
  readonly accessContext: ContentAccessContext;
  readonly request: LibraryModuleApplyRequest;
  readonly presentation: NfmHistoryPresentation;
  readonly replay: boolean;
}

export type NfmHistoryRequest =
  | NfmLibraryHistoryRequest
  | {
      readonly kind: "block_transfer";
      readonly request: PublicBlockTransferIntent;
      readonly presentation: NfmHistoryPresentation;
    };

export type NfmHistoryReceipt =
  | { readonly kind: "native"; readonly captureId: number }
  | { readonly kind: "block_transfer"; readonly result: BlockTransferReceipt }
  | {
      readonly kind: "structural";
      readonly result: LibraryStructuralEditResult;
      readonly presentation?: NfmHistoryPresentation;
      readonly replay?: boolean;
    }
  | { readonly kind: "no_content_change" }
  | { readonly kind: "barrier"; readonly reason: string };

export const nfmCommandLabel = (command: NfmHistoryCommand): string => {
  switch (command.kind) {
    case "delete":
      return "Delete Blocks";
    case "duplicate":
      return "Duplicate Blocks";
    case "turn_into":
      return "Change Block Type";
    case "replace":
      return "Replace Blocks";
    case "move_to_document":
      return "Move Blocks";
    case "merge_backward":
      return "Merge Blocks";
    case "paste":
    case "paste_claim":
      return "Paste Blocks";
    case "clipboard":
      return command.action === "cut" ? "Cut Blocks" : "Copy Blocks";
    case "transfer":
      return command.transfer.mode === "move" ? "Move Blocks" : "Copy Blocks";
    case "page_mention":
      return "Create Page";
    case "promotion":
      return "Move to Database";
    case "receive_pages":
      return command.transfer.mode === "move" ? "Move Pages here" : "Copy Pages here";
  }
};
