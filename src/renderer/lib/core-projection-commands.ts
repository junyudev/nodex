import type { BlockPropertyMutationRequestV2 } from "../../shared/block-property-mutations-v2";
import type {
  DatabaseApplyOperationV2,
  DatabaseApplyV2,
  LibraryDatabaseApplyV2,
} from "../../shared/database-module-v2";
import type { IpcOperationDefinitionMap } from "../../shared/ipc-endpoint-policy";
import type { LibraryModuleApplyRequest } from "../../shared/library-module";
import type {
  PageLifecycleMutationRequestV2,
  PageLifecycleOperationV2,
} from "../../shared/page-lifecycle-v2";
import {
  defineLocalCommitRendererCommand,
  type LocalCommitRendererCommandDefinition,
} from "./renderer-command";

type ReceiptFencedProjection = {
  readonly kind: "receipt_fenced_projection";
  readonly presentation: "required";
};

type ProjectDatabaseCommand = LocalCommitRendererCommandDefinition<
  string,
  "database-module:apply",
  ReceiptFencedProjection
>;

type LibraryDatabaseCommand = LocalCommitRendererCommandDefinition<
  string,
  "library-database-module:apply",
  ReceiptFencedProjection
>;

type PageLifecycleCommand = LocalCommitRendererCommandDefinition<
  string,
  "pages:lifecycle:apply",
  ReceiptFencedProjection
>;

const defineProjectDatabaseOperation = (
  kind: DatabaseApplyOperationV2["kind"],
): ProjectDatabaseCommand => defineProjectDatabaseCommand(kind);

const defineProjectDatabaseCommand = (key: string): ProjectDatabaseCommand =>
  defineLocalCommitRendererCommand({
    key: `database.${key}`,
    channel: "database-module:apply",
    authority: "core",
    owner: "DatabaseModule",
    protocol: { kind: "receipt_fenced_projection", presentation: "required" },
  });

/**
 * Database Settings does not present a predictable local projection. It remains
 * pending through exact apply admission and its causally fenced descriptor reread.
 */
export const databaseSettingsApplyCommand = defineLocalCommitRendererCommand({
  key: "database.settings.apply",
  channel: "database-module:apply",
  authority: "core",
  owner: "DatabaseSettingsRuntime",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "database" },
});

const defineLibraryDatabaseOperation = (
  kind: DatabaseApplyOperationV2["kind"],
): LibraryDatabaseCommand => defineLibraryDatabaseCommand(kind);

const defineLibraryDatabaseCommand = (key: string): LibraryDatabaseCommand =>
  defineLocalCommitRendererCommand({
    key: `library_database.${key}`,
    channel: "library-database-module:apply",
    authority: "core",
    owner: "LibraryDatabaseModule",
    protocol: { kind: "receipt_fenced_projection", presentation: "required" },
  });

const definePageLifecycleOperation = (
  kind: PageLifecycleOperationV2["kind"],
): PageLifecycleCommand =>
  defineLocalCommitRendererCommand({
    key: `page_lifecycle.${kind}`,
    channel: "pages:lifecycle:apply",
    authority: "core",
    owner: "PageLifecycleRuntime",
    protocol: { kind: "receipt_fenced_projection", presentation: "required" },
  });

const projectDatabaseCommands = {
  change_property_type: defineProjectDatabaseOperation("change_property_type"),
  change_view_layout: defineProjectDatabaseOperation("change_view_layout"),
  delete_option: defineProjectDatabaseOperation("delete_option"),
  delete_option_and_clear_values: defineProjectDatabaseOperation("delete_option_and_clear_values"),
  delete_property: defineProjectDatabaseOperation("delete_property"),
  delete_view: defineProjectDatabaseOperation("delete_view"),
  duplicate_property: defineProjectDatabaseOperation("duplicate_property"),
  duplicate_view: defineProjectDatabaseOperation("duplicate_view"),
  edit_property_values: defineProjectDatabaseOperation("edit_property_values"),
  move_list_occurrences: defineProjectDatabaseOperation("move_list_occurrences"),
  move_option: defineProjectDatabaseOperation("move_option"),
  move_property: defineProjectDatabaseOperation("move_property"),
  move_view: defineProjectDatabaseOperation("move_view"),
  permanently_delete_property: defineProjectDatabaseOperation("permanently_delete_property"),
  position_page: defineProjectDatabaseOperation("position_page"),
  position_pages: defineProjectDatabaseOperation("position_pages"),
  put_option: defineProjectDatabaseOperation("put_option"),
  put_page_layout_entry: defineProjectDatabaseOperation("put_page_layout_entry"),
  put_property: defineProjectDatabaseOperation("put_property"),
  put_view: defineProjectDatabaseOperation("put_view"),
  put_view_personal_preferences: defineProjectDatabaseOperation("put_view_personal_preferences"),
  rename_page_key_prefix: defineProjectDatabaseOperation("rename_page_key_prefix"),
  restore_property: defineProjectDatabaseOperation("restore_property"),
  set_task_parent: defineProjectDatabaseOperation("set_task_parent"),
  set_view_occurrence_disclosure: defineProjectDatabaseOperation("set_view_occurrence_disclosure"),
  transfer_page: defineProjectDatabaseOperation("transfer_page"),
  undo_list_occurrence_move: defineProjectDatabaseOperation("undo_list_occurrence_move"),
} satisfies IpcOperationDefinitionMap<DatabaseApplyOperationV2["kind"], ProjectDatabaseCommand>;

const libraryDatabaseCommands = {
  change_property_type: defineLibraryDatabaseOperation("change_property_type"),
  change_view_layout: defineLibraryDatabaseOperation("change_view_layout"),
  delete_option: defineLibraryDatabaseOperation("delete_option"),
  delete_option_and_clear_values: defineLibraryDatabaseOperation("delete_option_and_clear_values"),
  delete_property: defineLibraryDatabaseOperation("delete_property"),
  delete_view: defineLibraryDatabaseOperation("delete_view"),
  duplicate_property: defineLibraryDatabaseOperation("duplicate_property"),
  duplicate_view: defineLibraryDatabaseOperation("duplicate_view"),
  edit_property_values: defineLibraryDatabaseOperation("edit_property_values"),
  move_list_occurrences: defineLibraryDatabaseOperation("move_list_occurrences"),
  move_option: defineLibraryDatabaseOperation("move_option"),
  move_property: defineLibraryDatabaseOperation("move_property"),
  move_view: defineLibraryDatabaseOperation("move_view"),
  permanently_delete_property: defineLibraryDatabaseOperation("permanently_delete_property"),
  position_page: defineLibraryDatabaseOperation("position_page"),
  position_pages: defineLibraryDatabaseOperation("position_pages"),
  put_option: defineLibraryDatabaseOperation("put_option"),
  put_page_layout_entry: defineLibraryDatabaseOperation("put_page_layout_entry"),
  put_property: defineLibraryDatabaseOperation("put_property"),
  put_view: defineLibraryDatabaseOperation("put_view"),
  put_view_personal_preferences: defineLibraryDatabaseOperation("put_view_personal_preferences"),
  rename_page_key_prefix: defineLibraryDatabaseOperation("rename_page_key_prefix"),
  restore_property: defineLibraryDatabaseOperation("restore_property"),
  set_task_parent: defineLibraryDatabaseOperation("set_task_parent"),
  set_view_occurrence_disclosure: defineLibraryDatabaseOperation("set_view_occurrence_disclosure"),
  transfer_page: defineLibraryDatabaseOperation("transfer_page"),
  undo_list_occurrence_move: defineLibraryDatabaseOperation("undo_list_occurrence_move"),
} satisfies IpcOperationDefinitionMap<DatabaseApplyOperationV2["kind"], LibraryDatabaseCommand>;

type DatabaseOperationKind = DatabaseApplyOperationV2["kind"];
type DatabaseOperationSet = readonly [
  DatabaseOperationKind,
  DatabaseOperationKind,
  ...DatabaseOperationKind[],
];

const databaseOperationSetSignature = (kinds: readonly DatabaseOperationKind[]): string =>
  [...new Set(kinds)].sort().join("+");

const defineDatabaseOperationSet = <const Kinds extends DatabaseOperationSet>(
  key: string,
  kinds: Kinds,
) => ({
  signature: databaseOperationSetSignature(kinds),
  project: defineProjectDatabaseCommand(key),
  library: defineLibraryDatabaseCommand(key),
});

/**
 * Atomic Database batches with more than one operation kind need one named owner action.
 * Keep this registry limited to operation sets emitted by production renderer compilers.
 */
const databaseOperationSetCommands = [
  defineDatabaseOperationSet("publish_view", ["put_view", "put_view_personal_preferences"]),
  defineDatabaseOperationSet("move_page", ["edit_property_values", "position_page"]),
  defineDatabaseOperationSet("move_pages", ["edit_property_values", "position_pages"]),
  defineDatabaseOperationSet("create_option_and_select", ["put_option", "edit_property_values"]),
] as const;

type LibraryOperationKind = LibraryModuleApplyRequest["operation"]["kind"];
type LibraryOperationCommand = LocalCommitRendererCommandDefinition<
  string,
  "library-module:apply",
  { readonly kind: "pending_operation" }
>;

/**
 * Library apply proves durable admission, not an initiating bounded projection.
 * A semantic owner may upgrade one operation to receipt-fenced presentation only
 * after it supplies an exact materialization predicate and rendered handoff.
 */
const defineLibraryOperation = (kind: LibraryOperationKind): LibraryOperationCommand =>
  defineLocalCommitRendererCommand({
    key: `library.${kind}`,
    channel: "library-module:apply",
    authority: "core",
    owner: "LibraryOperationRuntime",
    protocol: { kind: "pending_operation" },
  });

const libraryCommands = {
  apply_page_file_changes: defineLibraryOperation("apply_page_file_changes"),
  apply_page_metadata_properties: defineLibraryOperation("apply_page_metadata_properties"),
  apply_structural_edit: defineLibraryOperation("apply_structural_edit"),
  archive_resource: defineLibraryOperation("archive_resource"),
  create_canvas: defineLibraryOperation("create_canvas"),
  create_database: defineLibraryOperation("create_database"),
  create_page: defineLibraryOperation("create_page"),
  create_page_mention: defineLibraryOperation("create_page_mention"),
  delete_canvas: defineLibraryOperation("delete_canvas"),
  duplicate_canvas: defineLibraryOperation("duplicate_canvas"),
  grant_project_access: defineLibraryOperation("grant_project_access"),
  move_block: defineLibraryOperation("move_block"),
  move_canvas: defineLibraryOperation("move_canvas"),
  move_page: defineLibraryOperation("move_page"),
  rename_canvas: defineLibraryOperation("rename_canvas"),
  restore_resource: defineLibraryOperation("restore_resource"),
  reverse_structural_edit: defineLibraryOperation("reverse_structural_edit"),
  set_project_access: defineLibraryOperation("set_project_access"),
  undo_page_relocation: defineLibraryOperation("undo_page_relocation"),
} satisfies IpcOperationDefinitionMap<LibraryOperationKind, LibraryOperationCommand>;

export const blockPropertyMutationCommand = defineLocalCommitRendererCommand({
  key: "block_properties.set_intrinsic_fields",
  channel: "block-properties:mutate",
  authority: "core",
  owner: "BlockProperties",
  protocol: { kind: "receipt_fenced_projection", presentation: "required" },
});

export const libraryBlockPropertyMutationCommand = defineLocalCommitRendererCommand({
  key: "library_block_properties.set_intrinsic_fields",
  channel: "library-block-properties:mutate",
  authority: "core",
  owner: "LibraryBlockProperties",
  protocol: { kind: "receipt_fenced_projection", presentation: "required" },
});

const pageLifecycleCommands = {
  archive_page: definePageLifecycleOperation("archive_page"),
  create_page: definePageLifecycleOperation("create_page"),
  delete_page: definePageLifecycleOperation("delete_page"),
  move_page_in_library: definePageLifecycleOperation("move_page_in_library"),
  restore_page: definePageLifecycleOperation("restore_page"),
  unarchive_page: definePageLifecycleOperation("unarchive_page"),
} satisfies IpcOperationDefinitionMap<PageLifecycleOperationV2["kind"], PageLifecycleCommand>;

export function projectDatabaseCommandFor(request: DatabaseApplyV2): ProjectDatabaseCommand {
  return commandForDatabaseOperations(
    request.operations,
    projectDatabaseCommands,
    (operationSet) => operationSet.project,
    "Database apply",
  );
}

export function libraryDatabaseCommandFor(request: LibraryDatabaseApplyV2): LibraryDatabaseCommand {
  return commandForDatabaseOperations(
    request.operations,
    libraryDatabaseCommands,
    (operationSet) => operationSet.library,
    "Library Database apply",
  );
}

type DatabaseOperationSetCommand = (typeof databaseOperationSetCommands)[number];

function commandForDatabaseOperations<Command>(
  operations: readonly DatabaseApplyOperationV2[],
  definitions: IpcOperationDefinitionMap<DatabaseApplyOperationV2["kind"], Command>,
  selectOperationSetCommand: (operationSet: DatabaseOperationSetCommand) => Command,
  label: string,
): Command {
  const first = operations[0];
  if (!first) throw new TypeError(`${label} requires at least one operation`);

  const definition = definitions[first.kind];
  if (operations.every((operation) => definitions[operation.kind] === definition))
    return definition;

  const signature = databaseOperationSetSignature(operations.map((operation) => operation.kind));
  const operationSet = databaseOperationSetCommands.find(
    (candidate) => candidate.signature === signature,
  );
  if (operationSet) return selectOperationSetCommand(operationSet);

  throw new TypeError(`${label} with mixed operation kinds requires an owning semantic command`);
}

export function libraryCommandFor(request: LibraryModuleApplyRequest): LibraryOperationCommand {
  return libraryCommands[request.operation.kind];
}

export function pageLifecycleCommandFor(
  request: PageLifecycleMutationRequestV2,
): PageLifecycleCommand {
  return pageLifecycleCommands[request.operation.kind];
}

export function assertBlockPropertyMutation(request: BlockPropertyMutationRequestV2): void {
  if (request.fields.length === 0) {
    throw new TypeError("Block property mutation requires at least one field");
  }
}
