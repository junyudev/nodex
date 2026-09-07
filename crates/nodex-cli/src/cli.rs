use std::ffi::OsString;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::presentation::OutputFormat;
use crate::skills::SkillAgent;

#[derive(Clone, Debug, Parser, PartialEq)]
#[command(
    name = "nodex",
    version = option_env!("NODEX_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
    about = "Read, query and edit Nodex Pages, Properties, Views and Files",
    arg_required_else_help = true
)]
pub struct Cli {
    /// Require the connected Core Profile identity; does not select a home.
    #[arg(
        long,
        global = true,
        help_heading = "Global options",
        value_name = "ID"
    )]
    pub expect_profile: Option<String>,
    /// Select the access Project by ID or unique name; otherwise use the host or working-directory context.
    #[arg(
        long,
        global = true,
        help_heading = "Global options",
        value_name = "UUID_OR_UNIQUE_NAME"
    )]
    pub project: Option<String>,
    /// Select a Database by ID or unique name for commands that use a Database scope.
    #[arg(
        long,
        global = true,
        help_heading = "Global options",
        value_name = "UUID_OR_UNIQUE_NAME"
    )]
    pub database: Option<String>,
    /// Select a Page context for commands that use a default Page scope.
    #[arg(
        long,
        global = true,
        help_heading = "Global options",
        value_name = "ID_OR_TITLE_PATH"
    )]
    pub page: Option<String>,
    /// Print structured JSON; equivalent to --output-format json.
    #[arg(
        long,
        global = true,
        help_heading = "Global options",
        conflicts_with = "output_format"
    )]
    pub json: bool,
    /// Choose structured output: auto uses text on a terminal and JSON when piped.
    #[arg(long, global = true, help_heading = "Global options", value_enum)]
    pub output_format: Option<OutputFormat>,
    /// Disable terminal colors.
    #[arg(long, global = true, help_heading = "Global options")]
    pub no_color: bool,
    /// Print an offline input, result, error, or complete schema guide as JSON.
    #[arg(long, global = true, help_heading = "Global options", value_enum)]
    pub help_schema: Option<HelpSchema>,
    #[command(subcommand)]
    pub command: Command,
}

impl Cli {
    pub fn requested_output(&self) -> OutputFormat {
        if self.json {
            return OutputFormat::Json;
        }
        self.output_format.unwrap_or_default()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum HelpSchema {
    Input,
    Result,
    Error,
    All,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum Command {
    /// Filter, join and summarize Pages, bodies, Properties and View results with read-only SQL.
    Sql(crate::sql::SqlArgs),
    /// Read one known Page body; --json includes reusable edit validators.
    Read(ReadArgs),
    /// Find ranked Page candidates; use SQL for combined filters and joins.
    Search(crate::search::SearchArgs),
    /// Report supported API versions and packaged Skill identity; optional diagnostics.
    Capabilities,
    /// Read the bundled content format documentation without connecting to Core.
    Docs(DocsArgs),
    /// Install the bundled Nodex Skill for selected Agents.
    Setup(SkillMutationArgs),
    /// Inspect, install or remove the bundled Agent Skill.
    Skills(SkillsArgs),
    /// Show the resolved Profile, Project, and default Database/View.
    Context,
    /// List direct child Pages of a Page or Database.
    Ls(crate::browse::BrowseArgs),
    /// Configure Property definitions and saved Views.
    DataSource(crate::data_source::DataSourceArgs),
    /// Show the Page hierarchy in a selected scope.
    Tree {
        /// Page or Database scope; omitted uses the selected context.
        #[arg(value_name = "SCOPE_SELECTOR")]
        scope: Option<String>,
    },
    /// Read a numbered line range from a Page body.
    Sed(SedArgs),
    /// Search Page text with ripgrep patterns and flags.
    Rg(RgArgs),
    /// Apply exact text edits to Page bodies from a Nodex patch.
    Patch(PatchArgs),
    /// Open a Page or saved View in the desktop app.
    Open(OpenArgs),
    /// Create, edit and organize Pages, Property values and Page attachments.
    Page(PageArgs),
    /// Manage shared Library Files and their content versions.
    File(FileArgs),
    /// Insert, update, move or delete individual Blocks in a Page.
    Block(BlockArgs),
    /// List a Page’s retained document history.
    History(HistoryArgs),
    /// Create or list Profile backups.
    Backup(BackupArgs),
    /// Create an independent local Profile from a published backup.
    Profile(ProfileArgs),
    /// Inspect Core health; optionally run database integrity checks.
    Doctor(DoctorArgs),
    /// Edit a Page through a local draft directory.
    Draft(DraftArgs),
    /// Inspect or manage the background Core service.
    Service(ServiceArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct DocsArgs {
    #[command(subcommand)]
    pub command: DocsCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum DocsCommand {
    /// Canonical Nested Markdown syntax for Page bodies.
    NestedMarkdown,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ProfileArgs {
    #[command(subcommand)]
    pub command: ProfileCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum ProfileCommand {
    /// Clone a published backup into a new local Profile home.
    Clone(ProfileCloneArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ProfileCloneArgs {
    /// Source Profile home containing published backups.
    #[arg(long = "from", value_name = "PROFILE_HOME")]
    pub source: PathBuf,
    /// New Profile home to create; it must not already exist.
    #[arg(long = "to", value_name = "PROFILE_HOME")]
    pub target: PathBuf,
    /// Published backup ID to copy, or latest.
    #[arg(long, default_value = "latest", value_name = "BACKUP_ID_OR_LATEST")]
    pub backup: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SkillsArgs {
    #[command(subcommand)]
    pub command: SkillsCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum SkillsCommand {
    /// Show Skill installation state for selected Agents.
    Status(SkillTargetArgs),
    /// Install the bundled Skill into selected Agent locations.
    Install(SkillMutationArgs),
    /// Remove managed Skill installations from selected Agents.
    Remove(SkillMutationArgs),
    /// Diagnose the bundled Skill and its installations.
    Doctor(SkillTargetArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SkillTargetArgs {
    /// Target Agent; repeat to select multiple Agents.
    #[arg(long = "agent", value_enum, action = clap::ArgAction::Append)]
    pub agents: Vec<SkillAgent>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SkillMutationArgs {
    #[command(flatten)]
    pub targets: SkillTargetArgs,
    /// Preview installation changes without writing them.
    #[arg(long)]
    pub dry_run: bool,
    /// Confirm the requested Skill installation or removal.
    #[arg(long)]
    pub yes: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct OpenArgs {
    #[command(subcommand)]
    pub command: OpenCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum OpenCommand {
    /// Open a Page by its selector, or print its deep link.
    Page(OpenResourceArgs),
    /// Open a saved View by its ID, or print its deep link.
    View(OpenResourceArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct OpenResourceArgs {
    /// Page selector or saved View ID, according to the command.
    #[arg(value_name = "RESOURCE_SELECTOR")]
    pub resource: String,
    /// Print the deep link without opening the desktop app.
    #[arg(long = "print")]
    pub print_only: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ReadArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    #[arg(value_name = "PAGE_SELECTOR")]
    pub page: String,
    /// Read Page metadata as YAML instead of the Nested Markdown body.
    #[arg(long)]
    pub meta: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PagePrepareArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    #[arg(value_name = "PAGE_SELECTOR")]
    pub page: String,
    /// Operation whose concurrency conditions should be prepared.
    #[arg(long, value_enum)]
    pub operation: PrepareOperation,
    /// Saved View ID for a move within that View; valid only with move.
    #[arg(long, value_name = "VIEW_ID")]
    pub view: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum PrepareOperation {
    Move,
    Delete,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SedArgs {
    /// Print only the requested lines; required for the supported sed form.
    #[arg(short = 'n', action = clap::ArgAction::SetTrue, required = true)]
    pub quiet: bool,
    /// Positive line range such as 3p or 3,12p (one-based, inclusive).
    #[arg(value_name = "PROGRAM")]
    pub program: String,
    /// Page ID, Page key, or uniquely resolvable title path.
    #[arg(value_name = "PAGE_SELECTOR")]
    pub page: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
#[command(trailing_var_arg = true)]
pub struct RgArgs {
    /// Pattern, optional Nodex scope, and supported ripgrep flags; use -- before a pattern starting with -.
    #[arg(value_name = "RG_ARGUMENT", num_args = 1.., allow_hyphen_values = true)]
    pub arguments: Vec<OsString>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PatchArgs {
    /// Read a Nodex patch from a UTF-8 file; omitted or - reads redirected stdin.
    #[arg(long, value_name = "PATCH_FILE")]
    pub file: Option<PathBuf>,
    /// Stable key for this write; reuse it with identical input after an uncertain result.
    #[arg(long)]
    pub idempotency_key: Option<String>,
    /// Include optional receipt fields; supported field: commit.
    #[arg(long, value_delimiter = ',')]
    pub r#return: Vec<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageArgs {
    #[command(subcommand)]
    pub command: PageCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum PageCommand {
    /// Prepare operation-specific conditions for a move or deletion.
    Prepare(PagePrepareArgs),
    /// Create one Page with a title, body and explicit parent.
    Create(PageCreateArgs),
    /// Create 1–16 Pages atomically from one JSON document.
    CreateBatch(crate::page_batch::PageCreateBatchArgs),
    /// Insert Nested Markdown without replacing existing Page content.
    Insert(PageInsertArgs),
    /// Replace the complete Page body using its current body ETag.
    Replace(PageReplaceArgs),
    /// Change only the Page title using its current title ETag.
    Rename(PageRenameArgs),
    /// Set Page Property values; use data-source configure for definitions.
    Properties(crate::page_properties::PagePropertiesArgs),
    /// Move a Page to a new parent or position.
    Move(PageMoveArgs),
    /// Copy a Page to an explicit destination.
    Duplicate(PageDuplicateArgs),
    /// Delete a Page using a prepared deletion ETag.
    Delete(PageDeleteArgs),
    /// Read and manage this Page’s File entries and logical paths.
    File(PageFileArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileArgs {
    #[command(subcommand)]
    pub command: FileCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum FileCommand {
    /// Import bytes as an independent Library File.
    Import(FileImportArgs),
    /// Read exact File bytes through direct File access.
    Read(FileReadArgs),
    /// Rename the default File name; Page paths are unchanged.
    Rename(FileRenameArgs),
    /// Replace shared content for every current use of this File.
    Replace(FileReplaceArgs),
    /// Create a separate File from an exact retained version.
    Fork(FileForkArgs),
    /// Publish a retained version as a new content head.
    Restore(FileRestoreArgs),
    /// Trash an unused File, retaining its versions.
    Trash(FileWriteArgs),
    /// Restore a trashed File to active use.
    Untrash(FileWriteArgs),
    /// Permanently remove a trashed File with no retention roots.
    Purge(FileWriteArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileImportArgs {
    /// Local file to import, or - for redirected stdin.
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    /// Default File name; inferred from the source path, required for stdin.
    #[arg(long)]
    pub name: Option<String>,
    /// MIME type; inferred from the File name when omitted.
    #[arg(long)]
    pub mime: Option<String>,
    /// Optional originating Turn ID recorded with the File change.
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileReadArgs {
    /// Library File ID; requires direct File access in this Project.
    pub file_id: String,
    /// Retained content version to read; omitted reads the current head.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub version: Option<i64>,
    /// Destination file (overwrites an existing regular file), or - for exact bytes on stdout.
    #[arg(long, default_value = "-", value_name = "PATH_OR_DASH")]
    pub output: PathBuf,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileWriteArgs {
    /// Library File ID to change.
    pub file_id: String,
    /// Observed File revision from the files SQL relation.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_revision: i64,
    /// Optional originating Turn ID recorded with the File change.
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileRenameArgs {
    #[command(flatten)]
    pub write: FileWriteArgs,
    /// New default File name; Page entry paths remain unchanged.
    #[arg(long)]
    pub name: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileReplaceArgs {
    #[command(flatten)]
    pub write: FileWriteArgs,
    /// Observed current content version; protects against replacing a newer head.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_head: i64,
    /// Replacement bytes from a local file, or - for redirected stdin.
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    /// Required for stdin; inferred from the source filename otherwise.
    #[arg(long)]
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileForkArgs {
    /// Library File ID whose content should be copied.
    pub file_id: String,
    /// Exact retained content version to copy into the new File.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub version: i64,
    /// Default name for the new independent File.
    #[arg(long)]
    pub name: String,
    /// Optional originating Turn ID recorded with the File change.
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileRestoreArgs {
    #[command(flatten)]
    pub write: FileWriteArgs,
    /// Observed current content version.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_head: i64,
    /// Retained version to publish as the new content head.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub version: i64,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileArgs {
    #[command(subcommand)]
    pub command: PageFileCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum PageFileCommand {
    /// Read current bytes by an explicit File ID or Page path.
    Read(PageFileReadArgs),
    /// Import at a path; --replace-entry replaces only this Page relation.
    Put(PageFilePutArgs),
    /// Add a path for an existing independently authorized File.
    Add(PageFilePathArgs),
    /// Rename this Page's virtual path.
    RenamePath(PageFilePathArgs),
    /// Remove this Page relation, retaining the File and body uses.
    Remove(PageFileWriteArgs),
    /// Import a new File and retarget only this Page relation.
    ReplaceEntry(PageFileReplaceArgs),
    /// Move a Page relation without changing File ownership or content.
    Move(PageFileTransferArgs),
    /// Copy a Page relation while retaining the shared File identity.
    Copy(PageFileTransferArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
#[command(group(clap::ArgGroup::new("file_selector").required(true).multiple(false).args(["file_id", "path"])))]
pub struct PageFileReadArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// File ID related to this Page; mutually exclusive with --path.
    #[arg(long, conflicts_with = "path")]
    pub file_id: Option<String>,
    /// Logical entry path on this Page, not an operating-system path.
    #[arg(long, conflicts_with = "file_id")]
    pub path: Option<String>,
    /// Destination file (overwrites an existing regular file), or - for exact bytes on stdout.
    #[arg(long, default_value = "-", value_name = "PATH_OR_DASH")]
    pub output: PathBuf,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFilePutArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Logical path for the new File entry on this Page.
    #[arg(long)]
    pub path: String,
    /// Local file to import, or - for redirected stdin.
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    /// MIME type; required for stdin, otherwise inferred from the source filename.
    #[arg(long)]
    pub mime: Option<String>,
    /// Replace an existing entry at this path with a new independent File.
    #[arg(long)]
    pub replace_entry: bool,
    /// Observed pages.file_manifest_revision, including zero for an empty manifest.
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_manifest: i64,
    /// Optional originating Turn ID recorded with the File change.
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileWriteArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// File ID of the entry on this Page.
    #[arg(long)]
    pub file_id: String,
    /// Observed pages.file_manifest_revision.
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_manifest: i64,
    /// Optional originating Turn ID recorded with the File change.
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFilePathArgs {
    #[command(flatten)]
    pub write: PageFileWriteArgs,
    /// Logical entry path on this Page.
    #[arg(long)]
    pub path: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileReplaceArgs {
    #[command(flatten)]
    pub write: PageFileWriteArgs,
    /// Replacement bytes from a local file, or - for redirected stdin.
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    /// MIME type; required for stdin, otherwise inferred from the source filename.
    #[arg(long)]
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileTransferArgs {
    /// Source Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// File ID of the source Page entry.
    #[arg(long)]
    pub file_id: String,
    /// Destination Page selector.
    #[arg(long)]
    pub to: String,
    /// Logical entry path on the destination Page.
    #[arg(long)]
    pub path: String,
    /// Observed source pages.file_manifest_revision.
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_source_manifest: i64,
    /// Observed destination pages.file_manifest_revision.
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_target_manifest: i64,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageCreateArgs {
    /// Parent destination: library, page:PAGE_ID or data_source:SOURCE_ID.
    #[arg(long)]
    pub parent: String,
    /// Initial Page title as inline Nested Markdown.
    #[arg(long)]
    pub title: String,
    #[command(flatten)]
    pub content: BodyInputArgs,
    #[command(flatten)]
    pub data_source: DataSourcePlacementArgs,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageInsertArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Block anchor: start, end, before:ID, after:ID, inside-start:ID or inside-end:ID.
    #[arg(long, default_value = "end")]
    pub at: String,
    /// Read Nested Markdown from a UTF-8 file; omitted or - reads redirected stdin.
    #[arg(long)]
    pub file: Option<PathBuf>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageReplaceArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Current validators.body_etag from read --json, or body_etag from page_documents SQL.
    #[arg(long = "if-match")]
    pub if_match: String,
    /// Read Nested Markdown from a UTF-8 file; omitted or - reads redirected stdin.
    #[arg(long)]
    pub file: Option<PathBuf>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
#[command(group(clap::ArgGroup::new("title_input").required(true).multiple(false).args(["title", "file"])))]
pub struct PageRenameArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Current validators.title_etag from read --json, or title_etag from pages SQL.
    #[arg(long = "if-match")]
    pub if_match: String,
    /// New inline Nested Markdown title; mutually exclusive with --file.
    #[arg(conflicts_with = "file")]
    pub title: Option<String>,
    /// Read the new title from a UTF-8 file or stdin (-); mutually exclusive with TITLE.
    #[arg(long, conflicts_with = "title")]
    pub file: Option<PathBuf>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageDestinationArgs {
    /// Destination: library, page:PAGE_ID or data_source:SOURCE_ID.
    #[arg(long)]
    pub to: String,
    /// Place at the start or end; mutually exclusive with --before and --after.
    #[arg(long, conflicts_with_all = ["before", "after"])]
    pub at: Option<BoundaryPlacement>,
    /// Place immediately before this sibling Page ID.
    #[arg(long, conflicts_with_all = ["at", "after"])]
    pub before: Option<String>,
    /// Place immediately after this sibling Page ID.
    #[arg(long, conflicts_with_all = ["at", "before"])]
    pub after: Option<String>,
    #[command(flatten)]
    pub data_source: DataSourcePlacementArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct DataSourcePlacementArgs {
    /// Saved View ID used to interpret grouping and placement.
    #[arg(long, value_name = "VIEW_ID")]
    pub view: Option<String>,
    /// Stable group key from View results; not a group display label.
    #[arg(long, value_name = "STABLE_GROUP_KEY", conflicts_with = "unassigned")]
    pub group: Option<String>,
    /// Place in the unassigned group instead of specifying --group.
    #[arg(long, conflicts_with = "group")]
    pub unassigned: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageMoveArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    #[command(flatten)]
    pub destination: PageDestinationArgs,
    /// validators.move_etag from page prepare --operation move using the same View.
    #[arg(long = "if-match")]
    pub if_match: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageDuplicateArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    #[command(flatten)]
    pub destination: PageDestinationArgs,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum BoundaryPlacement {
    Start,
    End,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageDeleteArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// validators.page_etag from page prepare --operation delete.
    #[arg(long = "if-match")]
    pub if_match: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
#[group(multiple = false)]
pub struct BodyInputArgs {
    /// Read Nested Markdown from a UTF-8 file; omitted or - reads redirected stdin.
    #[arg(long)]
    pub file: Option<PathBuf>,
    /// Create an empty body without reading stdin.
    #[arg(long)]
    pub empty: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct MutationArgs {
    /// Stable key for this write; reuse it with identical input after an uncertain result.
    #[arg(long)]
    pub idempotency_key: Option<String>,
    /// Include optional receipt fields (commit for Page/Block writes; unsupported by File commands).
    #[arg(long, value_delimiter = ',')]
    pub r#return: Vec<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockArgs {
    #[command(subcommand)]
    pub command: BlockCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum BlockCommand {
    /// Insert a typed Block draft at a Page anchor.
    Insert(BlockInsertArgs),
    /// Update one Block with a typed JSON patch and its ETag.
    Update(BlockUpdateArgs),
    /// Move an existing Block to another anchor in the same Page.
    Move(BlockMoveArgs),
    /// Delete one Block using its current ETag.
    Delete(BlockDeleteArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockInsertArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Block anchor: start, end, before:ID, after:ID, inside-start:ID or inside-end:ID.
    #[arg(long)]
    pub at: String,
    /// Typed Block draft JSON file, or - for stdin; see --help-schema input.
    #[arg(long)]
    pub block_json: PathBuf,
    #[arg(skip)]
    pub prepared: Option<nodex_core_contracts::document::DocumentSemanticBlockDraft>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockUpdateArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Stable Block ID within the Page.
    #[arg(long)]
    pub block: String,
    /// Observed ETag for the target Block.
    #[arg(long = "if-match")]
    pub if_match: String,
    /// Typed Block update JSON file, or - for stdin; see --help-schema input.
    #[arg(long)]
    pub patch_json: PathBuf,
    #[arg(skip)]
    pub prepared: Option<nodex_core_contracts::document::DocumentBlockUpdatePatch>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockMoveArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Stable Block ID within the Page.
    #[arg(long)]
    pub block: String,
    /// Block anchor: start, end, before:ID, after:ID, inside-start:ID or inside-end:ID.
    #[arg(long)]
    pub at: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockDeleteArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Stable Block ID within the Page.
    #[arg(long)]
    pub block: String,
    /// Observed ETag for the target Block.
    #[arg(long = "if-match")]
    pub if_match: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct HistoryArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Opaque continuation cursor from a preceding history result.
    #[arg(long)]
    pub before: Option<String>,
    /// Maximum history entries to return.
    #[arg(long)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BackupArgs {
    #[command(subcommand)]
    pub command: BackupCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum BackupCommand {
    /// Publish an assets-inclusive backup of this Profile.
    Create {
        #[arg(long)]
        /// Optional human-readable label for the backup.
        label: Option<String>,
        #[command(flatten)]
        mutation: MutationArgs,
    },
    /// List published backups of this Profile.
    List,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct DoctorArgs {
    /// Also run database integrity and foreign-key checks.
    #[arg(long)]
    pub full: bool,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct DraftArgs {
    #[command(subcommand)]
    pub command: DraftCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum DraftCommand {
    /// Materialize a Page body and edit conditions in a new local directory.
    Create {
        /// Page ID, Page key, or uniquely resolvable title path.
        page: String,
        #[arg(long)]
        /// New directory in which to create the editable draft.
        output: PathBuf,
    },
    /// Show local draft changes against the saved baseline.
    Diff {
        /// Draft directory produced by nodex draft create.
        directory: PathBuf,
    },
    /// Apply identity-preserving draft edits atomically; conflicts keep the work files.
    Apply {
        /// Draft directory produced by nodex draft create.
        directory: PathBuf,
    },
    /// Remove a local draft directory without applying it.
    Discard {
        /// Draft directory produced by nodex draft create.
        directory: PathBuf,
    },
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ServiceArgs {
    #[command(subcommand)]
    pub command: ServiceCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, Subcommand)]
pub enum ServiceCommand {
    /// Show the background Core service state.
    Status,
    /// Enable the background Core service for this Profile.
    Enable,
    /// Disable the background Core service for this Profile.
    Disable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_prepare_selects_an_explicit_semantic_operation() {
        let parsed = Cli::try_parse_from([
            "nodex",
            "page",
            "prepare",
            "page-id",
            "--operation",
            "move",
            "--view",
            "view-id",
        ])
        .unwrap();
        let Command::Page(PageArgs {
            command: PageCommand::Prepare(args),
        }) = parsed.command
        else {
            panic!("Page prepare")
        };
        assert_eq!(args.operation, PrepareOperation::Move);
        assert_eq!(args.view.as_deref(), Some("view-id"));
        assert!(Cli::try_parse_from(["nodex", "page", "prepare", "page-id"]).is_err());
    }

    #[test]
    fn parses_global_scope_and_nested_page_command() {
        let cli = Cli::try_parse_from([
            "nodex",
            "--project",
            "Docs",
            "--json",
            "page",
            "rename",
            "@page_1",
            "--if-match",
            "title-etag",
            "New **title**",
            "--idempotency-key",
            "operation-1",
        ])
        .expect("valid command");

        assert_eq!(cli.project.as_deref(), Some("Docs"));
        assert!(cli.json);
        let Command::Page(PageArgs {
            command: PageCommand::Rename(command),
        }) = cli.command
        else {
            panic!("expected rename command")
        };
        assert_eq!(command.page, "@page_1");
        assert_eq!(command.title.as_deref(), Some("New **title**"));
        assert_eq!(
            command.mutation.idempotency_key.as_deref(),
            Some("operation-1")
        );
    }

    #[test]
    fn rg_preserves_hyphenated_arguments_for_policy_validation() {
        let cli = Cli::try_parse_from([
            "nodex",
            "rg",
            "--glob",
            "*.nested.md",
            "--fixed-strings",
            "Core starts",
            "@scope",
        ])
        .expect("rg command");
        let Command::Rg(arguments) = cli.command else {
            panic!("expected rg command")
        };
        assert_eq!(
            arguments.arguments,
            [
                "--glob",
                "*.nested.md",
                "--fixed-strings",
                "Core starts",
                "@scope"
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn destructive_commands_require_narrow_etags() {
        let error = Cli::try_parse_from(["nodex", "page", "delete", "@page_1"])
            .expect_err("delete without ETag must fail");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn page_create_keeps_prose_out_of_structured_flags() {
        let cli = Cli::try_parse_from([
            "nodex",
            "page",
            "create",
            "--parent",
            "library",
            "--title",
            "Native **Page**",
            "--empty",
            "--idempotency-key",
            "create-page-1",
        ])
        .expect("empty semantic Page creation");
        let Command::Page(PageArgs {
            command: PageCommand::Create(arguments),
        }) = cli.command
        else {
            panic!("expected Page create command")
        };
        assert_eq!(arguments.parent, "library");
        assert_eq!(arguments.title, "Native **Page**");
        assert!(arguments.content.empty);
        assert!(arguments.content.file.is_none());

        let conflicting = Cli::try_parse_from([
            "nodex",
            "page",
            "create",
            "--parent",
            "library",
            "--title",
            "Page",
            "--empty",
            "--file",
            "body.nested.md",
        ])
        .expect_err("Page create body sources are exclusive");
        assert_eq!(conflicting.kind(), clap::error::ErrorKind::ArgumentConflict);
    }

    #[test]
    fn page_transfer_parses_one_stable_placement_mode() {
        let cli = Cli::try_parse_from([
            "nodex",
            "page",
            "duplicate",
            "@page_1",
            "--to",
            "database",
            "--after",
            "@page_2",
            "--idempotency-key",
            "duplicate-page-1",
        ])
        .expect("semantic Page transfer");
        let Command::Page(PageArgs {
            command: PageCommand::Duplicate(arguments),
        }) = cli.command
        else {
            panic!("expected Page duplicate command")
        };
        assert_eq!(arguments.page, "@page_1");
        assert_eq!(arguments.destination.to, "database");
        assert_eq!(arguments.destination.after.as_deref(), Some("@page_2"));

        let error = Cli::try_parse_from([
            "nodex",
            "page",
            "move",
            "@page_1",
            "--to",
            "library",
            "--at",
            "start",
            "--before",
            "@page_2",
            "--if-match",
            "move-etag",
        ])
        .expect_err("placement modes are exclusive");
        assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);

        let missing_etag =
            Cli::try_parse_from(["nodex", "page", "move", "@page_1", "--to", "library"])
                .expect_err("Page movement requires its narrow ETag");
        assert_eq!(
            missing_etag.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );

        let grouped = Cli::try_parse_from([
            "nodex",
            "page",
            "move",
            "@page_1",
            "--to",
            "data_source:@source_1",
            "--view",
            "@view_1",
            "--group",
            "build",
            "--at",
            "end",
            "--if-match",
            "move-etag",
        ])
        .expect("grouped Data Source move");
        let Command::Page(PageArgs {
            command: PageCommand::Move(arguments),
        }) = grouped.command
        else {
            panic!("expected Page move command")
        };
        assert_eq!(
            arguments.destination.data_source.view.as_deref(),
            Some("@view_1")
        );
        assert_eq!(
            arguments.destination.data_source.group.as_deref(),
            Some("build")
        );

        let group_conflict = Cli::try_parse_from([
            "nodex",
            "page",
            "duplicate",
            "@page_1",
            "--to",
            "database",
            "--group",
            "build",
            "--unassigned",
        ])
        .expect_err("group and unassigned are exclusive");
        assert_eq!(
            group_conflict.kind(),
            clap::error::ErrorKind::ArgumentConflict
        );
    }

    #[test]
    fn file_commands_require_explicit_write_fences_and_unambiguous_selectors() {
        let put = Cli::try_parse_from([
            "nodex",
            "page",
            "file",
            "put",
            "@page-1",
            "--path",
            "references/api.md",
            "--from",
            "./api.md",
            "--if-manifest",
            "0",
        ])
        .expect("Page import");
        let Command::Page(PageArgs {
            command:
                PageCommand::File(PageFileArgs {
                    command: PageFileCommand::Put(args),
                }),
        }) = put.command
        else {
            panic!("Page put")
        };
        assert!(!args.replace_entry);
        assert_eq!(args.if_manifest, 0);
        for argv in [
            vec!["nodex", "file", "rename", "file-id", "--name", "next.txt"],
            vec![
                "nodex",
                "file",
                "replace",
                "file-id",
                "--from",
                "next.txt",
                "--if-revision",
                "1",
            ],
            vec![
                "nodex",
                "page",
                "file",
                "remove",
                "@page-1",
                "--file-id",
                "file-id",
            ],
            vec!["nodex", "page", "file", "read", "@page-1"],
            vec![
                "nodex",
                "page",
                "file",
                "read",
                "@page-1",
                "--path",
                "x",
                "--file-id",
                "x",
            ],
            vec![
                "nodex",
                "page",
                "file",
                "read",
                "@page-1",
                "--path",
                "x",
                "--version",
                "1",
            ],
        ] {
            assert!(Cli::try_parse_from(argv).is_err());
        }
        assert!(
            Cli::try_parse_from(["nodex", "file", "read", "file-id", "--version", "1"]).is_ok()
        );
        assert!(
            Cli::try_parse_from(["nodex", "page", "file", "read", "@page-1", "--path", "x"])
                .is_ok()
        );
    }

    #[test]
    fn open_accepts_only_typed_resource_subcommands() {
        let page = Cli::try_parse_from(["nodex", "--json", "open", "page", "@page-1", "--print"])
            .expect("typed Page open");
        let Command::Open(OpenArgs {
            command: OpenCommand::Page(arguments),
        }) = page.command
        else {
            panic!("expected Page open")
        };
        assert_eq!(arguments.resource, "@page-1");
        assert!(arguments.print_only);

        let arbitrary_url = Cli::try_parse_from(["nodex", "open", "nodex://pages/page-1"])
            .expect_err("arbitrary URLs are not an open command");
        assert_eq!(
            arbitrary_url.kind(),
            clap::error::ErrorKind::InvalidSubcommand
        );
    }
}
