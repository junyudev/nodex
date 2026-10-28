//! Markdown projections leave out extensions and keep their nearest readable form.

use super::blocks;
use crate::{
    Block, BlockKind, Colors, Inline, LineBreaks, Portable, PortableOptions, Style, StyledText,
};

pub(super) fn write(blocks: &[Block], options: &PortableOptions<'_>) -> Portable {
    let mut state = State {
        options,
        lossy: false,
    };
    let mut projected = state.flow(blocks);
    crate::normalize_blocks(&mut projected);
    let markdown = blocks::flow_with_mode(
        &projected,
        blocks::Mode {
            portable: true,
            document_breaks: options.line_breaks == LineBreaks::Document,
            ..blocks::Mode::default()
        },
    );
    let read_options = if options.line_breaks == LineBreaks::Document {
        crate::ReadOptions::DOCUMENT
    } else {
        crate::ReadOptions::BOUNDARY
    };
    let exact =
        !state.lossy && crate::read(&markdown, read_options).ok().as_deref() == Some(blocks);
    Portable { markdown, exact }
}

struct State<'a, 'b> {
    options: &'a PortableOptions<'b>,
    lossy: bool,
}

impl State<'_, '_> {
    fn flow(&mut self, blocks: &[Block]) -> Vec<Block> {
        blocks.iter().flat_map(|block| self.block(block)).collect()
    }

    fn block(&mut self, block: &Block) -> Vec<Block> {
        if !block.children.is_empty()
            && matches!(
                block.kind,
                BlockKind::Paragraph { .. } | BlockKind::Toggle { .. }
            )
        {
            self.lossy = true;
            return self.flow(&[outline(block)]);
        }
        let mut projected = Block {
            id: block.id.clone(),
            kind: block.kind.clone(),
            children: self.flow(&block.children),
        };
        match &mut projected.kind {
            BlockKind::Paragraph { text, colors } | BlockKind::Toggle { text, colors } => {
                let toggle = matches!(block.kind, BlockKind::Toggle { .. });
                self.drop_colors(colors);
                *text = self.text(text);
                if toggle || !block.children.is_empty() {
                    self.lossy = true;
                }
                if text.is_empty() {
                    self.lossy = true;
                    return Vec::new();
                } else if toggle {
                    projected.kind = BlockKind::Paragraph {
                        text: text.clone(),
                        colors: Colors::default(),
                    };
                }
            }
            BlockKind::Heading {
                text,
                colors,
                toggleable,
                ..
            } => {
                self.lossy |= *toggleable;
                *toggleable = false;
                self.drop_colors(colors);
                *text = self.text(text);
                let mut result = vec![projected.clone()];
                result[0].children.clear();
                if !projected.children.is_empty() {
                    self.lossy = true;
                }
                result.extend(projected.children);
                return result;
            }
            BlockKind::Bullet { text, colors }
            | BlockKind::Numbered { text, colors, .. }
            | BlockKind::Check { text, colors, .. }
            | BlockKind::Quote { text, colors } => {
                self.drop_colors(colors);
                *text = self.text(text);
            }
            BlockKind::Callout { icon, text, colors } => {
                self.drop_colors(colors);
                *text = self.text(text);
                if blocks::alert(icon).is_none() {
                    self.lossy = true;
                    projected.kind = BlockKind::Quote {
                        text: text.clone(),
                        colors: Colors::default(),
                    };
                }
            }
            BlockKind::Image { width, .. } => {
                self.lossy |= width.is_some();
                *width = None;
            }
            BlockKind::Table(table) => {
                self.lossy |= !table.header_row
                    || table.header_column
                    || table.color.is_some()
                    || table.widths.iter().any(Option::is_some);
                table.header_row = true;
                table.header_column = false;
                table.widths.clear();
                table.color = None;
                for row in &mut table.rows {
                    for cell in row {
                        self.lossy |= cell.background.is_some();
                        cell.background = None;
                        cell.text = self.text(&cell.text);
                        for item in &mut cell.text {
                            match item {
                                Inline::Text { text, .. } => {
                                    self.lossy |= text.contains('\n');
                                    *text = text.replace('\n', " ");
                                }
                                Inline::Link { content, .. } => {
                                    for run in content {
                                        self.lossy |= run.text.contains('\n');
                                        run.text = run.text.replace('\n', " ");
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            BlockKind::Page | BlockKind::PageRef { .. } => {
                self.lossy = true;
                let page = match &block.kind {
                    BlockKind::PageRef { page } => page.as_str(),
                    _ => block.id.as_deref().unwrap_or_default(),
                };
                projected.kind = BlockKind::Paragraph {
                    text: vec![self.page_link(page)],
                    colors: Colors::default(),
                };
            }
            BlockKind::Database
            | BlockKind::Canvas
            | BlockKind::DatabaseViewRef { .. }
            | BlockKind::SyncedBlockRef { .. }
            | BlockKind::TemplateRef { .. } => {
                self.lossy = true;
                return projected.children;
            }
            _ => {}
        }
        vec![projected]
    }

    fn drop_colors(&mut self, colors: &mut Colors) {
        self.lossy |= !colors.is_empty();
        *colors = Colors::default();
    }

    fn style(&mut self, style: &Style) -> Style {
        self.lossy |= style.underline || style.color.is_some() || style.background.is_some();
        Style {
            underline: false,
            color: None,
            background: None,
            ..style.clone()
        }
    }

    fn page_link(&self, page: &str) -> Inline {
        let title = self
            .options
            .page_title
            .and_then(|lookup| lookup(page))
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Page".to_owned());
        link(crate::links::page_link(page), title)
    }

    fn text(&mut self, items: &[Inline]) -> Vec<Inline> {
        items
            .iter()
            .filter_map(|item| {
                Some(match item {
                    Inline::Text { text, style } => Inline::Text {
                        text: text.clone(),
                        style: self.style(style),
                    },
                    Inline::Link { href, content } => Inline::Link {
                        href: href.clone(),
                        content: content
                            .iter()
                            .map(|run| StyledText {
                                text: run.text.clone(),
                                style: self.style(&run.style),
                            })
                            .collect(),
                    },
                    Inline::PageMention { page } => {
                        self.lossy = true;
                        self.page_link(page)
                    }
                    Inline::ChatMention { session } => {
                        self.lossy = true;
                        link(crate::links::session_link(session), "Thread".to_owned())
                    }
                    Inline::DateMention(date) => {
                        self.lossy = true;
                        plain(crate::text::date_plain_text(date))
                    }
                    Inline::Attachment(attachment) => {
                        self.lossy = true;
                        let label = attachment
                            .name
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ");
                        let label = if label.is_empty() {
                            "Untitled attachment".to_owned()
                        } else {
                            label
                        };
                        if attachment.source.trim().is_empty() {
                            plain(format!("[Attachment: {label}]"))
                        } else {
                            link(attachment.source.clone(), label)
                        }
                    }
                    Inline::AgentConfig(_) => {
                        self.lossy = true;
                        return None;
                    }
                    Inline::Image(image) => {
                        self.lossy |= image.width.is_some();
                        let mut image = image.clone();
                        image.width = None;
                        Inline::Image(image)
                    }
                    Inline::Math { .. } => item.clone(),
                })
            })
            .collect()
    }
}

fn outline(block: &Block) -> Block {
    let kind = match &block.kind {
        BlockKind::Paragraph { text, colors } | BlockKind::Toggle { text, colors } => {
            BlockKind::Bullet {
                text: text.clone(),
                colors: *colors,
            }
        }
        kind => kind.clone(),
    };
    Block {
        id: block.id.clone(),
        kind,
        children: block.children.iter().map(outline).collect(),
    }
}

fn link(href: String, text: String) -> Inline {
    Inline::Link {
        href,
        content: vec![StyledText {
            text,
            style: Style::default(),
        }],
    }
}
fn plain(text: String) -> Inline {
    Inline::Text {
        text,
        style: Style::default(),
    }
}
