use std::ffi::OsString;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::skills::SkillAgent;

#[derive(Clone, Debug, Parser, PartialEq)]
#[command(
    name = "nodex",
    version = option_env!("NODEX_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
    about = "Read and change Nodex through the native Core",
    arg_required_else_help = true
)]
pub struct Cli {
    #[arg(long, global = true, value_name = "NAME_OR_ID")]
    pub profile: Option<String>,
    #[arg(long, global = true, value_name = "UUID_OR_UNIQUE_NAME")]
    pub project: Option<String>,
    #[arg(long, global = true, value_name = "UUID_OR_UNIQUE_NAME")]
    pub database: Option<String>,
    #[arg(long, global = true, value_name = "ID_OR_TITLE_PATH")]
    pub page: Option<String>,
    #[arg(long, global = true)]
    pub json: bool,
    #[arg(long, global = true)]
    pub no_color: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum Command {
    Capabilities,
    Setup(SkillMutationArgs),
    Skills(SkillsArgs),
    Context,
    Tree {
        #[arg(value_name = "SCOPE_SELECTOR")]
        scope: Option<String>,
    },
    Read(ReadArgs),
    Sed(SedArgs),
    Rg(RgArgs),
    Patch(PatchArgs),
    Open(OpenArgs),
    View(ViewArgs),
    Page(PageArgs),
    File(FileArgs),
    Block(BlockArgs),
    History(HistoryArgs),
    Backup(BackupArgs),
    Profile(ProfileArgs),
    Doctor(DoctorArgs),
    Draft(DraftArgs),
    Service(ServiceArgs),
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
    #[arg(long = "from", value_name = "PROFILE_HOME")]
    pub source: PathBuf,
    #[arg(long = "to", value_name = "PROFILE_HOME")]
    pub target: PathBuf,
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
    Status(SkillTargetArgs),
    Install(SkillMutationArgs),
    Remove(SkillMutationArgs),
    Doctor(SkillTargetArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SkillTargetArgs {
    #[arg(long = "agent", value_enum, action = clap::ArgAction::Append)]
    pub agents: Vec<SkillAgent>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SkillMutationArgs {
    #[command(flatten)]
    pub targets: SkillTargetArgs,
    #[arg(long)]
    pub dry_run: bool,
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
    Page(OpenResourceArgs),
    View(OpenResourceArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct OpenResourceArgs {
    #[arg(value_name = "RESOURCE_SELECTOR")]
    pub resource: String,
    #[arg(long = "print")]
    pub print_only: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ReadArgs {
    #[arg(value_name = "PAGE_SELECTOR")]
    pub page: String,
    #[arg(long)]
    pub meta: bool,
    #[arg(long, value_enum)]
    pub prepare: Option<PrepareKind>,
    #[arg(long, value_name = "VIEW_ID")]
    pub view: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum PrepareKind {
    #[value(name = "title.set")]
    TitleSet,
    #[value(name = "document.replace")]
    DocumentReplace,
    #[value(name = "page.delete")]
    PageDelete,
    #[value(name = "page.move")]
    PageMove,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct SedArgs {
    #[arg(short = 'n', action = clap::ArgAction::SetTrue, required = true)]
    pub quiet: bool,
    #[arg(value_name = "PROGRAM")]
    pub program: String,
    #[arg(value_name = "PAGE_SELECTOR")]
    pub page: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
#[command(trailing_var_arg = true)]
pub struct RgArgs {
    #[arg(value_name = "RG_ARGUMENT", num_args = 1.., allow_hyphen_values = true)]
    pub arguments: Vec<OsString>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PatchArgs {
    #[arg(long, value_name = "PATCH_FILE")]
    pub file: Option<PathBuf>,
    #[arg(long)]
    pub idempotency_key: Option<String>,
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
    Create(PageCreateArgs),
    Insert(PageInsertArgs),
    Replace(PageReplaceArgs),
    Title(PageTitleArgs),
    Move(PageMoveArgs),
    Duplicate(PageDuplicateArgs),
    Delete(PageDeleteArgs),
    File(PageFileArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileArgs {
    #[command(subcommand)]
    pub command: FileCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum FileCommand {
    /// List independently authorized Library Files.
    List(FileListArgs),
    /// Inspect metadata and write fences for one independently authorized File.
    Info(FileIdentityArgs),
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
    Versions(FileWindowArgs),
    /// Publish a retained version as a new content head.
    Restore(FileRestoreArgs),
    /// Trash an unused File, retaining its versions.
    Trash(FileWriteArgs),
    Untrash(FileWriteArgs),
    /// Permanently remove a trashed File with no retention roots.
    Purge(FileWriteArgs),
    Usages(FileWindowArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FilePaginationArgs {
    #[arg(long, value_name = "OPAQUE_CURSOR")]
    pub after: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileListArgs {
    #[arg(long)]
    pub query: Option<String>,
    #[arg(long)]
    pub trashed: bool,
    #[command(flatten)]
    pub pagination: FilePaginationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileImportArgs {
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub mime: Option<String>,
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileIdentityArgs {
    pub file_id: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileReadArgs {
    pub file_id: String,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub version: Option<i64>,
    #[arg(long, default_value = "-", value_name = "PATH_OR_DASH")]
    pub output: PathBuf,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileWriteArgs {
    pub file_id: String,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_revision: i64,
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileRenameArgs {
    #[command(flatten)]
    pub write: FileWriteArgs,
    #[arg(long)]
    pub name: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileReplaceArgs {
    #[command(flatten)]
    pub write: FileWriteArgs,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_head: i64,
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    /// Required for stdin; inferred from the source filename otherwise.
    #[arg(long)]
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileForkArgs {
    pub file_id: String,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub version: i64,
    #[arg(long)]
    pub name: String,
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileWindowArgs {
    pub file_id: String,
    #[command(flatten)]
    pub pagination: FilePaginationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct FileRestoreArgs {
    #[command(flatten)]
    pub write: FileWriteArgs,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_head: i64,
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
    /// List Page entries and body uses, deduplicated by File ID.
    List(PageFileListArgs),
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
    Copy(PageFileTransferArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileListArgs {
    pub page: String,
    #[arg(long)]
    pub query: Option<String>,
    #[command(flatten)]
    pub pagination: FilePaginationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileReadArgs {
    pub page: String,
    #[arg(long, required_unless_present = "path", conflicts_with = "path")]
    pub file_id: Option<String>,
    #[arg(long, required_unless_present = "file_id", conflicts_with = "file_id")]
    pub path: Option<String>,
    #[arg(long, default_value = "-", value_name = "PATH_OR_DASH")]
    pub output: PathBuf,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFilePutArgs {
    pub page: String,
    #[arg(long)]
    pub path: String,
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    #[arg(long)]
    pub mime: Option<String>,
    #[arg(long)]
    pub replace_entry: bool,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_manifest: i64,
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileWriteArgs {
    pub page: String,
    #[arg(long)]
    pub file_id: String,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_manifest: i64,
    #[arg(long)]
    pub turn_id: Option<String>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFilePathArgs {
    #[command(flatten)]
    pub write: PageFileWriteArgs,
    #[arg(long)]
    pub path: String,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileReplaceArgs {
    #[command(flatten)]
    pub write: PageFileWriteArgs,
    #[arg(long = "from", value_name = "PATH_OR_DASH")]
    pub source: PathBuf,
    #[arg(long)]
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageFileTransferArgs {
    pub page: String,
    #[arg(long)]
    pub file_id: String,
    #[arg(long)]
    pub to: String,
    #[arg(long)]
    pub path: String,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_source_manifest: i64,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    pub if_target_manifest: i64,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageCreateArgs {
    #[arg(long)]
    pub parent: String,
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
    pub page: String,
    #[arg(long)]
    pub at: String,
    #[arg(long)]
    pub file: Option<PathBuf>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageReplaceArgs {
    pub page: String,
    #[arg(long = "if-match")]
    pub if_match: String,
    #[arg(long)]
    pub file: Option<PathBuf>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageTitleArgs {
    #[command(subcommand)]
    pub command: PageTitleCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum PageTitleCommand {
    Set(PageTitleSetArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageTitleSetArgs {
    pub page: String,
    #[arg(long = "if-match")]
    pub if_match: String,
    #[arg(long, required_unless_present = "file", conflicts_with = "file")]
    pub value: Option<String>,
    #[arg(long, required_unless_present = "value", conflicts_with = "value")]
    pub file: Option<PathBuf>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageDestinationArgs {
    #[arg(long)]
    pub to: String,
    #[arg(long, conflicts_with_all = ["before", "after"])]
    pub at: Option<BoundaryPlacement>,
    #[arg(long, conflicts_with_all = ["at", "after"])]
    pub before: Option<String>,
    #[arg(long, conflicts_with_all = ["at", "before"])]
    pub after: Option<String>,
    #[command(flatten)]
    pub data_source: DataSourcePlacementArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct DataSourcePlacementArgs {
    #[arg(long, value_name = "VIEW_ID")]
    pub view: Option<String>,
    #[arg(long, value_name = "STABLE_GROUP_KEY", conflicts_with = "unassigned")]
    pub group: Option<String>,
    #[arg(long, conflicts_with = "group")]
    pub unassigned: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageMoveArgs {
    pub page: String,
    #[command(flatten)]
    pub destination: PageDestinationArgs,
    #[arg(long = "if-match")]
    pub if_match: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct PageDuplicateArgs {
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
    pub page: String,
    #[arg(long = "if-match")]
    pub if_match: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
#[group(multiple = false)]
pub struct BodyInputArgs {
    #[arg(long)]
    pub file: Option<PathBuf>,
    #[arg(long)]
    pub empty: bool,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct MutationArgs {
    #[arg(long)]
    pub idempotency_key: Option<String>,
    #[arg(long, value_delimiter = ',')]
    pub r#return: Vec<String>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ViewArgs {
    #[command(subcommand)]
    pub command: ViewCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum ViewCommand {
    Query(ViewQueryArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct ViewQueryArgs {
    #[arg(value_name = "VIEW_SELECTOR")]
    pub view: String,
    #[arg(long, value_name = "STABLE_GROUP_KEY", conflicts_with = "unassigned")]
    pub group: Option<String>,
    #[arg(long, conflicts_with = "group")]
    pub unassigned: bool,
    #[arg(long, value_name = "OPAQUE_CURSOR")]
    pub after: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockArgs {
    #[command(subcommand)]
    pub command: BlockCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum BlockCommand {
    Insert(BlockInsertArgs),
    Update(BlockUpdateArgs),
    Move(BlockMoveArgs),
    Delete(BlockDeleteArgs),
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockInsertArgs {
    pub page: String,
    #[arg(long)]
    pub at: String,
    #[arg(long)]
    pub block_json: PathBuf,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockUpdateArgs {
    pub page: String,
    #[arg(long)]
    pub block: String,
    #[arg(long = "if-match")]
    pub if_match: String,
    #[arg(long)]
    pub patch_json: PathBuf,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockMoveArgs {
    pub page: String,
    #[arg(long)]
    pub block: String,
    #[arg(long)]
    pub at: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct BlockDeleteArgs {
    pub page: String,
    #[arg(long)]
    pub block: String,
    #[arg(long = "if-match")]
    pub if_match: String,
    #[command(flatten)]
    pub mutation: MutationArgs,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct HistoryArgs {
    pub page: String,
    #[arg(long)]
    pub before: Option<String>,
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
    Create {
        #[arg(long)]
        label: Option<String>,
        #[command(flatten)]
        mutation: MutationArgs,
    },
    List,
}

#[derive(Clone, Debug, Args, PartialEq)]
pub struct DoctorArgs {
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
    Create {
        page: String,
        #[arg(long)]
        output: PathBuf,
    },
    Diff {
        directory: PathBuf,
    },
    Apply {
        directory: PathBuf,
    },
    Discard {
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
    Status,
    Enable,
    Disable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_global_scope_and_nested_page_command() {
        let cli = Cli::try_parse_from([
            "nodex",
            "--project",
            "Docs",
            "--json",
            "page",
            "title",
            "set",
            "@page_1",
            "--if-match",
            "title-etag",
            "--value",
            "New **title**",
            "--idempotency-key",
            "operation-1",
        ])
        .expect("valid command");

        assert_eq!(cli.project.as_deref(), Some("Docs"));
        assert!(cli.json);
        let Command::Page(PageArgs {
            command:
                PageCommand::Title(PageTitleArgs {
                    command: PageTitleCommand::Set(command),
                }),
        }) = cli.command
        else {
            panic!("expected title set command")
        };
        assert_eq!(command.page, "@page_1");
        assert_eq!(command.value.as_deref(), Some("New **title**"));
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
    fn view_query_keeps_group_scope_and_paging_bounded() {
        let cli = Cli::try_parse_from([
            "nodex",
            "--json",
            "view",
            "query",
            "@view-1",
            "--group",
            "in-progress",
            "--limit",
            "200",
        ])
        .expect("saved View query");
        let Command::View(ViewArgs {
            command: ViewCommand::Query(arguments),
        }) = cli.command
        else {
            panic!("expected View query")
        };
        assert_eq!(arguments.view, "@view-1");
        assert_eq!(arguments.group.as_deref(), Some("in-progress"));
        assert_eq!(arguments.limit, Some(200));

        let conflict = Cli::try_parse_from([
            "nodex",
            "view",
            "query",
            "@view-1",
            "--group",
            "triage",
            "--unassigned",
        ])
        .expect_err("group scopes are exclusive");
        assert_eq!(conflict.kind(), clap::error::ErrorKind::ArgumentConflict);

        let unbounded =
            Cli::try_parse_from(["nodex", "view", "query", "@view-1", "--limit", "201"])
                .expect_err("View windows are bounded");
        assert_eq!(unbounded.kind(), clap::error::ErrorKind::ValueValidation);
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
        let unbounded =
            Cli::try_parse_from(["nodex", "file", "list", "--limit", "201"]).unwrap_err();
        assert_eq!(unbounded.kind(), clap::error::ErrorKind::ValueValidation);
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
