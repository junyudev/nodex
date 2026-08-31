import fs from "node:fs";
import path from "node:path";

type Category = "runtimeCompatibility" | "durableFormat" | "algorithmIdentity";
type Surface = readonly [
  key: `${string}:${string}`,
  category: Category,
  owner: string,
  strategy: string,
];

/**
 * Executable inventory for production TypeScript version declarations.
 * Same-build request, receipt, snapshot, and intent DTOs do not belong here.
 */
const VERSION_SURFACES: readonly Surface[] = [
  [
    "crates/nodex-browser-profile-helper/src/main.rs:SCHEMA_VERSION",
    "runtimeCompatibility",
    "browser Profile helper protocol",
    "reject mismatched helper requests",
  ],
  [
    "crates/nodex-cli/src/agent_interface.rs:MACHINE_HELP_SCHEMA_VERSION",
    "runtimeCompatibility",
    "CLI machine help output",
    "reject unknown output schemas",
  ],
  [
    "crates/nodex-cli/src/draft.rs:DRAFT_SCHEMA_VERSION",
    "durableFormat",
    "CLI Page draft",
    "decode or reject draft directories",
  ],
  [
    "crates/nodex-cli/src/draft.rs:METADATA_PROJECTION_VERSION",
    "durableFormat",
    "CLI draft metadata projection",
    "migrate projected metadata",
  ],
  [
    "crates/nodex-cli/src/open.rs:OPEN_RESULT_SCHEMA_VERSION",
    "runtimeCompatibility",
    "CLI open result",
    "reject unknown output schemas",
  ],
  [
    "crates/nodex-cli/src/service.rs:ADAPTER_PROTOCOL_VERSION",
    "runtimeCompatibility",
    "CLI service adapter",
    "reject mismatched processes",
  ],
  [
    "crates/nodex-cli/src/skills/install.rs:SKILL_RESULT_SCHEMA_VERSION",
    "runtimeCompatibility",
    "CLI skill install result",
    "reject unknown output schemas",
  ],
  [
    "crates/nodex-cli/src/view.rs:VIEW_QUERY_SCHEMA_VERSION",
    "runtimeCompatibility",
    "CLI View query output",
    "reject unknown output schemas",
  ],
  [
    "crates/nodex-core-contracts/src/administration.rs:STORE_ADMINISTRATION_CONTRACT_VERSION",
    "runtimeCompatibility",
    "Store Administration Module",
    "negotiate generated Module requirements",
  ],
  [
    "crates/nodex-core-contracts/src/automation.rs:AUTOMATION_CONTRACT_VERSION",
    "runtimeCompatibility",
    "Automation Module",
    "negotiate generated Module requirements",
  ],
  [
    "crates/nodex-core-contracts/src/database.rs:DATABASE_CONTRACT_VERSION",
    "runtimeCompatibility",
    "Database Module",
    "negotiate generated Module requirements",
  ],
  [
    "crates/nodex-core-contracts/src/document.rs:OWNED_DOCUMENT_CONTRACT_VERSION",
    "runtimeCompatibility",
    "Owned Document Module",
    "negotiate generated Module requirements",
  ],
  [
    "crates/nodex-core-contracts/src/document.rs:OWNED_DOCUMENT_DESCRIPTOR_VERSION",
    "durableFormat",
    "Owned Document descriptor",
    "decode or reject descriptors",
  ],
  [
    "crates/nodex-core-contracts/src/lib.rs:CORE_EVENT_VERSION",
    "runtimeCompatibility",
    "Core event stream",
    "negotiate and reject unsupported events",
  ],
  [
    "crates/nodex-core-contracts/src/library.rs:LIBRARY_CONTRACT_VERSION",
    "runtimeCompatibility",
    "Library Module",
    "negotiate generated Module requirements",
  ],
  [
    "crates/nodex-core-contracts/src/workspace.rs:PROJECT_WORKSPACE_CONTRACT_VERSION",
    "runtimeCompatibility",
    "Project Workspace Module",
    "negotiate generated Module requirements",
  ],
  [
    "crates/nodex-core-protocol/src/lib.rs:COMPATIBILITY_MANIFEST_VERSION",
    "runtimeCompatibility",
    "Core compatibility manifest",
    "reject noncanonical manifests",
  ],
  [
    "crates/nodex-core-server/src/lib.rs:INTERNAL_STARTUP_EVENTS_VERSION",
    "runtimeCompatibility",
    "Core startup event stream",
    "reject unsupported startup frames",
  ],
  [
    "crates/nodex-core-server/src/lifecycle_summary.rs:SUMMARY_VERSION",
    "durableFormat",
    "Core lifecycle summary",
    "decode or replace diagnostic summaries",
  ],
  [
    "crates/nodex-core/src/administration/backup.rs:BACKUP_INTEGRITY_EVIDENCE_VERSION",
    "durableFormat",
    "backup integrity evidence",
    "validate captured evidence before backup reuse",
  ],
  [
    "crates/nodex-core/src/administration/backup.rs:BACKUP_JOB_VERSION",
    "durableFormat",
    "backup job recovery record",
    "reject unsupported job records during recovery",
  ],
  [
    "crates/nodex-core/src/administration/backup.rs:BACKUP_MANIFEST_VERSION",
    "durableFormat",
    "Store backup manifest",
    "validate before restore",
  ],
  [
    "crates/nodex-core/src/administration/profile_clone.rs:PROFILE_SNAPSHOT_VERSION",
    "durableFormat",
    "development Profile snapshot",
    "validate snapshot evidence before cloning",
  ],
  [
    "crates/nodex-core/src/database/view_contract.rs:VIEW_SCHEMA_VERSION",
    "durableFormat",
    "Database View",
    "migrate saved View definitions",
  ],
  [
    "crates/nodex-core/src/document/block_document.rs:PAGE_SCHEMA_VERSION",
    "durableFormat",
    "Page Document",
    "select the persisted Document decoder",
  ],
  [
    "crates/nodex-core/src/document/block_document.rs:REUSABLE_TEMPLATE_SCHEMA_VERSION",
    "durableFormat",
    "Reusable Template Document",
    "select the persisted Document decoder",
  ],
  [
    "crates/nodex-core/src/document/block_document.rs:SYNCED_BLOCK_SCHEMA_VERSION",
    "durableFormat",
    "Synced Block Document",
    "select the persisted Document decoder",
  ],
  [
    "crates/nodex-core/src/document/canvas.rs:PROJECTION_VERSION",
    "durableFormat",
    "Canvas projection",
    "rebuild incompatible projections",
  ],
  [
    "crates/nodex-core/src/document/canvas_scene.rs:CANVAS_SCHEMA_VERSION",
    "durableFormat",
    "Canvas Document",
    "select the persisted Canvas decoder",
  ],
  [
    "crates/nodex-core/src/document/canvas_scene.rs:CANVAS_SCENE_HASH_VERSION",
    "algorithmIdentity",
    "Canvas scene hash",
    "recompute hashes with the named algorithm",
  ],
  [
    "crates/nodex-core/src/document/schema_migration.rs:BASELINE_PAGE_SCHEMA_VERSION",
    "durableFormat",
    "Block children migration Page baseline",
    "migrate the exact legacy Page schema",
  ],
  [
    "crates/nodex-core/src/document/schema_migration.rs:BASELINE_REUSABLE_TEMPLATE_SCHEMA_VERSION",
    "durableFormat",
    "Block children migration reusable-template baseline",
    "migrate the exact legacy reusable-template schema",
  ],
  [
    "crates/nodex-core/src/document/schema_migration.rs:BASELINE_SYNCED_BLOCK_SCHEMA_VERSION",
    "durableFormat",
    "Block children migration synced-Block baseline",
    "migrate the exact legacy synced-Block schema",
  ],
  [
    "crates/nodex-core/src/document/materialization.rs:CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION",
    "durableFormat",
    "Document materialization derivation",
    "rebuild incompatible projections",
  ],
  [
    "crates/nodex-core/src/document/persistence.rs:PROJECTION_VERSION",
    "durableFormat",
    "Document projection",
    "rebuild incompatible projections",
  ],
  [
    "crates/nodex-core/src/domain/task_shorthand.rs:TASK_SHORTHAND_GRAMMAR_VERSION",
    "algorithmIdentity",
    "task shorthand grammar",
    "persist the parser identity in Undo evidence",
  ],
  [
    "crates/nodex-core/src/infrastructure/authorized_delivery.rs:DELIVERY_PACKET_VERSION",
    "durableFormat",
    "authorized delivery packet",
    "decode durable delivery evidence",
  ],
  [
    "crates/nodex-core/src/infrastructure/cursor.rs:PAYLOAD_VERSION",
    "durableFormat",
    "opaque Core cursor",
    "reject unsupported cursor payloads",
  ],
  [
    "crates/nodex-core/src/infrastructure/local_commit.rs:CANONICAL_HASH_VERSION",
    "algorithmIdentity",
    "Local Commit canonical hash",
    "migrate canonical manifests",
  ],
  [
    "crates/nodex-core/src/infrastructure/operational_journal.rs:POLICY_VERSION",
    "algorithmIdentity",
    "operational journal maintenance policy",
    "invalidate completed work after policy changes",
  ],
  [
    "crates/nodex-core/src/infrastructure/local_commit.rs:PROJECTION_SCHEMA_VERSION",
    "durableFormat",
    "Local Commit projection",
    "rebuild incompatible projections",
  ],
  [
    "crates/nodex-core/src/infrastructure/projection_scope_head.rs:PROJECTION_SCOPE_SCHEMA_VERSION",
    "durableFormat",
    "projection scope head",
    "validate durable scope identities",
  ],
  [
    "crates/nodex-core/src/infrastructure/sqlite.rs:MIN_SQLITE_VERSION",
    "runtimeCompatibility",
    "SQLite runtime",
    "reject unsupported native runtimes",
  ],
  [
    "crates/nodex-core/src/infrastructure/store_replacement.rs:JOURNAL_VERSION",
    "durableFormat",
    "Store replacement journal",
    "resume or reject journal state",
  ],
  [
    "crates/nodex-core/src/infrastructure/store_validation_receipt.rs:RECEIPT_VERSION",
    "durableFormat",
    "Store validation receipt",
    "validate receipt evidence before reuse",
  ],
  [
    "crates/nodex-core/src/library/block_transfer.rs:BLOCK_TRANSFER_UNDO_RECIPE_VERSION",
    "durableFormat",
    "Block transfer Undo recipe",
    "decode exact recipe versions",
  ],
  [
    "crates/nodex-core/src/library/page_projection.rs:PAGE_DRAFT_VERSION",
    "durableFormat",
    "Library Page draft",
    "decode or reject draft files",
  ],
  [
    "crates/nodex-core/src/library/page_projection.rs:PAGE_FILE_VERSION",
    "durableFormat",
    "Library Page file",
    "decode or migrate Page files",
  ],
  [
    "crates/nodex-core/src/library/search_snapshot.rs:PROJECTION_VERSION",
    "durableFormat",
    "Library search projection",
    "rebuild incompatible snapshots",
  ],
  [
    "crates/nodex-core/src/library/search_snapshot.rs:SNAPSHOT_VERSION",
    "durableFormat",
    "Library search snapshot",
    "decode or reject snapshot manifests",
  ],
  [
    "crates/nodex-core/src/library/structural_edit.rs:RECIPE_VERSION",
    "durableFormat",
    "structural edit Undo recipe",
    "decode exact recipe versions",
  ],
  [
    "crates/nodex-core/src/library/structural_edit.rs:SNAPSHOT_VERSION",
    "durableFormat",
    "structural clipboard snapshot",
    "reject unsupported clipboard snapshots",
  ],
  [
    "crates/nodex-core/src/workspace/queued_follow_up.rs:MANIFEST_SCHEMA_VERSION",
    "durableFormat",
    "queued follow-up payload manifest",
    "decode or reject queued payload manifests",
  ],
  [
    "crates/nodex-core/src/workspace/execution.rs:AUTHORITY_PROVENANCE_VERSION",
    "durableFormat",
    "execution authority provenance",
    "decode durable authority evidence",
  ],
  [
    "crates/nodex-store-format/src/lib.rs:CURRENT_STORE_VERSION",
    "durableFormat",
    "Store format catalog",
    "migrate recognized revisions and reject drift",
  ],
  [
    "scripts/development-environment-home.ts:DEVELOPMENT_HOME_MANIFEST_VERSION",
    "durableFormat",
    "development environment home",
    "reject unknown manifests",
  ],
  [
    "scripts/prepared-electron-build.ts:MANIFEST_SCHEMA_VERSION",
    "durableFormat",
    "prepared Electron build",
    "reject unknown manifests",
  ],
  [
    "scripts/scenarios/contracts.ts:SCENARIO_MANIFEST_VERSION",
    "durableFormat",
    "scenario harness",
    "reject unknown manifests",
  ],
  [
    "scripts/scenarios/profile/isolated-profile-manifest.ts:ISOLATED_PROFILE_MANIFEST_VERSION",
    "durableFormat",
    "isolated Profile",
    "reject unknown manifests",
  ],
  [
    "scripts/semantic-theme/profile.ts:SEMANTIC_THEME_GENERATOR_VERSION",
    "algorithmIdentity",
    "semantic theme generator",
    "regenerate artifacts",
  ],
  [
    "scripts/semantic-theme/profile.ts:SEMANTIC_THEME_REF_VERSION",
    "algorithmIdentity",
    "semantic theme reference",
    "pin the reference input",
  ],
  [
    "src/main/browser/browser-credential-vault.ts:FILE_SCHEMA_VERSION",
    "durableFormat",
    "browser credential vault",
    "decode or reject files",
  ],
  [
    "src/main/codex/bundled-desktop-tool-marketplace.ts:MATERIALIZATION_SCHEMA_VERSION",
    "durableFormat",
    "bundled tool marketplace",
    "rebuild materialized state",
  ],
  [
    "src/main/codex/codex-thread-handoff-capability.ts:MINIMUM_HANDOFF_RUNTIME_VERSION",
    "runtimeCompatibility",
    "Codex handoff capability",
    "disable on older runtimes",
  ],
  [
    "src/main/codex/codex-thread-handoff-journal.ts:CODEX_THREAD_HANDOFF_JOURNAL_SCHEMA_VERSION",
    "durableFormat",
    "Codex handoff journal",
    "decode or reject files",
  ],
  [
    "src/main/core-client/core-client.ts:MODULE_CONTRACT_VERSIONS",
    "runtimeCompatibility",
    "generated Core requirements",
    "inject exact Module contracts",
  ],
  [
    "src/main/dictation/mac-dictation-native-helper-client.ts:MAC_DICTATION_HELPER_PROTOCOL_VERSION",
    "runtimeCompatibility",
    "macOS dictation helper protocol",
    "reject mismatched helper processes",
  ],
  [
    "src/main/sparkle-mac-app-updater.ts:SPARKLE_VERSION",
    "runtimeCompatibility",
    "Sparkle updater binding",
    "pin native compatibility",
  ],
  [
    "src/main/window-session-state.ts:WINDOW_SESSION_VERSION",
    "durableFormat",
    "window session state",
    "migrate persisted sessions",
  ],
  [
    "src/main/worktree-worker/worktree-worker-protocol.ts:CODEX_WORKTREE_WORKER_PROTOCOL_VERSION",
    "runtimeCompatibility",
    "worktree worker",
    "reject mismatched processes",
  ],
  [
    "src/renderer/lib/canvas-scene-outbox.ts:CANVAS_SCENE_OUTBOX_DATABASE_VERSION",
    "durableFormat",
    "Canvas outbox",
    "upgrade IndexedDB",
  ],
  [
    "src/renderer/lib/document-local-checkpoint.ts:DATABASE_VERSION",
    "durableFormat",
    "Document checkpoint cache",
    "upgrade IndexedDB",
  ],
  [
    "src/renderer/lib/git-worker-client.ts:GIT_WORKER_CLIENT_PROTOCOL_VERSION",
    "runtimeCompatibility",
    "Git worker client",
    "alias worker authority",
  ],
  [
    "src/renderer/lib/owned-block-document.ts:PAGE_BLOCK_DOCUMENT_SCHEMA_VERSION",
    "durableFormat",
    "Page Document adapter",
    "alias schema authority",
  ],
  [
    "src/shared/authorized-delivery-packet.ts:PACKET_VERSION",
    "durableFormat",
    "authorized delivery packet",
    "decode delivery evidence",
  ],
  [
    "src/shared/codex-queued-follow-up-state.ts:CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION",
    "durableFormat",
    "queued follow-up payload manifest",
    "decode or reject queued payload manifests",
  ],
  [
    "src/shared/block-documents/additional-document-bearing-blocks.ts:REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION",
    "durableFormat",
    "Reusable Template Document",
    "select decoder",
  ],
  [
    "src/shared/block-documents/canvas-document-identity.ts:CANVAS_DOCUMENT_SCHEMA_VERSION",
    "durableFormat",
    "Canvas Document",
    "select decoder",
  ],
  [
    "src/shared/block-documents/canvas-scene.ts:CANVAS_SCENE_SCHEMA_VERSION",
    "durableFormat",
    "Canvas scene",
    "decode or migrate scenes",
  ],
  [
    "src/shared/block-documents/page-document.ts:PAGE_DOCUMENT_SCHEMA_VERSION",
    "durableFormat",
    "Page Document",
    "select decoder",
  ],
  [
    "src/shared/block-documents/portable-rich-text.ts:PORTABLE_RICH_TEXT_VERSION",
    "durableFormat",
    "portable rich text",
    "decode persisted text",
  ],
  [
    "src/shared/block-documents/synced-block-document.ts:SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION",
    "durableFormat",
    "Synced Block Document",
    "select decoder",
  ],
  [
    "src/shared/browser-runtime-metadata.ts:BROWSER_RUNTIME_SCHEMA_VERSION",
    "durableFormat",
    "browser runtime manifest",
    "decode or reject manifests",
  ],
  [
    "src/shared/browser/browser-use-capability-projection.ts:BROWSER_USE_CAPABILITY_FORMAT_VERSION",
    "runtimeCompatibility",
    "Browser Use artifact",
    "reject incompatible artifacts",
  ],
  [
    "src/shared/codex-conversation-state/test-fixtures/agent-activity-v2-fixture-schema.ts:AGENT_ACTIVITY_V2_FIXTURE_SCHEMA_VERSION",
    "durableFormat",
    "Agent activity fixture",
    "decode frozen fixtures",
  ],
  [
    "src/shared/codex-conversation-state/test-fixtures/agent-activity-v2-payload-corpus-manifest.ts:AGENT_ACTIVITY_V2_PAYLOAD_CORPUS_MANIFEST_SCHEMA_VERSION",
    "durableFormat",
    "Agent activity corpus",
    "decode frozen manifests",
  ],
  [
    "src/shared/codex-runtime-metadata.ts:AGENT_RUNTIME_LAYOUT_VERSION",
    "durableFormat",
    "Agent runtime layout",
    "decode installed layouts",
  ],
  [
    "src/shared/command-keybindings.ts:COMMAND_KEYMAP_VERSION",
    "durableFormat",
    "command keymap",
    "migrate persisted keymaps",
  ],
  [
    "src/shared/database-events.ts:DATABASE_CHANGE_EVENT_VERSION",
    "runtimeCompatibility",
    "Database event stream",
    "reject unsupported frames",
  ],
  [
    "src/shared/dictation-history.ts:DICTATION_RECORDING_SCHEMA_VERSION",
    "durableFormat",
    "dictation recording history",
    "decode or reject recording metadata",
  ],
  [
    "src/shared/git-worker-protocol.ts:GIT_WORKER_PROTOCOL_VERSION",
    "runtimeCompatibility",
    "Git worker protocol",
    "reject mismatched processes",
  ],
  [
    "src/shared/library-events.ts:LIBRARY_NAVIGATION_EVENT_VERSION",
    "runtimeCompatibility",
    "Library event stream",
    "reject unsupported frames",
  ],
  [
    "src/shared/nodex-agent-authority.ts:NODEX_AGENT_AUTHORITY_PROVENANCE_VERSION",
    "durableFormat",
    "Agent authority provenance",
    "decode durable evidence",
  ],
  [
    "src/shared/recipient-delivery.ts:RECIPIENT_DELIVERY_VERSION",
    "durableFormat",
    "recipient delivery",
    "decode durable records",
  ],
  [
    "src/shared/workbench-panel-layout.ts:WORKBENCH_PANEL_LAYOUT_VERSION",
    "durableFormat",
    "Workbench panel layout",
    "migrate layouts",
  ],
  [
    "src/shared/workbench-scene.ts:WORKBENCH_SCENE_VERSION",
    "durableFormat",
    "Workbench scene",
    "migrate scenes",
  ],
  [
    "src/shared/workbench-session-view.ts:WORKBENCH_SESSION_VIEW_VERSION",
    "durableFormat",
    "Workbench session view",
    "migrate views",
  ],
];

const filesUnder = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") return [];
      return filesUnder(candidate);
    }
    return /\.(?:tsx?|rs)$/u.test(entry.name) && !/\.test\./u.test(entry.name) ? [candidate] : [];
  });
};

const declaration = /^(?:(?:export|pub(?:\(crate\))?) )?const ([A-Z][A-Z0-9_]*VERSION(?:S)?)\b/gmu;
const observed = new Set<string>();
for (const file of ["crates", "src", "scripts", "packages"].flatMap(filesUnder)) {
  for (const match of fs.readFileSync(file, "utf8").matchAll(declaration)) {
    observed.add(`${file}:${match[1]}`);
  }
}

const registered: ReadonlyMap<string, Surface> = new Map(
  VERSION_SURFACES.map((entry) => [entry[0], entry]),
);
const keys = VERSION_SURFACES.map((entry) => entry[0]);
const failures = [
  ...keys
    .filter((key, index) => keys.indexOf(key) !== index)
    .map((key) => `duplicate registry entry: ${key}`),
  ...[...observed]
    .filter((key) => !registered.has(key))
    .sort()
    .map((key) => `unclassified version surface: ${key}`),
  ...[...registered.keys()]
    .filter((key) => !observed.has(key))
    .sort()
    .map((key) => `stale version registry entry: ${key}`),
  ...VERSION_SURFACES.filter((entry) => !entry[2].trim() || !entry[3].trim()).map(
    (entry) => `owner/strategy missing: ${entry[0]}`,
  ),
  ...[...observed]
    .filter(
      (key) =>
        key.slice(key.lastIndexOf(":") + 1).endsWith("CONTRACT_VERSION") &&
        !key.startsWith("crates/nodex-core-contracts/src/"),
    )
    .map(
      (key) => `shadow *_CONTRACT_VERSION is forbidden outside generated Core requirements: ${key}`,
    ),
];

if (failures.length > 0) {
  throw new Error(`Version surface audit failed:\n${failures.join("\n")}`);
}

console.log(`Version surface audit passed (${observed.size} classified declarations).`);
