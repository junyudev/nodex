import type { AuthorizedReadStamp } from "./authorized-read-stamp";
import type {
  DatabaseId,
  DatabaseViewId,
  DataSourceId,
  DataSourceOptionId,
  DataSourcePropertyId,
} from "./database-identities";
import type { LocalCommitCommandSuccess } from "./local-commit-delivery";
import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabasePropertyValueType,
  DatabaseViewConfigV6,
  DatabaseViewFilterOperator,
  DatabaseViewLayout,
  DatabaseViewPreferencesOverride,
  DatabaseViewPresentationOverride,
  DatabaseViewRulesOverride,
} from "./database-kernel";
import type { Page } from "./page";

export const MAX_DATABASE_MODULE_V2_OPERATIONS = 64 as const;
export const MAX_DATABASE_MODULE_V2_BULK_ENTRIES = 100 as const;
export const MAX_DATABASE_DATA_HISTORY_IDENTITIES = 4096;
export const MAX_DATABASE_DATA_HISTORY_BYTES = 8 * 1024 * 1024;

export interface DatabaseContainerRecordV2 {
  readonly databaseId: DatabaseId;
  readonly libraryId: string;
  readonly name: string;
  readonly lifecycle: "active" | "archived" | "deleted";
  readonly defaultViewId: DatabaseViewId | null;
  readonly accessRevision: number;
  readonly metadataRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DataSourceRecordV2 {
  readonly dataSourceId: DataSourceId;
  readonly libraryId: string;
  readonly homeDatabaseId: DatabaseId;
  readonly name: string;
  readonly schemaKey: string;
  readonly schemaRevision: number;
  readonly lifecycle: "active" | "archived" | "deleted";
  readonly rankKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DatabaseNumberFormatV2 =
  | { readonly kind: "plain" }
  | { readonly kind: "percent" }
  | {
      readonly kind: "currency";
      readonly currencyCode: "usd" | "eur" | "gbp" | "jpy" | "cny";
    };

export type DatabaseDateFormatV2 =
  | "full"
  | "month_day_year"
  | "day_month_year"
  | "year_month_day"
  | "relative";

export type DatabaseTimeFormatV2 = "twelve_hour" | "twenty_four_hour";

export type DatabasePropertySchemaV2 =
  | { readonly kind: "text" }
  | { readonly kind: "number"; readonly format: DatabaseNumberFormatV2 }
  | { readonly kind: "checkbox" }
  | { readonly kind: "select" }
  | { readonly kind: "multi_select" }
  | { readonly kind: "date"; readonly dateFormat: DatabaseDateFormatV2 }
  | {
      readonly kind: "datetime";
      readonly dateFormat: DatabaseDateFormatV2;
      readonly timeFormat: DatabaseTimeFormatV2;
    }
  | {
      readonly kind: "relation";
      readonly targetDataSourceId: DataSourceId;
      readonly cardinality: "one" | "many";
    };

export interface DatabasePropertyCapabilitiesV2 {
  readonly filterOperators: readonly DatabaseViewFilterOperator[];
  readonly sortable: boolean;
  readonly groupable: boolean;
}

export type DatabasePropertySystemRoleV2 = "status" | "task_parent";

export interface DatabasePropertyManagementPolicyV2 {
  readonly canRename: boolean;
  readonly canReorder: boolean;
  readonly canChangeType: boolean;
  readonly canDuplicate: boolean;
  readonly canDelete: boolean;
  readonly canRestore: boolean;
  readonly canPermanentlyDelete: boolean;
  readonly canManageOptions: boolean;
  readonly allowedTypes: readonly DatabasePropertyValueType[];
  readonly blockedReasons: readonly string[];
}

export interface DataSourcePropertyRecordV2 {
  readonly propertyId: DataSourcePropertyId;
  readonly dataSourceId: DataSourceId;
  readonly name: string;
  readonly schema: DatabasePropertySchemaV2;
  readonly capabilities: DatabasePropertyCapabilitiesV2;
  readonly systemRole: DatabasePropertySystemRoleV2 | null;
  readonly nonEmptyValueCount: number;
  readonly referencedViewIds: readonly DatabaseViewId[];
  readonly managementPolicy: DatabasePropertyManagementPolicyV2;
  /** Derived presentation discriminator; schema is the authority. */
  readonly valueType: DatabasePropertyValueType;
  /** Option registries are fetched through OptionWindow when an editor opens. */
  readonly config: Readonly<Record<string, DatabaseJsonValue>>;
  readonly optionCount: number;
  readonly rankKey: string;
  readonly lifecycle: "active" | "deleted";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DatabaseViewRecordV2 {
  readonly viewId: DatabaseViewId;
  readonly databaseId: DatabaseId;
  readonly dataSourceId: DataSourceId;
  readonly name: string;
  readonly layout: DatabaseViewLayout;
  readonly config: DatabaseViewConfigV6;
  readonly isDefault: boolean;
  readonly revision: number;
  readonly rankKey: string;
  readonly lifecycle: "active" | "deleted";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DatabaseContainerDescriptorV2 {
  readonly database: DatabaseContainerRecordV2;
  readonly dataSources: readonly DataSourceRecordV2[];
  readonly views: readonly DatabaseViewRecordV2[];
}

export type DatabasePageKeyPrefixAvailabilityV2 = "available" | "current" | "reserved";

export interface DatabasePageKeyPrefixPreviewV2 {
  readonly prefix: string;
  readonly availability: DatabasePageKeyPrefixAvailabilityV2;
  readonly alternativePrefix: string | null;
  readonly nextNumber: number;
  readonly exampleKeys: readonly string[];
}

export interface DatabasePageKeyNamespaceV2 {
  readonly databaseId: DatabaseId;
  readonly currentPrefix: string;
  readonly nextNumber: number;
  readonly assignedPageCount: number;
  readonly revision: number;
  readonly retiredPrefixes: readonly {
    readonly prefix: string;
    readonly lastNumber: number;
  }[];
}

export interface DataSourceDescriptorV2 {
  readonly dataSource: DataSourceRecordV2;
  readonly properties: readonly DataSourcePropertyRecordV2[];
}

export interface DataSourcePageValueV2 {
  readonly propertyId: DataSourcePropertyId;
  readonly valueType: DatabasePropertyValueType;
  readonly value: DatabaseJsonValue;
  readonly revision: number;
}

export interface PageIntrinsicPropertyValueV2 {
  readonly key: string;
  readonly valueType: string;
  readonly value: DatabaseJsonValue;
  readonly revision: number;
}

export interface DataSourcePageRowV2 {
  readonly page: Page;
  /** Human-readable key in this Data Source's owning Database namespace. */
  readonly pageKey: string | null;
  readonly membership: {
    readonly membershipId: string;
    readonly dataSourceId: DataSourceId;
    readonly revision: number;
    readonly createdAt: string;
  };
  readonly values: Readonly<Record<string, DataSourcePageValueV2>>;
  readonly position: null | {
    readonly rankKey: string;
    readonly revision: number;
    /** Zero-based order inside this View group when supplied by native Core. */
    readonly order?: number;
  };
  readonly effectiveGroupKey: string | null;
  readonly effectiveSubgroupKey: string | null;
  /** Exact-head Page body projection supplied by native Database authority. */
  readonly bodyNfm?: string;
  /** Exact-head intrinsic values requested by complete Page projections. */
  readonly intrinsicProperties?: readonly PageIntrinsicPropertyValueV2[];
  /** Projection of the standard Parent Relation, independent from structural ownership. */
  readonly taskParent: {
    readonly parentPageId: string | null;
    readonly siblingRank: string | null;
    readonly valueRevision: number;
  };
}

export interface DatabaseViewQueryResultV2 {
  readonly database: DatabaseContainerRecordV2;
  readonly dataSource: DataSourceRecordV2;
  readonly view: DatabaseViewRecordV2;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly rows: readonly DataSourcePageRowV2[];
}

export interface DataSourceQueryResultV2 {
  readonly database: DatabaseContainerRecordV2;
  readonly dataSource: DataSourceRecordV2;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly rows: readonly DataSourcePageRowV2[];
}

export type DatabaseRelationTargetV2 =
  | {
      readonly kind: "visible";
      readonly edgeId: string;
      readonly pageId: string;
      readonly title: string;
      readonly lifecycle: string;
      readonly membershipState: string;
    }
  | { readonly kind: "restricted"; readonly edgeId: string };

export interface DatabaseRelationTargetWindowV2 {
  readonly valueRevision: number;
  readonly totalCount: number;
  readonly targets: readonly DatabaseRelationTargetV2[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface DatabasePropertyOptionWindowV2 {
  readonly options: readonly (DatabasePropertyOption & {
    readonly selectedPageCount: number;
  })[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface DatabaseCatalogWindowV2 {
  readonly databases: readonly DatabaseContainerDescriptorV2[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface DatabaseRelationCandidateWindowV2 {
  readonly candidates: readonly {
    readonly pageId: string;
    readonly title: string;
  }[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface DatabaseViewPersonalPreferencesV2 {
  readonly rulesOverride: DatabaseViewRulesOverride;
  readonly presentationOverride: DatabaseViewPresentationOverride;
  /** Zero means that this Profile has never changed this View. */
  readonly revision: number;
}

export type DatabaseViewDisclosureTargetV2 =
  | { readonly kind: "group"; readonly occurrenceKey: string }
  | { readonly kind: "page"; readonly occurrenceKey: string };

export interface DatabaseViewCollapsedOccurrencesV2 {
  readonly targets: readonly DatabaseViewDisclosureTargetV2[];
}

export type DatabasePagePropertyVisibilityV2 = "always_show" | "hide_when_empty" | "always_hide";

export interface DatabasePageLayoutV2 {
  readonly dataSourceId: DataSourceId;
  readonly revision: number;
  readonly entries: readonly {
    readonly propertyId: DataSourcePropertyId;
    readonly rankKey: string;
    readonly visibility: DatabasePagePropertyVisibilityV2;
  }[];
}

export type DatabaseReadV2 = (
  | {
      readonly target: { readonly kind: "project_default" };
      readonly mode: "database";
    }
  | {
      readonly target: { readonly kind: "project_default" };
      readonly mode: "catalog_window";
      readonly window?: { readonly after?: string | null; readonly first?: number };
    }
  | {
      readonly target: {
        readonly kind: "database";
        readonly databaseId: DatabaseId;
      };
      readonly mode: "database";
    }
  | {
      readonly target: {
        readonly kind: "page_key_namespace";
        readonly databaseId?: DatabaseId;
      };
      readonly mode: "page_key_prefix_preview";
      readonly nameHint: string;
      readonly requestedPrefix?: string;
    }
  | {
      readonly target: {
        readonly kind: "database";
        readonly databaseId: DatabaseId;
      };
      readonly mode: "page_key_namespace";
    }
  | {
      readonly target: {
        readonly kind: "data_source";
        readonly dataSourceId: DataSourceId;
      };
      readonly mode: "data_source";
    }
  | {
      readonly target: {
        readonly kind: "data_source";
        readonly dataSourceId: DataSourceId;
      };
      readonly mode: "page_layout";
    }
  | {
      readonly target: {
        readonly kind: "data_source";
        readonly dataSourceId: DataSourceId;
      };
      readonly mode: "relation_candidate_window";
      readonly query?: string;
      readonly window?: { readonly after?: string | null; readonly first?: number };
    }
  | {
      readonly target: {
        readonly kind: "view";
        readonly viewId: DatabaseViewId;
      };
      readonly mode: "view";
    }
  | {
      readonly target: {
        readonly kind: "view";
        readonly viewId: DatabaseViewId;
      };
      readonly mode: "view_personal_preferences";
    }
  | {
      readonly target: {
        readonly kind: "view";
        readonly viewId: DatabaseViewId;
      };
      readonly mode: "view_collapsed_occurrences";
    }
  | {
      readonly target: {
        readonly kind: "page_property";
        readonly pageId: string;
        readonly dataSourceId: DataSourceId;
        readonly propertyId: DataSourcePropertyId;
      };
      readonly mode: "relation_target_window";
      readonly window?: { readonly after?: string | null; readonly first?: number };
    }
  | {
      readonly target: {
        readonly kind: "property";
        readonly dataSourceId: DataSourceId;
        readonly propertyId: DataSourcePropertyId;
      };
      readonly mode: "option_window";
      readonly window?: { readonly after?: string | null; readonly first?: number };
    }
) & {
  /** Main/Core adapter read barrier for a previously returned local commit. */
  readonly minimumCommitSeq?: number;
};

export type DatabaseReadValueV2 =
  | {
      readonly kind: "catalog_window";
      readonly value: DatabaseCatalogWindowV2;
    }
  | {
      readonly kind: "database";
      readonly value: DatabaseContainerDescriptorV2;
    }
  | {
      readonly kind: "page_key_prefix_preview";
      readonly value: DatabasePageKeyPrefixPreviewV2;
    }
  | {
      readonly kind: "page_key_namespace";
      readonly value: DatabasePageKeyNamespaceV2;
    }
  | { readonly kind: "data_source"; readonly value: DataSourceDescriptorV2 }
  | { readonly kind: "page_layout"; readonly value: DatabasePageLayoutV2 }
  | { readonly kind: "view"; readonly value: DatabaseViewRecordV2 }
  | {
      readonly kind: "view_personal_preferences";
      readonly value: DatabaseViewPersonalPreferencesV2;
    }
  | {
      readonly kind: "view_collapsed_occurrences";
      readonly value: DatabaseViewCollapsedOccurrencesV2;
    }
  | { readonly kind: "query"; readonly value: DatabaseViewQueryResultV2 }
  | {
      readonly kind: "data_source_query";
      readonly value: DataSourceQueryResultV2;
    }
  | {
      readonly kind: "relation_target_window";
      readonly value: DatabaseRelationTargetWindowV2;
    }
  | {
      readonly kind: "option_window";
      readonly value: DatabasePropertyOptionWindowV2;
    }
  | {
      readonly kind: "relation_candidate_window";
      readonly value: DatabaseRelationCandidateWindowV2;
    };

export interface DatabaseModuleReadRequestV2 {
  readonly projectId: string;
  readonly read: DatabaseReadV2;
}

export interface DatabaseModuleReadSnapshotV2 {
  readonly projectId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: AuthorizedReadStamp | null;
  readonly value: DatabaseReadValueV2;
}

export type DatabaseModuleErrorCodeV2 =
  | "invalid_request"
  | "store_not_initialized"
  | "project_not_found"
  | "resource_not_found"
  | "authorization_denied"
  | "revision_conflict"
  | "operation_id_collision"
  | "resource_exhausted"
  | "recovery_required"
  | "state_corrupt"
  | "unsupported_operation"
  | "unknown"
  | "identity_conflict";

export interface DatabaseModuleErrorV2 {
  readonly code: DatabaseModuleErrorCodeV2;
  readonly message: string;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
}

export type DatabaseModuleReadResultV2 =
  | { readonly ok: true; readonly value: DatabaseModuleReadSnapshotV2 }
  | { readonly ok: false; readonly error: DatabaseModuleErrorV2 };

/**
 * Local Library reads name a concrete resource, except for the namespace
 * prefix preview used before a Project Database exists. `project_default`
 * remains an execution-context concept and is excluded.
 */
export type LibraryDatabaseReadV2 = Exclude<
  DatabaseReadV2,
  { readonly target: { readonly kind: "project_default" } }
>;

export interface LibraryDatabaseModuleReadRequestV2 {
  readonly read: LibraryDatabaseReadV2;
}

export interface LibraryDatabaseModuleReadSnapshotV2 extends Omit<
  DatabaseModuleReadSnapshotV2,
  "projectId"
> {
  readonly accessContext: { readonly kind: "library" };
}

export type LibraryDatabaseModuleReadResultV2 =
  | { readonly ok: true; readonly value: LibraryDatabaseModuleReadSnapshotV2 }
  | { readonly ok: false; readonly error: DatabaseModuleErrorV2 };

/**
 * Property metadata is intentionally separate from a select-like Property's
 * option registry. The current Property schemas have no mutable config outside
 * that registry, so v2 accepts only an empty object here.
 */
export type DataSourcePropertyMutationConfigV2 = Readonly<Record<string, never>>;

export interface PutDataSourcePropertyOperationV2 {
  readonly kind: "put_property";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
  readonly name: string;
  readonly schema: DatabasePropertySchemaV2;
  readonly beforePropertyId?: DataSourcePropertyId;
}

export interface MoveDataSourcePropertyOperationV2 {
  readonly kind: "move_property";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
  readonly placement:
    | { readonly kind: "before"; readonly propertyId: DataSourcePropertyId }
    | { readonly kind: "end" };
}

export interface RenameDatabasePageKeyPrefixOperationV2 {
  readonly kind: "rename_page_key_prefix";
  readonly databaseId: DatabaseId;
  readonly expectedRevision: number;
  readonly prefix: string;
}

export interface DeleteDataSourcePropertyOperationV2 {
  readonly kind: "delete_property";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
}

export interface ChangeDataSourcePropertyTypeOperationV2 {
  readonly kind: "change_property_type";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
  readonly schema: DatabasePropertySchemaV2;
}

export interface DuplicateDataSourcePropertyOperationV2 {
  readonly kind: "duplicate_property";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
  readonly newPropertyId: DataSourcePropertyId;
  readonly name: string;
  readonly optionIds: readonly {
    readonly sourceOptionId: DataSourceOptionId;
    readonly newOptionId: DataSourceOptionId;
  }[];
}

export interface RestoreDataSourcePropertyOperationV2 {
  readonly kind: "restore_property";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
}

export interface PermanentlyDeleteDataSourcePropertyOperationV2 {
  readonly kind: "permanently_delete_property";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly expectedDataSourceRevision: number;
  readonly expectedPropertyRevision: number;
}

export interface PutDataSourceOptionOperationV2 {
  readonly kind: "put_option";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly optionId: DataSourceOptionId;
  readonly name: string;
  readonly color?: string;
  readonly expectedPropertyRevision: number;
}

export interface DeleteDataSourceOptionOperationV2 {
  readonly kind: "delete_option";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly optionId: DataSourceOptionId;
  readonly expectedPropertyRevision: number;
}

export interface MoveDataSourceOptionOperationV2 {
  readonly kind: "move_option";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly optionId: DataSourceOptionId;
  readonly expectedPropertyRevision: number;
  readonly placement:
    | { readonly kind: "before"; readonly optionId: DataSourceOptionId }
    | { readonly kind: "end" };
}

export interface DeleteDataSourceOptionAndClearValuesOperationV2 {
  readonly kind: "delete_option_and_clear_values";
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly optionId: DataSourceOptionId;
  readonly expectedPropertyRevision: number;
}

export interface PutDatabasePageLayoutEntryOperationV2 {
  readonly kind: "put_page_layout_entry";
  readonly dataSourceId: DataSourceId;
  readonly expectedRevision: number;
  readonly propertyId: DataSourcePropertyId;
  readonly visibility: DatabasePagePropertyVisibilityV2;
  readonly placement?:
    | { readonly kind: "before"; readonly propertyId: DataSourcePropertyId }
    | { readonly kind: "end" };
}

export type DatabasePropertyValueInputV2 =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "checkbox"; readonly value: boolean }
  | { readonly kind: "select"; readonly optionId: DataSourceOptionId }
  | {
      readonly kind: "multi_select";
      readonly optionIds: readonly DataSourceOptionId[];
    }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "datetime"; readonly value: string };

export type DatabasePropertySetDeltaV2 =
  | {
      readonly kind: "multi_select";
      readonly addOptionIds: readonly DataSourceOptionId[];
      readonly removeOptionIds: readonly DataSourceOptionId[];
    }
  | {
      readonly kind: "relation";
      readonly addPageIds: readonly string[];
      readonly removeEdgeIds: readonly string[];
    };

export interface DatabasePropertyValueMutationV2 {
  readonly pageId: string;
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
  readonly edit:
    | {
        readonly kind: "replace";
        readonly expectedValueRevision: number;
        readonly value: DatabasePropertyValueInputV2;
      }
    | { readonly kind: "patch_set"; readonly delta: DatabasePropertySetDeltaV2 }
    | {
        readonly kind: "replace_one_relation";
        readonly expectedValueRevision: number;
        readonly targetPageId?: string;
      }
    | {
        readonly kind: "clear_many_relation";
        readonly expectedValueRevision: number;
      };
}

export interface EditDataSourcePageValuesOperationV2 {
  readonly kind: "edit_property_values";
  readonly edits: readonly DatabasePropertyValueMutationV2[];
}

export interface TransferDataSourcePageOperationV2 {
  readonly kind: "transfer_page";
  readonly pageId: string;
  readonly expectedParentRevision: number;
  readonly expectedActiveMembershipRevision: number;
  readonly target:
    | { readonly kind: "library"; readonly libraryId: string }
    | { readonly kind: "page"; readonly pageId: string }
    | { readonly kind: "data_source"; readonly dataSourceId: DataSourceId };
}

export interface PutDatabaseViewOperationV2 {
  readonly kind: "put_view";
  readonly databaseId: DatabaseId;
  readonly dataSourceId: DataSourceId;
  readonly viewId: DatabaseViewId;
  readonly expectedRevision: number;
  readonly name: string;
  readonly layout: DatabaseViewLayout;
  readonly config: DatabaseViewConfigV6;
  readonly isDefault: boolean;
  readonly beforeViewId?: DatabaseViewId | null;
}

export interface DuplicateDatabaseViewOperationV2 {
  readonly kind: "duplicate_view";
  readonly databaseId: DatabaseId;
  readonly sourceViewId: DatabaseViewId;
  readonly expectedRevision: number;
  readonly newViewId: DatabaseViewId;
}

export interface ChangeDatabaseViewLayoutOperationV2 {
  readonly kind: "change_view_layout";
  readonly databaseId: DatabaseId;
  readonly viewId: DatabaseViewId;
  readonly expectedRevision: number;
  readonly layout: DatabaseViewLayout;
}

export interface DeleteDatabaseViewOperationV2 {
  readonly kind: "delete_view";
  readonly databaseId: DatabaseId;
  readonly viewId: DatabaseViewId;
  readonly expectedRevision: number;
}

export interface MoveDatabaseViewOperationV2 {
  readonly kind: "move_view";
  readonly databaseId: DatabaseId;
  readonly viewId: DatabaseViewId;
  readonly expectedRevision: number;
  readonly placement:
    | { readonly kind: "before"; readonly viewId: DatabaseViewId }
    | { readonly kind: "end" };
}

export interface PositionDatabaseViewPageOperationV2 {
  readonly kind: "position_page";
  readonly viewId: DatabaseViewId;
  readonly pageId: string;
  readonly expectedPositionRevision: number;
  readonly beforePageId?: string;
}

export interface PositionDatabaseViewPagesOperationV2 {
  readonly kind: "position_pages";
  readonly viewId: DatabaseViewId;
  readonly pages: readonly {
    readonly pageId: string;
    readonly expectedPositionRevision: number;
  }[];
  readonly beforePageId?: string;
}

export interface SetDatabaseTaskParentOperationV2 {
  readonly kind: "set_task_parent";
  readonly dataSourceId: DataSourceId;
  readonly pages: readonly {
    readonly pageId: string;
    /** Standard `task_parent` Relation value revision, including for roots. */
    readonly expectedValueRevision: number;
  }[];
  /** Missing means promote the ordered Page run to the root level. */
  readonly parentPageId?: string;
  /** Missing appends the run to the target parent's child order. */
  readonly beforePageId?: string;
}

export type DatabaseListMoveSelectionV2 =
  | {
      readonly kind: "explicit";
      readonly occurrenceKeys: readonly string[];
    }
  | {
      readonly kind: "all_matching";
      readonly excludedOccurrenceKeys: readonly string[];
    };

export type DatabaseListMoveEdgeV2 = "before" | "after" | "inside";

export type DatabaseListMoveTargetV2 =
  | {
      readonly kind: "page";
      readonly occurrenceKey: string;
      readonly edge: DatabaseListMoveEdgeV2;
    }
  | {
      readonly kind: "group";
      readonly occurrenceKey: string;
    }
  | { readonly kind: "root" };

export interface DatabaseListProjectionExpectationV2 {
  readonly scopeKey: string;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly coveredCommitSeq: number;
  readonly effectHash: string | null;
}

export interface MoveDatabaseListOccurrencesOperationV2 {
  readonly kind: "move_list_occurrences";
  readonly viewId: DatabaseViewId;
  readonly preferencesOverride: DatabaseViewPreferencesOverride;
  readonly expectedProjection: DatabaseListProjectionExpectationV2;
  readonly initiatorOccurrenceKey: string;
  readonly selection: DatabaseListMoveSelectionV2;
  readonly target: DatabaseListMoveTargetV2;
}

export interface DatabaseListMovePropertyStateV2 {
  readonly pageId: string;
  readonly propertyId: DataSourcePropertyId;
  readonly beforeValue: DatabasePropertyValueInputV2;
  readonly afterValue: DatabasePropertyValueInputV2;
}

export interface DatabaseListMoveParentGuardV2 {
  readonly pageId: string;
  readonly parentPageId: string | null;
}

export interface DatabaseListMoveRestoreRunV2 {
  readonly pageIds: readonly string[];
  readonly parentPageId: string | null;
  readonly beforePageId: string | null;
}

export interface DatabaseListMoveUndoRecipeV2 {
  readonly viewId: DatabaseViewId;
  readonly dataSourceId: DataSourceId;
  readonly propertyStates: readonly DatabaseListMovePropertyStateV2[];
  readonly postParentGuards: readonly DatabaseListMoveParentGuardV2[];
  readonly postOrderRuns: readonly DatabaseListMoveRestoreRunV2[];
  readonly restoreRuns: readonly DatabaseListMoveRestoreRunV2[];
}

export interface UndoDatabaseListOccurrenceMoveOperationV2 {
  readonly kind: "undo_list_occurrence_move";
  readonly recipe: DatabaseListMoveUndoRecipeV2;
}

export interface DatabaseDataEditPropertyStateV2 {
  readonly address: Pick<DatabasePropertyValueMutationV2, "pageId" | "dataSourceId" | "propertyId">;
  readonly propertyType: Exclude<DatabasePropertyValueType, "relation">;
  readonly beforeValue: DatabasePropertyValueInputV2;
  readonly afterValue: DatabasePropertyValueInputV2;
}

export interface DatabaseDataEditPositionRunV2 {
  readonly pageIds: readonly string[];
  readonly beforePageId: string | null;
}

export interface DatabaseDataEditPositionStateV2 {
  readonly viewId: DatabaseViewId;
  readonly dataSourceId: DataSourceId;
  readonly direction: "asc" | "desc";
  readonly beforeRuns: readonly DatabaseDataEditPositionRunV2[];
  readonly afterRuns: readonly DatabaseDataEditPositionRunV2[];
}

export interface DatabaseDataEditUndoRecipeV2 {
  readonly propertyStates: readonly DatabaseDataEditPropertyStateV2[];
  readonly positionStates: readonly DatabaseDataEditPositionStateV2[];
}

export interface ReverseDatabaseDataEditOperationV2 {
  readonly kind: "reverse_data_edit";
  readonly recipe: DatabaseDataEditUndoRecipeV2;
}

export type DatabaseOperationOutcomeV2 =
  | {
      readonly kind: "data_edit";
      readonly operationIndex: number;
      readonly operationCount: number;
      /** Null is a supported gesture with no logical change, not a barrier. */
      readonly undoRecipe: DatabaseDataEditUndoRecipeV2 | null;
    }
  | {
      readonly kind: "list_occurrence_move";
      readonly operationIndex: number;
      readonly movedPageIds: readonly string[];
      readonly moveRootPageIds: readonly string[];
      readonly normalizedTarget: {
        readonly targetOccurrenceKey: string | null;
        readonly targetPageId: string | null;
        readonly parentPageId: string | null;
        readonly beforePageId: string | null;
        readonly groupKey: string | null;
        readonly subgroupKey: string | null;
        readonly depth: number;
        readonly edge: DatabaseListMoveEdgeV2;
      };
      readonly undoRecipe: DatabaseListMoveUndoRecipeV2;
    }
  | {
      readonly kind: "list_occurrence_move_undo";
      readonly operationIndex: number;
      readonly restoredPageIds: readonly string[];
      readonly undoRecipe: DatabaseListMoveUndoRecipeV2;
    };

export interface PutDatabaseViewPersonalPreferencesOperationV2 {
  readonly kind: "put_view_personal_preferences";
  readonly viewId: DatabaseViewId;
  readonly expectedRevision: number;
  readonly rulesOverride: DatabaseViewRulesOverride;
  readonly presentationOverride: DatabaseViewPresentationOverride;
}

export interface SetDatabaseViewOccurrenceDisclosureOperationV2 {
  readonly kind: "set_view_occurrence_disclosure";
  readonly viewId: DatabaseViewId;
  readonly target: DatabaseViewDisclosureTargetV2;
  readonly collapsed: boolean;
}

export type DatabaseApplyOperationV2 =
  | RenameDatabasePageKeyPrefixOperationV2
  | PutDataSourcePropertyOperationV2
  | MoveDataSourcePropertyOperationV2
  | ChangeDataSourcePropertyTypeOperationV2
  | DuplicateDataSourcePropertyOperationV2
  | RestoreDataSourcePropertyOperationV2
  | PermanentlyDeleteDataSourcePropertyOperationV2
  | DeleteDataSourcePropertyOperationV2
  | PutDataSourceOptionOperationV2
  | MoveDataSourceOptionOperationV2
  | DeleteDataSourceOptionOperationV2
  | DeleteDataSourceOptionAndClearValuesOperationV2
  | PutDatabasePageLayoutEntryOperationV2
  | EditDataSourcePageValuesOperationV2
  | TransferDataSourcePageOperationV2
  | PutDatabaseViewOperationV2
  | DuplicateDatabaseViewOperationV2
  | ChangeDatabaseViewLayoutOperationV2
  | MoveDatabaseViewOperationV2
  | DeleteDatabaseViewOperationV2
  | PositionDatabaseViewPageOperationV2
  | PositionDatabaseViewPagesOperationV2
  | SetDatabaseTaskParentOperationV2
  | MoveDatabaseListOccurrencesOperationV2
  | UndoDatabaseListOccurrenceMoveOperationV2
  | ReverseDatabaseDataEditOperationV2
  | PutDatabaseViewPersonalPreferencesOperationV2
  | SetDatabaseViewOccurrenceDisclosureOperationV2;

export interface DatabaseApplyV2 {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly actor: Readonly<Record<string, DatabaseJsonValue>>;
  readonly operations: readonly DatabaseApplyOperationV2[];
}

export type LibraryDatabaseApplyV2 = Omit<DatabaseApplyV2, "projectId" | "actor">;

export interface DatabaseApplyReceiptV2 {
  readonly operationId: string;
  readonly projectId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly duplicate: boolean;
  readonly operationKinds: readonly DatabaseApplyOperationV2["kind"][];
  readonly operationOutcomes: readonly DatabaseOperationOutcomeV2[];
  readonly affectedDatabaseIds: readonly DatabaseId[];
  readonly affectedDataSourceIds: readonly DataSourceId[];
  readonly affectedPageIds: readonly string[];
  readonly affectedViewIds: readonly DatabaseViewId[];
  readonly committedRevisions: Readonly<Record<string, number>>;
  readonly commitSeq: number;
  readonly committedAt: string;
}

export interface LibraryDatabaseApplyReceiptV2 extends Omit<DatabaseApplyReceiptV2, "projectId"> {
  readonly accessContext: { readonly kind: "library" };
}

export type LibraryDatabaseApplyResultV2 =
  | LocalCommitCommandSuccess<LibraryDatabaseApplyReceiptV2>
  | { readonly ok: false; readonly error: DatabaseModuleErrorV2 };

export type DatabaseApplyResultV2 =
  | LocalCommitCommandSuccess<DatabaseApplyReceiptV2>
  | { readonly ok: false; readonly error: DatabaseModuleErrorV2 };

export interface DatabaseModuleV2 {
  read(input: DatabaseModuleReadRequestV2): Promise<DatabaseModuleReadResultV2>;
  apply(input: DatabaseApplyV2): Promise<DatabaseApplyResultV2>;
}
