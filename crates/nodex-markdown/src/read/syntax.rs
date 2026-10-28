//! Protects raw directive values and turns indentation containers into parser containers.

use crate::attributes::{Attribute, decode_references, read_attribute_list};
use crate::{ReadError, ReadOptions};

use super::error;

#[derive(Clone, Debug)]
pub(super) struct Directive {
    pub name: String,
    pub label: Option<String>,
    pub attrs: Vec<Attribute>,
    pub line: usize,
    pub raw: String,
}

#[derive(Clone, Debug)]
pub(super) enum Token {
    Directive(Directive),
    Math { source: String, raw: String },
    SpanEnd,
    Literal(String),
    Attributes { attrs: Vec<Attribute>, raw: String },
}

#[derive(Clone)]
struct Line {
    text: String,
    number: usize,
}

pub(super) struct Syntax {
    pub options: ReadOptions,
    pub containers: Vec<Directive>,
    pub tokens: Vec<Token>,
    pub prefix: String,
    pub line_numbers: Vec<usize>,
    literal_lines: std::collections::HashSet<usize>,
}

impl Syntax {
    pub fn new(source: &str, mut options: ReadOptions) -> Self {
        if options.exact {
            options.line_breaks = crate::LineBreaks::Comment;
        }
        // Include decoded references so source text cannot impersonate a parser token.
        let decoded = decode_references(source);
        let used: std::collections::HashSet<usize> = decoded
            .match_indices("\u{e000}ndx")
            .filter_map(|(index, _)| {
                let tail = &decoded[index + "\u{e000}ndx".len()..];
                let length = tail.bytes().take_while(u8::is_ascii_digit).count();
                if tail.as_bytes().get(length) != Some(&b':') {
                    return None;
                }
                tail[..length].parse().ok()
            })
            .collect();
        let id = (0..=used.len())
            .find(|id| !used.contains(id))
            .unwrap_or(used.len() + 1);
        let prefix = format!("\u{e000}ndx{id}:");
        Self {
            options,
            containers: Vec::new(),
            tokens: Vec::new(),
            prefix,
            line_numbers: Vec::new(),
            literal_lines: std::collections::HashSet::new(),
        }
    }

    pub fn line(&self, line: usize) -> usize {
        self.line_numbers
            .get(line.saturating_sub(1))
            .copied()
            .unwrap_or(line)
            .max(1)
    }

    pub fn token(&self, text: &str) -> Option<(usize, usize)> {
        let rest = text.strip_prefix(&self.prefix)?;
        let end = rest.find('\u{e001}')?;
        Some((
            rest[..end].parse().ok()?,
            self.prefix.len() + end + '\u{e001}'.len_utf8(),
        ))
    }

    pub fn leaf_comment(&self, html: &str) -> Option<&Directive> {
        let token = html.trim().strip_prefix("<!--")?.strip_suffix("-->")?;
        let (id, length) = self.token(token)?;
        if length != token.len() {
            return None;
        }
        match self.tokens.get(id)? {
            Token::Directive(d) if is_leaf(&d.name) => Some(d),
            _ => None,
        }
    }

    fn insert(&mut self, token: Token) -> String {
        let id = self.tokens.len();
        self.tokens.push(token);
        format!("{}{id}\u{e001}", self.prefix)
    }

    pub fn prepare(&mut self, source: &str) -> Result<String, ReadError> {
        if !source.contains([':', '{'])
            && !source.contains("$$")
            && !source.contains("\\(")
            && !source.contains("\\[")
        {
            self.line_numbers
                .extend(1..=source.bytes().filter(|b| *b == b'\n').count() + 1);
            return Ok(source.to_owned());
        }
        self.literal_lines = literal_lines(source);
        let lines: Vec<_> = source
            .split('\n')
            .enumerate()
            .map(|(i, text)| Line {
                text: text.into(),
                number: i + 1,
            })
            .collect();
        let (lines, _, _) = self.scope(&lines, 0, None, 0)?;
        let mut fence = Fence::default();
        let mut prepared = Vec::with_capacity(lines.len());
        let mut math_close: Option<(String, String, usize, usize)> = None;
        for line in lines {
            self.line_numbers.push(line.number);
            let prefix = line_prefix(&line.text);
            let content = &line.text[prefix.len()..];
            if let Some((close, base, opening, longest)) = &mut math_close {
                if line
                    .text
                    .strip_prefix(base.as_str())
                    .is_some_and(|s| s.trim() == close)
                {
                    let code_fence = "`".repeat((*longest).max(2) + 1);
                    prepared[*opening] = format!("{base}{code_fence}math");
                    prepared.push(format!("{base}{code_fence}"));
                    math_close = None;
                } else {
                    let mut run = 0;
                    for byte in line.text.bytes() {
                        run = if byte == b'`' { run + 1 } else { 0 };
                        *longest = (*longest).max(run);
                    }
                    prepared.push(line.text);
                }
                continue;
            }
            if !fence.active()
                && (content.len() >= 2 && content.bytes().all(|b| b == b'$') || content == "\\[")
            {
                let close = if content == "\\[" { "\\]" } else { content };
                math_close = Some((close.to_owned(), prefix.to_owned(), prepared.len(), 0));
                prepared.push(String::new());
                continue;
            }
            if fence.consume(&line.text) {
                prepared.push(line.text);
                continue;
            }
            prepared.push(line.text);
        }
        if let Some((_, base, opening, longest)) = math_close {
            prepared[opening] = format!("{base}{}math", "`".repeat(longest.max(2) + 1));
        }
        let source = prepared.join("\n");
        let protected = protected_ranges(&source);
        self.inline_source_protected(&source, 1, 0, &protected, true)
    }

    /// A scope owns its closing fence; a dedent ends an unfinished indented body.
    fn scope(
        &mut self,
        lines: &[Line],
        mut i: usize,
        parent: Option<(&str, bool)>,
        depth: usize,
    ) -> Result<(Vec<Line>, usize, bool), ReadError> {
        let mut out = Vec::new();
        let mut code = Fence::default();
        let mut list_indents = Vec::new();
        while let Some(line) = lines.get(i) {
            let prefix = line_prefix(&line.text);
            let content = &line.text[prefix.len()..];
            let closing = content.len() >= 3 && content.bytes().all(|b| b == b':');
            if !code.active()
                && let Some((base, indented)) = parent
            {
                if closing
                    && (prefix == base || !indented && quote_count(prefix) == quote_count(base))
                {
                    return Ok((out, i + 1, true));
                }
                if !line.text.trim().is_empty()
                    && (!line.text.starts_with(base)
                        || indented && !line.text[base.len()..].starts_with("  "))
                {
                    return Ok((out, i, false));
                }
            }
            let indent = content_indent(prefix);
            if !line.text.trim().is_empty() {
                while list_indents.last().is_some_and(|last| *last > indent) {
                    list_indents.pop();
                }
            }
            let base = parent.map_or(0, |(base, indented)| {
                content_indent(base) + if indented { 2 } else { 0 }
            });
            let base = list_indents.last().copied().unwrap_or(base).max(base);
            if !code.active() && indent >= base + 4 {
                out.push(line.clone());
                i += 1;
                continue;
            }
            if let Some(width) = list_marker_width(content) {
                list_indents.push(indent + width);
            }
            if code.consume(&line.text) {
                out.push(line.clone());
                i += 1;
                continue;
            }
            if self.literal_lines.contains(&line.number) {
                let text = if content.starts_with(":::") {
                    let count = content.bytes().take_while(|b| *b == b':').count();
                    format!(
                        "{prefix}{}{}",
                        self.insert(Token::Literal(content[..count].into())),
                        &content[count..]
                    )
                } else {
                    line.text.clone()
                };
                out.push(Line {
                    text,
                    number: line.number,
                });
                i += 1;
                continue;
            }
            if let Some(raw) = content.strip_prefix("::")
                && is_leaf(name(raw))
            {
                match parse_directive(raw, line.number, false) {
                    Ok(directive) => {
                        let token = self.insert(Token::Directive(directive));
                        out.push(Line {
                            text: format!("{prefix}<!--{token}-->"),
                            number: line.number,
                        });
                    }
                    Err(err) if self.options.exact => return Err(err),
                    Err(_) => out.push(line.clone()),
                }
                i += 1;
                continue;
            }
            if let Some(raw) = content.strip_prefix(":::") {
                let raw = raw.trim_start_matches(':');
                if is_container(name(raw)) {
                    if depth >= 128 {
                        return Err(error(
                            line.number,
                            "containers nest too deeply; use fewer than 128 levels",
                        ));
                    }
                    let parsed = parse_directive(raw, line.number, false);
                    let directive = match parsed {
                        Ok(directive) => directive,
                        Err(err) if self.options.exact => return Err(err),
                        Err(_) => {
                            out.push(Line {
                                text: format!("{prefix}\\{content}"),
                                number: line.number,
                            });
                            i += 1;
                            continue;
                        }
                    };
                    let first = lines[i + 1..]
                        .iter()
                        .find(|line| !line.text.trim().is_empty());
                    let indented = first.is_some_and(|line| {
                        line.text
                            .strip_prefix(prefix)
                            .is_some_and(|rest| rest.starts_with("  "))
                    });
                    let (mut body, next, closed) =
                        self.scope(lines, i + 1, Some((prefix, indented)), depth + 1)?;
                    if !closed && self.options.exact {
                        return Err(error(
                            line.number,
                            format!(
                                "the {} opened on line {} has no closing `:::`; close it before the body ends",
                                directive.name, line.number
                            ),
                        ));
                    }
                    if indented {
                        for child in &mut body {
                            if child
                                .text
                                .get(prefix.len()..)
                                .is_some_and(|rest| rest.starts_with("  "))
                            {
                                child.text.replace_range(prefix.len()..prefix.len() + 2, "");
                            }
                        }
                    }
                    let length = body
                        .iter()
                        .map(|line| {
                            line.text[line_prefix(&line.text).len()..]
                                .bytes()
                                .take_while(|b| *b == b':')
                                .count()
                        })
                        .max()
                        .unwrap_or(0)
                        .max(2)
                        + 1;
                    let id = self.containers.len();
                    self.containers.push(directive);
                    let fence = ":".repeat(length);
                    out.push(Line {
                        text: format!("{prefix}{fence} nodex-{id}"),
                        number: line.number,
                    });
                    let trailing = if closed {
                        Vec::new()
                    } else {
                        let end = body
                            .iter()
                            .rposition(|line| !line.text.trim().is_empty())
                            .map_or(0, |index| index + 1);
                        body.split_off(end)
                    };
                    out.extend(body);
                    out.push(Line {
                        text: format!("{prefix}{fence}"),
                        number: if closed {
                            lines
                                .get(next.saturating_sub(1))
                                .map_or(line.number, |l| l.number)
                        } else {
                            0
                        },
                    });
                    out.extend(trailing);
                    i = next;
                    continue;
                }
                if closing && self.options.exact {
                    return Err(error(
                        line.number,
                        "this `:::` closes no container; open a container first or escape it as `\\:::`",
                    ));
                }
                // Comrak accepts any directive name. Only Nodex's names are containers.
                out.push(Line {
                    text: format!("{prefix}\\{content}"),
                    number: line.number,
                });
                i += 1;
                continue;
            }
            out.push(line.clone());
            i += 1;
        }
        Ok((out, i, false))
    }

    /// Tokens are text to GFM. Their values and span labels are read only after GFM structure.
    pub fn inline_source(
        &mut self,
        source: &str,
        line: usize,
        depth: usize,
    ) -> Result<String, ReadError> {
        self.inline_source_protected(source, line, depth, &[], false)
    }

    fn inline_source_protected(
        &mut self,
        source: &str,
        mut line: usize,
        depth: usize,
        protected: &[std::ops::Range<usize>],
        allow_leaf: bool,
    ) -> Result<String, ReadError> {
        let mut out = String::with_capacity(source.len());
        let runs = Runs::new(source);
        let first_line = line;
        let mut offset = 0;
        let leaf_prefixes: Vec<_> = if allow_leaf {
            source
                .split_inclusive('\n')
                .map(|line| {
                    let leading = line.len() - line.trim_start().len();
                    let rest = &line[leading..];
                    let quotes = rest.bytes().take_while(|b| *b == b'>').count();
                    let rest = &rest[quotes..];
                    let trailing = rest.len() - rest.trim_start().len();
                    let end = offset + leading + quotes + trailing;
                    offset += line.len();
                    end
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut missing_latex = [false; 2];
        let paragraphs = paragraph_ends(source);
        let mut paragraph = 0;
        let mut missing_angle = false;
        let mut missing_comment = false;
        let mut i = 0;
        let mut protected_index = 0;
        while i < source.len() {
            while paragraphs.get(paragraph).is_some_and(|end| *end <= i) {
                paragraph += 1;
                missing_latex = [false; 2];
            }
            while protected
                .get(protected_index)
                .is_some_and(|range| range.end <= i || range.start < i)
            {
                protected_index += 1;
            }
            if let Some(range) = protected
                .get(protected_index)
                .filter(|range| range.start == i && i < range.end)
            {
                let literal = &source[i..range.end];
                line += literal.bytes().filter(|b| *b == b'\n').count();
                out.push_str(literal);
                i = range.end;
                continue;
            }
            let rest = &source[i..];
            if rest.starts_with("\\(") || rest.starts_with("\\[") {
                let kind = usize::from(rest.starts_with("\\["));
                let close = if rest.starts_with("\\(") {
                    "\\)"
                } else {
                    "\\]"
                };
                let end = paragraphs.get(paragraph).copied().unwrap_or(source.len());
                if let Some(end) = (!missing_latex[kind])
                    .then(|| source[i + 2..end].find(close))
                    .flatten()
                {
                    let length = end + 4;
                    out.push_str(&rest[..length]);
                    line += rest[..length].bytes().filter(|b| *b == b'\n').count();
                    i += length;
                    continue;
                }
                missing_latex[kind] = true;
                // Comrak also searches the suffix for LaTeX. An unmatched opener is
                // just an escaped bracket, so give it that literal meaning directly.
                out.push_str(&self.insert(Token::Literal(rest[1..2].to_owned())));
                i += 2;
                continue;
            }
            if rest.starts_with('\\') {
                let length = rest.chars().nth(1).map_or(1, |c| 1 + c.len_utf8());
                out.push_str(&rest[..length]);
                line += rest[..length].bytes().filter(|b| *b == b'\n').count();
                i += length;
                continue;
            }
            // Code spans and inline math end within their paragraph, as Markdown reads them.
            let paragraph_end = paragraphs.get(paragraph).copied().unwrap_or(source.len());
            if rest.starts_with("$$") {
                let count = rest.bytes().take_while(|b| *b == b'$').count();
                if let Some(end) = runs
                    .matching(i, b'$', count)
                    .filter(|end| end + count <= paragraph_end)
                    .map(|end| end - i - count)
                {
                    let raw = &rest[count..count + end];
                    let source = if raw.starts_with(' ')
                        && raw.ends_with(' ')
                        && raw.len() >= 2
                        && !raw.trim().is_empty()
                    {
                        &raw[1..raw.len() - 1]
                    } else {
                        raw
                    };
                    out.push_str(&self.insert(Token::Math {
                        source: source.to_owned(),
                        raw: rest[..count + end + count].to_owned(),
                    }));
                    line += rest[..count + end + count]
                        .bytes()
                        .filter(|b| *b == b'\n')
                        .count();
                    i += count + end + count;
                    continue;
                }
                out.push_str(&rest[..count]);
                i += count;
                continue;
            }
            if rest.starts_with('`') {
                let marker = rest.as_bytes()[0];
                let count = rest.bytes().take_while(|b| *b == marker).count();
                if let Some(end) = runs
                    .matching(i, marker, count)
                    .filter(|end| end + count <= paragraph_end)
                    .map(|end| end - i - count)
                {
                    let length = count + end + count;
                    out.push_str(&rest[..length]);
                    line += rest[..length].bytes().filter(|b| *b == b'\n').count();
                    i += length;
                    continue;
                }
                out.push_str(&rest[..count]);
                i += count;
                continue;
            }
            if rest.starts_with("<!--")
                && let Some(end) = (!missing_comment).then(|| rest.find("-->")).flatten()
            {
                out.push_str(&rest[..end + 3]);
                line += rest[..end + 3].bytes().filter(|b| *b == b'\n').count();
                i += end + 3;
                continue;
            }
            if rest.starts_with("<!--") {
                missing_comment = true;
            }
            if rest.starts_with('<')
                && let Some(end) = (!missing_angle).then(|| rest.find('>')).flatten()
            {
                out.push_str(&rest[..end + 1]);
                line += rest[..end + 1].bytes().filter(|b| *b == b'\n').count();
                i += end + 1;
                continue;
            }
            if rest.starts_with('<') {
                missing_angle = true;
            }
            let colons = rest.bytes().take_while(|b| *b == b':').count();
            if colons > 2 {
                out.push_str(&rest[..colons]);
                i += colons;
                continue;
            }
            let directive_name = if colons > 0 {
                name(&rest[colons..])
            } else {
                ""
            };
            let leaf = allow_leaf
                && colons == 2
                && is_leaf(directive_name)
                && leaf_prefixes
                    .get(line.saturating_sub(first_line))
                    .is_some_and(|end| i <= *end);
            let inline = colons == 1 && is_inline(directive_name);
            if leaf || inline {
                let length = directive_length(&rest[colons..], &runs, i + colons);
                let raw = &rest[colons..colons + length];
                let parsed =
                    parse_directive(raw, self.line(line), inline && directive_name != "span");
                match parsed {
                    Ok(directive) if depth < 128 => {
                        if directive.name == "span" {
                            let label = directive.label.clone().unwrap_or_default();
                            out.push_str(&self.insert(Token::Directive(directive)));
                            out.push('[');
                            out.push_str(&label);
                            out.push(']');
                            out.push_str(&self.insert(Token::SpanEnd));
                        } else {
                            out.push_str(&self.insert(Token::Directive(directive)));
                        }
                    }
                    Err(err) if self.options.exact => return Err(err),
                    _ => out.push_str(&rest[..colons + length]),
                }
                i += colons + length;
                continue;
            }
            if rest.starts_with('{')
                && let Ok((attrs, length)) = read_attribute_list(rest)
            {
                out.push_str(&self.insert(Token::Attributes {
                    attrs,
                    raw: rest[..length].to_owned(),
                }));
                i += length;
                continue;
            }
            let c = rest.chars().next().unwrap_or_default();
            out.push(c);
            if c == '\n' {
                line += 1;
            }
            i += c.len_utf8();
        }
        Ok(out)
    }
}

/// Index maximal delimiter runs once, including ones inside escaped/literal text:
/// a closing fence is literal even there. A suffix query never rescans input.
struct Runs(std::collections::HashMap<(u8, usize), Vec<usize>>);

impl Runs {
    fn new(source: &str) -> Self {
        let mut runs = std::collections::HashMap::<_, Vec<_>>::new();
        let bytes = source.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let marker = bytes[i];
            if !matches!(marker, b'`' | b'$') {
                i += 1;
                continue;
            }
            let start = i;
            while bytes.get(i) == Some(&marker) {
                i += 1;
            }
            runs.entry((marker, i - start)).or_default().push(start);
        }
        Self(runs)
    }

    fn matching(&self, start: usize, marker: u8, length: usize) -> Option<usize> {
        let positions = self.0.get(&(marker, length))?;
        positions
            .get(positions.partition_point(|pos| *pos < start + length))
            .copied()
    }
}

pub(super) fn name(source: &str) -> &str {
    let end = source
        .bytes()
        .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        .count();
    &source[..end]
}

pub(super) fn is_leaf(name: &str) -> bool {
    matches!(
        name,
        "page"
            | "database"
            | "canvas"
            | "page-ref"
            | "database-view-ref"
            | "synced-block-ref"
            | "template-ref"
    )
}
fn is_container(name: &str) -> bool {
    matches!(name, "paragraph" | "toggle" | "callout" | "table")
}
fn is_inline(name: &str) -> bool {
    matches!(name, "span" | "date" | "attachment" | "agent-config")
}

/// The label balances brackets and ignores escaped brackets and brackets in code spans.
fn label_end(source: &str) -> Option<usize> {
    let runs = Runs::new(source);
    label_end_indexed(source, &runs, 0)
}

fn label_end_indexed(source: &str, runs: &Runs, offset: usize) -> Option<usize> {
    let mut nesting = 0usize;
    let mut i = 0;
    while i < source.len() {
        let rest = &source[i..];
        if rest.starts_with('\\') {
            i += rest.chars().nth(1).map_or(1, |c| 1 + c.len_utf8());
            continue;
        }
        if rest.starts_with('`') {
            let count = rest.bytes().take_while(|b| *b == b'`').count();
            if let Some(end) = runs.matching(offset + i, b'`', count) {
                i = end + count - offset;
                continue;
            }
            i += count;
            continue;
        }
        match rest.as_bytes()[0] {
            b'[' => nesting += 1,
            b']' => {
                nesting = nesting.saturating_sub(1);
                if nesting == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += rest.chars().next()?.len_utf8();
    }
    None
}

fn directive_length(source: &str, runs: &Runs, offset: usize) -> usize {
    let mut length = name(source).len();
    if source[length..].starts_with('[') {
        length += label_end_indexed(&source[length..], runs, offset + length)
            .unwrap_or(source.len() - length);
    }
    if source[length..].starts_with('{') {
        length += read_attribute_list(&source[length..]).map_or_else(
            |_| {
                source[length..]
                    .find('}')
                    .map_or(source.len() - length, |n| n + 1)
            },
            |(_, n)| n,
        );
    }
    length
}

fn parse_directive(source: &str, line: usize, braces: bool) -> Result<Directive, ReadError> {
    let name = name(source);
    if source.contains(['\n', '\r']) {
        return Err(error(
            line,
            format!("the {name} label takes one line; write line breaks as `<br>`"),
        ));
    }
    let mut rest = &source[name.len()..];
    let label = if rest.starts_with('[') {
        let end = label_end(rest).ok_or_else(|| {
            error(
                line,
                format!("the {name} label has no closing `]`; close the label on this line"),
            )
        })?;
        let label = rest[1..end - 1].to_owned();
        rest = &rest[end..];
        Some(label)
    } else {
        None
    };
    if name == "span" && label.is_none() {
        return Err(error(line, "a span needs a `[text]` label"));
    }
    if (is_leaf(name) || is_inline(name) && name != "span") && label.is_some() {
        return Err(error(
            line,
            format!("{name} takes attributes only; remove its label"),
        ));
    }
    let attrs = if rest.starts_with('{') {
        let (attrs, end) = read_attribute_list(rest)
            .map_err(|err| error(line, format!("{err}; write attributes as `name=\"value\"`")))?;
        rest = &rest[end..];
        attrs
    } else if braces || is_leaf(name) {
        return Err(error(
            line,
            format!("{name} needs its attributes in braces; write `:{name}{{…}}`"),
        ));
    } else {
        Vec::new()
    };
    if !rest.trim().is_empty() {
        return Err(error(
            line,
            format!("unexpected text after {name}; put the body on the next line"),
        ));
    }
    Ok(Directive {
        name: name.into(),
        label,
        attrs,
        line,
        raw: source.to_owned(),
    })
}

fn line_prefix(line: &str) -> &str {
    let length = line
        .bytes()
        .take_while(|b| matches!(b, b' ' | b'\t' | b'>'))
        .count();
    &line[..length]
}
fn quote_count(prefix: &str) -> usize {
    prefix.bytes().filter(|b| *b == b'>').count()
}

#[derive(Default)]
struct Fence {
    marker: u8,
    length: usize,
}
impl Fence {
    fn active(&self) -> bool {
        self.length > 0
    }
    fn consume(&mut self, line: &str) -> bool {
        let text = &line[line_prefix(line).len()..];
        if self.active() {
            if self.marker == b'[' {
                if text == "\\]" {
                    self.length = 0;
                }
                return true;
            }
            let count = text.bytes().take_while(|b| *b == self.marker).count();
            if count >= self.length && text[count..].trim().is_empty() {
                self.length = 0;
            }
            return true;
        }
        if text == "\\[" {
            self.marker = b'[';
            self.length = 2;
            return true;
        }
        if text.len() >= 2 && text.bytes().all(|b| b == b'$') {
            self.marker = b'$';
            self.length = text.len();
            return true;
        }
        let marker = text.as_bytes().first().copied().unwrap_or_default();
        if !matches!(marker, b'`' | b'~') {
            return false;
        }
        let length = text.bytes().take_while(|b| *b == marker).count();
        if length < 3 || marker == b'`' && text[length..].contains('`') {
            return false;
        }
        self.marker = marker;
        self.length = length;
        true
    }
}

/// Comrak identifies literal regions before the extension lexer visits their contents.
fn protected_ranges(source: &str) -> Vec<std::ops::Range<usize>> {
    use comrak::{Arena, nodes::NodeValue, parse_document};
    let arena = Arena::new();
    let safe = unmatched_latex(source);
    let root = parse_document(&arena, &safe, &super::parser_options());
    let columns = super::columns::Columns::new(safe.split('\n'));
    let mut offsets = vec![0];
    offsets.extend(source.match_indices('\n').map(|(index, _)| index + 1));
    let mut ranges = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        let block = matches!(
            data.value,
            NodeValue::CodeBlock(_) | NodeValue::HtmlBlock(_)
        );
        if !block && !matches!(data.value, NodeValue::Code(_) | NodeValue::Math(_)) {
            continue;
        }
        let pos = data.sourcepos;
        let Some(start_line) = offsets.get(pos.start.line.saturating_sub(1)).copied() else {
            continue;
        };
        let Some(end_line) = offsets.get(pos.end.line.saturating_sub(1)).copied() else {
            continue;
        };
        let start = if block {
            start_line
        } else {
            start_line + columns.offset(node, pos.start)
        };
        let end = if block {
            offsets.get(pos.end.line).copied().unwrap_or(source.len())
        } else {
            end_line + columns.offset(node, pos.end) + 1
        };
        if start < end
            && end <= source.len()
            && source.is_char_boundary(start)
            && source.is_char_boundary(end)
        {
            ranges.push(start..end);
        }
    }
    ranges.sort_by_key(|range| range.start);
    ranges
}

fn content_indent(prefix: &str) -> usize {
    prefix.rsplit_once('>').map_or(prefix.len(), |(_, rest)| {
        rest.strip_prefix(' ').unwrap_or(rest).len()
    })
}

fn list_marker_width(source: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    if matches!(bytes.first(), Some(b'-' | b'+' | b'*'))
        && bytes.get(1).is_some_and(u8::is_ascii_whitespace)
    {
        return Some(2);
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if (1..=9).contains(&digits)
        && matches!(bytes.get(digits), Some(b'.' | b')'))
        && bytes.get(digits + 1).is_some_and(u8::is_ascii_whitespace)
    {
        return Some(digits + 2);
    }
    None
}

/// Multiline code spans and HTML comments can contain directive-looking lines.
fn literal_lines(source: &str) -> std::collections::HashSet<usize> {
    use comrak::{Arena, nodes::NodeValue, parse_document};
    let mut options = super::parser_options();
    options.extension.block_directive = false;
    let arena = Arena::new();
    let safe = unmatched_latex(source);
    let root = parse_document(&arena, &safe, &options);
    let mut lines = std::collections::HashSet::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        let pos = data.sourcepos;
        let start = match data.value {
            NodeValue::Code(_) => pos.start.line + 1,
            NodeValue::HtmlBlock(_) => pos.start.line,
            _ => continue,
        };
        lines.extend(start..=pos.end.line);
    }
    lines
}

/// Comrak's LaTeX extension searches every remaining backslash for each unmatched
/// opener. The final closer of each kind proves which openers cannot match.
/// Use an equally wide escaped punctuation mark for these preliminary parses;
/// their only outputs are literal ranges and line numbers, never text values.
fn unmatched_latex(source: &str) -> std::borrow::Cow<'_, str> {
    let bytes = source.as_bytes();
    let mut safe = std::borrow::Cow::Borrowed(source.as_bytes());
    let mut start = 0;
    for end in paragraph_ends(source) {
        let part = &source[start..end];
        let last = [part.rfind("\\)"), part.rfind("\\]")];
        let mut i = start;
        while i + 1 < end {
            if bytes[i] != b'\\' {
                i += 1;
                continue;
            }
            if matches!(bytes[i + 1], b'(' | b'[') {
                let kind = usize::from(bytes[i + 1] == b'[');
                if last[kind].is_none_or(|close| close + start < i + 2) {
                    safe.to_mut()[i + 1] = b'!';
                }
            }
            i += 2;
        }
        start = end;
    }
    match safe {
        std::borrow::Cow::Borrowed(_) => std::borrow::Cow::Borrowed(source),
        std::borrow::Cow::Owned(bytes) => std::borrow::Cow::Owned(
            String::from_utf8(bytes).expect("ASCII substitution preserves UTF-8"),
        ),
    }
}

fn paragraph_ends(source: &str) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        offset += line.len();
        if line.trim().is_empty() {
            ends.push(offset);
        }
    }
    if ends.last() != Some(&source.len()) {
        ends.push(source.len());
    }
    ends
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_runs_match_exhaustive_suffix_searches() {
        let mut random = 0x7912_ef01_u64;
        for length in 0..2000 {
            let mut source = String::new();
            for _ in 0..length % 100 {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                let alphabet = b"``$$a \\[\n";
                source.push(char::from(alphabet[random as usize % alphabet.len()]));
            }
            let runs = Runs::new(&source);
            for (start, marker) in source
                .bytes()
                .enumerate()
                .filter(|(_, b)| matches!(b, b'`' | b'$'))
            {
                let count = source[start..].bytes().take_while(|b| *b == marker).count();
                let mut offset = start + count;
                let mut expected = None;
                for run in source[offset..].split_inclusive(|c| c != char::from(marker)) {
                    if run.bytes().take_while(|b| *b == marker).count() == count {
                        expected = Some(offset);
                        break;
                    }
                    offset += run.len();
                }
                assert_eq!(
                    runs.matching(start, marker, count),
                    expected,
                    "{source:?} at {start}"
                );
            }
        }
    }
}
