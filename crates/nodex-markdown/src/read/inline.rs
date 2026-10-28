//! Inline conversion keeps code, math and escaped punctuation outside extension parsing.

use super::{
    blocks::Reader,
    error, parser_options,
    syntax::{Directive, Syntax, Token},
    values,
};
use crate::{Inline, InlineImage, LineBreaks, ReadError, Style, StyledText};
use comrak::{
    Arena,
    nodes::{AstNode, NodeValue},
    parse_document,
};

pub(super) fn text(value: impl Into<String>) -> Inline {
    Inline::Text {
        text: value.into(),
        style: Style::default(),
    }
}

fn push(out: &mut Vec<Inline>, value: &str, style: &Style, href: Option<&str>) {
    for (i, line) in value.split('\n').enumerate() {
        if i > 0 {
            out.push(text("\n"));
        }
        if line.is_empty() {
            continue;
        }
        let item = if let Some(href) = href {
            Inline::Link {
                href: href.into(),
                content: vec![StyledText {
                    text: line.into(),
                    style: style.clone(),
                }],
            }
        } else {
            Inline::Text {
                text: line.into(),
                style: style.clone(),
            }
        };
        out.push(item);
    }
}

struct Reading {
    indentation: bool,
    started: usize,
    skipping_span: bool,
}

impl Reader<'_> {
    pub(super) fn inlines<'a>(
        &self,
        nodes: impl Iterator<Item = &'a AstNode<'a>>,
        style: &Style,
        href: Option<&str>,
        indentation: bool,
        depth: usize,
    ) -> Result<Vec<Inline>, ReadError> {
        let mut reading = Reading {
            indentation,
            started: 0,
            skipping_span: false,
        };
        self.inline_run(nodes, style, href, depth, &mut reading)
    }

    fn inline_run<'a>(
        &self,
        nodes: impl Iterator<Item = &'a AstNode<'a>>,
        style: &Style,
        href: Option<&str>,
        depth: usize,
        reading: &mut Reading,
    ) -> Result<Vec<Inline>, ReadError> {
        if depth > 128 {
            return Err(error(
                1,
                "inline content nests too deeply; use fewer than 128 levels",
            ));
        }
        let mut out = Vec::new();
        let mut current = style.clone();
        let mut html_styles: Vec<(usize, Option<usize>, Style)> = Vec::new();
        let mut html_tops: [Option<usize>; 8] = [None; 8];
        for node in nodes {
            let data = node.data.borrow();
            let line = self.syntax.line(data.sourcepos.start.line);
            if !reading.skipping_span
                && reading.indentation
                && self.syntax.options.line_breaks == LineBreaks::Comment
                && data.sourcepos.start.line > reading.started
            {
                let source = self
                    .lines
                    .get(data.sourcepos.start.line.saturating_sub(1))
                    .copied()
                    .unwrap_or("");
                push(
                    &mut out,
                    &source[..source.len() - source.trim_start_matches([' ', '\t']).len()],
                    &current,
                    href,
                );
            }
            let container = matches!(
                data.value,
                NodeValue::Strong | NodeValue::Emph | NodeValue::Strikethrough | NodeValue::Link(_)
            );
            reading.started = reading.started.max(if container {
                data.sourcepos.start.line
            } else {
                data.sourcepos.end.line
            });
            match &data.value {
                NodeValue::Text(value) => {
                    let mut rest = value.as_ref();
                    while let Some(index) = rest.find(&self.syntax.prefix) {
                        if !reading.skipping_span {
                            push(&mut out, &rest[..index], &current, href);
                        }
                        let Some((id, length)) = self.syntax.token(&rest[index..]) else {
                            push(&mut out, &rest[index..], &current, href);
                            rest = "";
                            break;
                        };
                        if reading.skipping_span {
                            if matches!(self.syntax.tokens.get(id), Some(Token::SpanEnd)) {
                                reading.skipping_span = false;
                            }
                            rest = &rest[index + length..];
                            continue;
                        }
                        match self.syntax.tokens.get(id) {
                            Some(Token::Literal(literal)) => {
                                push(&mut out, literal, &current, href)
                            }
                            Some(Token::Math { source, .. }) => out.push(Inline::Math {
                                source: source.clone(),
                            }),
                            Some(Token::Directive(d)) => {
                                match self.atom(d, &current, depth + 1) {
                                    Ok(items) => out.extend(with_href(items, href)),
                                    Err(err) if self.syntax.options.exact => return Err(err),
                                    Err(_) => push(&mut out, &literal(d), &current, href),
                                }
                                if d.name == "span" {
                                    reading.skipping_span = true;
                                }
                            }
                            _ => push(&mut out, &rest[index..index + length], &current, href),
                        }
                        rest = &rest[index + length..];
                    }
                    if !reading.skipping_span {
                        push(&mut out, rest, &current, href);
                    }
                }
                _ if reading.skipping_span => {
                    out.extend(self.inline_run(
                        node.children(),
                        &current,
                        href,
                        depth + 1,
                        reading,
                    )?);
                }
                NodeValue::SoftBreak => push(
                    &mut out,
                    if self.syntax.options.line_breaks == LineBreaks::Document {
                        " "
                    } else {
                        "\n"
                    },
                    &Style::default(),
                    href,
                ),
                NodeValue::LineBreak => out.push(text("\n")),
                NodeValue::Emph | NodeValue::Strong | NodeValue::Strikethrough => {
                    let mut style = current.clone();
                    match data.value {
                        NodeValue::Emph => style.italic = true,
                        NodeValue::Strong => style.bold = true,
                        _ => style.strike = true,
                    }
                    out.extend(self.inline_run(
                        node.children(),
                        &style,
                        href,
                        depth + 1,
                        reading,
                    )?);
                }
                NodeValue::Code(code) => push(
                    &mut out,
                    &self.materialize_text(&code.literal).replace('\n', " "),
                    &Style {
                        code: true,
                        ..current.clone()
                    },
                    href,
                ),
                NodeValue::Math(math) => out.push(Inline::Math {
                    source: math.literal.clone(),
                }),
                NodeValue::Escaped => {
                    // Its children are literal punctuation: an escaped colon or brace cannot open syntax.
                    for child in node.children() {
                        if let NodeValue::Text(value) = &child.data.borrow().value {
                            push(&mut out, value, &current, href);
                        }
                    }
                }
                NodeValue::HtmlInline(html) => {
                    if html.starts_with("<!--") {
                        continue;
                    }
                    let normalized = html.to_ascii_lowercase();
                    if is_br(&normalized) {
                        out.push(text("\n"));
                        continue;
                    }
                    let closing = normalized.starts_with("</");
                    let tag = normalized
                        .trim_start_matches('<')
                        .trim_start_matches('/')
                        .trim_end_matches('>');
                    if let Some(kind) = ["b", "strong", "i", "em", "s", "del", "u", "ins"]
                        .iter()
                        .position(|name| *name == tag)
                    {
                        if closing {
                            if let Some(index) = html_tops[kind] {
                                current = html_styles[index].2.clone();
                                while html_styles.len() > index {
                                    let (kind, previous, _) =
                                        html_styles.pop().expect("nonempty style stack");
                                    html_tops[kind] = previous;
                                }
                            }
                            continue;
                        }
                        html_styles.push((kind, html_tops[kind], current.clone()));
                        html_tops[kind] = Some(html_styles.len() - 1);
                        match tag {
                            "b" | "strong" => current.bold = true,
                            "i" | "em" => current.italic = true,
                            "s" | "del" => current.strike = true,
                            _ => current.underline = true,
                        }
                        continue;
                    }
                    if self.syntax.options.exact {
                        return Err(error(
                            line,
                            format!(
                                "Nodex has no `{tag}` HTML style; use Markdown text, code, or `:::toggle` for hidden content"
                            ),
                        ));
                    }
                    if !matches!(tag, "sub" | "sup" | "kbd") {
                        push(&mut out, html, &current, href);
                    }
                }
                NodeValue::Link(link) => {
                    let raw = self.raw(node);
                    let url = self.destination(&link.url);
                    if raw.starts_with('<') {
                        if let Some(page) = crate::links::parse_page_link(&url) {
                            out.push(Inline::PageMention { page });
                            continue;
                        }
                        if let Some(session) = crate::links::parse_session_link(&url) {
                            out.push(Inline::ChatMention { session });
                            continue;
                        }
                    }
                    let label =
                        self.inline_run(node.children(), &current, Some(&url), depth + 1, reading)?;
                    if !raw.starts_with(['[', '<'])
                        && let Some(index) = url.char_indices().find_map(|(i, c)| {
                            "。．，、？！：；（）【】「」『』〈〉《》"
                                .contains(c)
                                .then_some(i)
                        })
                    {
                        let label_text = plain(&label);
                        if index > 0 && label_text == url {
                            push(&mut out, &url[..index], &current, Some(&url[..index]));
                            push(&mut out, &url[index..], &current, href);
                            continue;
                        }
                    }
                    out.extend(label);
                }
                NodeValue::Image(link) => {
                    let (alt, width) = self.image_description(node);
                    out.push(Inline::Image(InlineImage {
                        url: self.destination(&link.url),
                        alt,
                        width,
                        href: href.map(str::to_owned),
                    }));
                }
                _ => out.extend(self.inline_run(
                    node.children(),
                    &current,
                    href,
                    depth + 1,
                    reading,
                )?),
            }
        }
        Ok(out)
    }

    fn atom(&self, d: &Directive, style: &Style, depth: usize) -> Result<Vec<Inline>, ReadError> {
        let atom = match d.name.as_str() {
            "date" => Inline::DateMention(values::date(d)?),
            "attachment" => Inline::Attachment(values::attachment(d)?),
            "agent-config" => Inline::AgentConfig(values::agent(d)?),
            "span" => {
                values::allowed(d, &["underline", "color", "background"])?;
                if values::value(&d.attrs, "underline").is_some() {
                    return Err(error(
                        d.line,
                        "`underline` is a flag; write `{underline}` without a value",
                    ));
                }
                let colors = values::colors(&d.attrs, d.line)?;
                let style = Style {
                    underline: style.underline || d.attrs.iter().any(|a| a.name == "underline"),
                    color: colors.text.or(style.color),
                    background: colors.background.or(style.background),
                    ..style.clone()
                };
                return fragment(
                    d.label.as_deref().unwrap_or(""),
                    self.syntax.options,
                    d.line,
                    &style,
                    depth,
                );
            }
            _ => return Ok(vec![text(literal(d))]),
        };
        Ok(vec![atom])
    }

    pub(super) fn materialize(&self, items: &mut [Inline]) {
        for item in items {
            match item {
                Inline::Text { text, .. } => *text = self.materialize_text(text),
                Inline::Link { content, .. } => {
                    for item in content {
                        item.text = self.materialize_text(&item.text);
                    }
                }
                _ => {}
            }
        }
    }

    /// A destination is literal: syntax the lexer protected inside it, such as `{name}` in a
    /// templated URL, is its own source again.
    pub(super) fn destination(&self, url: &str) -> String {
        self.materialize_text(url)
    }

    fn materialize_text(&self, source: &str) -> String {
        let mut out = String::new();
        let mut rest = source;
        while let Some(index) = rest.find(&self.syntax.prefix) {
            out.push_str(&rest[..index]);
            let Some((id, length)) = self.syntax.token(&rest[index..]) else {
                out.push_str(&rest[index..]);
                return out;
            };
            match self.syntax.tokens.get(id) {
                Some(
                    Token::Attributes { raw, .. } | Token::Math { raw, .. } | Token::Literal(raw),
                ) => out.push_str(raw),
                Some(Token::Directive(d)) => out.push_str(&literal(d)),
                _ => out.push_str(&rest[index..index + length]),
            }
            rest = &rest[index + length..];
        }
        out.push_str(rest);
        out
    }

    pub(super) fn image_description<'a>(&self, node: &'a AstNode<'a>) -> (String, Option<u32>) {
        let mut alt = self.materialize_text(&plain_node(node));
        let Some((caption, width)) = alt.rsplit_once('|') else {
            return (alt, None);
        };
        let width_text = width;
        let width = if !width.is_empty() && width.bytes().all(|b| b.is_ascii_digit()) {
            width.parse::<u32>().ok().filter(|n| *n > 0)
        } else {
            None
        };
        let escaped = node.descendants().any(|n| matches!(n.data.borrow().value, NodeValue::Escaped) && n.next_sibling().is_some_and(|n| matches!(&n.data.borrow().value, NodeValue::Text(t) if t.as_ref() == width_text)));
        if width.is_some() && !escaped {
            alt = caption.to_owned();
            return (alt, width);
        }
        (alt, None)
    }
}

pub(super) fn fragment(
    source: &str,
    options: crate::ReadOptions,
    line: usize,
    style: &Style,
    depth: usize,
) -> Result<Vec<Inline>, ReadError> {
    if source.is_empty() {
        return Ok(Vec::new());
    }
    let mut syntax = Syntax::new(source, options);
    let prepared = format!("x {}", syntax.inline_source(source, line, depth)?);
    syntax.line_numbers = vec![line];
    let arena = Arena::new();
    let root = parse_document(&arena, &prepared, &parser_options());
    let reader = Reader::new(&syntax, &prepared);
    let Some(paragraph) = root.first_child() else {
        return Ok(Vec::new());
    };
    let mut content = reader.inlines(paragraph.children(), style, None, false, depth + 1)?;
    if let Some(Inline::Text { text, .. }) = content.first_mut()
        && text.starts_with("x ")
    {
        text.drain(..2);
    }
    reader.materialize(&mut content);
    Ok(content)
}

pub(super) fn literal(d: &Directive) -> String {
    let colons = if super::syntax::is_leaf(&d.name) {
        "::"
    } else {
        ":"
    };
    format!("{colons}{}", d.raw)
}

fn with_href(items: Vec<Inline>, href: Option<&str>) -> Vec<Inline> {
    let Some(href) = href else {
        return items;
    };
    items
        .into_iter()
        .map(|item| match item {
            Inline::Text { text, style } => Inline::Link {
                href: href.into(),
                content: vec![StyledText { text, style }],
            },
            Inline::Image(mut image) => {
                image.href = Some(href.into());
                Inline::Image(image)
            }
            other => other,
        })
        .collect()
}

pub(super) fn is_br(source: &str) -> bool {
    matches!(
        source.trim().to_ascii_lowercase().as_str(),
        "<br>" | "<br/>" | "<br />"
    )
}
pub(super) fn plain(items: &[Inline]) -> String {
    items
        .iter()
        .map(|item| match item {
            Inline::Text { text, .. } => text.clone(),
            Inline::Link { content, .. } => content.iter().map(|s| s.text.as_str()).collect(),
            Inline::Image(image) => image.alt.clone(),
            Inline::Math { source } => source.clone(),
            _ => String::new(),
        })
        .collect()
}
fn plain_node<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    for node in node.descendants() {
        match &node.data.borrow().value {
            NodeValue::Text(text) => out.push_str(text),
            NodeValue::Code(code) => out.push_str(&code.literal),
            NodeValue::Math(math) => out.push_str(&math.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push('\n'),
            _ => {}
        }
    }
    out
}
