mod arguments;
pub(crate) mod schema;

use std::collections::BTreeMap;
use std::ffi::OsString;

use serde::Serialize;
use serde_json::Value;

use crate::error::{CliError, CliErrorCode};

pub const AGENT_API_MIN_REVISION: u32 = 1;
pub const AGENT_API_MAX_REVISION: u32 = 1;
const MACHINE_HELP_SCHEMA_VERSION: u32 = 2;
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
    "SCOPE_NOT_FOUND",
    "SCOPE_UNAUTHORIZED",
    "CORE_UNAVAILABLE",
    "PROTOCOL_INCOMPATIBLE",
];
const WRITE_ERRORS: &[&str] = &[
    "PROJECT_NOT_FOUND",
    "PROJECT_AMBIGUOUS",
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
        example: "nodex ls @page-id",
        example_argv: &["ls", "@page-id"],
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
        path: &["data-source", "list"],
        capability: "dataSource",
        effect: CommandEffect::Read,
        validators: &[],
        result: "data_source_window",
        errors: READ_ERRORS,
        example: "nodex data-source list --database @database-id",
        example_argv: &["data-source", "list", "--database", "@database-id"],
    },
    CommandMetadata {
        path: &["data-source", "describe"],
        capability: "dataSource",
        effect: CommandEffect::Read,
        validators: &[],
        result: "data_source_description",
        errors: READ_ERRORS,
        example: "nodex data-source describe @data-source-id",
        example_argv: &["data-source", "describe", "@data-source-id"],
    },
    CommandMetadata {
        path: &["data-source", "options"],
        capability: "dataSource",
        effect: CommandEffect::Read,
        validators: &[],
        result: "property_option_window",
        errors: READ_ERRORS,
        example: "nodex data-source options @data-source-id --property @property-id",
        example_argv: &[
            "data-source",
            "options",
            "@data-source-id",
            "--property",
            "@property-id",
        ],
    },
    CommandMetadata {
        path: &["data-source", "query"],
        capability: "dataSource",
        effect: CommandEffect::Read,
        validators: &[],
        result: "data_source_query_window",
        errors: READ_ERRORS,
        example: "nodex data-source query @data-source-id --input - <<'JSON'\n{\"filter\":{\"kind\":\"group\",\"operator\":\"and\",\"children\":[]},\"sort\":[],\"limit\":50}\nJSON",
        example_argv: &["data-source", "query", "@data-source-id", "--input", "-"],
    },
    CommandMetadata {
        path: &["page", "properties", "get"],
        capability: "properties",
        effect: CommandEffect::Read,
        validators: &[],
        result: "page_property_values",
        errors: READ_ERRORS,
        example: "nodex page properties get @page-id",
        example_argv: &["page", "properties", "get", "@page-id"],
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
        example: "nodex page properties set @page-id --property @property-id --option @option-id --if-revision 0",
        example_argv: &[
            "page",
            "properties",
            "set",
            "@page-id",
            "--property",
            "@property-id",
            "--option",
            "@option-id",
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
        path: &["read"],
        capability: "read",
        effect: CommandEffect::Read,
        validators: &["read_validators", "specialized_prepare_when_needed"],
        result: "canonical_page_file",
        errors: READ_ERRORS,
        example: "nodex --json read @page-id",
        example_argv: &["--json", "read", "@page-id"],
    },
    CommandMetadata {
        path: &["sed"],
        capability: "read",
        effect: CommandEffect::Read,
        validators: &[],
        result: "canonical_page_line_slice",
        errors: READ_ERRORS,
        example: "nodex --json sed -n 1,20p @page-id",
        example_argv: &["--json", "sed", "-n", "1,20p", "@page-id"],
    },
    CommandMetadata {
        path: &["rg"],
        capability: "rg",
        effect: CommandEffect::Read,
        validators: &[],
        result: "ripgrep_matches_over_authorized_snapshot",
        errors: &[
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
        path: &["view", "query"],
        capability: "viewQuery",
        effect: CommandEffect::Read,
        validators: &[],
        result: "saved_view_context",
        errors: READ_ERRORS,
        example: "nodex --json view query @view-id --limit 50",
        example_argv: &["--json", "view", "query", "@view-id", "--limit", "50"],
    },
    CommandMetadata {
        path: &["open", "page"],
        capability: "open",
        effect: CommandEffect::Open,
        validators: &["project_authorization"],
        result: "canonical_resource_open",
        errors: OPEN_ERRORS,
        example: "nodex --json open page @page-id --print",
        example_argv: &["--json", "open", "page", "@page-id", "--print"],
    },
    CommandMetadata {
        path: &["open", "view"],
        capability: "open",
        effect: CommandEffect::Open,
        validators: &["project_authorization"],
        result: "canonical_resource_open",
        errors: OPEN_ERRORS,
        example: "nodex --json open view @view-id --print",
        example_argv: &["--json", "open", "view", "@view-id", "--print"],
    },
    CommandMetadata {
        path: &["patch"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: IDEMPOTENCY_VALIDATOR,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex patch <<'PATCH'\n*** Begin Patch\n*** Update Page: @page-id\n@@\n-Old note\n+Updated note\n*** End Patch\nPATCH",
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
        example: "nodex page insert @page-id <<'MARKDOWN'\n## Next steps\n- Review the proposal.\nMARKDOWN",
        example_argv: &["page", "insert", "@page-id"],
    },
    CommandMetadata {
        path: &["page", "replace"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page replace @page-id --if-match body-etag <<'MARKDOWN'\n## Updated plan\nReview the proposal.\nMARKDOWN",
        example_argv: &["page", "replace", "@page-id", "--if-match", "body-etag"],
    },
    CommandMetadata {
        path: &["page", "rename"],
        capability: "pageWrite",
        effect: CommandEffect::Write,
        validators: ETAG_AND_IDEMPOTENCY_VALIDATORS,
        result: "page_mutation_receipt",
        errors: WRITE_ERRORS,
        example: "nodex page rename @page-id Title --if-match title-etag",
        example_argv: &[
            "page",
            "rename",
            "@page-id",
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
        example: "nodex --json page move @page-id --to library --at end --if-match move-etag --idempotency-key move-1",
        example_argv: &[
            "--json",
            "page",
            "move",
            "@page-id",
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
        example: "nodex --json page duplicate @page-id --to library --at end --idempotency-key copy-1",
        example_argv: &[
            "--json",
            "page",
            "duplicate",
            "@page-id",
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
        example: "nodex --json page delete @page-id --if-match page-etag --idempotency-key delete-1",
        example_argv: &[
            "--json",
            "page",
            "delete",
            "@page-id",
            "--if-match",
            "page-etag",
            "--idempotency-key",
            "delete-1",
        ],
    },
    CommandMetadata {
        path: &["file", "list"],
        capability: "files",
        effect: CommandEffect::Read,
        validators: &["project_authorization", "bounded_window"],
        result: "file_catalog",
        errors: READ_ERRORS,
        example: "nodex --json file list --limit 100",
        example_argv: &["--json", "file", "list", "--limit", "100"],
    },
    CommandMetadata {
        path: &["file", "info"],
        capability: "files",
        effect: CommandEffect::Read,
        validators: &["project_authorization", "direct_file_access"],
        result: "file_metadata",
        errors: READ_ERRORS,
        example: "nodex --json file info file-id",
        example_argv: &["--json", "file", "info", "file-id"],
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
        path: &["file", "versions"],
        capability: "files",
        effect: CommandEffect::Read,
        validators: &[
            "project_authorization",
            "direct_file_access",
            "bounded_window",
        ],
        result: "file_versions",
        errors: READ_ERRORS,
        example: "nodex --json file versions file-id --limit 100",
        example_argv: &["--json", "file", "versions", "file-id", "--limit", "100"],
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
        path: &["file", "usages"],
        capability: "files",
        effect: CommandEffect::Read,
        validators: &[
            "project_authorization",
            "direct_file_access",
            "bounded_window",
        ],
        result: "file_usages",
        errors: READ_ERRORS,
        example: "nodex --json file usages file-id --limit 100",
        example_argv: &["--json", "file", "usages", "file-id", "--limit", "100"],
    },
    CommandMetadata {
        path: &["page", "file", "list"],
        capability: "pageFiles",
        effect: CommandEffect::Read,
        validators: &["project_authorization", "bounded_window"],
        result: "page_file_inventory",
        errors: READ_ERRORS,
        example: "nodex --json page file list @page-id --limit 100",
        example_argv: &[
            "--json", "page", "file", "list", "@page-id", "--limit", "100",
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
        example: "nodex --json page file read @page-id --path references/api.md --output ./api.md",
        example_argv: &[
            "--json",
            "page",
            "file",
            "read",
            "@page-id",
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
        example: "nodex --json page file put @page-id --path references/api.md --from ./api.md --if-manifest 0 --idempotency-key page-file-put-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "put",
            "@page-id",
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
        example: "nodex --json page file add @page-id --file-id file-id --path api.md --if-manifest 0 --idempotency-key page-file-add-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "add",
            "@page-id",
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
        example: "nodex --json page file rename-path @page-id --file-id file-id --path references/api.md --if-manifest 1 --idempotency-key page-file-rename-path-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "rename-path",
            "@page-id",
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
        example: "nodex --json page file remove @page-id --file-id file-id --if-manifest 1 --idempotency-key page-file-remove-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "remove",
            "@page-id",
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
        example: "nodex --json page file replace-entry @page-id --file-id file-id --from ./api.md --if-manifest 1 --idempotency-key page-file-replace-entry-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "replace-entry",
            "@page-id",
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
        example: "nodex --json page file move @page-id --file-id file-id --to @target-page --path api.md --if-source-manifest 1 --if-target-manifest 0 --idempotency-key page-file-move-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "move",
            "@page-id",
            "--file-id",
            "file-id",
            "--to",
            "@target-page",
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
        example: "nodex --json page file copy @page-id --file-id file-id --to @target-page --path api.md --if-source-manifest 1 --if-target-manifest 0 --idempotency-key page-file-copy-1",
        example_argv: &[
            "--json",
            "page",
            "file",
            "copy",
            "@page-id",
            "--file-id",
            "file-id",
            "--to",
            "@target-page",
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
        example: "nodex block insert @page-id --at end --block-json - <<'JSON'\n{\"local_id\":\"note\",\"block_type\":\"paragraph\",\"props\":{},\"content\":{\"kind\":\"absent\"},\"children\":[]}\nJSON",
        example_argv: &[
            "block",
            "insert",
            "@page-id",
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
        example: "nodex block update @page-id --block block-id --if-match block-etag --patch-json - <<'JSON'\n{\"block_type\":\"heading\",\"props\":{\"level\":2},\"content\":{\"kind\":\"absent\"},\"unset_content\":false}\nJSON",
        example_argv: &[
            "block",
            "update",
            "@page-id",
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
        example: "nodex --json block move @page-id --block @block-id --at end --idempotency-key block-move-1",
        example_argv: &[
            "--json",
            "block",
            "move",
            "@page-id",
            "--block",
            "@block-id",
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
        example: "nodex --json block delete @page-id --block @block-id --if-match block-etag --idempotency-key block-delete-1",
        example_argv: &[
            "--json",
            "block",
            "delete",
            "@page-id",
            "--block",
            "@block-id",
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
        example: "nodex --json history @page-id --limit 20",
        example_argv: &["--json", "history", "@page-id", "--limit", "20"],
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
        example: "nodex --json draft create @page-id --output ./page-draft",
        example_argv: &[
            "--json",
            "draft",
            "create",
            "@page-id",
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
    pub result_schema: Value,
    pub error_schema: Value,
    pub payload_schemas: BTreeMap<String, Value>,
    pub exit_codes: BTreeMap<i32, &'static str>,
    pub nested_markdown: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineHelpIndex {
    pub schema_version: u32,
    pub command: String,
    pub commands: Vec<MachineHelpSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineHelpSummary {
    pub command: String,
    pub capability: &'static str,
    pub effect: CommandEffect,
    pub result_schema_revision: u32,
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
    let tokens = command_tokens(arguments);
    if tokens.is_empty() {
        return Ok(MachineHelpDocument::Index(machine_help_index(&[])));
    }

    if let Some(metadata) = COMMANDS
        .iter()
        .filter(|metadata| starts_with_path(&tokens, metadata.path))
        .max_by_key(|metadata| metadata.path.len())
    {
        return Ok(MachineHelpDocument::Command(machine_help_for(metadata)));
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
    match path {
        ["data-source", "query"] => vec![
            "--after and --limit override the input cursor and limit; they do not change filter or sort rules.",
            "Omitted projection_property_ids requests the supported default Property set; [] requests no Property values.",
            "Rows are a bounded window. Continue with the emitted cursor and unchanged query rules.",
        ],
        ["data-source", "describe" | "options" | "list"] => vec![
            "A non-null next_cursor means this is an incomplete window; continue before treating the schema or option inventory as complete.",
        ],
        ["search"] => {
            vec!["Matches are ranked evidence snippets, never a complete Page editing baseline."]
        }
        ["read"] => vec![
            "JSON returns the selected complete Page projection and reusable title/body validators; raw output contains only the selected file content.",
            "Specialized move/delete prepare validators apply only to their declared operation and scope.",
        ],
        ["sed"] => vec![
            "The program is one positive numeric <start>[,<end>]p range; content is a line slice, not a complete Page editing baseline.",
        ],
        ["ls"] => vec![
            "List direct children only; continuation identifies additional children, not deeper descendants.",
        ],
        ["patch"]
        | ["page", "insert" | "replace" | "rename"]
        | ["page", "properties", "apply" | "set"]
        | ["page", "create-batch"] => vec![
            "Output format never changes write authorization, concurrency conditions, or idempotency.",
            "Without an idempotency key each call is a new operation. Reuse an explicit key and identical input when retrying an uncertain result.",
        ],
        _ => Vec::new(),
    }
}

fn result_revision(path: &[&str]) -> u32 {
    match path {
        ["read"] => 2,
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

fn machine_help_for(metadata: &CommandMetadata) -> MachineHelp {
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
        examples: vec![metadata.example],
        arguments,
        argument_groups,
        usage,
        content_input: arguments::content_input(metadata.path),
        output: output_help(metadata.path),
        semantics: command_semantics(metadata.path),
        forwarded_arguments: forwarded_arguments(metadata.path),
        result_schema: schema::result(metadata.path),
        error_schema: schema::document::<crate::error::ErrorEnvelope>(),
        payload_schemas: schema::payloads(metadata.path),
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
    let commands = COMMANDS
        .iter()
        .filter(|metadata| metadata.path.starts_with(prefix))
        .map(|metadata| MachineHelpSummary {
            command: command_name(metadata.path),
            capability: metadata.capability,
            effect: metadata.effect,
            result_schema_revision: result_revision(metadata.path),
        })
        .collect();
    MachineHelpIndex {
        schema_version: MACHINE_HELP_SCHEMA_VERSION,
        command: command_name(prefix),
        commands,
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
            "--profile" | "--project" | "--database" | "--page" | "--output-format"
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
