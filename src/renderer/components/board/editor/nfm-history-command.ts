import type { SurfaceHistorySelectionPair } from "@blocknote/core/yjs";
import { defineMessages, getIntl } from "@/lib/i18n";
import type { ContentRoutingContext } from "../../../../shared/content-routing-context";
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
import type { StructuralReplayDocument } from "../../../lib/block-document-mutation-registry";
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
  readonly operationId: string;
  readonly projectId: string | null;
  readonly storeEpoch: string;
  readonly mode: "move" | "copy";
  readonly rootBlockIds: readonly string[];
  readonly dataSourceId: string;
  readonly pages: readonly {
    readonly pageId: string;
    readonly title: string;
  }[];
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
      readonly captureOperationId: string;
      readonly deleteOperationId: string;
      readonly fileExportCandidates?: readonly string[];
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
      readonly documents: readonly StructuralReplayDocument[];
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
  readonly routingContext: ContentRoutingContext;
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

const COMMAND_MESSAGES = defineMessages({
  delete: { id: "editor.nfmHistoryCommand.delete", defaultMessage: "Delete Blocks" },
  duplicate: { id: "editor.nfmHistoryCommand.duplicate", defaultMessage: "Duplicate Blocks" },
  turnInto: { id: "editor.nfmHistoryCommand.turnInto", defaultMessage: "Change Block Type" },
  replace: { id: "editor.nfmHistoryCommand.replace", defaultMessage: "Replace Blocks" },
  move: { id: "editor.nfmHistoryCommand.move", defaultMessage: "Move Blocks" },
  merge: { id: "editor.nfmHistoryCommand.merge", defaultMessage: "Merge Blocks" },
  paste: { id: "editor.nfmHistoryCommand.paste", defaultMessage: "Paste Blocks" },
  cut: { id: "editor.nfmHistoryCommand.cut", defaultMessage: "Cut Blocks" },
  copy: { id: "editor.nfmHistoryCommand.copy", defaultMessage: "Copy Blocks" },
  createPage: { id: "editor.nfmHistoryCommand.createPage", defaultMessage: "Create Page" },
  promotion: { id: "editor.nfmHistoryCommand.promotion", defaultMessage: "Move to Database" },
  movePages: { id: "editor.nfmHistoryCommand.movePages", defaultMessage: "Move Pages here" },
  copyPages: { id: "editor.nfmHistoryCommand.copyPages", defaultMessage: "Copy Pages here" },
});

export const nfmCommandLabel = (command: NfmHistoryCommand): string => {
  const intl = getIntl();
  switch (command.kind) {
    case "delete":
      return intl.formatMessage(COMMAND_MESSAGES.delete);
    case "duplicate":
      return intl.formatMessage(COMMAND_MESSAGES.duplicate);
    case "turn_into":
      return intl.formatMessage(COMMAND_MESSAGES.turnInto);
    case "replace":
      return intl.formatMessage(COMMAND_MESSAGES.replace);
    case "move_to_document":
      return intl.formatMessage(COMMAND_MESSAGES.move);
    case "merge_backward":
      return intl.formatMessage(COMMAND_MESSAGES.merge);
    case "paste":
    case "paste_claim":
      return intl.formatMessage(COMMAND_MESSAGES.paste);
    case "clipboard":
      return intl.formatMessage(
        command.action === "cut" ? COMMAND_MESSAGES.cut : COMMAND_MESSAGES.copy,
      );
    case "transfer":
      return intl.formatMessage(
        command.transfer.mode === "move" ? COMMAND_MESSAGES.move : COMMAND_MESSAGES.copy,
      );
    case "page_mention":
      return intl.formatMessage(COMMAND_MESSAGES.createPage);
    case "promotion":
      return intl.formatMessage(COMMAND_MESSAGES.promotion);
    case "receive_pages":
      return intl.formatMessage(
        command.transfer.mode === "move" ? COMMAND_MESSAGES.movePages : COMMAND_MESSAGES.copyPages,
      );
  }
};
