//! The message authority: exact Page-body Markdown and its Library images in reading order.
use std::collections::HashMap;

use nodex_core_contracts::inbox::ProjectWorkspaceInboxMessageImage;
use nodex_markdown::{Block, BlockKind, Inline, Style};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::domain::derived_records::parse_page_file_source;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_SUGGESTION_IMAGES: usize = 20;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct MessageContent {
    pub markdown: String,
    pub images: Vec<ProjectWorkspaceInboxMessageImage>,
}

/// Complete content has the bound of its consumer. Scheduled prompts retain Automation's
/// larger limit, independently of ordinary capture and suggestion input.
#[derive(Clone, Copy)]
pub(super) enum MessageContentLimit {
    Message,
    ScheduledPrompt,
}

impl MessageContentLimit {
    fn maximum_bytes(self) -> usize {
        match self {
            Self::Message => MAX_MESSAGE_BYTES,
            Self::ScheduledPrompt => crate::automation::MAX_PROMPT_BYTES,
        }
    }

    fn exceeded(self) -> StoreError {
        match self {
            Self::Message => super::inbox::invalid("Inbox input exceeds the complete 64 KiB bound"),
            Self::ScheduledPrompt => {
                super::inbox::invalid("The complete message exceeds the scheduled prompt limit")
            }
        }
    }
}

/// A complete body is required wherever a message leaves the Inbox. Titles and placement
/// never enter its content. File hashes are the Library's immutable blob digests.
pub(super) fn read_message_content(
    connection: &Connection,
    page_id: &str,
    limit: MessageContentLimit,
) -> Result<MessageContent, StoreError> {
    let markdown: Option<String> = connection.query_row(
        "SELECT CASE WHEN length(CAST(COALESCE(body.markdown,'') AS BLOB))<=?2 THEN COALESCE(body.markdown,'') END FROM pages page LEFT JOIN document_materializations body ON body.document_id=page.document_id WHERE page.block_id=?1",
        rusqlite::params![page_id, limit.maximum_bytes() as i64],
        |row| row.get(0),
    )?;
    let markdown = markdown.ok_or_else(|| limit.exceeded())?;
    content_from_markdown(connection, markdown)
}

/// Also used for retained historical bodies. A missing File has no bytes to claim: retain
/// its identity with an unavailable digest, so restoration invalidates that evidence.
pub(crate) fn content_from_markdown(
    connection: &Connection,
    markdown: String,
) -> Result<MessageContent, StoreError> {
    let blocks = crate::domain::markdown::parse_markdown(&markdown)
        .map_err(|_| super::inbox::corrupt("Inbox Page Markdown is unreadable"))?;
    let mut sources = Vec::new();
    super::inbox::collect_image_sources(&blocks, &mut sources);
    let images = sources.into_iter().map(|source| {
        let file_id = parse_page_file_source(&source).expect("collected Library image");
        let content_hash = connection.query_row(
            "SELECT version.blob_hash FROM library_files file JOIN file_versions version ON version.file_id=file.file_id AND version.version=file.head_version WHERE file.file_id=?1",
            [&file_id], |row| row.get::<_, String>(0),
        ).optional()?.unwrap_or_else(|| crate::document::sha256(format!("unavailable-inbox-image:{file_id}").as_bytes()));
        Ok(ProjectWorkspaceInboxMessageImage { source, file_id, content_hash })
    }).collect::<Result<Vec<_>, StoreError>>()?;
    Ok(MessageContent { markdown, images })
}

impl MessageContent {
    /// Canonical UTF-8 JSON tuple: ["nodex-inbox-message",1,body,[ordered image SHA-256s]].
    pub(crate) fn fingerprint(&self) -> String {
        let hashes = self
            .images
            .iter()
            .map(|image| image.content_hash.as_str())
            .collect::<Vec<_>>();
        let canonical = serde_json::to_vec(&("nodex-inbox-message", 1, &self.markdown, hashes))
            .expect("message fingerprint is serializable");
        crate::document::sha256(&canonical)
    }

    pub(super) fn require_suggestion_budget(&self) -> Result<(), StoreError> {
        if self.images.len() > MAX_SUGGESTION_IMAGES {
            return Err(StoreError::new(
                StoreErrorCode::InvalidInput,
                "More images than a suggestion can read (20)",
                false,
            ));
        }
        Ok(())
    }
}

/// All Agent consumers use this renderer. Numbering is supplied by the whole request or
/// handoff; repeated occurrences use the same number. External images remain Markdown.
pub(crate) fn agent_markdown(
    content: &MessageContent,
    numbers: &HashMap<String, usize>,
    image_limit: usize,
) -> Result<String, StoreError> {
    let (mut markdown, replacements) = agent_markdown_parts(content, numbers, image_limit)?;
    for (token, label) in replacements {
        markdown = markdown.replace(&token, &label);
    }
    Ok(markdown)
}

/// Image captions are inserted as literal Agent labels after serialization and
/// need not themselves be exact Markdown (for example, a caption can be HTML).
/// Mask those generated labels before comparing predecessor escape spellings.
pub(super) fn predecessor_agent_markdown_matches(
    content: &MessageContent,
    numbers: &HashMap<String, usize>,
    stored: &str,
) -> Result<bool, StoreError> {
    let (mut expected, replacements) = agent_markdown_parts(content, numbers, usize::MAX)?;
    let mut stored = stored.to_owned();
    let mut labels = Vec::new();
    for (token, label) in replacements {
        expected = expected.replace(&token, &label);
        labels.push(label);
    }
    // Longer labels can contain shorter ones. Mask both bodies identically,
    // including authored occurrences, with tokens absent from either source.
    labels.sort_by_key(|label| std::cmp::Reverse(label.len()));
    let mut prefix = "\u{e000}inbox-compare".to_owned();
    while expected.contains(&prefix) || stored.contains(&prefix) {
        prefix.push('_');
    }
    for (index, label) in labels.iter().enumerate() {
        let token = format!("{prefix}{index}\u{e001}");
        expected = expected.replace(label, &token);
        stored = stored.replace(label, &token);
    }
    let canonical = |text: &str| {
        crate::domain::markdown::parse_markdown(text)
            .map(|blocks| crate::domain::markdown::serialize_markdown(&blocks))
            .map_err(|_| super::inbox::corrupt("Stored Inbox Agent body is unreadable"))
    };
    Ok(canonical(&expected)? == canonical(&stored)?)
}

fn agent_markdown_parts(
    content: &MessageContent,
    numbers: &HashMap<String, usize>,
    image_limit: usize,
) -> Result<(String, Vec<(String, String)>), StoreError> {
    let mut blocks = crate::domain::markdown::parse_markdown(&content.markdown)
        .map_err(|_| super::inbox::corrupt("Inbox Page Markdown is unreadable"))?;
    // Tokens survive the exact writer without its literal-bracket escaping. Choose a prefix
    // absent from the source, so authored text cannot accidentally become an image marker.
    let mut prefix = "\u{e000}inbox-image".to_owned();
    while content.markdown.contains(&prefix) {
        prefix.push('_');
    }
    let mut replacements = Vec::new();
    let mut marker = |url: &str, alt: &str| -> Option<String> {
        let number = *numbers.get(url)?;
        let label = if alt.is_empty() {
            format!("[Image #{number}]")
        } else {
            format!("[Image #{number}] (caption: {alt})")
        };
        let label = if number > image_limit {
            format!("{label} (stays on the Page)")
        } else {
            label
        };
        let token = format!("{prefix}{}\u{e001}", replacements.len());
        replacements.push((token.clone(), label));
        Some(token)
    };
    replace_images(&mut blocks, &mut marker);
    Ok((
        crate::domain::markdown::serialize_markdown(&blocks),
        replacements,
    ))
}

fn replace_inline_images(
    items: &mut [Inline],
    marker: &mut impl FnMut(&str, &str) -> Option<String>,
) {
    for item in items {
        let Inline::Image(image) = item else {
            continue;
        };
        if let Some(text) = marker(&image.url, &image.alt) {
            *item = Inline::Text {
                text,
                style: Style::default(),
            };
        }
    }
}

fn replace_images(blocks: &mut [Block], marker: &mut impl FnMut(&str, &str) -> Option<String>) {
    for block in blocks {
        match &mut block.kind {
            BlockKind::Image { url, caption, .. } => {
                if let Some(text) = marker(url, caption) {
                    block.kind = BlockKind::Paragraph {
                        text: vec![Inline::Text {
                            text,
                            style: Style::default(),
                        }],
                        colors: Default::default(),
                    };
                }
            }
            BlockKind::Paragraph { text, .. }
            | BlockKind::Heading { text, .. }
            | BlockKind::Bullet { text, .. }
            | BlockKind::Numbered { text, .. }
            | BlockKind::Check { text, .. }
            | BlockKind::Toggle { text, .. }
            | BlockKind::Quote { text, .. }
            | BlockKind::Prompt { text, .. }
            | BlockKind::Callout { text, .. } => replace_inline_images(text, marker),
            BlockKind::Table(table) => {
                for cell in table.rows.iter_mut().flatten() {
                    replace_inline_images(&mut cell.text, marker);
                }
            }
            _ => {}
        }
        replace_images(&mut block.children, marker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inbox_content_keeps_images_in_prompt_first_lines_and_children() {
        let workspace = super::super::test_support::seeded_workspace();
        for id in ["prompt-first", "prompt-child"] {
            super::super::test_support::create_library_image(&workspace, id);
        }
        workspace.kernel.readers().read_default(|connection| {
            let markdown = ":::prompt[Review ![First](nodex://files/prompt-first)]\n  ![Child](nodex://files/prompt-child)\n:::";
            let content = content_from_markdown(connection, markdown.into())?;
            assert_eq!(content.images.iter().map(|image| image.file_id.as_str()).collect::<Vec<_>>(), vec!["prompt-first", "prompt-child"]);
            let numbers = content.images.iter().enumerate().map(|(index, image)| (image.source.clone(), index + 1)).collect();
            let rendered = agent_markdown(&content, &numbers, 20)?;
            assert_eq!(rendered, ":::prompt[Review [Image #1] (caption: First)]\n  [Image #2] (caption: Child)\n:::");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn inbox_content_collects_inline_table_and_nested_images_in_reading_order() {
        let workspace = super::super::test_support::seeded_workspace();
        for id in ["nested", "table", "last"] {
            super::super::test_support::create_library_image(&workspace, id);
        }
        workspace.kernel.readers().read_default(|connection| {
            let markdown = "- First\n  - nested ![Nested](nodex://files/nested)\n\n| Screenshot |\n| --- |\n| ![Cell](nodex://files/table) |\n\n![](nodex://files/last)\n\nAgain ![Same](nodex://files/nested) and ![External](https://example.com/image.png)";
            let content = content_from_markdown(connection, markdown.into())?;
            assert_eq!(content.images.iter().map(|image| image.file_id.as_str()).collect::<Vec<_>>(), vec!["nested", "table", "last"]);
            let numbers = content.images.iter().enumerate().map(|(index, image)| (image.source.clone(), index + 1)).collect();
            let rendered = agent_markdown(&content, &numbers, 20)?;
            assert!(rendered.contains("nested [Image #1] (caption: Nested)"));
            assert!(rendered.contains("| [Image #2] (caption: Cell) |"));
            assert!(rendered.contains("[Image #3]"));
            assert!(rendered.contains("Again [Image #1] (caption: Same) and ![External](https://example.com/image.png)"));
            Ok(())
        }).unwrap();
    }
}
