mod arguments;
pub(crate) mod schema;

use std::collections::BTreeMap;
use std::ffi::OsString;

use serde::Serialize;
use serde_json::Value;

use crate::error::{CliError, CliErrorCode};

pub const AGENT_API_MIN_REVISION: u32 = 1;
pub const AGENT_API_MAX_REVISION: u32 = 1;
const MACHINE_HELP_SCHEMA_VERSION: u32 = 4;
const NESTED_MARKDOWN_REVISION: u32 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CommandEffect {
    Read,
    Write,
    Local,
    Open,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CommandMetadata {
    path: &'static [&'static str],
    capability: &'static str,
    effect: CommandEffect,
    validators: &'static [&'static str],
    result: &'static str,
    errors: &'static [&'static str],
    example: &'static str,
    example_argv: &'static [&'static str],
}

const READ_ERRORS: &[&str] = &[
    "PROJECT_NOT_FOUND",
    "PROJECT_AMBIGUOUS",
    "PROFILE_MISMATCH",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNAUTHORIZED",
    "CORE_UNAVAILABLE",
    "PROTOCOL_INCOMPATIBLE",
];
const WRITE_ERRORS: &[&str] = &[
    "PROJECT_NOT_FOUND",
    "PROJECT_AMBIGUOUS",
    "PROFILE_MISMATCH",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNAUTHORIZED",
    "ETAG_CONFLICT",
    "IDEMPOTENCY_KEY_REUSED",
    "CORE_UNAVAILABLE",
    "PROTOCOL_INCOMPATIBLE",
];
const FILE_ERRORS: &[&str] = &[
    "PROJECT_NOT_FOUND",
    "PROJECT_AMBIGUOUS",
    "PROFILE_MISMATCH",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNAUTHORIZED",
    "ETAG_CONFLICT",
    "INVALID_INPUT",
    "IDEMPOTENCY_KEY_REUSED",
    "CORE_UNAVAILABLE",
    "PROTOCOL_INCOMPATIBLE",
];
const IDEMPOTENCY_VALIDATOR: &[&str] = &["idempotency_key"];
const ETAG_AND_IDEMPOTENCY_VALIDATORS: &[&str] = &["narrow_etag", "idempotency_key"];
const OPEN_ERRORS: &[&str] = &[
    "PROJECT_NOT_FOUND",
    "PROJECT_AMBIGUOUS",
    "PROFILE_MISMATCH",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNAUTHORIZED",
    "CORE_UNAVAILABLE",
    "PROTOCOL_INCOMPATIBLE",
    "OPEN_FAILED",
];
const SKILL_ERRORS: &[&str] = &[
    "SKILL_BUNDLE_UNAVAILABLE",
    "SKILL_BUNDLE_INVALID",
    "SKILL_TARGET_CONFLICT",
    "SKILL_TARGET_RACED",
    "SKILL_AGENT_UNSUPPORTED",
    "INVALID_INPUT",
];

const COMMANDS: &[CommandMetadata] = &[
    CommandMetadata {
        path: &["sql", "schema"],
        capability: "sql",
        effect: CommandEffect::Read,
        validators: &[],
        result: "sql_catalog",
        errors: READ_ERRORS,
        example: "nodex sql schema",
        example_argv: &["sql", "schema"],
    },
    CommandMetadata {
        path: &["sql", "query"],
        capability: "sql",
        effect: CommandEffect::Read,
        validators: &[],
        result: "sql_result",
        errors: READ_ERRORS,
        example: "nodex sql query 'SELECT page_id, title FROM pages LIMIT 20'",
        example_argv: &["sql", "query", "SELECT page_id, title FROM pages LIMIT 20"],
    },
    CommandMetadata {
        path: &["data-source", "configure"],
        capability: "configuration",
        effect: CommandEffect::Write,
        validators: &["schema_revision", "view_revision", "idempotency_key"],
        result: "configuration_receipt",
        errors: WRITE_ERRORS,
        example: "nodex data-source configure --input -",
        example_argv: &["data-source", "configure", "--input", "-"],
    },
    CommandMetadata {
        path: &["docs", "nested-markdown"],
        capability: "nestedMarkdown",
        effect: CommandEffect::Local,
        validators: &[],
        result: "nested_markdown_reference",
        errors: READ_ERRORS,
        example: "nodex docs nested-markdown",
        example_argv: &["docs", "nested-markdown"],
    },
    CommandMetadata {
        path: &["ls"],
        capability: "browse",
        effect: CommandEffect::Read,
        validators: &[],
        result: "child_window",
        errors: READ_ERRORS,
        example: "nodex ls page-id",
        example_argv: &["ls", "page-id"],
    },
    CommandMetadata {
        path: &["search"],
        capability: "search",
        effect: CommandEffect::Read,
        validators: &[],
        result: "ranked_page_search",
        errors: READ_ERRORS,
        example: "nodex search planning",
        example_argv: &["search", "planning"],
    },
    CommandMetadata {
        path: &["page", "properties", "prepare-batch"],
        capability: "properties",
        effect: CommandEffect::Read,
        validators: &[],
        result: "prepared_property_edits",
        errors: READ_ERRORS,
        example: "nodex page properties prepare-batch --selection - --values values.json",
        example_argv: &[
            "page",
            "properties",
            "prepare-batch",
            "--selection",
            "-",
            "--values",
            "values.json",
        ],
    },
    CommandMetadata {
        path: &["page", "properties", "apply"],
        capability: "properties",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "property_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page properties apply --input -",
        example_argv: &["page", "properties", "apply", "--input", "-"],
    },
    CommandMetadata {
        path: &["page", "properties", "set"],
        capability: "properties",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "property_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page properties set page-id --property property-id --option option-id --if-revision 0",
        example_argv: &[
            "page",
            "properties",
            "set",
            "page-id",
            "--property",
            "property-id",
            "--option",
            "option-id",
            "--if-revision",
            "0",
        ],
    },
    CommandMetadata {
        path: &["page", "create-batch"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "page_batch_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page create-batch --input -",
        example_argv: &["page", "create-batch", "--input", "-"],
    },
    CommandMetadata {
        path: &["capabilities"],
        capability: "capabilities",
        effect: CommandEffect::Read,
        validators: &[],
        result: "agent_capabilities",
        errors: &["SKILL_BUNDLE_INVALID"],
        example: "nodex --json capabilities",
        example_argv: &["--json", "capabilities"],
    },
    CommandMetadata {
        path: &["setup"],
        capability: "skills",
        effect: CommandEffect::Local,
        validators: &["global_only", "explicit_confirmation"],
        result: "agent_skill_setup",
        errors: SKILL_ERRORS,
        example: "nodex --json setup --agent codex --yes",
        example_argv: &["--json", "setup", "--agent", "codex", "--yes"],
    },
    CommandMetadata {
        path: &["skills", "status"],
        capability: "skills",
        effect: CommandEffect::Read,
        validators: &["global_only"],
        result: "agent_skill_status",
        errors: SKILL_ERRORS,
        example: "nodex --json skills status",
        example_argv: &["--json", "skills", "status"],
    },
    CommandMetadata {
        path: &["skills", "install"],
        capability: "skills",
        effect: CommandEffect::Local,
        validators: &["global_only", "explicit_confirmation"],
        result: "agent_skill_install",
        errors: SKILL_ERRORS,
        example: "nodex --json skills install --agent codex --yes",
        example_argv: &["--json", "skills", "install", "--agent", "codex", "--yes"],
    },
    CommandMetadata {
        path: &["skills", "remove"],
        capability: "skills",
        effect: CommandEffect::Local,
        validators: &["global_only", "managed_current_only"],
        result: "agent_skill_remove",
        errors: SKILL_ERRORS,
        example: "nodex --json skills remove --agent claude-code --yes",
        example_argv: &[
            "--json",
            "skills",
            "remove",
            "--agent",
            "claude-code",
            "--yes",
        ],
    },
    CommandMetadata {
        path: &["skills", "doctor"],
        capability: "skills",
        effect: CommandEffect::Read,
        validators: &["global_only"],
        result: "agent_skill_diagnostics",
        errors: SKILL_ERRORS,
        example: "nodex --json skills doctor",
        example_argv: &["--json", "skills", "doctor"],
    },
    CommandMetadata {
        path: &["context"],
        capability: "context",
        effect: CommandEffect::Read,
        validators: &[],
        result: "selected_profile_project_context",
        errors: READ_ERRORS,
        example: "nodex --json context",
        example_argv: &["--json", "context"],
    },
    CommandMetadata {
        path: &["tree"],
        capability: "tree",
        effect: CommandEffect::Read,
        validators: &[],
        result: "authorized_page_tree",
        errors: READ_ERRORS,
        example: "nodex --json tree database",
        example_argv: &["--json", "tree", "database"],
    },
    CommandMetadata {
        path: &["page", "prepare"],
        capability: "read",
        effect: CommandEffect::Read,
        validators: &["operation_scope"],
        result: "prepared_page_operation",
        errors: READ_ERRORS,
        example: "nodex page prepare page-id --operation move --view view-id",
        example_argv: &[
            "page",
            "prepare",
            "page-id",
            "--operation",
            "move",
            "--view",
            "view-id",
        ],
    },
    CommandMetadata {
        path: &["read"],
        capability: "read",
        effect: CommandEffect::Read,
        validators: &["read_validators"],
        result: "canonical_page_file",
        errors: READ_ERRORS,
        example: "nodex --json read page-id",
        example_argv: &["--json", "read", "page-id"],
    },
    CommandMetadata {
        path: &["sed"],
        capability: "read",
        effect: CommandEffect::Read,
        validators: &[],
        result: "canonical_page_line_slice",
        errors: READ_ERRORS,
        example: "nodex --json sed -n 1,20p page-id",
        example_argv: &["--json", "sed", "-n", "1,20p", "page-id"],
    },
    CommandMetadata {
        path: &["rg"],
        capability: "rg",
        effect: CommandEffect::Read,
        validators: &[],
        result: "ripgrep_matches_over_authorized_snapshot",
        errors: &[
            "PROFILE_MISMATCH",
            "SCOPE_NOT_FOUND",
            "SCOPE_UNAUTHORIZED",
            "MATERIALIZATION_STALE",
            "SNAPSHOT_EXPIRED",
            "RG_ARGUMENT_UNSUPPORTED",
        ],
        example: "nodex --json rg --fixed-strings Planning database",
        example_argv: &["--json", "rg", "--fixed-strings", "Planning", "database"],
    },
    CommandMetadata {
        path: &["open", "page"],
        capability: "open",
        effect: CommandEffect::Open,
        validators: &["project_authorization"],
        result: "canonical_resource_open",
        errors: OPEN_ERRORS,
        example: "nodex --json open page page-id --print",
        example_argv: &["--json", "open", "page", "page-id", "--print"],
    },
    CommandMetadata {
        path: &["open", "view"],
        capability: "open",
        effect: CommandEffect::Open,
        validators: &["project_authorization"],
        result: "canonical_resource_open",
        errors: OPEN_ERRORS,
        example: "nodex --json open view view-id --print",
        example_argv: &["--json", "open", "view", "view-id", "--print"],
    },
    CommandMetadata {
        path: &["patch"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex patch <<'PATCH'\n*** Begin Patch\n*** Update Page: page-id\n@@\n-Old note\n+Updated note\n*** End Patch\nPATCH",
        example_argv: &["patch"],
    },
    CommandMetadata {
        path: &["page", "create"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "page_creation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex --json page create --parent library --title Page --empty --idempotency-key create-1",
        example_argv: &[
            "--json",
            "page",
            "create",
            "--parent",
            "library",
            "--title",
            "Page",
            "--empty",
            "--idempotency-key",
            "create-1",
        ],
    },
    CommandMetadata {
        path: &["page", "insert"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page insert page-id <<'MARKDOWN'\n## Next steps\n- Review the proposal.\nMARKDOWN",
        example_argv: &["page", "insert", "page-id"],
    },
    CommandMetadata {
        path: &["page", "replace"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page replace page-id --if-match body-etag <<'MARKDOWN'\n## Updated plan\nReview the proposal.\nMARKDOWN",
        example_argv: &["page", "replace", "page-id", "--if-match", "body-etag"],
    },
    CommandMetadata {
        path: &["page", "rename"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page rename page-id Title --if-match title-etag",
        example_argv: &[
            "page",
            "rename",
            "page-id",
            "Title",
            "--if-match",
            "title-etag",
        ],
    },
    CommandMetadata {
        path: &["page", "move"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "page_transfer_receipt",
        errors: WRITE_ERRORS,
        example: "nodex --json page move page-id --to library --at end --if-match move-etag --idempotency-key move-1",
        example_argv: &[
            "--json",
            "page",
            "move",
            "page-id",
            "--to",
            "library",
            "--at",
            "end",
            "--if-match",
            "move-etag",
            "--idempotency-key",
            "move-1",
        ],
    },
    CommandMetadata {
        path: &["page", "duplicate"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "page_copy_receipt",
        errors: WRITE_ERRORS,
        example: "nodex --json page duplicate page-id --to library --at end --idempotency-key copy-1",
        example_argv: &[
            "--json",
            "page",
            "duplicate",
            "page-id",
            "--to",
            "library",
            "--at",
            "end",
            "--idempotency-key",
            "copy-1",
        ],
    },
    CommandMetadata {
        path: &["page", "delete"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "page_deletion_receipt",
        errors: WRITE_ERRORS,
        example: "nodex --json page delete page-id --if-match page-etag --idempotency-key delete-1",
        example_argv: &[
            "--json",
            "page",
            "delete",
            "page-id",
            "--if-match",
            "page-etag",
            "--idempotency-key",
            "delete-1",
        ],
    },
    CommandMetadata {
        path: &["file", "import"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &["project_authorization", "bounded_bytes", "idempotency_key"],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file import --from ./api.md --name api.md --idempotency-key file-import-1",
        example_argv: &[
            "--json",
            "file",
            "import",
            "--from",
            "./api.md",
            "--name",
            "api.md",
            "--idempotency-key",
            "file-import-1",
        ],
    },
    CommandMetadata {
        path: &["file", "read"],
        capability: "files",
        effect: CommandEffect::Read,
        validators: &[
            "project_authorization",
            "direct_file_access",
            "exact_version",
        ],
        result: "file_bytes_or_download_receipt",
        errors: READ_ERRORS,
        example: "nodex --json file read file-id --version 1 --output ./api.md",
        example_argv: &[
            "--json",
            "file",
            "read",
            "file-id",
            "--version",
            "1",
            "--output",
            "./api.md",
        ],
    },
    CommandMetadata {
        path: &["file", "rename"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &["project_authorization", "file_revision", "idempotency_key"],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file rename file-id --if-revision 1 --name reference.md --idempotency-key file-rename-1",
        example_argv: &[
            "--json",
            "file",
            "rename",
            "file-id",
            "--if-revision",
            "1",
            "--name",
            "reference.md",
            "--idempotency-key",
            "file-rename-1",
        ],
    },
    CommandMetadata {
        path: &["file", "replace"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "file_revision",
            "file_head",
            "bounded_bytes",
            "idempotency_key",
        ],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file replace file-id --if-revision 1 --if-head 1 --from ./api.md --idempotency-key file-replace-1",
        example_argv: &[
            "--json",
            "file",
            "replace",
            "file-id",
            "--if-revision",
            "1",
            "--if-head",
            "1",
            "--from",
            "./api.md",
            "--idempotency-key",
            "file-replace-1",
        ],
    },
    CommandMetadata {
        path: &["file", "fork"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &["project_authorization", "exact_version", "idempotency_key"],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file fork file-id --version 1 --name copy.md --idempotency-key file-fork-1",
        example_argv: &[
            "--json",
            "file",
            "fork",
            "file-id",
            "--version",
            "1",
            "--name",
            "copy.md",
            "--idempotency-key",
            "file-fork-1",
        ],
    },
    CommandMetadata {
        path: &["file", "restore"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "file_revision",
            "file_head",
            "exact_version",
            "idempotency_key",
        ],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file restore file-id --version 1 --if-revision 2 --if-head 2 --idempotency-key file-restore-1",
        example_argv: &[
            "--json",
            "file",
            "restore",
            "file-id",
            "--version",
            "1",
            "--if-revision",
            "2",
            "--if-head",
            "2",
            "--idempotency-key",
            "file-restore-1",
        ],
    },
    CommandMetadata {
        path: &["file", "trash"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "file_revision",
            "current_usage_guard",
            "idempotency_key",
        ],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file trash file-id --if-revision 1 --idempotency-key file-trash-1",
        example_argv: &[
            "--json",
            "file",
            "trash",
            "file-id",
            "--if-revision",
            "1",
            "--idempotency-key",
            "file-trash-1",
        ],
    },
    CommandMetadata {
        path: &["file", "untrash"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &["project_authorization", "file_revision", "idempotency_key"],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file untrash file-id --if-revision 2 --idempotency-key file-untrash-1",
        example_argv: &[
            "--json",
            "file",
            "untrash",
            "file-id",
            "--if-revision",
            "2",
            "--idempotency-key",
            "file-untrash-1",
        ],
    },
    CommandMetadata {
        path: &["file", "purge"],
        capability: "files",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "file_revision",
            "retention_guard",
            "idempotency_key",
        ],
        result: "file_mutation_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json file purge file-id --if-revision 3 --idempotency-key file-purge-1",
        example_argv: &[
            "--json",
            "file",
            "purge",
            "file-id",
            "--if-revision",
            "3",
            "--idempotency-key",
            "file-purge-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "read"],
        capability: "pageFiles",
        effect: CommandEffect::Read,
        validators: &[
            "project_authorization",
            "explicit_selector",
            "current_page_access",
        ],
        result: "file_bytes_or_download_receipt",
        errors: READ_ERRORS,
        example: "nodex --json page file read page-id --path references/api.md --output ./api.md",
        example_argv: &[
            "--json",
            "page",
            "file",
            "read",
            "page-id",
            "--path",
            "references/api.md",
            "--output",
            "./api.md",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "put"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "portable_path",
            "bounded_bytes",
            "manifest_revision",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file put page-id --path references/api.md --from ./api.md --if-manifest 0 --idempotency-key page-file-put-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "put",
            "page-id",
            "--path",
            "references/api.md",
            "--from",
            "./api.md",
            "--if-manifest",
            "0",
            "--idempotency-key",
            "page-file-put-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "add"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "direct_file_access",
            "portable_path",
            "manifest_revision",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file add page-id --file-id file-id --path api.md --if-manifest 0 --idempotency-key page-file-add-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "add",
            "page-id",
            "--file-id",
            "file-id",
            "--path",
            "api.md",
            "--if-manifest",
            "0",
            "--idempotency-key",
            "page-file-add-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "rename-path"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "portable_path",
            "manifest_revision",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file rename-path page-id --file-id file-id --path references/api.md --if-manifest 1 --idempotency-key page-file-rename-path-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "rename-path",
            "page-id",
            "--file-id",
            "file-id",
            "--path",
            "references/api.md",
            "--if-manifest",
            "1",
            "--idempotency-key",
            "page-file-rename-path-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "remove"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "manifest_revision",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file remove page-id --file-id file-id --if-manifest 1 --idempotency-key page-file-remove-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "remove",
            "page-id",
            "--file-id",
            "file-id",
            "--if-manifest",
            "1",
            "--idempotency-key",
            "page-file-remove-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "replace-entry"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "manifest_revision",
            "bounded_bytes",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file replace-entry page-id --file-id file-id --from ./api.md --if-manifest 1 --idempotency-key page-file-replace-entry-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "replace-entry",
            "page-id",
            "--file-id",
            "file-id",
            "--from",
            "./api.md",
            "--if-manifest",
            "1",
            "--idempotency-key",
            "page-file-replace-entry-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "move"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "portable_path",
            "source_manifest_revision",
            "target_manifest_revision",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file move page-id --file-id file-id --to target-page --path api.md --if-source-manifest 1 --if-target-manifest 0 --idempotency-key page-file-move-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "move",
            "page-id",
            "--file-id",
            "file-id",
            "--to",
            "target-page",
            "--path",
            "api.md",
            "--if-source-manifest",
            "1",
            "--if-target-manifest",
            "0",
            "--idempotency-key",
            "page-file-move-1",
        ],
    },
    CommandMetadata {
        path: &["page", "file", "copy"],
        capability: "pageFiles",
        effect: CommandEffect::Write,
        validators: &[
            "project_authorization",
            "portable_path",
            "source_manifest_revision",
            "target_manifest_revision",
            "idempotency_key",
        ],
        result: "page_file_entry_receipt",
        errors: FILE_ERRORS,
        example: "nodex --json page file copy page-id --file-id file-id --to target-page --path api.md --if-source-manifest 1 --if-target-manifest 0 --idempotency-key page-file-copy-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "copy",
            "page-id",
            "--file-id",
            "file-id",
            "--to",
            "target-page",
            "--path",
            "api.md",
            "--if-source-manifest",
            "1",
            "--if-target-manifest",
            "0",
            "--idempotency-key",
            "page-file-copy-1",
        ],
    },
    CommandMetadata {
        path: &["block", "insert"],
        capability: "blockWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "block_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex block insert page-id --at end --block-json - <<'JSON'\n{\"local_id\":\"note\",\"block_type\":\"paragraph\",\"props\":{},\"content\":{\"kind\":\"absent\"},\"children\":[]}\nJSON",
        example_argv: &[
            "block",
            "insert",
            "page-id",
            "--at",
            "end",
            "--block-json",
            "-",
        ],
    },
    CommandMetadata {
        path: &["block", "update"],
        capability: "blockWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "block_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex block update page-id --block block-id --if-match block-etag --patch-json - <<'JSON'\n{\"block_type\":\"heading\",\"props\":{\"level\":2},\"content\":{\"kind\":\"absent\"},\"unset_content\":false}\nJSON",
        example_argv: &[
            "block",
            "update",
            "page-id",
            "--block",
            "block-id",
            "--if-match",
            "block-etag",
            "--patch-json",
            "-",
        ],
    },
    CommandMetadata {
        path: &["block", "move"],
        capability: "blockWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "block_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex --json block move page-id --block block-id --at end --idempotency-key block-move-1",
        example_argv: &[
            "--json",
            "block",
            "move",
            "page-id",
            "--block",
            "block-id",
            "--at",
            "end",
            "--idempotency-key",
            "block-move-1",
        ],
    },
    CommandMetadata {
        path: &["block", "delete"],
        capability: "blockWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "block_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex --json block delete page-id --block block-id --if-match block-etag --idempotency-key block-delete-1",
        example_argv: &[
            "--json",
            "block",
            "delete",
            "page-id",
            "--block",
            "block-id",
            "--if-match",
            "block-etag",
            "--idempotency-key",
            "block-delete-1",
        ],
    },
    CommandMetadata {
        path: &["history"],
        capability: "read",
        effect: CommandEffect::Read,
        validators: &[],
        result: "page_history_window",
        errors: READ_ERRORS,
        example: "nodex --json history page-id --limit 20",
        example_argv: &["--json", "history", "page-id", "--limit", "20"],
    },
    CommandMetadata {
        path: &["backup", "create"],
        capability: "backup",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "backup_creation_receipt",
        errors: &["CORE_UNAVAILABLE", "PROTOCOL_INCOMPATIBLE"],
        example: "nodex --json backup create --label manual --idempotency-key backup-1",
        example_argv: &[
            "--json",
            "backup",
            "create",
            "--label",
            "manual",
            "--idempotency-key",
            "backup-1",
        ],
    },
    CommandMetadata {
        path: &["backup", "list"],
        capability: "backup",
        effect: CommandEffect::Read,
        validators: &[],
        result: "backup_inventory",
        errors: &["CORE_UNAVAILABLE", "PROTOCOL_INCOMPATIBLE"],
        example: "nodex --json backup list",
        example_argv: &["--json", "backup", "list"],
    },
    CommandMetadata {
        path: &["profile", "clone"],
        capability: "profile_clone",
        effect: CommandEffect::Local,
        validators: &["global_only", "published_backup", "new_target_profile"],
        result: "profile_clone_receipt",
        errors: &["INVALID_INPUT", "CLI_INTERNAL"],
        example: "nodex --json profile clone --from ~/.nodex --to ./runs.local/real/.nodex",
        example_argv: &[
            "--json",
            "profile",
            "clone",
            "--from",
            "/tmp/source-profile",
            "--to",
            "/tmp/target-profile",
        ],
    },
    CommandMetadata {
        path: &["doctor"],
        capability: "doctor",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "maintenance_report",
        errors: &["CORE_UNAVAILABLE", "PROTOCOL_INCOMPATIBLE"],
        example: "nodex --json doctor --idempotency-key doctor-1",
        example_argv: &["--json", "doctor", "--idempotency-key", "doctor-1"],
    },
    CommandMetadata {
        path: &["draft", "create"],
        capability: "draft",
        effect: CommandEffect::Local,
        validators: &[],
        result: "draft_workspace",
        errors: READ_ERRORS,
        example: "nodex --json draft create page-id --output ./page-draft",
        example_argv: &[
            "--json",
            "draft",
            "create",
            "page-id",
            "--output",
            "./page-draft",
        ],
    },
    CommandMetadata {
        path: &["draft", "diff"],
        capability: "draft",
        effect: CommandEffect::Local,
        validators: &[],
        result: "draft_diff",
        errors: &["DRAFT_UNSAFE_PATH", "META_YAML_INVALID"],
        example: "nodex --json draft diff ./page-draft",
        example_argv: &["--json", "draft", "diff", "./page-draft"],
    },
    CommandMetadata {
        path: &["draft", "apply"],
        capability: "draft",
        effect: CommandEffect::Write,
        validators: &["draft_manifest", "narrow_etag", "idempotency_key"],
        result: "page_mutation_receipt",
        errors: &[
            "DRAFT_UNSAFE_PATH",
            "DRAFT_CONFLICT",
            "DRAFT_AMBIGUOUS_EDIT",
            "DRAFT_EDIT_LIMIT",
            "DRAFT_INVALID_MARKDOWN",
            "DRAFT_ALREADY_APPLIED",
            "ETAG_CONFLICT",
        ],
        example: "nodex --json draft apply ./page-draft",
        example_argv: &["--json", "draft", "apply", "./page-draft"],
    },
    CommandMetadata {
        path: &["draft", "discard"],
        capability: "draft",
        effect: CommandEffect::Local,
        validators: &["draft_manifest"],
        result: "draft_discard_result",
        errors: &["DRAFT_UNSAFE_PATH"],
        example: "nodex --json draft discard ./page-draft",
        example_argv: &["--json", "draft", "discard", "./page-draft"],
    },
    CommandMetadata {
        path: &["service", "status"],
        capability: "service",
        effect: CommandEffect::Local,
        validators: &[],
        result: "service_status",
        errors: &["INVALID_INPUT"],
        example: "nodex --json service status",
        example_argv: &["--json", "service", "status"],
    },
    CommandMetadata {
        path: &["service", "enable"],
        capability: "service",
        effect: CommandEffect::Local,
        validators: &[],
        result: "service_status",
        errors: &["INVALID_INPUT"],
        example: "nodex --json service enable",
        example_argv: &["--json", "service", "enable"],
    },
    CommandMetadata {
        path: &["service", "disable"],
        capability: "service",
        effect: CommandEffect::Local,
        validators: &[],
        result: "service_status",
        errors: &["INVALID_INPUT"],
        example: "nodex --json service disable",
        example_argv: &["--json", "service", "disable"],
    },
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitiesV1 {
    pub schema_version: u32,
    pub agent_api: AgentApiRange,
    pub formats: AgentFormatCapabilities,
    pub commands: BTreeMap<&'static str, u32>,
    pub deep_links: Vec<&'static str>,
    pub bundle: AgentBundleCapability,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentApiRange {
    pub minimum_revision: u32,
    pub maximum_revision: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentFormatCapabilities {
    pub nested_markdown_revision: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AgentBundleStatus {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentBundleCapability {
    pub status: AgentBundleStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree_sha256: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineHelp {
    pub schema_version: u32,
    pub command: String,
    pub capability: &'static str,
    pub effect: CommandEffect,
    pub validators: Vec<&'static str>,
    pub result_schema_revision: u32,
    pub result: &'static str,
    pub errors: Vec<&'static str>,
    pub examples: Vec<&'static str>,
    pub arguments: Vec<arguments::ArgumentHelp>,
    pub content_input: Option<arguments::ContentInputHelp>,
    pub output: OutputHelp,
    pub semantics: Vec<&'static str>,
    pub forwarded_arguments: Option<ForwardedArgumentHelp>,
    pub argument_groups: Vec<arguments::ArgumentGroupHelp>,
    pub usage: String,
    pub purpose: String,
    pub default_scope: &'static str,
    pub schema_help: String,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub result_schema: Value,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub error_schema: Value,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub payload_schemas: BTreeMap<String, Value>,
    pub exit_codes: BTreeMap<i32, &'static str>,
    pub nested_markdown: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineHelpIndex {
    pub schema_version: u32,
    pub command: String,
    pub purpose: String,
    pub semantics: Vec<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<arguments::ArgumentHelp>,
    pub commands: Vec<MachineHelpSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineHelpSummary {
    pub command: String,
    pub purpose: String,
    pub category: &'static str,
    pub has_subcommands: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<CommandEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_schema_revision: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(untagged)]
pub enum MachineHelpDocument {
    Index(MachineHelpIndex),
    Command(MachineHelp),
}

pub fn capabilities() -> Result<Value, CliError> {
    let capabilities = AgentCapabilitiesV1 {
        schema_version: 1,
        agent_api: AgentApiRange {
            minimum_revision: AGENT_API_MIN_REVISION,
            maximum_revision: AGENT_API_MAX_REVISION,
        },
        formats: AgentFormatCapabilities {
            nested_markdown_revision: NESTED_MARKDOWN_REVISION,
        },
        commands: capability_revisions(),
        deep_links: vec!["pages", "views"],
        bundle: discover_bundle_capability()?,
    };
    serde_json::to_value(capabilities).map_err(internal)
}

pub fn machine_help(arguments: &[OsString]) -> Result<MachineHelpDocument, CliError> {
    let selection = schema_selection(arguments)?;
    let tokens = command_tokens(arguments);
    if tokens.is_empty() {
        return Ok(MachineHelpDocument::Index(machine_help_index(&[])));
    }

    if let Some(metadata) = COMMANDS
        .iter()
        .filter(|metadata| starts_with_path(&tokens, metadata.path))
        .max_by_key(|metadata| metadata.path.len())
    {
        return Ok(MachineHelpDocument::Command(machine_help_for(
            metadata, selection,
        )));
    }

    let prefix = tokens.iter().map(String::as_str).collect::<Vec<_>>();
    if COMMANDS
        .iter()
        .any(|metadata| metadata.path.starts_with(&prefix))
    {
        return Ok(MachineHelpDocument::Index(machine_help_index(&prefix)));
    }

    Err(CliError::new(
        CliErrorCode::InvalidInput,
        format!(
            "no machine-readable help exists for command path '{}'",
            tokens.join(" ")
        ),
    ))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputHelp {
    pub result_schema_applies_to: &'static str,
    pub stdout: &'static str,
    pub diagnostics: &'static str,
}

fn output_help(path: &[&str]) -> OutputHelp {
    let stdout = match path {
        ["sql", "query"] => {
            "Structured JSON result by default; --raw returns one text cell as exact UTF-8 bytes and rejects JSON output"
        }
        ["read"] | ["sed"] | ["rg"] | ["docs", _] | ["draft", "diff"] => {
            "content stream by default; --json selects a result envelope"
        }
        ["file", "read"] | ["page", "file", "read"] => {
            "--output - returns exact bytes; --output PATH returns a download receipt; --json requires PATH"
        }
        _ => {
            "JSON envelope when stdout is redirected; human-readable text on a terminal; --output-format overrides"
        }
    };
    OutputHelp {
        result_schema_applies_to: "JSON envelope.result",
        stdout,
        diagnostics: "stderr; JSON error envelope for non-terminal auto output or --json; exit 2",
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedArgumentHelp {
    pub positionals: &'static str,
    pub boolean_flags: &'static [&'static str],
    pub value_flags: &'static [&'static str],
    pub maximum_arguments: usize,
    pub maximum_bytes: usize,
}

fn forwarded_arguments(path: &[&str]) -> Option<ForwardedArgumentHelp> {
    if path != ["rg"] {
        return None;
    }
    Some(ForwardedArgumentHelp {
        positionals: "one pattern, followed by an optional Nodex scope selector; -- ends flags",
        boolean_flags: crate::ripgrep::BOOLEAN_FLAGS,
        value_flags: crate::ripgrep::VALUE_FLAGS,
        maximum_arguments: crate::ripgrep::MAX_ARGUMENTS,
        maximum_bytes: crate::ripgrep::MAX_ARGUMENT_BYTES,
    })
}

fn command_semantics(path: &[&str]) -> Vec<&'static str> {
    let mut semantics = match path {
        ["sql", "schema"] => vec![
            "Without RELATION, returns a compact catalog. Describe one relation or bound Source for full column and identity contracts.",
            "--database is a discovery hint; pages always means all authorized active Pages.",
        ],
        ["sql", "query"] => vec![
            "One read-only query sees one observation. Results are complete or the query fails its budget; snapshot is an observation identity, not a write condition or resumable session.",
            "Bind Sources explicitly with --bind ALIAS=SOURCE_ID. Built-in pages includes standalone Pages and is never a Source alias.",
            "search_hits(query, k) returns only the top k Page hits before outer filtering. ORDER BY ordinal preserves search or View ordering.",
            "--raw accepts one non-null text cell and writes it without an added newline; it cannot be combined with JSON output.",
        ],
        ["page", "properties", "prepare-batch"] => vec![
            "Selection must carry page_id, data_source_id, membership_revision and value_revisions. Preparation preserves those observations and never refreshes their revisions.",
            "Conditions protect the edited fields and membership, not arbitrary WHERE or JOIN dependencies.",
        ],
        ["page", "prepare"] => vec![
            "Prepare validators apply only to the declared move or delete operation and scope; --view is valid only for move.",
        ],
        ["search"] => {
            vec![
                "Use search for ranked candidates. For additional filters, joins or bodies, use SQL search_hits with the needed relations. Matches are evidence snippets, never a complete Page editing baseline.",
            ]
        }
        ["read"] => vec![
            "Use read for one known Page. Prefer sql query when selecting fields, filtering several Pages or joining bodies with Properties and validators.",
            "JSON returns the selected complete Page projection and reusable title/body validators; raw output contains only the selected file content.",
        ],
        ["sed"] => vec![
            "The program is one positive numeric <start>[,<end>]p range; content is a line slice, not a complete Page editing baseline.",
        ],
        ["ls"] => vec![
            "List direct children only; continuation identifies additional children, not deeper descendants.",
        ],
        ["data-source", "configure"] => vec![
            "Read data_sources.schema_revision before editing; put that value in if_schema_revision. The examples use revision 1 and placeholder IDs: replace them with your observations.",
            "A script contains 1–100 operations and commits atomically. add_property extends the schema; create_view adds a saved View. Unmentioned definitions and Views remain unchanged.",
            "create_view and update_view accept filter using the shared View clause/group grammar and typed operators. propertyId and select option values resolve exact IDs or unique names within the Source; missing or ambiguous selectors fail.",
            "filter replaces all saved quick and advanced filters, never personal preferences. Conditions must be complete; invalid or incomplete conditions roll back the entire script. Read the resulting rows with SQL view_rows(VIEW_ID).",
            "update_view requires the observed views.revision as if_revision. Omitted fields retain settings, filter:null clears all saved filters, sorts:[] clears sorts, and group_by:null clears grouping.",
            "After a conflict, reread and reassess. After an uncertain response, retry identical input with the same idempotency key.",
        ],
        ["patch"] => vec![
            "Read the exact old text first. Each hunk must match uniquely; missing or ambiguous text fails rather than replacing the whole Page.",
            "Unchanged Blocks retain their identities. Use page insert for pure insertion and page replace only when supplying a complete replacement body.",
        ],
        ["page", "insert"] => vec![
            "Insert Nested Markdown at an anchor; existing Blocks retain their identities. Omitted --file reads stdin.",
        ],
        ["draft", "apply"] => vec![
            "Applies title and body edits atomically against the original Block identities. Unrelated concurrent edits may merge when targets remain unambiguous. Deleted or replaced targets fail even when their text is unchanged.",
            "DRAFT_AMBIGUOUS_EDIT means baseline targets cannot be determined; DRAFT_CONFLICT means observed targets changed; DRAFT_EDIT_LIMIT means the atomic edit exceeds a supported bound. Failures keep work files. Use explicit Block operations for unsupported structure; whole-body replacement requires a separate, intentional page replace operation.",
            "Retry unchanged pending work with the same draft; its original operation is replayed, never recompiled as a replacement. diff is a local text comparison, not a guarantee of current applicability.",
        ],
        ["page", "replace"] => vec![
            "Read the complete body and its body_etag first. Input is the whole replacement body, not a partial fragment; use patch or insert for local edits.",
        ],
        ["page", "rename"] => vec![
            "Changes only the title. Read title_etag from pages SQL or validators.title_etag from read --json; the body and Property values remain unchanged.",
        ],
        ["page", "properties", "set"] => vec![
            "Read Property IDs and option IDs with sql schema tasks --bind tasks=SOURCE_ID; read value_revision from property_values before replacing a value.",
            "Prefer apply for several Pages or fields instead of repeated set calls; use SQL -> prepare-batch -> apply for query-selected targets. apply also supports clearing values, multi-select and Relation edits. Use data-source configure for definitions.",
        ],
        ["page", "properties", "apply"] => vec![
            "All edits commit atomically. Each address uses Page, Data Source and Property IDs; replacement edits carry expected_value_revision from property_values.",
            "The text example assumes the Property has no value (revision 0); replace IDs and revisions with observed values. Use prepare-batch to preserve SQL-selected membership and value observations.",
        ],
        ["page", "create-batch"] => vec![
            "Supply an explicit destination and 1–16 Page drafts. Each draft has title_markdown, nested_markdown and optional typed values. All Pages are created together or none are.",
        ],
        ["page", "move" | "delete"] => vec![
            "Run page prepare for the same operation and View to obtain its ETag. If the condition conflicts, reread and prepare again before deciding to retry.",
        ],
        ["file", "read"] | ["page", "file", "read"] => vec![
            "--output PATH overwrites an existing regular file. --output - writes exact bytes to stdout. Inspect the download receipt for byte count and content identity.",
        ],
        ["block", "insert" | "update"] => vec![
            "JSON uses the typed Block draft or update shape, not a whole Page body. Inspect --help-schema input for the selected operation; stable Block IDs identify existing content.",
        ],
        _ => Vec::new(),
    };
    if path != ["data-source", "configure"]
        && path != ["draft", "apply"]
        && COMMANDS.iter().any(|metadata| {
            metadata.path == path && metadata.validators.contains(&"idempotency_key")
        })
    {
        semantics.push("Each call without an idempotency key is a new operation. Reuse an explicit key and identical input when retrying an uncertain result.");
    }
    semantics
}

fn result_revision(path: &[&str]) -> u32 {
    match path {
        ["search"] => 2,
        ["read"] | ["data-source", _] | ["sql", _] | ["page", "properties", "prepare-batch"] => 2,
        _ => 1,
    }
}

fn capability_revisions() -> BTreeMap<&'static str, u32> {
    COMMANDS
        .iter()
        .fold(BTreeMap::new(), |mut revisions, metadata| {
            let revision = revisions.entry(metadata.capability).or_insert(1);
            *revision = (*revision).max(result_revision(metadata.path));
            revisions
        })
}

fn machine_help_for(
    metadata: &CommandMetadata,
    selection: Option<crate::cli::HelpSchema>,
) -> MachineHelp {
    use crate::cli::HelpSchema;
    let (arguments, argument_groups, usage) = arguments::describe(metadata.path);
    MachineHelp {
        schema_version: MACHINE_HELP_SCHEMA_VERSION,
        command: command_name(metadata.path),
        capability: metadata.capability,
        effect: metadata.effect,
        validators: metadata.validators.to_vec(),
        result_schema_revision: result_revision(metadata.path),
        result: metadata.result,
        errors: metadata.errors.to_vec(),
        examples: command_examples(metadata),
        arguments: arguments
            .into_iter()
            .filter(|argument| !argument.global && argument.id != "help")
            .collect(),
        argument_groups: argument_groups
            .into_iter()
            .filter(|group| group.required)
            .collect(),
        usage,
        content_input: arguments::content_input(metadata.path),
        output: output_help(metadata.path),
        semantics: command_semantics(metadata.path),
        forwarded_arguments: forwarded_arguments(metadata.path),
        purpose: command_purpose(metadata.path),
        default_scope: default_scope(metadata.path),
        schema_help: format!(
            "{} --help-schema input|result|error|all",
            command_name(metadata.path)
        ),
        result_schema: if matches!(selection, Some(HelpSchema::Result | HelpSchema::All)) {
            schema::result(metadata.path)
        } else {
            Value::Null
        },
        error_schema: if matches!(selection, Some(HelpSchema::Error | HelpSchema::All)) {
            schema::document::<crate::error::ErrorEnvelope>()
        } else {
            Value::Null
        },
        payload_schemas: if matches!(selection, Some(HelpSchema::Input | HelpSchema::All)) {
            schema::payloads(metadata.path)
        } else {
            BTreeMap::new()
        },
        exit_codes: BTreeMap::from([
            (0, "success"),
            (1, "rg found no matches"),
            (2, "rejected operation or invalid invocation"),
            (130, "interrupted"),
        ]),
        nested_markdown: "nodex docs nested-markdown",
    }
}

fn machine_help_index(prefix: &[&str]) -> MachineHelpIndex {
    use clap::CommandFactory;
    let root = crate::cli::Cli::command();
    let parent = prefix.iter().fold(&root, |command, segment| {
        command
            .find_subcommand(segment)
            .expect("registered command group")
    });
    let commands = parent
        .get_subcommands()
        .filter(|child| !child.is_hide_set())
        .map(|child| {
            let mut path = prefix.to_vec();
            path.push(child.get_name());
            let metadata = COMMANDS.iter().find(|metadata| metadata.path == path);
            MachineHelpSummary {
                command: command_name(&path),
                purpose: command_purpose(&path),
                category: command_category(path[0]),
                has_subcommands: child.has_subcommands(),
                capability: metadata.map(|metadata| metadata.capability),
                effect: metadata.map(|metadata| metadata.effect),
                result_schema_revision: metadata.map(|metadata| result_revision(metadata.path)),
            }
        })
        .collect();
    MachineHelpIndex {
        schema_version: MACHINE_HELP_SCHEMA_VERSION,
        command: command_name(prefix),
        purpose: command_purpose(prefix),
        semantics: group_semantics(prefix),
        arguments: if prefix.is_empty() {
            arguments::describe(prefix).0
        } else {
            vec![]
        },
        commands,
    }
}

/// Root categories describe task intent; both text and JSON directories use them.
fn command_category(name: &str) -> &'static str {
    match name {
        "context" | "search" | "ls" | "tree" | "read" | "sed" | "rg" | "sql" | "history" => {
            "Read and query"
        }
        "page" | "data-source" | "patch" | "block" | "draft" => "Edit and configure",
        "file" | "open" => "Files and desktop",
        _ => "Setup and maintenance",
    }
}

/// Task defaults, shared by the root text help and structured guide.
const RECOMMENDED_ROUTES: &[&str] = &[
    "Filter, join or summarize Pages: prefer sql query; select the needed fields, bodies and validators together.",
    "Read one known Page: read. Find ranked candidates: search; use SQL when combining search with other data.",
    "Edit exact text: patch. Add content: page insert. Substantial rewrites or a local diff: draft.",
    "Set one text, number or select value: page properties set. For other value types or several Pages/fields, prefer page properties apply.",
    "Edit SQL-selected Pages: sql query -> page properties prepare-batch -> page properties apply; preserve observed targets and versions.",
    "Change Property definitions or saved Views: data-source configure; combine related changes in one script.",
    "Reuse known IDs and relevant validators. Send short inputs through stdin; use shell/Python for further computation.",
];

fn group_semantics(path: &[&str]) -> Vec<&'static str> {
    match path {
        [] => RECOMMENDED_ROUTES.iter().copied().chain([
            "Read or attach a Page File: nodex page file --help. Manage shared Library Files: nodex file --help.",
            "Use known commands directly. Read nodex context when the current Project is unknown; --project selects a different access context.",
            "Read nodex COMMAND --help for usage and examples, --json COMMAND --help for a structured guide, and COMMAND --help-schema input for JSON payload shapes.",
        ]).collect(),
        ["page"] => vec![
            "Prefer insert for additions and patch for exact text changes. Use draft for substantial rewrites or a local diff; replace accepts a complete replacement body. rename changes only the title.",
            "properties changes values on Pages. data-source configure changes Property definitions and saved Views.",
            "file manages Page attachment entries; Library File content and lifecycle are managed by nodex file.",
        ],
        ["data-source"] => vec![
            "configure adds or changes Property definitions and saved Views. Use page properties to change values on individual Pages.",
            "Discover Sources with nodex sql query 'SELECT data_source_id,name,schema_revision FROM data_sources'.",
        ],
        ["page", "properties"] => vec![
            "Prefer set for one select, text or number value; use apply for several Pages or fields in one atomic change. For query-selected targets, use SQL -> prepare-batch -> apply to retain the original observations.",
            "Read Property IDs and value revisions with SQL. Add or rename Property definitions through nodex data-source configure.",
        ],
        ["file"] => vec![
            "These commands require direct Library File access. For a File related to a Page, use nodex page file read with that Page's selector.",
            "replace changes shared bytes for all current uses; fork creates a separate File. restore publishes a retained version; untrash restores lifecycle state.",
        ],
        ["page", "file"] => vec![
            "Logical paths belong to this Page. Discover entries with the page_files SQL relation and read pages.file_manifest_revision before changing entries.",
            "put imports a File; add links an existing authorized File. remove detaches the entry while retaining its File and body uses. replace-entry changes only this Page relation.",
        ],
        ["sql"] => vec![
            "Prefer query for filtering, joins, aggregation or reading several Pages. Select the needed bodies, metadata and validators together. Use read for a single known Page body.",
            "Use schema only when the model is unfamiliar. Bind a Data Source with --bind tasks=SOURCE_ID; query view_rows(VIEW_ID) for a saved View's filtering and order.",
        ],
        ["block"] => vec![
            "Use stable Block IDs and typed JSON for precise structural edits; read --help-schema input for the chosen operation.",
        ],
        ["draft"] => vec![
            "create saves a baseline with original Block identities and editable Page files. Edit work files, inspect the local diff, then apply. Safe edits preserve existing Block identities; ambiguous, conflicting or oversized edits fail atomically and keep the files. apply never falls back to whole-body replacement. Use page replace only for an explicitly intended complete replacement.",
        ],
        ["skills"] | ["setup"] => vec![
            "Inspect status or use --dry-run before installation changes. Select Agents with --agent; --yes confirms the requested change.",
        ],
        _ => vec![],
    }
}

fn command_name(path: &[&str]) -> String {
    if path.is_empty() {
        return "nodex".to_owned();
    }
    format!("nodex {}", path.join(" "))
}

fn starts_with_path(tokens: &[String], path: &[&str]) -> bool {
    tokens.len() >= path.len()
        && tokens
            .iter()
            .zip(path)
            .all(|(token, component)| token == component)
}

fn command_tokens(arguments: &[OsString]) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut skip_global_value = false;
    for argument in arguments.iter().skip(1) {
        let Some(argument) = argument.to_str() else {
            continue;
        };
        if skip_global_value {
            skip_global_value = false;
            continue;
        }
        if matches!(
            argument,
            "--expect-profile"
                | "--project"
                | "--database"
                | "--page"
                | "--output-format"
                | "--help-schema"
        ) {
            skip_global_value = true;
            continue;
        }
        if matches!(argument, "--json" | "--no-color" | "--help" | "-h") {
            continue;
        }
        if argument.starts_with('-') {
            continue;
        }
        tokens.push(argument.to_owned());
    }
    tokens
}

fn schema_selection(arguments: &[OsString]) -> Result<Option<crate::cli::HelpSchema>, CliError> {
    use crate::cli::HelpSchema;
    let mut arguments = arguments.iter().skip(1).take_while(|value| *value != "--");
    let mut selection = None;
    while let Some(argument) = arguments.next() {
        let value = if argument == "--help-schema" {
            Some(
                arguments
                    .next()
                    .and_then(|value| value.to_str())
                    .unwrap_or(""),
            )
        } else {
            argument
                .to_str()
                .and_then(|value| value.strip_prefix("--help-schema="))
        };
        let Some(value) = value else { continue };
        selection = Some(match value {
            "input" => HelpSchema::Input,
            "result" => HelpSchema::Result,
            "error" => HelpSchema::Error,
            "all" => HelpSchema::All,
            _ => return Err(CliError::new(CliErrorCode::InvalidInput, "--help-schema expects input, result, error, or all")
                .with_details(serde_json::json!({"argument":"--help-schema", "allowed_values":["input","result","error","all"]}))),
        });
    }
    Ok(selection)
}

fn default_scope(path: &[&str]) -> &'static str {
    match path {
        ["sql", _] => {
            "The selected Project's authorized resources. Source wide tables require --bind; --database only hints schema discovery."
        }
        ["data-source", "configure"] => {
            "The unique active Data Source in the selected Database when omitted; multiple candidates require an explicit selector."
        }
        [
            "capabilities" | "docs" | "skills" | "setup" | "service" | "profile",
            ..,
        ] => "Local command; no Project context required.",
        _ => {
            "Uses --project when given, otherwise the Project matching the working directory. Resource selectors accept bare IDs."
        }
    }
}

fn command_purpose(path: &[&str]) -> String {
    use clap::CommandFactory;
    let mut root = crate::cli::Cli::command();
    root.build();
    let command = path.iter().fold(&root, |command, segment| {
        command
            .find_subcommand(segment)
            .expect("registered command")
    });
    command
        .get_about()
        .map(ToString::to_string)
        .expect("every command must describe its purpose")
}

fn command_examples(metadata: &CommandMetadata) -> Vec<&'static str> {
    let second = match metadata.path {
        ["sql", "query"] => Some(
            "nodex sql query 'SELECT nested_markdown FROM page_documents WHERE page_id = :id' --param 'id=\"page-id\"' --raw",
        ),
        ["sql", "schema"] => Some("nodex sql schema tasks --bind tasks=source-id"),
        ["read"] => Some("nodex read page-id"),
        ["search"] => Some("nodex search 'release plan' --limit 5"),
        ["data-source", "configure"] => Some(
            r#"nodex data-source configure source-id --idempotency-key risk-note-1 <<'JSON'
{"if_schema_revision":1,"operations":[{"kind":"add_property","name":"Risk note","schema":{"kind":"text"}}]}
JSON"#,
        ),
        ["page", "create-batch"] => Some(
            r#"nodex page create-batch --idempotency-key release-pages-1 <<'JSON'
{"destination":{"kind":"library"},"pages":[{"title_markdown":"Release plan","nested_markdown":"Release date: Friday."},{"title_markdown":"Release checks","nested_markdown":"Verify the release artifacts."}]}
JSON"#,
        ),
        ["page", "properties", "apply"] => Some(
            r#"nodex page properties apply --idempotency-key risk-value-1 <<'JSON'
{"edits":[{"address":{"page_id":"page-id","data_source_id":"source-id","property_id":"property-id"},"edit":{"kind":"replace","expected_value_revision":0,"value":{"kind":"text","value":"Needs review"}}}]}
JSON"#,
        ),
        ["page", "properties", "prepare-batch"] => Some(
            r#"nodex sql query 'SELECT page_id,data_source_id,membership_revision,value_revisions FROM tasks WHERE title=:title' --bind tasks=source-id --param 'title="Release plan"' |
  nodex page properties prepare-batch --selection - --set 'Risk note={"kind":"text","value":"Needs review"}' |
  nodex page properties apply --idempotency-key selected-risk-1"#,
        ),
        ["page", "insert"] => Some(
            "nodex page insert page-id --at end --idempotency-key next-steps-1 <<'BODY'\n## Next steps\n\nFinish the release checks.\nBODY",
        ),
        ["patch"] => Some(
            "nodex patch --idempotency-key release-date-1 <<'PATCH'\n*** Begin Patch\n*** Update Page: page-id\n@@\n-Release date: Friday.\n+Release date: Monday.\n*** End Patch\nPATCH",
        ),
        ["block", "insert"] => Some(
            r#"nodex block insert page-id --at end --block-json - --idempotency-key note-block-1 <<'JSON'
{"local_id":"note","block_type":"paragraph","props":{},"content":{"kind":"value","value":[{"type":"text","text":"Review pending.","styles":{}}]},"children":[]}
JSON"#,
        ),
        ["block", "update"] => Some(
            r#"nodex block update page-id --block block-id --if-match block-etag --patch-json - <<'JSON'
{"content":{"kind":"value","value":[{"type":"text","text":"Review complete.","styles":{}}]},"unset_content":false}
JSON"#,
        ),
        _ => None,
    };
    let mut examples = std::iter::once(metadata.example)
        .chain(second)
        .collect::<Vec<_>>();
    if metadata.path == ["data-source", "configure"] {
        examples.push(r#"nodex data-source configure source-id --idempotency-key task-list-1 <<'JSON'
{"if_schema_revision":1,"operations":[{"kind":"create_view","name":"Task list","layout":"list","sorts":[{"property":"title","direction":"asc"}]}]}
JSON"#);
        examples.push(r#"nodex data-source configure source-id --idempotency-key review-queue-1 <<'JSON'
{"if_schema_revision":1,"operations":[{"kind":"create_view","name":"Review queue","layout":"list","filter":{"kind":"clause","propertyId":"Status","operator":"select_is","value":"Review"}}]}
JSON"#);
    }
    examples
}

/// Ordinary and machine help share command metadata and the Clap argument definitions.
pub(crate) fn command() -> clap::Command {
    use clap::CommandFactory;
    fn decorate(command: clap::Command, path: Vec<String>) -> clap::Command {
        let command = command.mut_subcommands(|child| {
            let mut child_path = path.clone();
            child_path.push(child.get_name().to_owned());
            decorate(child, child_path)
        });
        let tokens = path.iter().map(String::as_str).collect::<Vec<_>>();
        if tokens.is_empty() {
            return root_help(command);
        }
        let Some(metadata) = COMMANDS.iter().find(|metadata| metadata.path == tokens) else {
            return command.after_help(group_semantics(&tokens).join("\n\n"));
        };
        let examples = command_examples(metadata).join("\n\n");
        let semantics = command_semantics(metadata.path).join("\n\n");
        let behavior = if semantics.is_empty() {
            String::new()
        } else {
            format!("\n\nBehavior:\n{semantics}")
        };
        command.after_help(format!(
            "Scope: {}{behavior}\n\nExamples:\n{examples}\n\nOutput: {}\n\nSchema: {} --help-schema input|result|error|all",
            default_scope(metadata.path),
            output_help(metadata.path).stdout,
            command_name(metadata.path)
        ))
    }
    decorate(crate::cli::Cli::command(), Vec::new())
}

fn root_help(command: clap::Command) -> clap::Command {
    let mut directory = String::new();
    for category in [
        "Read and query",
        "Edit and configure",
        "Files and desktop",
        "Setup and maintenance",
    ] {
        directory.push_str(&format!("{category}:\n"));
        for child in command
            .get_subcommands()
            .filter(|child| !child.is_hide_set() && command_category(child.get_name()) == category)
        {
            directory.push_str(&format!(
                "  {:<13} {}\n",
                child.get_name(),
                child.get_about().expect("command purpose")
            ));
        }
        directory.push('\n');
    }
    let routes = RECOMMENDED_ROUTES
        .iter()
        .map(|route| format!("  {route}"))
        .collect::<Vec<_>>()
        .join("\n");
    let footer = group_semantics(&[])
        .into_iter()
        .skip(RECOMMENDED_ROUTES.len())
        .collect::<Vec<_>>()
        .join("\n\n");
    command.help_template(format!(
        "{{about}}\n\n{{usage-heading}} {{usage}}\n\nRecommended routes:\n{routes}\n\n{directory}Options:\n{{options}}{{after-help}}\n"
    )).after_help(footer)
}

fn discover_bundle_capability() -> Result<AgentBundleCapability, CliError> {
    let Some(bundle) = crate::skills::bundle::discover_current()? else {
        return Ok(unavailable_bundle());
    };
    Ok(AgentBundleCapability {
        status: AgentBundleStatus::Available,
        release_version: Some(bundle.release_version),
        tree_sha256: Some(bundle.tree_sha256),
    })
}

fn unavailable_bundle() -> AgentBundleCapability {
    AgentBundleCapability {
        status: AgentBundleStatus::Unavailable,
        release_version: None,
        tree_sha256: None,
    }
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::iter;

    use clap::{CommandFactory, Parser};

    use super::*;
    use crate::cli::Cli;

    #[test]
    fn command_registry_covers_every_clap_leaf_exactly_once() {
        let mut clap_paths = Vec::new();
        collect_clap_leaf_paths(&Cli::command(), &mut Vec::new(), &mut clap_paths);
        let clap_paths = clap_paths.into_iter().collect::<BTreeSet<_>>();
        let metadata_paths = COMMANDS
            .iter()
            .map(|metadata| metadata.path.join(" "))
            .collect::<BTreeSet<_>>();

        assert_eq!(metadata_paths.len(), COMMANDS.len(), "duplicate metadata");
        assert_eq!(clap_paths, metadata_paths);
    }

    #[test]
    fn every_help_directory_and_argument_explains_its_purpose() {
        fn inspect(command: &clap::Command, path: &mut Vec<String>) {
            if command.get_name() == "help" {
                return;
            }
            assert!(
                command
                    .get_about()
                    .is_some_and(|about| !about.to_string().trim().is_empty()),
                "missing command purpose: {path:?}"
            );
            for argument in command.get_arguments().filter(|arg| !arg.is_hide_set()) {
                assert!(
                    argument
                        .get_help()
                        .is_some_and(|help| !help.to_string().trim().is_empty()),
                    "missing argument description: {path:?} {}",
                    argument.get_id()
                );
            }
            if command.has_subcommands() {
                let prefix = path.iter().map(String::as_str).collect::<Vec<_>>();
                let directory = machine_help_index(&prefix);
                let expected = command
                    .get_subcommands()
                    .filter(|child| !child.is_hide_set() && child.get_name() != "help")
                    .count();
                assert_eq!(
                    directory.commands.len(),
                    expected,
                    "directory must list each direct child once"
                );
                for entry in directory.commands {
                    assert!(!entry.purpose.is_empty());
                    assert_eq!(entry.command.split_whitespace().count(), path.len() + 2);
                    assert_eq!(entry.effect.is_none(), entry.has_subcommands);
                }
            }
            for child in command
                .get_subcommands()
                .filter(|child| !child.is_hide_set())
            {
                path.push(child.get_name().to_owned());
                inspect(child, path);
                path.pop();
            }
        }
        let mut root = Cli::command();
        root.build();
        inspect(&root, &mut Vec::new());
    }

    #[test]
    fn every_documented_example_is_accepted_by_clap() {
        for metadata in COMMANDS {
            let arguments = iter::once("nodex").chain(metadata.example_argv.iter().copied());
            Cli::try_parse_from(arguments).unwrap_or_else(|error| {
                panic!(
                    "{} example did not parse: {error}",
                    command_name(metadata.path)
                )
            });
        }
    }

    #[test]
    fn machine_help_returns_leaf_and_group_documents() {
        let leaf =
            machine_help(&["nodex", "--json", "page", "delete", "--help"].map(OsString::from))
                .expect("leaf help");
        let MachineHelpDocument::Command(leaf) = leaf else {
            panic!("expected leaf help")
        };
        assert_eq!(leaf.command, "nodex page delete");
        assert_eq!(leaf.effect, CommandEffect::Write);
        assert!(leaf.validators.contains(&"narrow_etag"));

        let group = machine_help(&["nodex", "--json", "page", "--help"].map(OsString::from))
            .expect("group help");
        let MachineHelpDocument::Index(group) = group else {
            panic!("expected group help")
        };
        assert!(
            group
                .commands
                .iter()
                .all(|command| command.command.starts_with("nodex page "))
        );
    }

    #[test]
    fn capability_revisions_come_from_the_command_registry() {
        let expected = COMMANDS
            .iter()
            .map(|metadata| metadata.capability)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            capability_revisions()
                .keys()
                .copied()
                .collect::<BTreeSet<_>>(),
            expected
        );
    }

    fn collect_clap_leaf_paths(
        command: &clap::Command,
        prefix: &mut Vec<String>,
        output: &mut Vec<String>,
    ) {
        for subcommand in command.get_subcommands() {
            prefix.push(subcommand.get_name().to_owned());
            if subcommand.has_subcommands() {
                collect_clap_leaf_paths(subcommand, prefix, output);
            } else {
                output.push(prefix.join(" "));
            }
            prefix.pop();
        }
    }
}
