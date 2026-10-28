//! Nodex Markdown: one text language for Blocks.
//!
//! Nodex Markdown is GitHub Flavored Markdown, read the way GitHub reads a comment, plus a
//! small set of extensions for what Markdown cannot say. Every Block tree has one exact text,
//! and reading that text gives the same Blocks back. The language is specified in
//! `docs/references/nodex-markdown.md` and pinned by `tests/fixtures/cases.json`.
//!
//! This crate is the only implementation. Core uses it natively; the app uses its WebAssembly
//! build (`wasm` feature), so every runtime reads and writes the language by the same rules.

pub mod attributes;
pub mod code_languages;
pub mod links;
pub mod located;
pub mod model;
mod read;
pub mod text;
mod write;

#[cfg(feature = "wasm")]
mod wasm;

pub use located::{Located, SourceBlock};
pub use model::{
    AgentConfig, Align, Attachment, AttachmentKind, Block, BlockKind, Cell, Color, Colors,
    DateMention, Inline, InlineImage, ModelError, Style, StyledText, Table, blocks_from_json,
    blocks_to_json, inline_content_from_json, inline_content_to_json, normalize_blocks,
};

/// How a single newline inside a paragraph reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineBreaks {
    /// As GitHub reads a comment: a newline is a line break, and the lines of a top-level
    /// paragraph keep their indentation. Exact text is always read this way.
    #[default]
    Comment,
    /// As GitHub reads a README: a newline is a space.
    Document,
}

/// How text is read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReadOptions {
    /// An exact write: malformed Nodex syntax is refused with the reason instead of being read
    /// as the text it is, and a container must have its closing line.
    pub exact: bool,
    pub line_breaks: LineBreaks,
}

impl ReadOptions {
    /// What an exact write reads: Agent and CLI Page writes and patches.
    pub const EXACT: ReadOptions = ReadOptions {
        exact: true,
        line_breaks: LineBreaks::Comment,
    };
    /// What people and other software exchange: pastes, messages and Agent replies.
    pub const BOUNDARY: ReadOptions = ReadOptions {
        exact: false,
        line_breaks: LineBreaks::Comment,
    };
    /// A Markdown file, read as GitHub reads a README.
    pub const DOCUMENT: ReadOptions = ReadOptions {
        exact: false,
        line_breaks: LineBreaks::Document,
    };
}

/// Why an exact write was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("line {line}: {message}")]
pub struct ReadError {
    /// The 1-based line the problem starts on.
    pub line: usize,
    pub message: String,
}

/// Reads Nodex Markdown into Blocks. The empty text is the Document whose only Block is an
/// empty paragraph.
pub fn read(markdown: &str, options: ReadOptions) -> Result<Vec<Block>, ReadError> {
    read::read(markdown, options)
}

/// Reads Blocks with their own source lines in preorder.
pub fn read_located(markdown: &str, options: ReadOptions) -> Result<Located, ReadError> {
    read::read_located(markdown, options)
}

/// Reads one line of inline Nodex Markdown, as a title or container label.
pub fn read_inline(text: &str, options: ReadOptions) -> Result<Vec<Inline>, ReadError> {
    read::read_inline(text, options)
}

/// The one exact text of Blocks.
pub fn write(blocks: &[Block]) -> String {
    write::write_exact(blocks)
}

/// The exact text and each Block’s own lines, in preorder.
pub fn write_located(blocks: &[Block]) -> (String, Vec<SourceBlock>) {
    write::write_located(blocks)
}

/// Inline text on one line, as a title or container label is written.
pub fn write_inline(items: &[Inline]) -> String {
    write::write_inline(items)
}

/// Looks up a Page's current title by its id.
pub type PageTitles<'a> = &'a dyn Fn(&str) -> Option<String>;

/// Options for Markdown written for apps that read only Markdown.
#[derive(Default)]
pub struct PortableOptions<'a> {
    pub line_breaks: LineBreaks,
    /// The current title of a Page, where the writer knows it, to name Page mentions and
    /// references.
    pub page_title: Option<PageTitles<'a>>,
}

/// Markdown written for apps that read only Markdown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Portable {
    pub markdown: String,
    /// Whether the Markdown says the Blocks exactly.
    pub exact: bool,
}

/// Blocks as Markdown that apps reading only Markdown show as near as they can: exact text with
/// the extensions left out.
pub fn write_portable(blocks: &[Block], options: &PortableOptions<'_>) -> Portable {
    write::write_portable(blocks, options)
}

/// Reads Nodex Markdown into compact BlockNote JSON.
pub fn read_json(markdown: &str, options: ReadOptions) -> Result<serde_json::Value, ReadError> {
    read(markdown, options).map(|blocks| blocks_to_json(&blocks))
}

/// The exact text of Blocks given as BlockNote JSON.
pub fn write_json(blocks: &serde_json::Value) -> Result<String, ModelError> {
    blocks_from_json(blocks).map(|blocks| write(&blocks))
}
