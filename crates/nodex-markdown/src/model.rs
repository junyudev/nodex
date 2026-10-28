//! The Block model Nodex Markdown says, and its BlockNote JSON form.
//!
//! Blocks cross every boundary as BlockNote-shaped JSON: the shape Nodex stores in its
//! documents and the editor edits. This module reads that JSON in its full or compact form and
//! writes the compact form the round-trip fixture spells: no identities but an owning shell's,
//! no props at their defaults, and no empty content or children. Reading normalizes what the
//! text cannot distinguish, so equal Blocks compare equal: adjacent runs with the same styles
//! join, a numbered item keeps a `start` only where it starts a list at a number other than
//! one, a table's cells share their column's alignment, and headings deeper than four are four.

use serde_json::{Map, Value, json};

/// The colors Nodex offers, for text and for backgrounds alike.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Color {
    Gray,
    Brown,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
}

impl Color {
    pub const ALL: [Color; 9] = [
        Color::Gray,
        Color::Brown,
        Color::Red,
        Color::Orange,
        Color::Yellow,
        Color::Green,
        Color::Blue,
        Color::Purple,
        Color::Pink,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Color::Gray => "gray",
            Color::Brown => "brown",
            Color::Red => "red",
            Color::Orange => "orange",
            Color::Yellow => "yellow",
            Color::Green => "green",
            Color::Blue => "blue",
            Color::Purple => "purple",
            Color::Pink => "pink",
        }
    }

    pub fn from_name(name: &str) -> Option<Color> {
        Color::ALL.into_iter().find(|color| color.name() == name)
    }
}

/// A Block's text color and background color.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Colors {
    pub text: Option<Color>,
    pub background: Option<Color>,
}

impl Colors {
    pub fn is_empty(&self) -> bool {
        self.text.is_none() && self.background.is_none()
    }
}

/// How a run of text is styled.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub code: bool,
    pub color: Option<Color>,
    pub background: Option<Color>,
}

impl Style {
    pub fn is_plain(&self) -> bool {
        *self == Style::default()
    }
}

/// A run of styled text inside a link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StyledText {
    pub text: String,
    pub style: Style,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DateMention {
    pub start: String,
    pub end: Option<String>,
    pub tz: Option<String>,
    pub format: Option<String>,
    pub time_format: Option<String>,
    pub reminder: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentKind {
    Text,
    File,
    Folder,
}

impl AttachmentKind {
    pub fn name(self) -> &'static str {
        match self {
            AttachmentKind::Text => "text",
            AttachmentKind::File => "file",
            AttachmentKind::Folder => "folder",
        }
    }

    pub fn from_name(name: &str) -> Option<AttachmentKind> {
        match name {
            "text" => Some(AttachmentKind::Text),
            "file" => Some(AttachmentKind::File),
            "folder" => Some(AttachmentKind::Folder),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attachment {
    pub kind: AttachmentKind,
    /// Whether the attachment links to its source rather than holding a copy of it.
    pub link: bool,
    pub source: String,
    pub name: String,
    pub mime: Option<String>,
    pub bytes: Option<u64>,
    pub origin: Option<String>,
}

/// Execution settings for the prompt an Agent config atom stands in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentConfig {
    pub mode: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub speed: Option<String>,
    /// Attributes Nodex does not know, kept as written after the known ones.
    pub unknown: Vec<(String, String)>,
}

impl AgentConfig {
    /// The settings Nodex knows, in the order they are written.
    pub const KNOWN: [&str; 5] = ["mode", "provider", "model", "reasoning", "speed"];
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InlineImage {
    pub url: String,
    pub alt: String,
    pub width: Option<u32>,
    /// The link the image opens, as a badge inside a link does.
    pub href: Option<String>,
}

/// One item of a Block's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inline {
    Text {
        text: String,
        style: Style,
    },
    Link {
        href: String,
        content: Vec<StyledText>,
    },
    PageMention {
        page: String,
    },
    /// A chat mention, naming the chat's Session.
    ChatMention {
        session: String,
    },
    DateMention(DateMention),
    Attachment(Attachment),
    AgentConfig(AgentConfig),
    Math {
        source: String,
    },
    Image(InlineImage),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

impl Align {
    pub fn name(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cell {
    pub text: Vec<Inline>,
    pub background: Option<Color>,
    pub align: Align,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Table {
    pub rows: Vec<Vec<Cell>>,
    pub header_row: bool,
    pub header_column: bool,
    /// Each column's width in pixels, `None` where it sizes itself.
    pub widths: Vec<Option<u32>>,
    pub color: Option<Color>,
}

impl Table {
    pub fn column_count(&self) -> usize {
        self.rows
            .iter()
            .map(Vec::len)
            .max()
            .unwrap_or(0)
            .max(self.widths.len())
    }
}

/// What a Block is, with its own content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph {
        text: Vec<Inline>,
        colors: Colors,
    },
    /// A heading of level one to four; a toggleable heading can hold Blocks.
    Heading {
        level: u8,
        toggleable: bool,
        text: Vec<Inline>,
        colors: Colors,
    },
    Bullet {
        text: Vec<Inline>,
        colors: Colors,
    },
    /// `start` is the number a list starts at, kept only where it is not one.
    Numbered {
        start: Option<u32>,
        text: Vec<Inline>,
        colors: Colors,
    },
    Check {
        checked: bool,
        text: Vec<Inline>,
        colors: Colors,
    },
    Toggle {
        text: Vec<Inline>,
        colors: Colors,
    },
    Quote {
        text: Vec<Inline>,
        colors: Colors,
    },
    Callout {
        icon: String,
        text: Vec<Inline>,
        colors: Colors,
    },
    /// `language` is a code language catalog id; plain text is `text`.
    Code {
        language: String,
        code: String,
    },
    Math {
        source: String,
    },
    Table(Table),
    Divider,
    Image {
        url: String,
        caption: String,
        width: Option<u32>,
    },
    Page,
    Database,
    Canvas,
    PageRef {
        page: String,
    },
    DatabaseViewRef {
        view: String,
        hint: String,
    },
    SyncedBlockRef {
        source: String,
    },
    TemplateRef {
        source: String,
        hint: String,
    },
}

/// A Block and the Blocks under it. Only an owning Page, Database or Canvas carries its
/// identity in the text; other identities pass through when given and are never read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub id: Option<String>,
    pub kind: BlockKind,
    pub children: Vec<Block>,
}

impl Block {
    pub fn new(kind: BlockKind) -> Block {
        Block {
            id: None,
            kind,
            children: Vec::new(),
        }
    }

    pub fn with_children(kind: BlockKind, children: Vec<Block>) -> Block {
        Block {
            id: None,
            kind,
            children,
        }
    }

    pub fn empty_paragraph() -> Block {
        Block::new(BlockKind::Paragraph {
            text: Vec::new(),
            colors: Colors::default(),
        })
    }

    /// The Block's own text, for Blocks that have one.
    pub fn text(&self) -> Option<&[Inline]> {
        match &self.kind {
            BlockKind::Paragraph { text, .. }
            | BlockKind::Heading { text, .. }
            | BlockKind::Bullet { text, .. }
            | BlockKind::Numbered { text, .. }
            | BlockKind::Check { text, .. }
            | BlockKind::Toggle { text, .. }
            | BlockKind::Quote { text, .. }
            | BlockKind::Callout { text, .. } => Some(text),
            _ => None,
        }
    }

    /// Whether the Block can hold Blocks, by Nodex's Block children policy.
    pub fn accepts_children(&self) -> bool {
        match &self.kind {
            BlockKind::Paragraph { .. }
            | BlockKind::Bullet { .. }
            | BlockKind::Numbered { .. }
            | BlockKind::Check { .. }
            | BlockKind::Toggle { .. }
            | BlockKind::Quote { .. }
            | BlockKind::Callout { .. } => true,
            BlockKind::Heading { toggleable, .. } => *toggleable,
            _ => false,
        }
    }

    pub fn is_list_item(&self) -> bool {
        matches!(
            self.kind,
            BlockKind::Bullet { .. } | BlockKind::Numbered { .. } | BlockKind::Check { .. }
        )
    }
}

pub const DEFAULT_CALLOUT_ICON: &str = "💡";
pub const PLAIN_CODE_LANGUAGE: &str = "text";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{path}: {message}")]
pub struct ModelError {
    pub path: String,
    pub message: String,
}

fn model_error(path: &str, message: impl Into<String>) -> ModelError {
    ModelError {
        path: path.to_owned(),
        message: message.into(),
    }
}

// --- Reading BlockNote JSON ---

/// Blocks from BlockNote JSON: an array of Blocks in their full or compact form.
pub fn blocks_from_json(value: &Value) -> Result<Vec<Block>, ModelError> {
    let items = value
        .as_array()
        .ok_or_else(|| model_error("blocks", "must be an array"))?;
    let mut blocks = items
        .iter()
        .enumerate()
        .map(|(index, item)| block_from_json(item, &format!("blocks[{index}]")))
        .collect::<Result<Vec<_>, _>>()?;
    normalize_blocks(&mut blocks);
    Ok(blocks)
}

fn block_from_json(value: &Value, path: &str) -> Result<Block, ModelError> {
    let object = value
        .as_object()
        .ok_or_else(|| model_error(path, "a Block must be an object"))?;
    let kind_name = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| model_error(path, "a Block must have a type"))?;
    let empty = Map::new();
    let props = object
        .get("props")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let id = object.get("id").and_then(Value::as_str).map(str::to_owned);
    let content = object.get("content");
    let text = || inline_from_json(content, &format!("{path}.content"));
    let colors = Colors {
        text: color_prop(props, "textColor"),
        background: color_prop(props, "backgroundColor"),
    };
    let kind = match kind_name {
        "paragraph" => BlockKind::Paragraph {
            text: text()?,
            colors,
        },
        "heading" => {
            let level = props
                .get("level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 4);
            BlockKind::Heading {
                level: level as u8,
                toggleable: bool_prop(props, "isToggleable"),
                text: text()?,
                colors,
            }
        }
        "bulletListItem" => BlockKind::Bullet {
            text: text()?,
            colors,
        },
        "numberedListItem" => BlockKind::Numbered {
            start: props
                .get("start")
                .and_then(Value::as_u64)
                .map(|start| start as u32),
            text: text()?,
            colors,
        },
        "checkListItem" => BlockKind::Check {
            checked: bool_prop(props, "checked"),
            text: text()?,
            colors,
        },
        "toggleListItem" => BlockKind::Toggle {
            text: text()?,
            colors,
        },
        "quote" => BlockKind::Quote {
            text: text()?,
            colors,
        },
        "callout" => BlockKind::Callout {
            icon: string_prop(props, "icon")
                .filter(|icon| !icon.is_empty())
                .unwrap_or(DEFAULT_CALLOUT_ICON)
                .to_owned(),
            text: text()?,
            colors,
        },
        // A stored alias or label, such as `ts`, names its catalog language.
        "codeBlock" => BlockKind::Code {
            language: crate::code_languages::language_id(
                string_prop(props, "language")
                    .filter(|language| !language.is_empty())
                    .unwrap_or(PLAIN_CODE_LANGUAGE),
            )
            .to_owned(),
            code: plain_content(content),
        },
        "mathBlock" => BlockKind::Math {
            source: plain_content(content),
        },
        "table" => BlockKind::Table(table_from_json(content, props, &format!("{path}.content"))?),
        "divider" => BlockKind::Divider,
        "image" => BlockKind::Image {
            url: string_prop(props, "url").unwrap_or("").trim().to_owned(),
            caption: string_prop(props, "caption").unwrap_or("").to_owned(),
            width: positive_prop(props, "previewWidth"),
        },
        "page" | "database" | "canvas" => {
            if id.as_deref().is_none_or(str::is_empty) {
                return Err(model_error(
                    path,
                    format!("an owning {kind_name} needs its id"),
                ));
            }
            match kind_name {
                "page" => BlockKind::Page,
                "database" => BlockKind::Database,
                _ => BlockKind::Canvas,
            }
        }
        "pageRef" => BlockKind::PageRef {
            page: owned_prop(props, "targetBlockId"),
        },
        "databaseViewRef" => BlockKind::DatabaseViewRef {
            view: owned_prop(props, "databaseViewId"),
            hint: owned_prop(props, "displayHint"),
        },
        "syncedBlockRef" => BlockKind::SyncedBlockRef {
            source: owned_prop(props, "sourceBlockId"),
        },
        "templateRef" => BlockKind::TemplateRef {
            source: owned_prop(props, "sourceBlockId"),
            hint: owned_prop(props, "displayHint"),
        },
        other => return Err(model_error(path, format!("unknown Block type `{other}`"))),
    };
    let children = match object.get("children").and_then(Value::as_array) {
        Some(children) => children
            .iter()
            .enumerate()
            .map(|(index, child)| block_from_json(child, &format!("{path}.children[{index}]")))
            .collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    Ok(Block { id, kind, children })
}

/// Inline content from its BlockNote JSON, normalized like a Block's text.
pub fn inline_content_from_json(value: &Value) -> Result<Vec<Inline>, ModelError> {
    let mut items = inline_from_json(Some(value), "inline")?;
    normalize_inline(&mut items);
    Ok(items)
}

/// The compact BlockNote JSON of inline content.
pub fn inline_content_to_json(items: &[Inline]) -> Value {
    Value::Array(items.iter().map(inline_item_to_json).collect())
}

fn inline_from_json(content: Option<&Value>, path: &str) -> Result<Vec<Inline>, ModelError> {
    let items = match content {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::String(text)) => {
            return Ok(vec![Inline::Text {
                text: text.clone(),
                style: Style::default(),
            }]);
        }
        Some(Value::Array(items)) => items,
        Some(_) => return Err(model_error(path, "inline content must be an array")),
    };
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let item_path = format!("{path}[{index}]");
        let object = item
            .as_object()
            .ok_or_else(|| model_error(&item_path, "must be an object"))?;
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("text");
        let empty = Map::new();
        let props = object
            .get("props")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let inline = match kind {
            "text" => Inline::Text {
                text: object
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                style: style_from_json(object.get("styles")),
            },
            "link" => Inline::Link {
                href: object
                    .get("href")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                content: link_content_from_json(object.get("content")),
            },
            "pageMention" => Inline::PageMention {
                page: owned_prop(props, "targetPageId"),
            },
            "threadMention" => Inline::ChatMention {
                session: owned_prop(props, "uuid"),
            },
            "dateMention" => Inline::DateMention(DateMention {
                start: owned_prop(props, "start"),
                end: optional_prop(props, "end"),
                tz: optional_prop(props, "tz"),
                format: optional_prop(props, "format"),
                time_format: optional_prop(props, "timeFormat"),
                reminder: optional_prop(props, "reminder"),
            }),
            "attachment" => Inline::Attachment(Attachment {
                kind: string_prop(props, "kind")
                    .and_then(AttachmentKind::from_name)
                    .unwrap_or(AttachmentKind::Text),
                link: string_prop(props, "mode") == Some("link"),
                source: owned_prop(props, "source"),
                name: owned_prop(props, "name"),
                mime: optional_prop(props, "mimeType"),
                bytes: props.get("bytes").and_then(Value::as_u64),
                origin: optional_prop(props, "origin"),
            }),
            "agentConfig" => Inline::AgentConfig(agent_config_from_json(props)),
            "math" => Inline::Math {
                source: match object.get("content") {
                    Some(Value::String(source)) => source.clone(),
                    other => plain_content(other),
                },
            },
            "inlineImage" => Inline::Image(InlineImage {
                url: owned_prop(props, "url"),
                alt: owned_prop(props, "alt"),
                width: positive_prop(props, "width"),
                href: optional_prop(props, "href"),
            }),
            other => {
                return Err(model_error(
                    &item_path,
                    format!("unknown inline type `{other}`"),
                ));
            }
        };
        out.push(inline);
    }
    Ok(out)
}

fn link_content_from_json(content: Option<&Value>) -> Vec<StyledText> {
    match content {
        Some(Value::String(text)) => vec![StyledText {
            text: text.clone(),
            style: Style::default(),
        }],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .map(|item| StyledText {
                text: item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                style: style_from_json(item.get("styles")),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Unknown attributes travel in `rawAttributes` as written, `name="value"` separated by spaces.
fn agent_config_from_json(props: &Map<String, Value>) -> AgentConfig {
    let mut config = AgentConfig {
        mode: optional_prop(props, "mode"),
        provider: optional_prop(props, "provider"),
        model: optional_prop(props, "model"),
        reasoning: optional_prop(props, "reasoning"),
        speed: optional_prop(props, "speed"),
        unknown: Vec::new(),
    };
    // Raw text stored by earlier versions can repeat the known settings, which the props own.
    if let Some(raw) = string_prop(props, "rawAttributes") {
        config.unknown = crate::attributes::parse_attribute_pairs(raw)
            .into_iter()
            .filter(|(name, _)| !AgentConfig::KNOWN.contains(&name.as_str()))
            .collect();
    }
    config
}

fn style_from_json(value: Option<&Value>) -> Style {
    let Some(styles) = value.and_then(Value::as_object) else {
        return Style::default();
    };
    let flag = |key: &str| styles.get(key).and_then(Value::as_bool).unwrap_or(false);
    Style {
        bold: flag("bold"),
        italic: flag("italic"),
        underline: flag("underline"),
        strike: flag("strike"),
        code: flag("code"),
        color: styles
            .get("textColor")
            .and_then(Value::as_str)
            .and_then(Color::from_name),
        background: styles
            .get("backgroundColor")
            .and_then(Value::as_str)
            .and_then(Color::from_name),
    }
}

fn table_from_json(
    content: Option<&Value>,
    props: &Map<String, Value>,
    path: &str,
) -> Result<Table, ModelError> {
    let empty = Map::new();
    let object = content.and_then(Value::as_object).unwrap_or(&empty);
    let rows_json = object
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut rows = Vec::with_capacity(rows_json.len());
    for (row_index, row) in rows_json.iter().enumerate() {
        let cells_json = row
            .get("cells")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut cells = Vec::with_capacity(cells_json.len());
        for (cell_index, cell) in cells_json.iter().enumerate() {
            let cell_path = format!("{path}.rows[{row_index}].cells[{cell_index}]");
            let (cell_props, cell_content) = match cell {
                Value::Array(_) => (&empty, Some(cell)),
                Value::Object(object) => (
                    object
                        .get("props")
                        .and_then(Value::as_object)
                        .unwrap_or(&empty),
                    object.get("content"),
                ),
                _ => return Err(model_error(&cell_path, "a cell must be an object")),
            };
            cells.push(Cell {
                text: inline_from_json(cell_content, &format!("{cell_path}.content"))?,
                background: color_prop(cell_props, "backgroundColor"),
                align: match string_prop(cell_props, "textAlignment") {
                    Some("center") => Align::Center,
                    Some("right") => Align::Right,
                    _ => Align::Left,
                },
            });
        }
        rows.push(cells);
    }
    let widths = object
        .get("columnWidths")
        .and_then(Value::as_array)
        .map(|widths| {
            widths
                .iter()
                .map(|width| {
                    width
                        .as_f64()
                        .filter(|width| *width > 0.0)
                        .map(|width| width as u32)
                })
                .collect()
        })
        .unwrap_or_default();
    let header_count = |key: &str| object.get(key).and_then(Value::as_u64).unwrap_or(0) > 0;
    Ok(Table {
        rows,
        header_row: header_count("headerRows"),
        header_column: header_count("headerCols"),
        widths,
        color: color_prop(props, "textColor"),
    })
}

fn plain_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

fn string_prop<'a>(props: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    props.get(key).and_then(Value::as_str)
}

fn owned_prop(props: &Map<String, Value>, key: &str) -> String {
    string_prop(props, key).unwrap_or("").to_owned()
}

fn optional_prop(props: &Map<String, Value>, key: &str) -> Option<String> {
    string_prop(props, key)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn bool_prop(props: &Map<String, Value>, key: &str) -> bool {
    props.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn positive_prop(props: &Map<String, Value>, key: &str) -> Option<u32> {
    props
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .map(|value| value as u32)
}

fn color_prop(props: &Map<String, Value>, key: &str) -> Option<Color> {
    string_prop(props, key).and_then(Color::from_name)
}

// --- Normalization ---

/// Normalizes what the text cannot distinguish, so equal Blocks compare equal.
pub fn normalize_blocks(blocks: &mut [Block]) {
    let mut previous_numbered = false;
    for block in blocks.iter_mut() {
        if let BlockKind::Numbered { start, .. } = &mut block.kind {
            if previous_numbered || *start == Some(1) || *start == Some(0) {
                *start = None;
            }
            previous_numbered = true;
        } else {
            previous_numbered = false;
        }
        match &mut block.kind {
            BlockKind::Paragraph { text, .. }
            | BlockKind::Heading { text, .. }
            | BlockKind::Bullet { text, .. }
            | BlockKind::Numbered { text, .. }
            | BlockKind::Check { text, .. }
            | BlockKind::Toggle { text, .. }
            | BlockKind::Quote { text, .. }
            | BlockKind::Callout { text, .. } => normalize_inline(text),
            BlockKind::Table(table) => normalize_table(table),
            _ => {}
        }
        normalize_blocks(&mut block.children);
    }
}

/// Joins adjacent runs and links that read the same and drops empty runs. A line break carries
/// no style: it joins the runs of one style, or the links to one destination, on either side of
/// it, and is plain text anywhere else, so no styled run or link begins or ends with one.
pub fn normalize_inline(items: &mut Vec<Inline>) {
    enum Token {
        Text(String, Style),
        Break(String),
        Link(String, Vec<StyledText>),
        Other(Inline),
    }
    let mut tokens = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        match item {
            Inline::Text { text, style } => {
                for (piece, is_break) in split_breaks(&text) {
                    match tokens.last_mut() {
                        // Breaks from neighbouring runs, such as a newline and a `<br>`, are one.
                        Some(Token::Break(breaks)) if is_break => breaks.push_str(&piece),
                        _ if is_break => tokens.push(Token::Break(piece)),
                        _ => tokens.push(Token::Text(piece, style.clone())),
                    }
                }
            }
            Inline::Link { href, content } => {
                let mut runs = normalize_runs(content);
                let leading = take_edge_breaks(&mut runs, true);
                let trailing = take_edge_breaks(&mut runs, false);
                if !leading.is_empty() {
                    match tokens.last_mut() {
                        Some(Token::Break(breaks)) => breaks.push_str(&leading),
                        _ => tokens.push(Token::Break(leading)),
                    }
                }
                if !runs.is_empty() {
                    tokens.push(Token::Link(href, runs));
                }
                if !trailing.is_empty() {
                    tokens.push(Token::Break(trailing));
                }
            }
            other => tokens.push(Token::Other(other)),
        }
    }
    let mut out: Vec<Inline> = Vec::with_capacity(tokens.len());
    let mut tokens = tokens.into_iter().peekable();
    while let Some(token) = tokens.next() {
        match token {
            Token::Text(text, style) => push_text(&mut out, text, style),
            Token::Break(breaks) => match (out.last_mut(), tokens.peek()) {
                (Some(Inline::Text { text, style }), Some(Token::Text(_, next)))
                    if !style.is_plain() && style == next =>
                {
                    text.push_str(&breaks);
                }
                (Some(Inline::Link { href, content }), Some(Token::Link(next_href, next)))
                    if href == next_href =>
                {
                    let style = next
                        .first()
                        .map(|run| run.style.clone())
                        .unwrap_or_default();
                    push_run(content, breaks, style);
                }
                _ => push_text(&mut out, breaks, Style::default()),
            },
            Token::Link(href, runs) => match out.last_mut() {
                Some(Inline::Link {
                    href: previous_href,
                    content,
                }) if *previous_href == href => {
                    for run in runs {
                        push_run(content, run.text, run.style);
                    }
                }
                _ => out.push(Inline::Link {
                    href,
                    content: runs,
                }),
            },
            Token::Other(other) => out.push(other),
        }
    }
    *items = out;
}

/// A link's runs follow the same rule: a break between runs of one style joins them.
fn normalize_runs(runs: Vec<StyledText>) -> Vec<StyledText> {
    let mut pieces: Vec<(String, Option<Style>)> = Vec::new();
    for run in runs {
        for (piece, is_break) in split_breaks(&run.text) {
            match pieces.last_mut() {
                Some((breaks, None)) if is_break => breaks.push_str(&piece),
                _ => pieces.push((piece, (!is_break).then(|| run.style.clone()))),
            }
        }
    }
    let mut out: Vec<StyledText> = Vec::with_capacity(pieces.len());
    let mut pieces = pieces.into_iter().peekable();
    while let Some((text, style)) = pieces.next() {
        let style = match style {
            Some(style) => style,
            None => match (out.last(), pieces.peek()) {
                (Some(previous), Some((_, Some(next))))
                    if !previous.style.is_plain() && previous.style == *next =>
                {
                    previous.style.clone()
                }
                _ => Style::default(),
            },
        };
        push_run(&mut out, text, style);
    }
    out
}

/// A run's text and line breaks, in order.
fn split_breaks(text: &str) -> Vec<(String, bool)> {
    let mut pieces: Vec<(String, bool)> = Vec::new();
    for character in text.chars() {
        let is_break = character == '\n';
        match pieces.last_mut() {
            Some((piece, kind)) if *kind == is_break => piece.push(character),
            _ => pieces.push((character.to_string(), is_break)),
        }
    }
    pieces
}

/// Takes the line breaks at the start or end of a link's text out of it.
fn take_edge_breaks(runs: &mut Vec<StyledText>, leading: bool) -> String {
    let mut breaks = String::new();
    while let Some(run) = if leading {
        runs.first_mut()
    } else {
        runs.last_mut()
    } {
        let kept = if leading {
            run.text.trim_start_matches('\n')
        } else {
            run.text.trim_end_matches('\n')
        };
        let taken = run.text.len() - kept.len();
        breaks.push_str(&"\n".repeat(taken));
        if kept.is_empty() {
            if leading {
                runs.remove(0);
            } else {
                runs.pop();
            }
            continue;
        }
        run.text = kept.to_owned();
        break;
    }
    breaks
}

fn push_text(out: &mut Vec<Inline>, text: String, style: Style) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(Inline::Text {
            text: previous,
            style: previous_style,
        }) if *previous_style == style => previous.push_str(&text),
        _ => out.push(Inline::Text { text, style }),
    }
}

fn push_run(runs: &mut Vec<StyledText>, text: String, style: Style) {
    if text.is_empty() {
        return;
    }
    match runs.last_mut() {
        Some(previous) if previous.style == style => previous.text.push_str(&text),
        _ => runs.push(StyledText { text, style }),
    }
}

/// A column's cells share its alignment: the alignment of the column's first cell.
fn normalize_table(table: &mut Table) {
    for row in &mut table.rows {
        for cell in row.iter_mut() {
            normalize_inline(&mut cell.text);
        }
    }
    let columns = table.column_count();
    for column in 0..columns {
        let align = table
            .rows
            .iter()
            .find_map(|row| row.get(column))
            .map(|cell| cell.align);
        if let Some(align) = align {
            for row in &mut table.rows {
                if let Some(cell) = row.get_mut(column) {
                    cell.align = align;
                }
            }
        }
    }
    if table.widths.iter().all(Option::is_none) {
        table.widths.clear();
    }
    // When every row is a header row, every cell is a header: no header column is left to state.
    if table.header_row && table.rows.len() <= 1 {
        table.header_column = false;
    }
}

// --- Writing BlockNote JSON ---

/// The compact BlockNote JSON of Blocks.
pub fn blocks_to_json(blocks: &[Block]) -> Value {
    Value::Array(blocks.iter().map(block_to_json).collect())
}

fn block_to_json(block: &Block) -> Value {
    let mut object = Map::new();
    if let Some(id) = &block.id {
        object.insert("id".into(), json!(id));
    }
    let mut props = Map::new();
    let put_colors = |props: &mut Map<String, Value>, colors: &Colors| {
        if let Some(color) = colors.text {
            props.insert("textColor".into(), json!(color.name()));
        }
        if let Some(color) = colors.background {
            props.insert("backgroundColor".into(), json!(color.name()));
        }
    };
    let (kind, content): (&str, Option<Value>) = match &block.kind {
        BlockKind::Paragraph { text, colors } => {
            put_colors(&mut props, colors);
            ("paragraph", inline_to_json(text))
        }
        BlockKind::Heading {
            level,
            toggleable,
            text,
            colors,
        } => {
            if *level != 1 {
                props.insert("level".into(), json!(level));
            }
            if *toggleable {
                props.insert("isToggleable".into(), json!(true));
            }
            put_colors(&mut props, colors);
            ("heading", inline_to_json(text))
        }
        BlockKind::Bullet { text, colors } => {
            put_colors(&mut props, colors);
            ("bulletListItem", inline_to_json(text))
        }
        BlockKind::Numbered {
            start,
            text,
            colors,
        } => {
            if let Some(start) = start {
                props.insert("start".into(), json!(start));
            }
            put_colors(&mut props, colors);
            ("numberedListItem", inline_to_json(text))
        }
        BlockKind::Check {
            checked,
            text,
            colors,
        } => {
            if *checked {
                props.insert("checked".into(), json!(true));
            }
            put_colors(&mut props, colors);
            ("checkListItem", inline_to_json(text))
        }
        BlockKind::Toggle { text, colors } => {
            put_colors(&mut props, colors);
            ("toggleListItem", inline_to_json(text))
        }
        BlockKind::Quote { text, colors } => {
            put_colors(&mut props, colors);
            ("quote", inline_to_json(text))
        }
        BlockKind::Callout { icon, text, colors } => {
            if icon != DEFAULT_CALLOUT_ICON {
                props.insert("icon".into(), json!(icon));
            }
            put_colors(&mut props, colors);
            ("callout", inline_to_json(text))
        }
        BlockKind::Code { language, code } => {
            if language != PLAIN_CODE_LANGUAGE {
                props.insert("language".into(), json!(language));
            }
            ("codeBlock", plain_to_json(code))
        }
        BlockKind::Math { source } => ("mathBlock", plain_to_json(source)),
        BlockKind::Table(table) => {
            if let Some(color) = table.color {
                props.insert("textColor".into(), json!(color.name()));
            }
            ("table", Some(table_to_json(table)))
        }
        BlockKind::Divider => ("divider", None),
        BlockKind::Image {
            url,
            caption,
            width,
        } => {
            if !url.is_empty() {
                props.insert("url".into(), json!(url));
            }
            if !caption.is_empty() {
                props.insert("caption".into(), json!(caption));
            }
            if let Some(width) = width {
                props.insert("previewWidth".into(), json!(width));
            }
            ("image", None)
        }
        BlockKind::Page => ("page", None),
        BlockKind::Database => ("database", None),
        BlockKind::Canvas => ("canvas", None),
        BlockKind::PageRef { page } => {
            props.insert("targetBlockId".into(), json!(page));
            ("pageRef", None)
        }
        BlockKind::DatabaseViewRef { view, hint } => {
            props.insert("databaseViewId".into(), json!(view));
            if !hint.is_empty() {
                props.insert("displayHint".into(), json!(hint));
            }
            ("databaseViewRef", None)
        }
        BlockKind::SyncedBlockRef { source } => {
            props.insert("sourceBlockId".into(), json!(source));
            ("syncedBlockRef", None)
        }
        BlockKind::TemplateRef { source, hint } => {
            props.insert("sourceBlockId".into(), json!(source));
            if !hint.is_empty() {
                props.insert("displayHint".into(), json!(hint));
            }
            ("templateRef", None)
        }
    };
    object.insert("type".into(), json!(kind));
    if !props.is_empty() {
        object.insert("props".into(), Value::Object(props));
    }
    if let Some(content) = content {
        object.insert("content".into(), content);
    }
    if !block.children.is_empty() {
        object.insert("children".into(), blocks_to_json(&block.children));
    }
    Value::Object(object)
}

fn inline_to_json(items: &[Inline]) -> Option<Value> {
    if items.is_empty() {
        return None;
    }
    Some(Value::Array(
        items.iter().map(inline_item_to_json).collect(),
    ))
}

/// The content of every inline item, including empty content, as a table cell spells it.
fn cell_inline_to_json(items: &[Inline]) -> Value {
    Value::Array(items.iter().map(inline_item_to_json).collect())
}

fn inline_item_to_json(item: &Inline) -> Value {
    let custom = |kind: &str, props: Map<String, Value>| {
        let mut object = Map::new();
        object.insert("type".into(), json!(kind));
        if !props.is_empty() {
            object.insert("props".into(), Value::Object(props));
        }
        Value::Object(object)
    };
    match item {
        Inline::Text { text, style } => text_to_json(text, style),
        Inline::Link { href, content } => json!({
            "type": "link",
            "href": href,
            "content": content.iter().map(|run| text_to_json(&run.text, &run.style)).collect::<Vec<_>>(),
        }),
        Inline::PageMention { page } => custom(
            "pageMention",
            Map::from_iter([("targetPageId".into(), json!(page))]),
        ),
        Inline::ChatMention { session } => custom(
            "threadMention",
            Map::from_iter([("uuid".into(), json!(session))]),
        ),
        Inline::DateMention(date) => {
            let mut props = Map::new();
            props.insert("start".into(), json!(date.start));
            for (key, value) in [
                ("end", &date.end),
                ("tz", &date.tz),
                ("format", &date.format),
                ("timeFormat", &date.time_format),
                ("reminder", &date.reminder),
            ] {
                if let Some(value) = value {
                    props.insert(key.into(), json!(value));
                }
            }
            custom("dateMention", props)
        }
        Inline::Attachment(attachment) => {
            let mut props = Map::new();
            if attachment.kind != AttachmentKind::Text {
                props.insert("kind".into(), json!(attachment.kind.name()));
            }
            if attachment.link {
                props.insert("mode".into(), json!("link"));
            }
            props.insert("source".into(), json!(attachment.source));
            props.insert("name".into(), json!(attachment.name));
            if let Some(mime) = &attachment.mime {
                props.insert("mimeType".into(), json!(mime));
            }
            if let Some(bytes) = attachment.bytes {
                props.insert("bytes".into(), json!(bytes));
            }
            if let Some(origin) = &attachment.origin {
                props.insert("origin".into(), json!(origin));
            }
            custom("attachment", props)
        }
        Inline::AgentConfig(config) => {
            let mut props = Map::new();
            for (key, value) in [
                ("mode", &config.mode),
                ("provider", &config.provider),
                ("model", &config.model),
                ("reasoning", &config.reasoning),
                ("speed", &config.speed),
            ] {
                if let Some(value) = value {
                    props.insert(key.into(), json!(value));
                }
            }
            if !config.unknown.is_empty() {
                let names: Vec<&str> = config
                    .unknown
                    .iter()
                    .map(|(name, _)| name.as_str())
                    .collect();
                props.insert("unknownAttributes".into(), json!(names.join(",")));
                props.insert(
                    "rawAttributes".into(),
                    json!(crate::attributes::write_attribute_pairs(&config.unknown)),
                );
            }
            custom("agentConfig", props)
        }
        Inline::Math { source } => json!({ "type": "math", "content": source }),
        Inline::Image(image) => {
            let mut props = Map::new();
            props.insert("url".into(), json!(image.url));
            if !image.alt.is_empty() {
                props.insert("alt".into(), json!(image.alt));
            }
            if let Some(width) = image.width {
                props.insert("width".into(), json!(width));
            }
            if let Some(href) = &image.href {
                props.insert("href".into(), json!(href));
            }
            custom("inlineImage", props)
        }
    }
}

fn text_to_json(text: &str, style: &Style) -> Value {
    let mut object = Map::new();
    object.insert("type".into(), json!("text"));
    object.insert("text".into(), json!(text));
    let mut styles = Map::new();
    for (key, on) in [
        ("bold", style.bold),
        ("italic", style.italic),
        ("underline", style.underline),
        ("strike", style.strike),
        ("code", style.code),
    ] {
        if on {
            styles.insert(key.into(), json!(true));
        }
    }
    if let Some(color) = style.color {
        styles.insert("textColor".into(), json!(color.name()));
    }
    if let Some(color) = style.background {
        styles.insert("backgroundColor".into(), json!(color.name()));
    }
    if !styles.is_empty() {
        object.insert("styles".into(), Value::Object(styles));
    }
    Value::Object(object)
}

fn plain_to_json(text: &str) -> Option<Value> {
    (!text.is_empty()).then(|| json!([{ "type": "text", "text": text }]))
}

fn table_to_json(table: &Table) -> Value {
    let mut object = Map::new();
    object.insert("type".into(), json!("tableContent"));
    if table.widths.iter().any(Option::is_some) {
        object.insert(
            "columnWidths".into(),
            Value::Array(table.widths.iter().map(|width| json!(width)).collect()),
        );
    }
    if table.header_row {
        object.insert("headerRows".into(), json!(1));
    }
    if table.header_column {
        object.insert("headerCols".into(), json!(1));
    }
    let rows = table
        .rows
        .iter()
        .map(|row| {
            let cells = row
                .iter()
                .map(|cell| {
                    let mut props = Map::new();
                    if let Some(color) = cell.background {
                        props.insert("backgroundColor".into(), json!(color.name()));
                    }
                    if cell.align != Align::Left {
                        props.insert("textAlignment".into(), json!(cell.align.name()));
                    }
                    let mut cell_object = Map::new();
                    if !props.is_empty() {
                        cell_object.insert("props".into(), Value::Object(props));
                    }
                    cell_object.insert("content".into(), cell_inline_to_json(&cell.text));
                    Value::Object(cell_object)
                })
                .collect::<Vec<_>>();
            json!({ "cells": cells })
        })
        .collect::<Vec<_>>();
    object.insert("rows".into(), Value::Array(rows));
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_raw_attributes_never_repeat_a_known_setting() {
        let blocks = blocks_from_json(&json!([{"type":"paragraph","content":[{
            "type":"agentConfig",
            "props":{"mode":"plan","rawAttributes":"mode=\"plan\" model=\"old\" extra=\"kept\""}
        }]}]))
        .unwrap();
        let text = crate::write(&blocks);
        assert_eq!(text, ":agent-config{mode=\"plan\" extra=\"kept\"}");
        assert_eq!(crate::read(&text, crate::ReadOptions::EXACT), Ok(blocks));
    }

    /// Stored forms the editor and earlier writers produce, which differ from their canonical
    /// form only where Markdown cannot say a difference, read back as the same Blocks.
    #[test]
    fn stored_forms_round_trip_through_their_exact_text() {
        let t = |text: &str, styles: Value| json!({"type": "text", "text": text, "styles": styles});
        let bold = json!({"bold": true});
        let cases = [
            // A line break carries no style: at a styled run's or a link's edge, and between
            // runs of one style.
            json!([{"type": "paragraph", "content": [t("one.\n", bold.clone()), t("two", json!({}))]}]),
            json!([{"type": "paragraph", "content": [t("x()\n", json!({"code": true})), t("next", json!({}))]}]),
            json!([{"type": "paragraph", "content": [t("one\n", bold.clone()), t("two", json!({"italic": true}))]}]),
            json!([{"type": "paragraph", "content": [t("end\n", bold.clone())]}]),
            json!([{"type": "quote", "content": [t("one；\ntwo；\nthree。", bold.clone())]}]),
            json!([{"type": "numberedListItem", "content": [
                {"type": "link", "href": "https://example.com/1", "content": [t("PR #12\n", json!({}))]},
                {"type": "link", "href": "https://example.com/2", "content": [t("next", json!({}))]}
            ]}]),
            json!([{"type": "paragraph", "content": [t("a = b\n\nc = d", json!({"code": true}))]}]),
            // A destination is literal, including braces in a templated URL.
            json!([{"type": "paragraph", "content": [{"type": "link", "href": "https://example.com/build-${name}-1.png", "content": [t("image", json!({}))]}]}]),
            json!([{"type": "image", "props": {"url": "https://example.com/build-${name}-1.png"}}]),
            // A code language alias names its catalog language.
            json!([{"type": "codeBlock", "props": {"language": "ts"}, "content": [t("let a = 1;", json!({}))]}]),
            // Emphasis cannot end at whitespace of any kind, including a no-break space.
            json!([{"type": "paragraph", "content": [t("a ", json!({})), t("b (c)\u{a0}", bold.clone()), t("d", json!({}))]}]),
            json!([{"type": "paragraph", "content": [t("a ", json!({})), t("b (c)\u{a0}", bold.clone()), t("d", json!({}))],
                "children": [{"type": "paragraph", "content": [t("child", json!({}))]}]}]),
            json!([{"type": "paragraph", "content": [t("a ", json!({})), t("b\u{a0}", json!({"strike": true})), t("d", json!({}))]}]),
            json!([{"type": "paragraph", "content": [t("a", json!({})), t("\u{3000}b", json!({"italic": true})), t("d", json!({}))]}]),
        ];
        for case in cases {
            let blocks = blocks_from_json(&case).unwrap();
            let text = crate::write(&blocks);
            assert_eq!(
                crate::read(&text, crate::ReadOptions::EXACT),
                Ok(blocks),
                "{text:?}"
            );
        }
    }

    #[test]
    fn a_table_of_only_its_header_row_is_a_plain_pipe_table() {
        // Header cells alone cannot say whether such a table also has a header column.
        let blocks = blocks_from_json(&json!([{"type":"table","content":{
            "type":"tableContent","headerRows":1,"headerCols":2,
            "rows":[{"cells":[[{"type":"text","text":"A"}],[{"type":"text","text":"B"}]]}]
        }}]))
        .unwrap();
        let text = crate::write(&blocks);
        assert_eq!(text, "| A | B |\n| --- | --- |");
        assert_eq!(crate::read(&text, crate::ReadOptions::EXACT), Ok(blocks));
    }
}
