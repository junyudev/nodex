//! Converts parsed structure into normalized content Blocks.

use super::{
    columns::Columns,
    error,
    inline::{self, fragment, is_br, text},
    syntax::{Directive, Syntax, Token},
    values,
};
use crate::{Align, Block, BlockKind, Cell, Colors, Inline, ReadError, Style, Table};
use comrak::nodes::{AlertType, AstNode, ListType, NodeValue, TableAlignment};
use std::cell::{Cell as DepthCell, RefCell};

pub(super) struct Reader<'s> {
    pub syntax: &'s Syntax,
    pub lines: Vec<&'s str>,
    depth: DepthCell<usize>,
    empty_blocks: RefCell<std::collections::HashSet<usize>>,
    columns: Columns,
}

struct Depth<'a>(&'a DepthCell<usize>);
impl Drop for Depth<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

impl<'s> Reader<'s> {
    pub fn new(syntax: &'s Syntax, source: &'s str) -> Self {
        let lines: Vec<_> = source.split('\n').collect();
        let columns = Columns::new(lines.iter().copied());
        Self {
            syntax,
            lines,
            depth: DepthCell::new(0),
            empty_blocks: RefCell::default(),
            columns,
        }
    }
    pub fn blocks<'a>(
        &self,
        nodes: impl Iterator<Item = &'a AstNode<'a>>,
        top: bool,
    ) -> Result<Vec<Block>, ReadError> {
        if self.depth.get() >= 128 {
            return Err(error(
                1,
                "Blocks nest too deeply; use fewer than 128 levels",
            ));
        }
        self.depth.set(self.depth.get() + 1);
        let _depth = Depth(&self.depth);
        let mut blocks = Vec::new();
        for node in nodes {
            let read = self.block(node, top)?;
            if read.is_empty() {
                self.empty_blocks
                    .borrow_mut()
                    .insert(node as *const _ as usize);
            }
            blocks.extend(read);
        }
        Ok(blocks)
    }

    pub(super) fn is_empty<'a>(&self, node: &'a AstNode<'a>) -> bool {
        self.empty_blocks
            .borrow()
            .contains(&(node as *const _ as usize))
    }

    fn block<'a>(&self, node: &'a AstNode<'a>, top: bool) -> Result<Vec<Block>, ReadError> {
        let data = node.data.borrow();
        let line = self.syntax.line(data.sourcepos.start.line);
        let block = match &data.value {
            NodeValue::Paragraph => return self.paragraph(node, top),
            NodeValue::Heading(heading) => {
                let (text, colors) = self.text(node, false)?;
                Block::new(BlockKind::Heading {
                    level: heading.level.min(4),
                    toggleable: false,
                    text,
                    colors,
                })
            }
            NodeValue::ThematicBreak => Block::new(BlockKind::Divider),
            NodeValue::CodeBlock(code) => {
                let code_text = code
                    .literal
                    .strip_suffix('\n')
                    .unwrap_or(&code.literal)
                    .to_owned();
                if code
                    .info
                    .split_whitespace()
                    .next()
                    .is_some_and(|s| s.eq_ignore_ascii_case("math"))
                {
                    Block::new(BlockKind::Math { source: code_text })
                } else {
                    Block::new(BlockKind::Code {
                        language: crate::code_languages::language_id(
                            code.info.split_whitespace().next().unwrap_or(""),
                        )
                        .into(),
                        code: code_text,
                    })
                }
            }
            NodeValue::BlockQuote | NodeValue::Alert(_) => {
                let (text, colors, children) = self.lead(node)?;
                let kind = match &data.value {
                    NodeValue::Alert(alert) => BlockKind::Callout {
                        icon: match alert.alert_type {
                            AlertType::Note => "ℹ️",
                            AlertType::Tip => "💡",
                            AlertType::Important => "❗",
                            AlertType::Warning => "⚠️",
                            AlertType::Caution => "🛑",
                        }
                        .into(),
                        text,
                        colors,
                    },
                    _ => BlockKind::Quote { text, colors },
                };
                Block::with_children(kind, children)
            }
            NodeValue::List(list) => {
                return node
                    .children()
                    .enumerate()
                    .map(|(index, item)| {
                        let (text, colors, children) = self.lead(item)?;
                        let kind = if let NodeValue::TaskItem(task) = &item.data.borrow().value {
                            BlockKind::Check {
                                checked: task.symbol.is_some(),
                                text,
                                colors,
                            }
                        } else if list.list_type == ListType::Ordered {
                            BlockKind::Numbered {
                                start: (index == 0 && list.start != 1).then_some(list.start as u32),
                                text,
                                colors,
                            }
                        } else {
                            BlockKind::Bullet { text, colors }
                        };
                        Ok(Block::with_children(kind, children))
                    })
                    .collect();
            }
            NodeValue::Table(table) => {
                let mut rows = Vec::new();
                for row in node.children() {
                    let mut cells = Vec::new();
                    for (index, cell) in row.children().enumerate() {
                        let mut text =
                            self.inlines(cell.children(), &Style::default(), None, false, 0)?;
                        let colors = self.take_attributes(&mut text, &["background"], line)?;
                        self.materialize(&mut text);
                        let align = match table.alignments.get(index) {
                            Some(TableAlignment::Center) => Align::Center,
                            Some(TableAlignment::Right) => Align::Right,
                            _ => Align::Left,
                        };
                        cells.push(Cell {
                            text,
                            background: colors.background,
                            align,
                        });
                    }
                    rows.push(cells);
                }
                Block::new(BlockKind::Table(Table {
                    rows,
                    header_row: true,
                    ..Table::default()
                }))
            }
            NodeValue::BlockDirective(directive) => {
                let Some(d) = directive
                    .info
                    .strip_prefix("nodex-")
                    .and_then(|id| id.parse::<usize>().ok())
                    .and_then(|id| self.syntax.containers.get(id))
                else {
                    return Ok(Vec::new());
                };
                let result = self.container(node, d);
                match result {
                    Ok(block) => block,
                    Err(err) if self.syntax.options.exact => return Err(err),
                    Err(_) => {
                        let mut blocks = vec![Block::new(BlockKind::Paragraph {
                            text: vec![text(format!(
                                ":::{}{}{}",
                                d.name,
                                d.label.as_ref().map_or(String::new(), |s| format!("[{s}]")),
                                crate::attributes::write_attribute_list(&d.attrs)
                            ))],
                            colors: Colors::default(),
                        })];
                        blocks.extend(self.blocks(node.children(), false)?);
                        blocks.push(Block::new(BlockKind::Paragraph {
                            text: vec![text(":::")],
                            colors: Colors::default(),
                        }));
                        return Ok(blocks);
                    }
                }
            }
            NodeValue::HtmlBlock(html) => {
                if let Some(d) = self.syntax.leaf_comment(&html.literal) {
                    return match self.leaf(d) {
                        Ok(block) => Ok(vec![block]),
                        Err(err) if self.syntax.options.exact => Err(err),
                        Err(_) => Ok(vec![Block::new(BlockKind::Paragraph {
                            text: vec![text(inline::literal(d))],
                            colors: Colors::default(),
                        })]),
                    };
                }
                let literal = html.literal.trim_end_matches('\n');
                if is_br(literal) {
                    Block::empty_paragraph()
                } else if literal.trim_start().starts_with("<!--") {
                    let mut rest = literal.trim();
                    while let Some(comment) = rest.strip_prefix("<!--") {
                        let Some(end) = comment.find("-->") else {
                            return Ok(Vec::new());
                        };
                        rest = comment[end + 3..].trim();
                    }
                    if rest.is_empty() {
                        return Ok(Vec::new());
                    }
                    if self.syntax.options.exact {
                        return Err(error(
                            line,
                            "HTML is not Nodex content; use Markdown or `:::toggle[More]`",
                        ));
                    }
                    Block::new(BlockKind::Paragraph {
                        text: vec![text(self.restore(literal))],
                        colors: Colors::default(),
                    })
                } else {
                    if self.syntax.options.exact {
                        return Err(error(
                            line,
                            "HTML is not Nodex content; use Markdown or `:::toggle[More]`",
                        ));
                    }
                    Block::new(BlockKind::Paragraph {
                        text: vec![text(self.restore(literal))],
                        colors: Colors::default(),
                    })
                }
            }
            _ => return self.blocks(node.children(), false),
        };
        Ok(vec![block])
    }

    fn paragraph<'a>(&self, node: &'a AstNode<'a>, top: bool) -> Result<Vec<Block>, ReadError> {
        if let Some(only) = node
            .first_child()
            .filter(|child| child.next_sibling().is_none())
        {
            let value = only.data.borrow();
            if let NodeValue::Math(math) = &value.value
                && math.display_math
                && math.literal.starts_with('\n')
            {
                let source = math.literal.strip_prefix('\n').unwrap_or(&math.literal);
                let source = source.strip_suffix('\n').unwrap_or(source);
                return Ok(vec![Block::new(BlockKind::Math {
                    source: source.into(),
                })]);
            }
            if let NodeValue::Image(link) = &value.value {
                let (caption, width) = self.image_description(only);
                return Ok(vec![Block::new(BlockKind::Image {
                    url: self.destination(&link.url),
                    caption,
                    width,
                })]);
            }
            if let NodeValue::Text(value) = &value.value
                && let Some((id, length)) = self.syntax.token(value)
                && length == value.len()
                && let Some(Token::Directive(d)) = self.syntax.tokens.get(id)
                && super::syntax::is_leaf(&d.name)
            {
                return match self.leaf(d) {
                    Ok(block) => Ok(vec![block]),
                    Err(err) if self.syntax.options.exact => Err(err),
                    Err(_) => Ok(vec![Block::new(BlockKind::Paragraph {
                        text: vec![text(inline::literal(d))],
                        colors: Colors::default(),
                    })]),
                };
            }
        }
        let (text, colors) = self.text(node, top)?;
        if text.is_empty() && colors.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![Block::new(BlockKind::Paragraph { text, colors })])
    }

    fn text<'a>(
        &self,
        node: &'a AstNode<'a>,
        top: bool,
    ) -> Result<(Vec<Inline>, Colors), ReadError> {
        let mut text = self.inlines(node.children(), &Style::default(), None, top, 0)?;
        let colors = self.take_attributes(
            &mut text,
            &["color", "background"],
            self.syntax.line(node.data.borrow().sourcepos.start.line),
        )?;
        self.materialize(&mut text);
        Ok((text, colors))
    }

    /// An explicit empty comment consumes the leading text slot just like a paragraph.
    fn lead<'a>(
        &self,
        node: &'a AstNode<'a>,
    ) -> Result<(Vec<Inline>, Colors, Vec<Block>), ReadError> {
        let Some(first) = node.first_child() else {
            return Ok((Vec::new(), Colors::default(), Vec::new()));
        };
        if matches!(first.data.borrow().value, NodeValue::Paragraph) {
            let (text, colors) = self.text(first, false)?;
            let children = self.blocks(node.children().skip(1), false)?;
            return Ok((text, colors, children));
        }
        if matches!(&first.data.borrow().value, NodeValue::HtmlBlock(html) if html.literal.trim().starts_with("<!--") && self.syntax.leaf_comment(&html.literal).is_none())
        {
            return Ok((
                Vec::new(),
                Colors::default(),
                self.blocks(node.children().skip(1), false)?,
            ));
        }
        Ok((
            Vec::new(),
            Colors::default(),
            self.blocks(node.children(), false)?,
        ))
    }

    pub(super) fn take_attributes(
        &self,
        items: &mut Vec<Inline>,
        allowed: &[&str],
        line: usize,
    ) -> Result<Colors, ReadError> {
        let Some(Inline::Text { text, .. }) = items.last() else {
            return Ok(Colors::default());
        };
        let Some(index) = text.rfind(&self.syntax.prefix) else {
            return Ok(Colors::default());
        };
        let Some((id, length)) = self.syntax.token(&text[index..]) else {
            return Ok(Colors::default());
        };
        if index + length != text.len() {
            return Ok(Colors::default());
        }
        let Some(Token::Attributes { attrs, .. }) = self.syntax.tokens.get(id) else {
            return Ok(Colors::default());
        };
        // The preceding space can be in the previous text run, because GFM separates tokens.
        let previous_space = index > 0 && text[..index].ends_with(' ')
            || index == 0
                && items.len() > 1
                && matches!(&items[items.len() - 2], Inline::Text { text, .. } if text.ends_with(' '));
        let whole = index == 0 && items.len() == 1;
        if !whole && !previous_space || attrs.iter().any(|a| !allowed.contains(&a.name.as_str())) {
            return Ok(Colors::default());
        }
        let colors = match values::colors(attrs, line) {
            Ok(colors) => colors,
            Err(err) if self.syntax.options.exact => return Err(err),
            Err(_) => return Ok(Colors::default()),
        };
        let remove = if index > 0 { index - 1 } else { 0 };
        if let Some(Inline::Text { text, .. }) = items.last_mut() {
            text.truncate(remove);
        }
        if index == 0 && previous_space {
            let prev = items.len() - 2;
            if let Inline::Text { text, .. } = &mut items[prev] {
                text.pop();
            }
        }
        if matches!(items.last(), Some(Inline::Text { text, .. }) if text.is_empty()) {
            items.pop();
        }
        Ok(colors)
    }

    fn container<'a>(&self, node: &'a AstNode<'a>, d: &Directive) -> Result<Block, ReadError> {
        let names: &[&str] = match d.name.as_str() {
            "paragraph" => &["color", "background"],
            "toggle" => &["heading", "color", "background"],
            "callout" => &["icon", "color", "background"],
            _ => &["header", "widths", "color"],
        };
        values::allowed(d, names)?;
        let colors = values::colors(&d.attrs, d.line)?;
        let children = self.blocks(node.children(), false)?;
        if d.name == "table" {
            if d.label.is_some() || children.len() != 1 {
                return Err(error(
                    d.line,
                    "a table container wraps exactly one pipe table and has no label",
                ));
            }
            let Some(Block {
                kind: BlockKind::Table(table),
                ..
            }) = children.into_iter().next()
            else {
                return Err(error(d.line, "a table container needs a pipe table"));
            };
            let mut table = table;
            values::one_of(d, "header", &["none", "column", "both"])?;
            if let Some(header) = values::value(&d.attrs, "header") {
                table.header_row = header == "both";
                table.header_column = header != "none";
            }
            if let Some(widths) = values::value(&d.attrs, "widths") {
                let column_count = table.column_count();
                table.widths = widths.split(',').map(|width| {
                    if width == "auto" { return Ok(None); }
                    width.parse::<u32>().ok().filter(|n| *n > 0).map(Some).ok_or_else(|| error(d.line, "table widths are positive whole pixels or `auto`, separated by commas"))
                }).collect::<Result<_, _>>()?;
                if table.widths.len() != column_count {
                    return Err(error(
                        d.line,
                        "table widths must give one width for each column",
                    ));
                }
            }
            table.color = colors.text;
            return Ok(Block::new(BlockKind::Table(table)));
        }
        let text = fragment(
            d.label.as_deref().unwrap_or(""),
            self.syntax.options,
            d.line,
            &Style::default(),
            0,
        )?;
        let kind = match d.name.as_str() {
            "paragraph" => BlockKind::Paragraph { text, colors },
            "callout" => BlockKind::Callout {
                icon: values::value(&d.attrs, "icon")
                    .unwrap_or(crate::model::DEFAULT_CALLOUT_ICON)
                    .into(),
                text,
                colors,
            },
            _ => {
                if let Some(level) = values::value(&d.attrs, "heading") {
                    let level = level
                        .parse::<u8>()
                        .ok()
                        .filter(|n| (1..=4).contains(n))
                        .ok_or_else(|| error(d.line, "toggle `heading` is `1`, `2`, `3` or `4`"))?;
                    BlockKind::Heading {
                        level,
                        toggleable: true,
                        text,
                        colors,
                    }
                } else {
                    BlockKind::Toggle { text, colors }
                }
            }
        };
        Ok(Block::with_children(kind, children))
    }

    fn leaf(&self, d: &Directive) -> Result<Block, ReadError> {
        let allowed = match d.name.as_str() {
            "page" | "database" | "canvas" => vec!["id"],
            "page-ref" => vec!["page"],
            "database-view-ref" => vec!["view", "hint"],
            "synced-block-ref" => vec!["source"],
            _ => vec!["source", "hint"],
        };
        values::allowed(d, &allowed)?;
        let kind = match d.name.as_str() {
            "page" => BlockKind::Page,
            "database" => BlockKind::Database,
            "canvas" => BlockKind::Canvas,
            "page-ref" => BlockKind::PageRef {
                page: values::required(d, "page")?.into(),
            },
            "database-view-ref" => BlockKind::DatabaseViewRef {
                view: values::required(d, "view")?.into(),
                hint: values::value(&d.attrs, "hint").unwrap_or("").into(),
            },
            "synced-block-ref" => BlockKind::SyncedBlockRef {
                source: values::required(d, "source")?.into(),
            },
            _ => BlockKind::TemplateRef {
                source: values::required(d, "source")?.into(),
                hint: values::value(&d.attrs, "hint").unwrap_or("").into(),
            },
        };
        let mut block = Block::new(kind);
        if allowed == ["id"] {
            block.id = Some(values::required(d, "id")?.into());
        }
        Ok(block)
    }

    pub(super) fn raw<'a>(&self, node: &'a AstNode<'a>) -> &str {
        let position = node.data.borrow().sourcepos;
        let Some(source) = self.lines.get(position.start.line.saturating_sub(1)) else {
            return "";
        };
        let index = self.columns.offset(node, position.start);
        source.get(index..).unwrap_or("")
    }

    fn restore(&self, source: &str) -> String {
        let mut items = vec![text(source)];
        self.materialize(&mut items);
        inline::plain(&items)
    }
}
