use std::path::{Path, PathBuf};

use clap::{Args, Subcommand, ValueEnum};
use nodex_core_contracts::{
    ModuleApplyRequest, StoreEpoch,
    discussions::*,
    library::{LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryRead, LibraryReadValue},
};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
use serde::Serialize;

use crate::error::{CliError, CliErrorCode};
use crate::input::{decode_json, read_bytes};
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, resolve_page_selector, selected_project,
    unwrap_library,
};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct DiscussionsArgs {
    /// Reuse the same key and input to retry a write.
    #[arg(long, global = true)]
    idempotency_key: Option<String>,
    #[command(subcommand)]
    command: DiscussionsCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
enum Status {
    Open,
    Resolved,
    All,
}
#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
enum Waiting {
    Nodex,
    Me,
}
#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
enum AskKind {
    Ask,
    Check,
    CheckPage,
    InPlace,
}
#[derive(Clone, Debug, PartialEq, Args)]
struct AskInput {
    /// Send the Comment to Nodex as this kind of Ask.
    #[arg(long, value_enum)]
    ask: Option<AskKind>,
    /// The Session the requester wants Nodex to use.
    #[arg(long, requires = "ask")]
    requested_session_id: Option<String>,
    /// The requested Agent configuration as JSON.
    #[arg(long, requires = "ask")]
    ask_agent_json: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
enum Verdict {
    True,
    #[value(name = "partly_true")]
    PartlyTrue,
    False,
    Unverifiable,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
enum DiscussionsCommand {
    /// List Discussions and their Comments. Use --cursor to continue an earlier list.
    List {
        /// Page ID or a Page selector in the selected Project.
        #[arg(long)]
        page: Option<String>,
        /// Discussion status to include.
        #[arg(long, value_enum, default_value = "all")]
        status: Status,
        /// Whose answer the Discussion is waiting for.
        #[arg(long, value_enum)]
        waiting: Option<Waiting>,
        /// The next cursor returned by a previous list.
        #[arg(long)]
        cursor: Option<String>,
        /// Maximum Discussions per page, from 1 to 100.
        #[arg(long)]
        limit: Option<u32>,
    },
    /// Read a Discussion with its Comments.
    Show {
        /// Discussion ID.
        discussion: String,
    },
    /// Open a Discussion and write its first Comment.
    Create {
        /// Page ID or a Page selector in the selected Project.
        #[arg(long)]
        page: String,
        /// The Page, Blocks, text, or datum anchor as JSON.
        #[arg(long)]
        anchor_json: String,
        /// The observed UTF-16 offsets and selected text for a text anchor.
        #[arg(long)]
        text_range_json: Option<String>,
        /// Optional client-generated Discussion UUIDv7.
        #[arg(long)]
        discussion_id: Option<String>,
        /// Optional client-generated first Comment UUIDv7.
        #[arg(long)]
        first_comment_id: Option<String>,
        /// Comment Markdown file or - for standard input.
        #[arg(long)]
        body_file: PathBuf,
        #[command(flatten)]
        ask: AskInput,
    },
    /// Reply, address a Member, or offer an exact replacement of contiguous Blocks.
    Reply {
        /// Discussion ID.
        discussion: String,
        /// Comment Markdown file or - for standard input.
        #[arg(long)]
        body_file: PathBuf,
        #[command(flatten)]
        ask: AskInput,
        /// The result of a Check.
        #[arg(long, value_enum)]
        verdict: Option<Verdict>,
        /// Check evidence as a JSON array.
        #[arg(long, requires = "verdict")]
        evidence_json: Option<String>,
        /// Contiguous sibling Block IDs, in document order.
        #[arg(long, value_delimiter = ',', requires = "suggest_file")]
        suggest_blocks: Vec<String>,
        /// Replacement Nodex Markdown file.
        #[arg(long, requires = "suggest_blocks")]
        suggest_file: Option<PathBuf>,
        /// Member ID to address.
        #[arg(long)]
        question_for: Option<String>,
    },
    /// Replace your Comment's body.
    Edit {
        /// Comment ID.
        comment: String,
        /// Comment Markdown file or - for standard input.
        #[arg(long)]
        body_file: PathBuf,
    },
    /// Soft-delete your Comment.
    Delete {
        /// Comment ID.
        comment: String,
    },
    /// Resolve a Discussion, keeping its anchor.
    Resolve {
        /// Discussion ID.
        discussion: String,
    },
    /// Reopen a resolved Discussion.
    Reopen {
        /// Discussion ID.
        discussion: String,
    },
    /// Apply the Suggested edit if its original Blocks still match.
    Accept {
        /// Comment ID.
        comment: String,
    },
    /// Reject an open Suggested edit.
    Reject {
        /// Comment ID.
        comment: String,
    },
    /// Set whether Nodex answers unaddressed questions on this Page.
    SetPageSetting {
        /// Page ID or a Page selector in the selected Project.
        #[arg(long)]
        page: String,
        /// Whether the Page owner asks Nodex to answer unaddressed questions.
        #[arg(long, value_parser = clap::value_parser!(bool), action = clap::ArgAction::Set)]
        nodex_answers_questions: bool,
    },
    /// Revert unchanged Blocks written by one Run on this Page.
    RevertRun {
        /// Page ID or a Page selector in the selected Project.
        #[arg(long)]
        page: String,
        /// Run ID.
        #[arg(long)]
        run: String,
    },
}

pub(crate) fn execute(
    client: &CoreClient,
    args: DiscussionsArgs,
    project: Option<&str>,
    cwd: &Path,
) -> Result<CommandOutput, CliError> {
    use DiscussionsCommand::*;
    let project = project
        .map(|id| selected_project(client, Some(id), cwd).map(|value| value.id))
        .transpose()?;
    let page_id = |page: &str| {
        if let Some(project) = &project {
            return resolve_page_selector(client, project, page);
        }
        if let Some(page) = crate::runtime::canonical_page_selector(page)? {
            return Ok(page.to_owned());
        }
        Ok(page.to_owned())
    };
    let command = match args.command {
        List {
            page,
            status,
            waiting,
            cursor,
            limit,
        } => {
            return read(
                client,
                project.as_deref(),
                LibraryRead::Discussions {
                    provenance: None,
                    page_id: page.as_deref().map(page_id).transpose()?,
                    status: match status {
                        Status::Open => Some(DiscussionStatus::Open),
                        Status::Resolved => Some(DiscussionStatus::Resolved),
                        Status::All => None,
                    },
                    waiting: waiting.map(|waiting| match waiting {
                        Waiting::Nodex => DiscussionWaiting::Nodex,
                        Waiting::Me => DiscussionWaiting::Me,
                    }),
                    cursor: cursor
                        .as_deref()
                        .map(|cursor| decode_json(cursor.as_bytes(), "Discussion cursor"))
                        .transpose()?,
                    limit,
                },
            );
        }
        Show { discussion } => {
            return read(
                client,
                project.as_deref(),
                LibraryRead::Discussion {
                    provenance: None,
                    discussion_id: discussion,
                },
            );
        }
        Create {
            page,
            anchor_json,
            text_range_json,
            discussion_id,
            first_comment_id,
            body_file,
            ask,
        } => DiscussionCommand::Create {
            page_id: page_id(&page)?,
            discussion_id,
            first_comment_id,
            quote: None,
            anchor: decode_json(anchor_json.as_bytes(), "Anchor")?,
            text_range: text_range_json
                .as_deref()
                .map(|json| decode_json(json.as_bytes(), "Text range"))
                .transpose()?,
            first_comment: Box::new(draft(&body_file, ask)?),
        },
        Reply {
            discussion,
            body_file,
            ask,
            verdict,
            evidence_json,
            suggest_blocks,
            suggest_file,
            question_for,
        } => {
            if body_file == Path::new("-") && suggest_file.as_deref() == Some(Path::new("-")) {
                return Err(invalid("Only one input can use stdin"));
            }
            let mut comment = draft(&body_file, ask)?;
            comment.question_for = question_for;
            comment.verdict = verdict
                .map(|result| -> Result<_, CliError> {
                    Ok(DiscussionVerdict {
                        result: match result {
                            Verdict::True => DiscussionVerdictResult::True,
                            Verdict::PartlyTrue => DiscussionVerdictResult::PartlyTrue,
                            Verdict::False => DiscussionVerdictResult::False,
                            Verdict::Unverifiable => DiscussionVerdictResult::Unverifiable,
                        },
                        evidence: evidence_json
                            .as_deref()
                            .map(|json| decode_json(json.as_bytes(), "Evidence"))
                            .transpose()?
                            .unwrap_or_default(),
                    })
                })
                .transpose()?;
            comment.suggested_edit = suggest_file
                .map(|file| -> Result<_, CliError> {
                    Ok(SuggestedEditDraft {
                        block_ids: suggest_blocks,
                        new_markdown: text(&file, 1024 * 1024)?,
                        expected_old_markdown: None,
                    })
                })
                .transpose()?;
            DiscussionCommand::Reply {
                discussion_id: discussion,
                comment: Box::new(comment),
            }
        }
        Edit { comment, body_file } => DiscussionCommand::Edit {
            comment_id: comment,
            body: text(&body_file, 64 * 1024)?,
        },
        Delete { comment } => DiscussionCommand::Delete {
            comment_id: comment,
        },
        Resolve { discussion } => DiscussionCommand::Resolve {
            discussion_id: discussion,
        },
        Reopen { discussion } => DiscussionCommand::Reopen {
            discussion_id: discussion,
        },
        Accept { comment } => DiscussionCommand::Accept {
            comment_id: comment,
        },
        Reject { comment } => DiscussionCommand::Reject {
            comment_id: comment,
        },
        SetPageSetting {
            page,
            nodex_answers_questions,
        } => DiscussionCommand::SetPageSetting {
            page_id: page_id(&page)?,
            nodex_answers_questions,
        },
        RevertRun { page, run } => DiscussionCommand::RevertRun {
            page_id: page_id(&page)?,
            run_id: run,
        },
    };
    let name = command_name(&command);
    let operation_id = crate::retry_key::admit(
        client,
        project.as_deref(),
        name,
        args.idempotency_key.as_deref(),
        &command,
    )?;
    let response = client
        .library_apply(
            project.as_deref(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::Discussion {
                    command: Box::new(command),
                    authorization: None,
                },
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => output(
            committed
                .outcome()
                .discussion
                .as_ref()
                .ok_or_else(|| invalid("Core returned no Discussion result"))?,
        ),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn command_name(command: &DiscussionCommand) -> &'static str {
    use DiscussionCommand::*;
    match command {
        Create { .. } => "discussions_create",
        Reply { .. } => "discussions_reply",
        Edit { .. } => "discussions_edit",
        Delete { .. } => "discussions_delete",
        Resolve { .. } => "discussions_resolve",
        Reopen { .. } => "discussions_reopen",
        Accept { .. } => "discussions_accept",
        Reject { .. } => "discussions_reject",
        SetPageSetting { .. } => "discussions_set_page_setting",
        RevertRun { .. } => "discussions_revert_run",
        UpdateAsk { .. }
        | ReserveAsk { .. }
        | ObserveAsk { .. }
        | SettleAsk { .. }
        | StopAsk { .. } => {
            unreachable!("only exposed Discussion subcommands reach this route")
        }
    }
}

fn read(
    client: &CoreClient,
    project: Option<&str>,
    read: LibraryRead,
) -> Result<CommandOutput, CliError> {
    match unwrap_library(client.library_read(project, read))?.value {
        LibraryReadValue::Discussion { value } => output(value),
        LibraryReadValue::Discussions { value } => output(value),
        _ => Err(invalid("Core returned an unexpected Discussions read")),
    }
}

fn text(path: &Path, max: usize) -> Result<String, CliError> {
    String::from_utf8(read_bytes(path, max, "Markdown")?)
        .map_err(|_| invalid("Markdown must be UTF-8"))
}

fn draft(path: &Path, ask: AskInput) -> Result<DiscussionCommentDraft, CliError> {
    Ok(DiscussionCommentDraft {
        body: text(path, 64 * 1024)?,
        to_nodex: ask.ask.is_some(),
        ask_agent: ask
            .ask_agent_json
            .as_deref()
            .map(|input| decode_json(input.as_bytes(), "Ask Agent"))
            .transpose()?,
        requested_session_id: ask.requested_session_id,
        ask_kind: ask.ask.map(|kind| match kind {
            AskKind::Ask => DiscussionAskKind::Ask,
            AskKind::Check => DiscussionAskKind::Check,
            AskKind::CheckPage => DiscussionAskKind::CheckPage,
            AskKind::InPlace => DiscussionAskKind::InPlace,
        }),
        verdict: None,
        suggested_edit: None,
        question_for: None,
    })
}

fn output(value: impl Serialize) -> Result<CommandOutput, CliError> {
    serde_json::to_value(value)
        .map(CommandOutput::Json)
        .map_err(|e| CliError::new(CliErrorCode::Internal, e.to_string()))
}
fn invalid(message: &str) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}
