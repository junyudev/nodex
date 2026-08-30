import type { DatabaseId, DatabaseViewId, DataSourceId } from "./database-identities";
import type { DatabaseViewLayout } from "./database-kernel";
import type { DocumentCommitRef } from "./block-documents/contracts";
import type { ProjectAppearance } from "./project-appearance";
import type { BlockPropertyFieldMutationV2 } from "./block-property-mutations-v2";
import type { DatabaseApplyOperationV2 } from "./database-module-v2";
import type { LocalCommitCommandSuccess } from "./local-commit-delivery";
import type { AuthorizedReadStamp } from "./authorized-read-stamp";
import type { WorkflowStatus } from "./workflow-status";
import type { PageSearchMatch, PageSearchTextPart } from "./types";
import type { PortableRichText } from "./block-documents/portable-rich-text";
import type { BlockTransferUndoToken } from "./block-transfer-undo-token";

export const DEFAULT_LIBRARY_READ_LIMIT = 20 as const;
export const MAX_LIBRARY_READ_LIMIT = 100 as const;
export const MAX_LIBRARY_CURSOR_LENGTH = 2_048 as const;
export const MAX_LIBRARY_QUERY_LENGTH = 256 as const;
export const MAX_LIBRARY_PROJECT_ACCESS_CHANGES = 100_000 as const;

export type LibraryRouteTarget =
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "database"; readonly databaseId: DatabaseId }
  | { readonly kind: "canvas"; readonly canvasId: string }
  | { readonly kind: "view"; readonly viewId: DatabaseViewId };

export type LibraryResourceTarget = Exclude<LibraryRouteTarget, { readonly kind: "view" }>;

export type LibraryNavigationParent =
  | { readonly kind: "library" }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "database"; readonly databaseId: DatabaseId };

export interface LibraryPageNavigationNode {
  readonly kind: "page";
  readonly pageId: string;
  readonly title: string;
  readonly hasChildren: boolean;
  readonly parentRevision: number;
  readonly metadataRevision: number;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly updatedAt: string;
}

export interface LibraryDatabaseNavigationNode {
  readonly kind: "database";
  readonly databaseId: DatabaseId;
  readonly title: string;
  readonly defaultViewId: DatabaseViewId;
  readonly hasMultipleViews: boolean;
  readonly metadataRevision: number;
  readonly locationRevision: number;
  readonly updatedAt: string;
}

export interface LibraryCanvasNavigationNode {
  readonly kind: "canvas";
  readonly canvasId: string;
  readonly title: string;
  readonly isPrimary: boolean;
  readonly metadataRevision: number;
  readonly locationRevision: number;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly updatedAt: string;
}

export interface LibraryDocumentHead {
  readonly documentId: string;
  readonly generation: number;
  readonly expectedHeadSeq: number;
}

export interface LibraryViewNavigationNode {
  readonly kind: "view";
  readonly viewId: DatabaseViewId;
  readonly databaseId: DatabaseId;
  readonly dataSourceId: DataSourceId;
  readonly title: string;
  readonly layout: DatabaseViewLayout;
  readonly isDefault: boolean;
  readonly revision: number;
}

export type LibraryNavigationNode =
  | LibraryPageNavigationNode
  | LibraryDatabaseNavigationNode
  | LibraryCanvasNavigationNode
  | LibraryViewNavigationNode;

export interface LibraryCatalogEntry {
  readonly target: Exclude<LibraryRouteTarget, { readonly kind: "view" }>;
  readonly title: string;
  readonly kind: "page" | "database" | "canvas";
  readonly lifecycle: "active" | "archived";
  readonly locationLabel: string;
  readonly updatedAt: string;
  readonly locationRevision: number;
  readonly metadataRevision: number;
}

export interface LibraryPageReferenceCandidate {
  readonly pageId: string;
  readonly title: string;
  readonly pageKey: string | null;
  readonly status: WorkflowStatus | null;
  readonly locationLabel: string;
  readonly matchExcerpt: string | null;
  readonly matchSource: LibraryPageReferenceMatchSource;
  readonly titleParts: readonly PageSearchTextPart[];
  readonly matchExcerptParts: readonly PageSearchTextPart[];
  readonly matches: readonly PageSearchMatch[];
}

export type LibraryPageReferenceMatchSource = "recent" | "page_key" | "title" | "content";

export type LibraryPageReferencePresentation = "mention" | "reference_block" | "link";

export interface LibraryPageBacklink {
  readonly sourcePageId: string;
  readonly sourceBlockId: string;
  readonly sourceTitle: string;
  readonly locationLabel: string;
  readonly presentations: readonly LibraryPageReferencePresentation[];
  readonly occurrenceCount: number;
  readonly updatedAt: string;
}

export type LibraryPageFileState = "live" | "deleted";
export type LibraryPageFileChangeKind =
  | "create"
  | "replace"
  | "rename"
  | "delete"
  | "restore"
  | "clone"
  | "rehome";

export interface LibraryPageFileOwnershipMove {
  readonly fileId: string;
  readonly previousOwnerPageId: string;
  readonly ownerPageId: string;
  readonly previousLogicalPath: string;
  readonly logicalPath: string;
  readonly version: number;
}

export type LibraryPageFileBodyUsage =
  | { readonly kind: "not_in_body" }
  | { readonly kind: "placed"; readonly placementCount: number };

export interface LibraryPageFileSummary {
  readonly fileId: string;
  readonly ownerPageId: string;
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly version: number;
  readonly blobEtag: string;
  readonly state: LibraryPageFileState;
  readonly createdByActorId: string;
  readonly createdByTurnId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly bodyUsage: LibraryPageFileBodyUsage;
}

export interface LibraryPageFileManifest {
  readonly pageId: string;
  readonly revision: number;
  readonly bodyUsageRevision: number;
  readonly files: readonly LibraryPageFileSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly total: number;
  readonly liveTotal: number;
  readonly unplacedTotal: number;
  readonly placedTotal: number;
  readonly deletedTotal: number;
}

export interface LibraryPageFileVersion {
  readonly fileId: string;
  readonly version: number;
  readonly ownerPageId: string;
  readonly manifestRevision: number;
  readonly changeKind: LibraryPageFileChangeKind;
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly blobEtag: string | null;
  readonly actorId: string;
  readonly turnId: string | null;
  readonly operationId: string;
  readonly occurredAt: string;
}

export interface LibraryPageFileVersionPage {
  readonly pageId: string;
  readonly fileId: string;
  readonly versions: readonly LibraryPageFileVersion[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type LibraryMoveDestinationScope =
  | { readonly kind: "suggested" }
  | {
      readonly kind: "children";
      readonly parent: Extract<LibraryNavigationParent, { readonly kind: "library" | "page" }>;
    }
  | { readonly kind: "search"; readonly query: string };

export interface LibraryMoveDestinationEntry {
  readonly pageId: string;
  readonly title: string;
  readonly path: readonly string[];
  readonly hasChildren: boolean;
  readonly isCurrent: boolean;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly updatedAt: string;
}

export type LibraryPageRelocationDestinationScope =
  | { readonly kind: "databases"; readonly query?: string }
  | { readonly kind: "page_suggested" }
  | {
      readonly kind: "page_children";
      readonly parent: Extract<LibraryNavigationParent, { readonly kind: "library" | "page" }>;
    }
  | { readonly kind: "page_search"; readonly query: string };

export type LibraryPageWriteDestination =
  | { readonly kind: "library"; readonly at?: LibraryAgentSiblingAnchor }
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly at?: LibraryAgentSiblingAnchor;
    }
  | {
      readonly kind: "data_source";
      readonly dataSourceId: DataSourceId;
      readonly viewId?: DatabaseViewId;
      readonly group?: {
        readonly kind: "path";
        readonly groupKey?: string;
        readonly subgroupKey?: string;
      };
      readonly at?: LibraryAgentSiblingAnchor;
    };

export type LibraryAgentSiblingAnchor =
  | { readonly kind: "start" | "end" }
  | { readonly kind: "before" | "after"; readonly blockId: string };

export interface LibraryPageRelocationDestinationEntry {
  readonly key: string;
  readonly kind: "library" | "page" | "database";
  readonly title: string;
  readonly path: readonly string[];
  readonly hasChildren: boolean;
  readonly isCurrent: boolean;
  readonly updatedAt: string;
  readonly destination: LibraryPageWriteDestination;
  readonly expectedMoveEtag: string;
}

export type LibraryRead =
  | { readonly mode: "metadata" }
  | {
      readonly mode: "resource_project_access";
      readonly target: LibraryResourceTarget;
    }
  | { readonly mode: "canvas_target"; readonly canvasId: string }
  | {
      readonly mode: "children";
      readonly parent: LibraryNavigationParent;
      readonly cursor?: string;
      readonly limit?: number;
      readonly forceIncludeTarget?: LibraryRouteTarget;
    }
  | {
      readonly mode: "standalone_roots";
      readonly cursor?: string;
      readonly limit?: number;
      readonly forceIncludeTarget?: LibraryResourceTarget;
    }
  | { readonly mode: "path"; readonly target: LibraryRouteTarget }
  | {
      readonly mode: "catalog";
      readonly query?: string;
      readonly kinds?: readonly ("page" | "database" | "canvas")[];
      readonly lifecycle?: "active" | "archived";
      readonly cursor?: string;
      readonly limit?: number;
    }
  | {
      readonly mode: "move_destinations";
      readonly target: LibraryResourceTarget;
      readonly scope: LibraryMoveDestinationScope;
      readonly cursor?: string;
      readonly limit?: number;
    }
  | {
      readonly mode: "page_relocation_destinations";
      readonly pageId: string;
      readonly scope: LibraryPageRelocationDestinationScope;
      readonly cursor?: string;
      readonly limit?: number;
    }
  | { readonly mode: "page_mention_destination"; readonly pageId: string }
  | {
      readonly mode: "page_reference_candidates";
      readonly query: string;
      readonly limit?: number;
      readonly sourcePageId?: string;
    }
  | {
      readonly mode: "page_backlinks";
      readonly targetPageId: string;
      readonly cursor?: string;
      readonly limit?: number;
    }
  | {
      readonly mode: "page_files";
      readonly pageId: string;
      readonly query?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly includeDeleted?: boolean;
    }
  | {
      readonly mode: "page_file_metadata";
      readonly pageId: string;
      readonly fileId: string;
    }
  | {
      readonly mode: "page_file_versions";
      readonly pageId: string;
      readonly fileId: string;
      readonly cursor?: string;
      readonly limit?: number;
    };

export interface LibraryModuleReadRequest {
  readonly read: LibraryRead;
}

export type LibraryCanvasLocation =
  | { readonly kind: "library" }
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly documentId: string;
    };

export interface LibraryCanvasSummary {
  readonly canvasId: string;
  readonly title: string;
  readonly lifecycle: string;
  readonly isPrimary: boolean;
  readonly location: LibraryCanvasLocation;
  readonly metadataRevision: number;
  readonly locationRevision: number;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly updatedAt: string;
}

export interface LibraryPageMentionDestinationHead {
  readonly pageId: string;
  readonly documentId: string;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
}

export type LibraryCanvasTarget =
  | { readonly status: "missing"; readonly canvasId: string }
  | {
      readonly status: "deleted";
      readonly canvasId: string;
      readonly libraryId: string;
    }
  | { readonly status: "available"; readonly summary: LibraryCanvasSummary };

export type LibraryReadValue =
  | { readonly kind: "metadata" }
  | {
      readonly kind: "resource_project_access";
      readonly value: LibraryResourceProjectAccess;
    }
  | { readonly kind: "canvas_target"; readonly value: LibraryCanvasTarget }
  | {
      readonly kind: "children";
      readonly parent: LibraryNavigationParent;
      readonly items: readonly LibraryNavigationNode[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly total: number;
    }
  | {
      readonly kind: "standalone_roots";
      readonly items: readonly Exclude<LibraryNavigationNode, LibraryViewNavigationNode>[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly total: number;
    }
  | {
      readonly kind: "path";
      readonly target: LibraryRouteTarget;
      readonly nodes: readonly LibraryNavigationNode[];
    }
  | {
      readonly kind: "catalog";
      readonly items: readonly LibraryCatalogEntry[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly total: number;
    }
  | {
      readonly kind: "move_destinations";
      readonly target: LibraryResourceTarget;
      readonly scope: LibraryMoveDestinationScope;
      readonly items: readonly LibraryMoveDestinationEntry[];
      readonly currentDestination: LibraryMoveDestinationEntry | null;
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly total: number;
      readonly rootIsCurrent: boolean;
    }
  | {
      readonly kind: "page_relocation_destinations";
      readonly pageId: string;
      readonly scope: LibraryPageRelocationDestinationScope;
      readonly items: readonly LibraryPageRelocationDestinationEntry[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly total: number;
    }
  | {
      readonly kind: "page_mention_destination";
      readonly value: LibraryPageMentionDestinationHead;
    }
  | {
      readonly kind: "page_reference_candidates";
      readonly items: readonly LibraryPageReferenceCandidate[];
    }
  | {
      readonly kind: "page_backlinks";
      readonly targetPageId: string;
      readonly items: readonly LibraryPageBacklink[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly total: number;
      readonly sourcePageCount: number;
    }
  | { readonly kind: "page_files"; readonly value: LibraryPageFileManifest }
  | { readonly kind: "page_file_metadata"; readonly value: LibraryPageFileSummary }
  | { readonly kind: "page_file_versions"; readonly value: LibraryPageFileVersionPage };

export interface LibraryModuleReadSnapshot {
  readonly profileId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: AuthorizedReadStamp | null;
  readonly value: LibraryReadValue;
}

export interface LibraryPlacementAnchor {
  readonly blockId: string;
  readonly expectedLocationRevision: number;
}

export type LibraryPageInsertion =
  | {
      readonly kind: "append";
      readonly parentBlockId?: string;
    }
  | {
      readonly kind: "before";
      readonly parentBlockId?: string;
      readonly anchorBlockId: string;
    }
  | {
      readonly kind: "replace_empty_paragraph";
      readonly blockId: string;
    };

export type LibraryCanvasDestination =
  | {
      readonly kind: "library";
      readonly before?: LibraryPlacementAnchor;
    }
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly expectedDocumentGeneration: number;
      readonly expectedDocumentHeadSeq: number;
      readonly insertion: LibraryPageInsertion;
    };

export type LibraryWriteParent =
  | {
      readonly kind: "library";
      readonly before?: LibraryPlacementAnchor;
    }
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly expectedDocumentGeneration: number;
      readonly expectedDocumentHeadSeq: number;
      readonly before?: LibraryPlacementAnchor;
      readonly insertion?: LibraryPageInsertion;
    };

export interface CreateLibraryPageOperation {
  readonly kind: "create_page";
  readonly pageId: string;
  readonly documentId: string;
  readonly title: string;
  readonly parent: LibraryWriteParent;
}

export interface CreateLibraryPageMentionOperation {
  readonly kind: "create_page_mention";
  readonly pageId: string;
  readonly documentId: string;
  readonly title: string;
  readonly mentionHost: {
    readonly pageId: string;
    readonly documentId: string;
    readonly expectedDocumentGeneration: number;
    readonly expectedDocumentHeadSeq: number;
    readonly blockId: string;
    readonly expectedContent: PortableRichText;
    readonly replacementContent: PortableRichText;
  };
  readonly destination: {
    readonly pageId: string;
    readonly documentId: string;
    readonly expectedDocumentGeneration: number;
    readonly expectedDocumentHeadSeq: number;
    readonly insertion: Extract<LibraryPageInsertion, { readonly kind: "append" }>;
  };
}

export interface CreateLibraryDatabaseOperation {
  readonly kind: "create_database";
  readonly databaseId: DatabaseId;
  readonly dataSourceId: DataSourceId;
  readonly viewId: DatabaseViewId;
  readonly name: string;
  readonly parent: LibraryWriteParent;
}

export interface CreateLibraryCanvasOperation {
  readonly kind: "create_canvas";
  readonly canvasId: string;
  readonly documentId: string;
  readonly displayName: string;
  readonly destination: LibraryCanvasDestination;
}

export interface RenameLibraryCanvasOperation {
  readonly kind: "rename_canvas";
  readonly canvasId: string;
  readonly displayName: string;
  readonly expectedMetadataRevision: number;
}

export interface MoveLibraryCanvasOperation {
  readonly kind: "move_canvas";
  readonly canvasId: string;
  readonly expectedLocationRevision: number;
  readonly destination: LibraryCanvasDestination;
}

export interface DuplicateLibraryCanvasOperation {
  readonly kind: "duplicate_canvas";
  readonly sourceCanvasId: string;
  readonly canvasId: string;
  readonly documentId: string;
  readonly displayName?: string;
  readonly expectedDocumentGeneration: number;
  readonly expectedDocumentHeadSeq: number;
  readonly destination: LibraryCanvasDestination;
}

export interface DeleteLibraryCanvasOperation {
  readonly kind: "delete_canvas";
  readonly canvasId: string;
  readonly expectedLocationRevision: number;
  readonly expectedMetadataRevision: number;
  readonly containingDocumentHead?: LibraryDocumentHead;
}

export interface MoveLibraryBlockOperation {
  readonly kind: "move_block";
  readonly target:
    | {
        readonly kind: "page";
        readonly pageId: string;
        readonly expectedLocationRevision: number;
      }
    | {
        readonly kind: "database";
        readonly databaseId: DatabaseId;
        readonly expectedLocationRevision: number;
      };
  readonly parent: LibraryWriteParent;
}

export type LibraryPageRelocationUndoToken = BlockTransferUndoToken;

export interface MoveLibraryPageOperation {
  readonly kind: "move_page";
  readonly pageId: string;
  readonly destination: LibraryPageWriteDestination;
  readonly expectedEtag: string;
}

export interface UndoLibraryPageRelocationOperation {
  readonly kind: "undo_page_relocation";
  readonly token: LibraryPageRelocationUndoToken;
}

export interface ArchiveLibraryResourceOperation {
  readonly kind: "archive_resource";
  readonly target:
    | {
        readonly kind: "page";
        readonly pageId: string;
        readonly expectedMetadataRevision: number;
      }
    | {
        readonly kind: "database";
        readonly databaseId: DatabaseId;
        readonly expectedMetadataRevision: number;
      };
}

export interface RestoreLibraryResourceOperation {
  readonly kind: "restore_resource";
  readonly target:
    | {
        readonly kind: "page";
        readonly pageId: string;
        readonly expectedMetadataRevision: number;
      }
    | {
        readonly kind: "database";
        readonly databaseId: DatabaseId;
        readonly expectedMetadataRevision: number;
      };
}

export interface GrantLibraryResourceToProjectOperation {
  readonly kind: "grant_project_access";
  readonly projectId: string;
  readonly target: LibraryResourceTarget;
  readonly access: "read" | "read_write";
}

export type LibraryAccess = "read" | "read_write";

export type LibraryInheritedProjectAccessSource =
  | {
      readonly kind: "primary_database";
      readonly databaseId: DatabaseId;
      readonly databaseName: string;
      readonly access: LibraryAccess;
    }
  | {
      readonly kind: "ancestor_page";
      readonly pageId: string;
      readonly pageTitle: string;
      readonly access: LibraryAccess;
    }
  | {
      readonly kind: "database_grant";
      readonly databaseId: DatabaseId;
      readonly databaseName: string;
      readonly access: LibraryAccess;
    };

export interface LibraryProjectAccessRow {
  readonly projectId: string;
  readonly projectName: string;
  readonly appearance: ProjectAppearance;
  readonly lifecycle: "active" | "inactive" | "archived";
  readonly directGrant: {
    readonly access: LibraryAccess;
    readonly revision: number;
  } | null;
  readonly inheritedSources: readonly LibraryInheritedProjectAccessSource[];
  readonly effectiveAccess: LibraryAccess | null;
}

export interface LibraryResourceProjectAccess {
  readonly target: LibraryResourceTarget;
  readonly projects: readonly LibraryProjectAccessRow[];
}

export interface SetLibraryProjectAccessOperation {
  readonly kind: "set_project_access";
  readonly target: LibraryResourceTarget;
  readonly changes: readonly {
    readonly projectId: string;
    readonly access: LibraryAccess | null;
    readonly expectedRevision: number | null;
  }[];
}

export interface ApplyPageMetadataPropertiesOperation {
  readonly kind: "apply_page_metadata_properties";
  readonly clientSessionId?: string;
  readonly databaseOperations: readonly Extract<
    DatabaseApplyOperationV2,
    { readonly kind: "edit_property_values" }
  >[];
  readonly intrinsicFields: readonly BlockPropertyFieldMutationV2[];
}

export interface LibraryStructuralClipboardToken {
  readonly bundleId: string;
  readonly capability: string;
  readonly manifestHash: string;
  readonly storeEpoch: string;
}

export interface LibraryStructuralHistoryToken {
  readonly recipeOperationId: string;
  readonly recipeHash: string;
  readonly storeEpoch: string;
}

export interface LibraryStructuralSelection {
  readonly sourceDocumentId: string;
  readonly rootBlockIds: readonly string[];
  readonly sourceHead: LibraryDocumentHead;
}

export interface LibraryStructuralTarget {
  readonly targetDocumentId: string;
  readonly parentBlockId: string | null;
  readonly beforeBlockId: string | null;
  readonly targetHead: LibraryDocumentHead;
}

export interface LibraryStructuralReplacementBlock {
  readonly blockType: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content: unknown | null;
  readonly children: readonly LibraryStructuralReplacementBlock[];
}

export type LibraryStructuralReplacement =
  | {
      readonly kind: "clipboard";
      readonly bundle: LibraryStructuralClipboardToken;
    }
  | {
      readonly kind: "blocks";
      readonly blocks: readonly LibraryStructuralReplacementBlock[];
    };

export type LibraryStructuralTurnIntoTarget =
  | { readonly kind: "paragraph" }
  | {
      readonly kind: "heading";
      readonly level: "one" | "two" | "three";
      readonly toggleable: boolean;
    }
  | { readonly kind: "bulleted_list" }
  | { readonly kind: "numbered_list" }
  | { readonly kind: "todo_list" }
  | { readonly kind: "toggle_list" }
  | { readonly kind: "quote" }
  | { readonly kind: "callout" }
  | { readonly kind: "code" }
  | { readonly kind: "equation" };

export type LibraryStructuralEditCommand =
  | {
      readonly kind: "capture_clipboard";
      readonly selection: LibraryStructuralSelection;
    }
  | {
      readonly kind: "delete_selection";
      readonly selection: LibraryStructuralSelection;
      readonly reason:
        | { readonly kind: "delete" }
        | { readonly kind: "cut"; readonly bundle: LibraryStructuralClipboardToken };
      readonly direction: "backward" | "forward";
    }
  | {
      readonly kind: "paste_clipboard";
      readonly bundle: LibraryStructuralClipboardToken;
      readonly target: LibraryStructuralTarget;
    }
  | {
      readonly kind: "duplicate_selection";
      readonly selection: LibraryStructuralSelection;
      readonly target: LibraryStructuralTarget;
    }
  | {
      readonly kind: "move_selection";
      readonly selection: LibraryStructuralSelection;
      readonly target: LibraryStructuralTarget;
    }
  | {
      readonly kind: "replace_selection";
      readonly selection: LibraryStructuralSelection;
      readonly replacement: LibraryStructuralReplacement;
    }
  | {
      readonly kind: "turn_selection_into";
      readonly selection: LibraryStructuralSelection;
      readonly target: LibraryStructuralTurnIntoTarget;
    }
  | {
      readonly kind: "merge_block_backward";
      readonly selection: LibraryStructuralSelection;
      readonly targetBlockId: string;
    }
  | {
      readonly kind: "release_history";
      readonly tokens: readonly LibraryStructuralHistoryToken[];
    };

export interface ApplyLibraryStructuralEditOperation {
  readonly kind: "apply_structural_edit";
  readonly command: LibraryStructuralEditCommand;
}

export interface ReverseLibraryStructuralEditOperation {
  readonly kind: "reverse_structural_edit";
  readonly token: LibraryStructuralHistoryToken;
}

export type LibraryPageFileChange =
  | {
      readonly kind: "create";
      readonly fileId: string;
      readonly logicalPath: string;
      readonly mimeType: string;
      readonly preparedBlobReceiptId: string;
      readonly collisionPolicy: "reject" | "suffix";
    }
  | {
      readonly kind: "replace_content";
      readonly fileId: string;
      readonly expectedVersion: number;
      readonly mimeType: string;
      readonly preparedBlobReceiptId: string;
    }
  | {
      readonly kind: "rename";
      readonly fileId: string;
      readonly expectedVersion: number;
      readonly logicalPath: string;
    }
  | {
      readonly kind: "delete";
      readonly fileId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "restore_version";
      readonly fileId: string;
      readonly expectedVersion: number;
      readonly sourceVersion: number;
    }
  | {
      readonly kind: "clone_into_page";
      readonly sourcePageId: string;
      readonly sourceFileId: string;
      readonly targetFileId: string;
      readonly logicalPath: string;
    };

export interface ApplyPageFileChangesOperation {
  readonly kind: "apply_page_file_changes";
  readonly pageId: string;
  readonly expectedManifestRevision: number;
  readonly turnId?: string;
  readonly changes: readonly LibraryPageFileChange[];
}

export type LibraryApplyOperation =
  | CreateLibraryPageOperation
  | CreateLibraryPageMentionOperation
  | CreateLibraryDatabaseOperation
  | CreateLibraryCanvasOperation
  | RenameLibraryCanvasOperation
  | MoveLibraryCanvasOperation
  | DuplicateLibraryCanvasOperation
  | DeleteLibraryCanvasOperation
  | MoveLibraryPageOperation
  | UndoLibraryPageRelocationOperation
  | MoveLibraryBlockOperation
  | ArchiveLibraryResourceOperation
  | RestoreLibraryResourceOperation
  | GrantLibraryResourceToProjectOperation
  | SetLibraryProjectAccessOperation
  | ApplyPageMetadataPropertiesOperation
  | ApplyPageFileChangesOperation
  | ApplyLibraryStructuralEditOperation
  | ReverseLibraryStructuralEditOperation;

export interface LibraryModuleApplyRequest {
  readonly operationId: string;
  readonly storeEpoch: string;
  readonly operation: LibraryApplyOperation;
}

export interface LibraryCanvasMutationResult {
  readonly operationKind: string;
  readonly canvasId: string;
  readonly documentId: string;
  readonly sourceCanvasId: string | null;
  readonly locationRevision: number;
  readonly metadataRevision: number;
  readonly documentCommits: readonly DocumentCommitRef[];
}

export interface LibraryStructuralEditResult {
  readonly operationKind: string;
  readonly sourceRootBlockIds: readonly string[];
  readonly resultRootBlockIds: readonly string[];
  readonly copiedBlockIds: Readonly<Record<string, string>>;
  readonly copiedDocumentIds: Readonly<Record<string, string>>;
  readonly documentCommits: readonly DocumentCommitRef[];
  readonly affectedPageIds: readonly string[];
  readonly affectedDatabaseIds: readonly DatabaseId[];
  readonly fileOwnershipMoves: readonly LibraryPageFileOwnershipMove[];
  readonly clipboard: LibraryStructuralClipboardToken | null;
  readonly history: LibraryStructuralHistoryToken | null;
  readonly supersededHistoryRecipeOperationIds: readonly string[];
  readonly resume: {
    readonly blockId: string;
    readonly edge: "start" | "end";
    readonly fallbackBeforeBlockId: string | null;
    readonly fallbackAfterBlockId: string | null;
  } | null;
}

export interface LibraryPageFileMutationReceipt {
  readonly pageId: string;
  readonly manifestRevision: number;
  readonly createdFileIds: readonly string[];
  readonly updatedFileIds: readonly string[];
  readonly deletedFileIds: readonly string[];
  readonly consumedBlobReceiptIds: readonly string[];
}

export interface LibraryModuleApplyReceipt {
  readonly operationId: string;
  readonly profileId: string;
  readonly storeEpoch: string;
  readonly libraryId: string;
  readonly operationKind: LibraryApplyOperation["kind"];
  readonly duplicate: boolean;
  readonly didMutate: boolean;
  readonly createdTarget: Exclude<LibraryRouteTarget, { readonly kind: "view" }> | null;
  readonly canvasMutation: LibraryCanvasMutationResult | null;
  readonly structuralEdit: LibraryStructuralEditResult | null;
  readonly pageFiles?: LibraryPageFileMutationReceipt | null;
  readonly pageRelocation?: {
    readonly pageId: string;
    readonly undoToken: LibraryPageRelocationUndoToken | null;
  } | null;
  readonly pageRelocationUndo?: {
    readonly pageId: string;
    readonly transferOperationId: string;
  } | null;
  readonly affectedParentKeys: readonly string[];
  readonly affectedPageIds: readonly string[];
  readonly affectedDatabaseIds: readonly DatabaseId[];
  readonly affectedViewIds: readonly DatabaseViewId[];
  readonly committedRevisions: Readonly<Record<string, number>>;
  readonly commitSeq: number;
  readonly committedAt: string;
}

export type LibraryModuleApplyResult =
  | LocalCommitCommandSuccess<LibraryModuleApplyReceipt>
  | { readonly ok: false; readonly error: LibraryModuleError };

export type LibraryModuleErrorCode =
  | "invalid_request"
  | "store_epoch_mismatch"
  | "identity_conflict"
  | "resource_not_found"
  | "revision_conflict"
  | "invalid_parent"
  | "hierarchy_cycle"
  | "project_inactive"
  | "primary_database_bound"
  | "document_conflict"
  | "stale_cursor"
  | "resource_exhausted"
  | "file_in_use"
  | "state_corrupt"
  | "unknown";

export interface LibraryModuleError {
  readonly code: LibraryModuleErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type LibraryModuleReadResult =
  | { readonly ok: true; readonly value: LibraryModuleReadSnapshot }
  | { readonly ok: false; readonly error: LibraryModuleError };
