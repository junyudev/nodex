use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use clap::{Args, Subcommand, ValueEnum};
use nodex_core_contracts::library::{
    LibraryFileReadSource, LibraryPageDraftProjection, LibraryPageFileSelector, LibraryRead,
    LibraryReadValue,
};
use nodex_core_protocol::client::CoreClient;
use nodex_markdown::{Block, BlockKind, ReadOptions, read_located, text::inline_text};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;

use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, map_client_error, unwrap_library};

const SOURCE_BYTES: usize = 1024 * 1024;
const FILE_BYTES: usize = 4 * SOURCE_BYTES;
const RESPONSE_BYTES: usize = 32 * SOURCE_BYTES;
const TIME_BUDGET: Duration = Duration::from_secs(45);
const DEVELOPMENT_ELECTRON_EXECUTABLE: &str = if cfg!(target_os = "macos") {
    "Electron.app/Contents/MacOS/Electron"
} else if cfg!(windows) {
    "electron.exe"
} else {
    "electron"
};

#[derive(Clone, Debug, Args, PartialEq)]
pub struct VisualArgs {
    #[command(subcommand)]
    pub command: VisualCommand,
}

#[derive(Clone, Debug, Subcommand, PartialEq)]
pub enum VisualCommand {
    /// Check JSX and measure the light and dark figures. Use - for stdin.
    Check {
        /// Raw Visual JSX file, or - for stdin.
        #[arg(value_name = "FILE|-")]
        source: PathBuf,
        /// Use this Visual block's Page to resolve Files and tables.
        #[arg(long)]
        block: Option<String>,
        /// Write light and dark PNG screenshots and SVG snapshots in this directory.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Export the current Visual block's PNG and SVG.
    Snapshot {
        /// Stable Block ID of the stored Visual.
        #[arg(long)]
        block: String,
        /// Export this appearance. Omit to capture light and dark.
        #[arg(long, value_enum)]
        theme: Option<Appearance>,
        /// Directory for the exported PNG and SVG.
        #[arg(long, default_value = ".")]
        out: PathBuf,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ValueEnum, PartialEq, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    fn filename(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

fn unavailable(message: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::CoreUnavailable, message.to_string())
}

fn invalid(message: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message.to_string())
}

pub fn standalone(args: &VisualArgs) -> bool {
    matches!(&args.command, VisualCommand::Check { block: None, .. })
}

struct Page<'a> {
    client: &'a CoreClient,
    project: Option<&'a str>,
    draft: LibraryPageDraftProjection,
}

fn open_page<'a>(
    client: &'a CoreClient,
    project: Option<&'a str>,
    block: &str,
) -> Result<Page<'a>, CliError> {
    let target = unwrap_library(client.library_read(
        project,
        LibraryRead::BlockPage {
            block_id: block.into(),
        },
    ))?;
    let LibraryReadValue::BlockPage {
        page_id: Some(page_id),
    } = target.value
    else {
        return Err(invalid("The Visual block is unavailable"));
    };
    let draft =
        unwrap_library(client.library_read(project, LibraryRead::PageDraftProjection { page_id }))?;
    let LibraryReadValue::PageDraftProjection { value } = draft.value else {
        return Err(invalid("The Visual block's Page is unavailable"));
    };
    Ok(Page {
        client,
        project,
        draft: *value,
    })
}

impl Page<'_> {
    fn block(&self, id: &str) -> Result<Block, CliError> {
        fn flatten(blocks: Vec<Block>, flat: &mut Vec<Block>) {
            for mut block in blocks {
                let children = std::mem::take(&mut block.children);
                flat.push(block);
                flatten(children, flat);
            }
        }
        let position = self
            .draft
            .body_blocks
            .iter()
            .find(|b| b.block_id == id)
            .and_then(|block| block.spans.first())
            .map(|span| span.start)
            .ok_or_else(|| invalid("The Block must belong to this Page"))?;
        let document =
            read_located(&self.draft.body_markdown, ReadOptions::DOCUMENT).map_err(invalid)?;
        let index = document
            .locations
            .iter()
            .position(|item| {
                item.spans
                    .first()
                    .is_some_and(|span| span.start == position)
            })
            .ok_or_else(|| invalid("The Block is unavailable"))?;
        let mut blocks = Vec::new();
        flatten(document.blocks, &mut blocks);
        blocks
            .into_iter()
            .nth(index)
            .ok_or_else(|| invalid("The Block is unavailable"))
    }

    fn resolve(&self, reference: SourceReference) -> Result<Value, CliError> {
        let page_id = self.draft.page_id.clone();
        match reference {
            SourceReference::Table { block } => match self.block(&block)?.kind {
                BlockKind::Table(table) if table.header_row => {
                    let cells: Vec<Vec<String>> = table
                        .rows
                        .iter()
                        .map(|row| row.iter().map(|cell| inline_text(&cell.text)).collect())
                        .collect();
                    let output = json!({ "kind": "table", "cells": cells });
                    if output.to_string().len() > FILE_BYTES {
                        return Err(invalid("The table source exceeds 4 MiB"));
                    }
                    Ok(output)
                }
                _ => Err(invalid("The table source needs a header row")),
            },
            SourceReference::File { file } => {
                let resolved = unwrap_library(self.client.library_read(
                    self.project,
                    LibraryRead::ResolvePageFile {
                        page_id: page_id.clone(),
                        selector: LibraryPageFileSelector::FileId {
                            file_id: file.clone(),
                        },
                    },
                ))?;
                if !matches!(resolved.value, LibraryReadValue::ResolvedPageFile { .. }) {
                    return Err(invalid("The File source must belong to this Page"));
                }
                let source = LibraryFileReadSource::Page { page_id };
                let presentation = unwrap_library(self.client.library_read(
                    self.project,
                    LibraryRead::FilePresentation {
                        file_id: file.clone(),
                        source: source.clone(),
                        version: None,
                    },
                ))?;
                let LibraryReadValue::FilePresentation { value } = presentation.value else {
                    return Err(invalid("The Page File source is unavailable"));
                };
                if resolved.store_epoch != presentation.store_epoch
                    || value.byte_length > FILE_BYTES as u64
                {
                    return Err(invalid("The Page File source is unavailable or over 4 MiB"));
                }
                let blob = self
                    .client
                    .read_file_blob(self.project, &file, &source, Some(value.version))
                    .map_err(map_client_error)?;
                let text = String::from_utf8(blob.bytes).map_err(invalid)?;
                Ok(json!({ "kind": "file", "text": text }))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum SourceReference {
    File { file: String },
    Table { block: String },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WorkerMessage {
    Source { reference: SourceReference },
    Result { result: WorkerResult },
    Error { message: String },
}

#[derive(Deserialize)]
struct WorkerResult {
    diagnostics: Vec<Diagnostic>,
    captures: Vec<Capture>,
}

#[derive(Deserialize, Serialize, ToSchema)]
struct Diagnostic {
    severity: Severity,
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    span: Option<SourceSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    appearance: Option<Appearance>,
}

#[derive(Deserialize, Serialize, ToSchema)]
struct SourceSpan {
    start: u32,
    end: u32,
}

#[derive(Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Severity {
    Error,
    Warning,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct VisualResult {
    valid: bool,
    diagnostics: Vec<Diagnostic>,
    captures: Vec<CaptureResult>,
}

#[derive(Serialize, ToSchema)]
struct CaptureResult {
    appearance: Appearance,
    hash: String,
    width: u32,
    height: u32,
    files: Option<CaptureFiles>,
}

#[derive(Serialize, ToSchema)]
struct CaptureFiles {
    #[schema(value_type = String)]
    png: PathBuf,
    #[schema(value_type = String)]
    svg: PathBuf,
}

#[derive(Deserialize)]
struct Capture {
    appearance: Appearance,
    hash: String,
    width: u32,
    height: u32,
    svg: String,
    png: String,
}

fn development_worker_launch(executable: &Path) -> Option<(PathBuf, PathBuf)> {
    let bin = executable.parent()?;
    // Managed Agent shells and direct invocations both resolve from their CLI's worktree.
    let checkout = if bin.ends_with("target/debug") || bin.ends_with("target/release") {
        bin.ancestors().nth(2)?
    } else if bin.ends_with(".generated/rust-dev-runtime/bin") {
        bin.ancestors().nth(3)?
    } else {
        return None;
    };
    let binary = checkout
        .join("node_modules/electron/dist")
        .join(DEVELOPMENT_ELECTRON_EXECUTABLE);
    let entry = checkout.join("out/main/bootstrap.js");
    (checkout.join("config/electron.vite.config.ts").is_file()
        && binary.is_file()
        && entry.is_file())
    .then_some((binary, entry))
}

fn launcher() -> Result<Command, CliError> {
    let (binary, entry) = match crate::serve::host_launch() {
        Ok((binary, entry)) => {
            let test_override = std::env::var("NODE_ENV").as_deref() == Ok("test")
                && std::env::var_os("NODEX_TEST_HOST_ELECTRON").is_some()
                && std::env::var_os("NODEX_TEST_HOST_ENTRY").is_some();
            (
                binary,
                test_override.then(|| entry.with_file_name("bootstrap.js")),
            )
        }
        Err(_) => {
            let executable = std::env::current_exe().map_err(unavailable)?;
            let (binary, entry) = development_worker_launch(&executable).ok_or_else(|| {
                unavailable("The Visual worker is unavailable. Start the development app with `vp run dev` or use a packaged Nodex installation.")
            })?;
            (binary, Some(entry))
        }
    };
    let headless = cfg!(target_os = "linux")
        && std::env::var_os("DISPLAY").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_none();
    let mut command = if headless {
        let mut command = Command::new("xvfb-run");
        command
            .args(["-a", "-s", "-screen 0 1280x1024x24 -nolisten tcp"])
            .arg(&binary);
        command
    } else {
        Command::new(binary)
    };
    if let Some(entry) = entry {
        command.arg(entry);
    }
    command.arg("--nodex-visual-worker").arg("--disable-gpu");
    if cfg!(target_os = "macos") {
        command.args(["-ApplePersistenceIgnoreState", "YES"]);
    }
    if headless {
        command.args(["--ozone-platform=x11", "--disable-dev-shm-usage"]);
    }
    nodex_platform::process::clear_agent_shell_environment(&mut command);
    command.env_remove("ELECTRON_RUN_AS_NODE");
    command.env_remove("NODE_OPTIONS");
    Ok(command)
}

fn write_message(writer: &mut impl Write, value: Value) -> Result<(), CliError> {
    serde_json::to_writer(&mut *writer, &value).map_err(unavailable)?;
    writer.write_all(b"\n").map_err(unavailable)
}

fn render(
    source: &str,
    themes: &[Appearance],
    page: Option<&Page<'_>>,
) -> Result<WorkerResult, CliError> {
    let mut child = launcher()?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(unavailable)?;
    let mut writer = child.stdin.take().expect("configured Visual worker stdin");
    let mut reader = BufReader::new(
        child
            .stdout
            .take()
            .expect("configured Visual worker stdout"),
    );
    let (send, receive) = mpsc::sync_channel(0);
    std::thread::spawn(move || {
        loop {
            let mut line = String::new();
            let read = (&mut reader)
                .take(RESPONSE_BYTES as u64 + 1)
                .read_line(&mut line);
            if !matches!(read, Ok(size) if size > 0 && size <= RESPONSE_BYTES)
                || send.send(line).is_err()
            {
                break;
            }
        }
    });
    let mut run = || {
        write_message(
            &mut writer,
            json!({ "kind": "render", "job": { "source": source, "appearances": themes } }),
        )?;
        let deadline = Instant::now() + TIME_BUDGET;
        loop {
            let line = receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| {
                    unavailable("The offline Visual worker exited or exceeded its time budget")
                })?;
            match serde_json::from_str::<WorkerMessage>(&line).map_err(unavailable)? {
                WorkerMessage::Result { result } => return Ok(result),
                WorkerMessage::Error { message } => return Err(unavailable(message)),
                WorkerMessage::Source { reference } => {
                    let content = page
                        .ok_or_else(|| invalid("Provide --block to resolve a Page source"))
                        .and_then(|page| page.resolve(reference))
                        .ok();
                    write_message(&mut writer, json!({ "kind": "source", "content": content }))?;
                }
            }
        }
    };
    let result = (run)();
    if result.is_err() {
        let _ = child.kill();
    }
    drop(writer);
    let _ = child.wait();
    result
}

pub fn execute(
    args: VisualArgs,
    client: Option<&CoreClient>,
    project: Option<&str>,
) -> Result<CommandOutput, CliError> {
    let (block, out, themes, path) = match args.command {
        VisualCommand::Check { source, block, out } => (
            block,
            out,
            vec![Appearance::Light, Appearance::Dark],
            Some(source),
        ),
        VisualCommand::Snapshot { block, out, theme } => (
            Some(block),
            Some(out),
            theme.map_or_else(
                || vec![Appearance::Light, Appearance::Dark],
                |value| vec![value],
            ),
            None,
        ),
    };
    let page = block
        .as_deref()
        .map(|id| {
            open_page(
                client.ok_or_else(|| unavailable("The Page connection is unavailable"))?,
                project,
                id,
            )
        })
        .transpose()?;
    let source = if let Some(path) = path {
        let reader: Box<dyn Read> = if path.as_os_str() == "-" {
            Box::new(io::stdin())
        } else {
            Box::new(fs::File::open(path).map_err(invalid)?)
        };
        let mut text = String::new();
        reader
            .take(SOURCE_BYTES as u64 + 1)
            .read_to_string(&mut text)
            .map_err(invalid)?;
        if text.len() > SOURCE_BYTES {
            return Err(invalid("Visual source text exceeds 1 MiB"));
        }
        text
    } else {
        match page
            .as_ref()
            .expect("snapshot has a Page")
            .block(block.as_deref().expect("snapshot has a Block"))?
            .kind
        {
            BlockKind::Code { language, code } if language == "visual" => code,
            _ => return Err(invalid("The Block is not a Visual")),
        }
    };
    let result = render(&source, &themes, page.as_ref())?;
    let mut captures = Vec::new();
    for capture in result.captures {
        let paths = out
            .as_ref()
            .map(|out| -> Result<CaptureFiles, CliError> {
                fs::create_dir_all(out).map_err(invalid)?;
                let png = out.join(format!("{}.png", capture.appearance.filename()));
                let svg = out.join(format!("{}.svg", capture.appearance.filename()));
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(capture.png)
                    .map_err(unavailable)?;
                fs::write(&png, bytes).map_err(invalid)?;
                fs::write(&svg, capture.svg).map_err(invalid)?;
                Ok(CaptureFiles { png, svg })
            })
            .transpose()?;
        captures.push(CaptureResult {
            appearance: capture.appearance,
            hash: capture.hash,
            width: capture.width,
            height: capture.height,
            files: paths,
        });
    }
    let valid = result
        .diagnostics
        .iter()
        .all(|d| d.severity != Severity::Error);
    let output = VisualResult {
        valid,
        diagnostics: result.diagnostics,
        captures,
    };
    Ok(CommandOutput::JsonStatus {
        value: serde_json::to_value(output).map_err(unavailable)?,
        exit_status: if valid {
            crate::EXIT_SUCCESS
        } else {
            crate::EXIT_REJECTED
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_visual_worker_in_the_executables_own_worktree() {
        let checkout = tempfile::tempdir().unwrap();
        let checkout = checkout.path();
        let binary = checkout
            .join("node_modules/electron/dist")
            .join(DEVELOPMENT_ELECTRON_EXECUTABLE);
        let entry = checkout.join("out/main/bootstrap.js");
        let config = checkout.join("config/electron.vite.config.ts");
        for path in [&binary, &config] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, []).unwrap();
        }
        let debug_cli = checkout.join("target/debug/nodex");
        assert_eq!(development_worker_launch(&debug_cli), None);
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, []).unwrap();
        for cli in [
            debug_cli,
            checkout.join("target/release/nodex"),
            checkout.join(".generated/rust-dev-runtime/bin/nodex"),
        ] {
            assert_eq!(
                development_worker_launch(&cli),
                Some((binary.clone(), entry.clone()))
            );
        }
        assert_eq!(development_worker_launch(&checkout.join("bin/nodex")), None);
    }
}
