//! Text escapes are removed from right to left, with the reader as the authority.

use crate::{ReadOptions, read};

mod literal;

#[cfg(test)]
thread_local! {
    static CHECK_EXHAUSTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static EXHAUSTIVE_CHECKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Clone, Debug)]
struct Escape {
    index: usize,
    length: usize,
    plain: char,
}

#[derive(Clone, Debug)]
struct Autolink {
    index: usize,
    label: String,
    href: String,
}

/// Keeps text escapes separate from the syntax the writer owns.
#[derive(Clone, Debug, Default)]
pub(super) struct Text {
    pub source: String,
    escapes: Vec<Escape>,
    autolinks: Vec<Autolink>,
}

impl Text {
    pub fn syntax(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            escapes: Vec::new(),
            autolinks: Vec::new(),
        }
    }

    pub fn autolink(source: String, href: &str) -> Self {
        Self {
            autolinks: vec![Autolink {
                index: 0,
                label: source.clone(),
                href: href.to_owned(),
            }],
            ..Self::syntax(source)
        }
    }

    pub fn push_syntax(&mut self, source: &str) {
        self.source.push_str(source);
    }

    pub fn append(&mut self, other: Self) {
        let offset = self.source.len();
        self.source.push_str(&other.source);
        self.escapes
            .extend(other.escapes.into_iter().map(|mut escape| {
                escape.index += offset;
                escape
            }));
        self.autolinks
            .extend(other.autolinks.into_iter().map(|mut link| {
                link.index += offset;
                link
            }));
    }

    pub fn escaped(source: &str) -> Self {
        Self::escaped_edges(source, true, true)
    }

    pub fn escaped_edges(source: &str, leading_edge: bool, trailing_edge: bool) -> Self {
        let mut out = Self::default();
        for line in source.split_inclusive('\n') {
            let content = line.strip_suffix('\n').unwrap_or(line);
            // Emphasis cannot begin or end at whitespace of any kind, so every whitespace
            // character at an edge starts as a reference, such as `&#x20;` or `&#xA0;`.
            let leading = content.len() - content.trim_start_matches(char::is_whitespace).len();
            let trailing = content.trim_end_matches(char::is_whitespace).len();
            for (index, character) in content.char_indices() {
                let at_edge =
                    (leading_edge && index < leading) || (trailing_edge && index >= trailing);
                let escaped = at_edge.then(|| format!("&#x{:X};", u32::from(character)));
                if let Some(encoded) = escaped {
                    out.escapes.push(Escape {
                        index: out.source.len(),
                        length: encoded.len(),
                        plain: character,
                    });
                    out.source.push_str(&encoded);
                } else if character.is_ascii_punctuation() {
                    out.escapes.push(Escape {
                        index: out.source.len(),
                        length: 2,
                        plain: character,
                    });
                    out.source.push('\\');
                    out.source.push(character);
                } else {
                    out.source.push(character);
                }
            }
            if line.ends_with('\n') {
                out.source.push('\n');
            }
        }
        out
    }

    /// `context` places this text in the same Markdown position as its Block.
    pub fn finish_expected(
        self,
        context: impl Fn(&str) -> String,
        expected: Vec<crate::Block>,
    ) -> String {
        self.minimize(context, true, Some(expected))
    }

    fn minimize(
        self,
        context: impl Fn(&str) -> String,
        fast: bool,
        expected: Option<Vec<crate::Block>>,
    ) -> String {
        #[cfg(test)]
        if fast && !self.escapes.is_empty() && CHECK_EXHAUSTIVE.get() {
            let exhaustive = self
                .clone()
                .minimize_impl(&context, false, expected.clone());
            let source = self.source.clone();
            let result = self.minimize_impl(&context, true, expected);
            assert_eq!(result, exhaustive, "{}", context(&source));
            EXHAUSTIVE_CHECKS.set(EXHAUSTIVE_CHECKS.get() + 1);
            return result;
        }
        self.minimize_impl(&context, fast, expected)
    }

    fn minimize_impl(
        self,
        context: &impl Fn(&str) -> String,
        fast: bool,
        expected: Option<Vec<crate::Block>>,
    ) -> String {
        if self.escapes.is_empty() {
            return self.source;
        }
        let facts = Facts::new(&self.source, &self.escapes);
        if fast
            && expected.is_some()
            && self.autolinks.is_empty()
            && !self.source.contains("\\(")
            && !self.source.contains("\\[")
            && self
                .escapes
                .iter()
                .zip(&facts.0)
                .all(|(escape, facts)| inert(&self.source, escape, facts))
        {
            // The writer already supplied the Block's semantic value. These marks
            // cannot open syntax, so neither a reference parse nor a trial is needed.
            return remove_inert(&self.source, &self.escapes, &facts).0;
        }
        // Character references provide a literal reference even for `\\[` and `\\]`,
        // which also form a supported math spelling when they occur together.
        let mut literal = String::new();
        let mut cursor = 0;
        for escape in &self.escapes {
            literal.push_str(&self.source[cursor..escape.index]);
            literal.push_str(&format!("&#{};", u32::from(escape.plain)));
            cursor = escape.index + escape.length;
        }
        literal.push_str(&self.source[cursor..]);
        let reference = expected.map_or_else(|| read(&context(&literal), ReadOptions::EXACT), Ok);
        if fast && let Some(source) = literal::minimize(&self, &context, &reference) {
            return source;
        }
        if fast
            && let Some(source) = homogeneous_run(&self.source, &self.escapes, &context, &reference)
        {
            return source;
        }
        let (source, _) = trials(
            self.source.clone(),
            &self.escapes,
            &context,
            &reference,
            fast && self.autolinks.is_empty(),
        );
        if read(&context(&source), ReadOptions::EXACT) == reference {
            return source;
        }
        // A pair of ordinary escaped brackets can itself spell LaTeX math. Start from
        // literal references when several such pairs make the fully escaped seed ambiguous.
        let mut seed = String::new();
        let mut references = Vec::new();
        let mut cursor = 0;
        for escape in &self.escapes {
            seed.push_str(&self.source[cursor..escape.index]);
            let encoded = format!("&#{};", u32::from(escape.plain));
            references.push(Escape {
                index: seed.len(),
                length: encoded.len(),
                plain: escape.plain,
            });
            seed.push_str(&encoded);
            cursor = escape.index + escape.length;
        }
        seed.push_str(&self.source[cursor..]);
        let (mut source, retained) = trials(
            seed,
            &references,
            &context,
            &reference,
            fast && self.autolinks.is_empty(),
        );
        for escape in retained.into_iter().rev() {
            if !escape.plain.is_ascii_punctuation() {
                continue;
            }
            let mut candidate = source.clone();
            candidate.replace_range(
                escape.index..escape.index + escape.length,
                &format!("\\{}", escape.plain),
            );
            if read(&context(&candidate), ReadOptions::EXACT) == reference {
                source = candidate;
            }
        }
        if self.autolinks.is_empty() || read(&context(&source), ReadOptions::EXACT) == reference {
            return source;
        }
        self.minimize_delimited_links(context, fast, &reference)
            .unwrap_or(source)
    }

    /// Backslashes and numeric references after a bare URL can both become URL
    /// bytes, so neither fully escaped seed need say the intended link. Reduce
    /// against delimited links in that case, then offer each bare spelling again
    /// in its complete, minimized context. Correct bare-link reductions above
    /// keep their original right-to-left decisions.
    fn minimize_delimited_links(
        &self,
        context: &impl Fn(&str) -> String,
        fast: bool,
        reference: &Result<Vec<crate::Block>, crate::ReadError>,
    ) -> Option<String> {
        let expected = reference.as_ref().ok()?;
        let mut seed = Self::default();
        let mut cursor = 0;
        let mut spellings = Vec::new();
        for link in &self.autolinks {
            seed.append(self.slice(cursor..link.index));
            let mut explicit = Self::syntax("[");
            explicit.append(Self::escaped(&link.label));
            explicit.push_syntax(&format!("]({})", super::inline::destination(&link.href)));
            let block = crate::Block::new(crate::BlockKind::Paragraph {
                text: vec![crate::Inline::Link {
                    href: link.href.clone(),
                    content: vec![crate::StyledText {
                        text: link.label.clone(),
                        style: crate::Style::default(),
                    }],
                }],
                colors: crate::Colors::default(),
            });
            let explicit = explicit.minimize_impl(&str::to_owned, fast, Some(vec![block]));
            seed.push_syntax(&explicit);
            spellings.push((explicit, &link.label));
            cursor = link.index + link.label.len();
        }
        seed.append(self.slice(cursor..self.source.len()));
        let mut source = seed.minimize_impl(context, fast, Some(expected.clone()));
        if read(&context(&source), ReadOptions::EXACT) != *reference {
            return None;
        }
        for (explicit, label) in spellings {
            let matches: Vec<_> = source
                .match_indices(&explicit)
                .map(|(index, _)| index)
                .collect();
            for index in matches.into_iter().rev() {
                let mut candidate = source.clone();
                candidate.replace_range(index..index + explicit.len(), label);
                if read(&context(&candidate), ReadOptions::EXACT) == *reference {
                    source = candidate;
                }
            }
        }
        Some(source)
    }

    /// References keep the surrounding text literal, including paired brackets
    /// that would be LaTeX in the backslash seed.
    fn slice(&self, range: std::ops::Range<usize>) -> Self {
        let start = self
            .escapes
            .partition_point(|escape| escape.index < range.start);
        let end = self
            .escapes
            .partition_point(|escape| escape.index < range.end);
        let mut out = Self::default();
        let mut cursor = range.start;
        for escape in &self.escapes[start..end] {
            out.push_syntax(&self.source[cursor..escape.index]);
            let encoded = format!("&#{};", u32::from(escape.plain));
            out.escapes.push(Escape {
                index: out.source.len(),
                length: encoded.len(),
                plain: escape.plain,
            });
            out.push_syntax(&encoded);
            cursor = escape.index + escape.length;
        }
        out.push_syntax(&self.source[cursor..range.end]);
        out
    }
}

#[cfg(test)]
pub(super) mod performance;

/// One uninterrupted punctuation run has no independent opener inside it. Its suffix can
/// therefore be removed together; only the first mark can acquire a Block meaning.
fn homogeneous_run(
    source: &str,
    escapes: &[Escape],
    context: &impl Fn(&str) -> String,
    reference: &Result<Vec<crate::Block>, crate::ReadError>,
) -> Option<String> {
    let first = escapes.first()?;
    if !first.plain.is_ascii_punctuation()
        || escapes.len() < 2
        || first.index != 0
        || escapes.last()?.index + escapes.last()?.length != source.len()
    {
        return None;
    }
    if !escapes.iter().enumerate().all(|(index, escape)| {
        escape.plain == first.plain
            && escape.length == first.length
            && escape.index == index * first.length
    }) {
        return None;
    }
    let plain = first.plain.to_string().repeat(escapes.len());
    if read(&context(&plain), ReadOptions::EXACT) == *reference {
        return Some(plain);
    }
    let protected = format!(
        "{}{}",
        &source[..first.length],
        first.plain.to_string().repeat(escapes.len() - 1)
    );
    if read(&context(&protected), ReadOptions::EXACT) == *reference {
        return Some(protected);
    }
    if first.plain == '\\' {
        let candidate = "\\".repeat(source.len() - 1);
        if read(&context(&candidate), ReadOptions::EXACT) == *reference {
            return Some(candidate);
        }
    }
    if first.plain == '|' && context("").starts_with('|') {
        return Some(source.to_owned());
    }
    None
}

fn trials(
    source: String,
    escapes: &[Escape],
    context: &impl Fn(&str) -> String,
    reference: &Result<Vec<crate::Block>, crate::ReadError>,
    fast: bool,
) -> (String, Vec<Escape>) {
    // Remove punctuation that cannot open syntax in one pass. Replacing each occurrence
    // separately would still move a long paragraph's suffix once per punctuation mark.
    let baseline = fast.then(|| read(&context(&source), ReadOptions::EXACT));
    let can_batch = reference.is_ok() && baseline.as_ref() == Some(reference);
    let mut excess_math = baseline
        .as_ref()
        .and_then(|actual| actual.as_ref().ok())
        .zip(reference.as_ref().ok())
        .is_some_and(|(actual, expected)| math_count(actual) > math_count(expected));
    let (mut source, escapes) = if can_batch {
        remove_inert(&source, escapes, &Facts::new(&source, escapes))
    } else {
        (source, escapes.to_vec())
    };
    let mut kept = vec![true; escapes.len()];
    let facts = Facts::new(&source, &escapes);
    let inline = fast
        .then(|| inline_reference(&source, &escapes, context, reference))
        .flatten();
    for (index, escape) in escapes.iter().enumerate().rev() {
        // A fully escaped \(...\) can create unwanted math before reduction.
        // These inert marks neither delimit math nor introduce an enclosing
        // code/link/image/directive/HTML construct. Inside math they only alter
        // its source; outside it they leave every math atom intact. If the seed
        // has more math atoms than the reference, no such trial can be equal.
        if excess_math && inert(&source, escape, &facts.0[index]) {
            continue;
        }
        let mut candidate = source.clone();
        candidate.replace_range(
            escape.index..escape.index + escape.length,
            &escape.plain.to_string(),
        );
        let equal = if let Some(inline) = inline.as_ref().filter(|inline| {
            escape.index >= inline.start && inline_trial(escape, &facts.0[index], inline.label)
        }) {
            crate::read_inline(&candidate[inline.start..], ReadOptions::EXACT)
                .ok()
                .as_deref()
                == Some(inline.text.as_ref())
        } else {
            reference.is_ok() && read(&context(&candidate), ReadOptions::EXACT) == *reference
        };
        if equal {
            source = candidate;
            kept[index] = false;
            excess_math = false;
        }
    }
    let mut removed = 0;
    let mut retained = Vec::new();
    for (escape, kept) in escapes.iter().zip(kept) {
        if kept {
            retained.push(Escape {
                index: escape.index - removed,
                ..escape.clone()
            });
        } else {
            removed += escape.length - escape.plain.len_utf8();
        }
    }
    (source, retained)
}

fn math_count(blocks: &[crate::Block]) -> usize {
    blocks
        .iter()
        .map(|block| {
            let inline = block.text().map_or(0, |text| {
                text.iter()
                    .filter(|item| matches!(item, crate::Inline::Math { .. }))
                    .count()
            });
            inline
                + block
                    .children
                    .iter()
                    .map(|child| math_count(std::slice::from_ref(child)))
                    .sum::<usize>()
        })
        .sum()
}

/// A single-line text field has the same inline grammar in a paragraph, heading,
/// item, quote, alert, or container label: its outside edges are whitespace to
/// the inline reader (labels also use `read_inline`). Block colors are outside
/// the field. Images and tables have different label/pipe/whitespace semantics.
struct InlineReference<'a> {
    text: std::borrow::Cow<'a, [crate::Inline]>,
    label: bool,
    start: usize,
}

fn inline_reference<'a>(
    source: &str,
    escapes: &[Escape],
    context: &impl Fn(&str) -> String,
    reference: &'a Result<Vec<crate::Block>, crate::ReadError>,
) -> Option<InlineReference<'a>> {
    if source.contains('\r') {
        return None;
    }
    let [block] = reference.as_ref().ok()?.as_slice() else {
        return None;
    };
    let text = block.text()?;
    let spelling = context("x");
    let probe = read(&spelling, ReadOptions::EXACT).ok()?;
    let [probe] = probe.as_slice() else {
        return None;
    };
    if probe.text()?
        != [crate::Inline::Text {
            text: "x".into(),
            style: crate::Style::default(),
        }]
    {
        return None;
    }
    let label = spelling.contains("[x]");
    let Some(newline) = source.find('\n') else {
        return Some(InlineReference {
            text: text.into(),
            label,
            start: 0,
        });
    };
    if label || source[newline + 1..].contains('\n') || !ordinary_prefix(source, escapes, newline) {
        return None;
    }
    // No opener or owned syntax exists before this one newline, so neither
    // inline matching nor a pipe-table header can cross it. The fixed prefix
    // must already equal the reference; trials in it still use the full oracle.
    // Its unchanged newline supplies the same whitespace flank to the suffix.
    let [crate::Inline::Text { text: first, style }, rest @ ..] = text else {
        return None;
    };
    if !style.is_plain() {
        return None;
    }
    let split = first.find('\n')?;
    let prefix = [crate::Inline::Text {
        text: first[..split].to_owned(),
        style: style.clone(),
    }];
    if crate::read_inline(&source[..newline], ReadOptions::EXACT)
        .ok()?
        .as_slice()
        != prefix
    {
        return None;
    }
    let mut suffix = Vec::with_capacity(text.len());
    if split + 1 < first.len() {
        suffix.push(crate::Inline::Text {
            text: first[split + 1..].to_owned(),
            style: style.clone(),
        });
    }
    suffix.extend_from_slice(rest);
    Some(InlineReference {
        text: suffix.into(),
        label,
        start: newline + 1,
    })
}

fn ordinary_prefix(source: &str, escapes: &[Escape], end: usize) -> bool {
    let mut cursor = 0;
    for escape in escapes.iter().take_while(|escape| escape.index < end) {
        if source[cursor..escape.index].contains([
            '*', '_', '~', '`', '$', '[', '(', '<', ':', '{', '&', '@', '\\', '|',
        ]) || !escape.plain.is_whitespace()
            && !matches!(
                escape.plain,
                '"' | '\''
                    | '%'
                    | ','
                    | '/'
                    | ';'
                    | '?'
                    | '^'
                    | '.'
                    | '-'
                    | '+'
                    | '>'
                    | '='
                    | '#'
                    | '!'
            )
        {
            return false;
        }
        cursor = escape.index + escape.length;
    }
    !source[cursor..end].contains([
        '*', '_', '~', '`', '$', '[', '(', '<', ':', '{', '&', '@', '\\', '|',
    ])
}

/// Preserve the complete Block oracle for anything that can change its layout,
/// label balance, trailing attributes, or closing heading hashes. Else only the
/// inline value can change; the surrounding Block syntax and colors are fixed.
/// Escapes inside destinations and attribute values are never owned by Text.
fn inline_trial(escape: &Escape, fact: &Fact, label: bool) -> bool {
    if escape.plain.is_whitespace() || matches!(escape.plain, '\\' | '{' | '#') {
        return false;
    }
    if label && matches!(escape.plain, '[' | ']') {
        return false;
    }
    if fact.line_start && escape.plain == '[' {
        return false;
    }
    if fact.line_start
        && matches!(
            escape.plain,
            '-' | '+' | '*' | '_' | '~' | '`' | '>' | '<' | ':' | '='
        )
    {
        return false;
    }
    !(fact.ordered_marker && matches!(escape.plain, '.' | ')'))
}

fn remove_inert(source: &str, escapes: &[Escape], facts: &Facts) -> (String, Vec<Escape>) {
    let mut out = String::with_capacity(source.len());
    let mut pending = Vec::new();
    let mut cursor = 0;
    for (escape, facts) in escapes.iter().zip(&facts.0) {
        out.push_str(&source[cursor..escape.index]);
        if inert(source, escape, facts) {
            out.push(escape.plain);
        } else {
            pending.push(Escape {
                index: out.len(),
                ..escape.clone()
            });
            out.push_str(&source[escape.index..escape.index + escape.length]);
        }
        cursor = escape.index + escape.length;
    }
    out.push_str(&source[cursor..]);
    (out, pending)
}

#[derive(Clone, Copy)]
struct Fact {
    line_start: bool,
    ordered_marker: bool,
}

struct Facts(Vec<Fact>);

impl Facts {
    /// Earlier text escapes have not been removed yet. Decode them for the
    /// conservative line-start test: a retained space reference can only prevent
    /// a Block marker, never create one where this decoded prefix forbids it.
    fn new(source: &str, escapes: &[Escape]) -> Self {
        let mut line_start = true;
        let mut digits = Some(0_usize);
        let mut cursor = 0;
        let mut facts = Vec::with_capacity(escapes.len());
        let consume = |c: char, line_start: &mut bool, digits: &mut Option<usize>| {
            if c == '\n' {
                *line_start = true;
                *digits = Some(0);
                return;
            }
            if *line_start && matches!(c, ' ' | '\t') {
                return;
            }
            *line_start = false;
            *digits = if c.is_ascii_digit() {
                digits.map(|n| n + 1)
            } else {
                None
            };
        };
        for escape in escapes {
            for c in source[cursor..escape.index].chars() {
                consume(c, &mut line_start, &mut digits);
            }
            facts.push(Fact {
                line_start,
                ordered_marker: digits.is_some_and(|n| (1..=9).contains(&n)),
            });
            consume(escape.plain, &mut line_start, &mut digits);
            cursor = escape.index + escape.length;
        }
        Self(facts)
    }
}

fn inert(source: &str, escape: &Escape, facts: &Fact) -> bool {
    let before = &source[..escape.index];
    let after = &source[escape.index + escape.length..];
    let previous = before.chars().next_back();
    match escape.plain {
        // No text-owned opener can precede these: earlier punctuation is still escaped.
        '"' | '\'' | '%' | ',' | '/' | ';' | '?' | '^' | '}' => true,
        // A period can complete an ordered marker only at a line's start, or
        // start a bare www URL. Earlier text-owned URL punctuation is escaped;
        // callers disable these rules entirely around writer-owned bare URLs.
        '.' => {
            !facts.ordered_marker
                && !before
                    .get(before.len().saturating_sub(3)..)
                    .is_some_and(|s| s.eq_ignore_ascii_case("www"))
        }
        // These open only Block syntax. A non-whitespace prefix within Text
        // remains on the line, including after the enclosing list/quote marker.
        '-' | '+' | '>' | '=' => !facts.line_start,
        // A closing ATX hash run must also start after whitespace. Leave runs
        // adjacent to another hash to the oracle, since it may be writer-owned.
        '#' => !facts.line_start && previous.is_some_and(|c| !c.is_whitespace() && c != '#'),
        // Destinations are writer-owned syntax, not escaped text. An opening
        // parenthesis can therefore introduce a link only immediately after a
        // closing label; a closing one can otherwise form only an ordered marker.
        // The caller first proves the seed exact, so removing a LaTeX escape
        // cannot silently repair one of several already-wrong math regions.
        '(' => escape.length > 2 && previous != Some(']'),
        ')' => escape.length > 2 && !facts.ordered_marker,
        '!' => {
            !after.starts_with(['[']) && !after.starts_with("\\[") && !after.starts_with("&#91;")
        }
        ':' => after
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphabetic() && !matches!(c, '\\' | ':' | '/' | '&')),
        '_' => {
            previous.is_some_and(|c| c.is_ascii_alphanumeric())
                && after
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

/// Keep neighboring syntax whole: an atom's token supplies its emphasis flank,
/// which can differ from the punctuation that starts its written form.
pub(super) fn needs_span(delimiter: &str, inner: &str, before: &str, after: &str) -> bool {
    let candidate = format!("{before}{delimiter}{inner}{delimiter}{after}");
    let protected = format!("{before}:span[{delimiter}{inner}{delimiter}]{after}");
    let expected = read(&protected, ReadOptions::EXACT);
    expected.is_err() || read(&candidate, ReadOptions::EXACT) != expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_batch_equivalence_does_not_prove_each_greedy_removal() {
        let value = "[a@b.com";
        let expected = vec![crate::Block::new(crate::BlockKind::Paragraph {
            text: vec![crate::Inline::Text {
                text: value.into(),
                style: crate::Style::default(),
            }],
            colors: crate::Colors::default(),
        })];
        assert_eq!(read(value, ReadOptions::EXACT), Ok(expected.clone()));
        let canonical = Text::escaped(value).minimize(str::to_owned, false, Some(expected));
        assert_ne!(canonical, value);
    }

    #[test]
    fn owned_wrappers_match_exhaustive_trials_with_cjk_and_literal_syntax() {
        use super::super::inline::{self, Position};
        use crate::{Block, BlockKind, Colors, Inline, Style, StyledText};
        for value in [
            "中文 *文字*，snake_case",
            "[a@b.com",
            "[label](url)",
            ":span[x]{underline}",
            "`code` $$math$$",
            "\\[x\\] \\(y\\)",
            "Ends with {color=\"red\"}",
            "<div>x</div>",
            "***___~~~",
            "a\nb* c",
        ] {
            for style in [
                Style::default(),
                Style {
                    bold: true,
                    italic: true,
                    ..Style::default()
                },
                Style {
                    underline: true,
                    strike: true,
                    ..Style::default()
                },
                Style {
                    code: true,
                    bold: true,
                    ..Style::default()
                },
            ] {
                let items = vec![
                    Inline::Text {
                        text: value.into(),
                        style: style.clone(),
                    },
                    Inline::Link {
                        href: "https://example.com".into(),
                        content: vec![StyledText {
                            text: value.into(),
                            style,
                        }],
                    },
                    Inline::Math {
                        source: value.into(),
                    },
                    Inline::Text {
                        text: format!(" {value}"),
                        style: Style::default(),
                    },
                ];
                let expected = vec![Block::new(BlockKind::Paragraph {
                    text: items.clone(),
                    colors: Colors::default(),
                })];
                let encoded = inline::text(&items, Position::Text);
                assert_eq!(
                    encoded
                        .clone()
                        .minimize(str::to_owned, true, Some(expected.clone())),
                    encoded.minimize(str::to_owned, false, Some(expected)),
                    "{value:?}"
                );
            }
        }
    }

    #[test]
    fn fast_paths_match_plain_reader_trials() {
        let alphabet: Vec<_> = "ab 中，。\n\t01*_[].()<>#-+!|{}:$`\\&,%'/;?^=@"
            .chars()
            .collect();
        let mut random = 0xe7a9_0135_u64;
        for marker in "*_`$#|->+\\".chars() {
            for length in 2..32 {
                let value = marker.to_string().repeat(length);
                let wrap = |s: &str| s.to_owned();
                let encoded = Text::escaped(&value);
                assert_eq!(
                    encoded.clone().minimize(wrap, true, None),
                    encoded.minimize(wrap, false, None),
                    "run {value:?}"
                );
            }
        }
        for index in 0..1200 {
            let mut value = String::new();
            for _ in 0..(index % 48 + 1) {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                value.push(alphabet[random as usize % alphabet.len()]);
            }
            for context in 0..8 {
                let wrap = |s: &str| match context {
                    0 => s.to_owned(),
                    1 => format!("- {s}"),
                    2 => format!(":::toggle[{s}]\n:::"),
                    3 => format!("| {s} |\n| --- |"),
                    4 => format!("> {s}"),
                    5 => format!("# {s}"),
                    6 => format!("**{s}**"),
                    _ => format!(":span[{s}]{{underline}}"),
                };
                let encoded = Text::escaped(&value);
                let exhaustive = encoded.clone().minimize(wrap, false, None);
                assert_eq!(
                    encoded.clone().minimize(wrap, true, None),
                    exhaustive,
                    "{value:?} in context {context}"
                );
                if let Ok(expected) = read(&wrap(&exhaustive), ReadOptions::EXACT) {
                    assert_eq!(
                        encoded.minimize(wrap, true, Some(expected)),
                        exhaustive,
                        "expected {value:?} in context {context}"
                    );
                }
            }
        }
    }

    #[test]
    fn ordinary_prefix_windows_match_exhaustive_trials() {
        for prefix in [
            "plain first line",
            "中英文，plain prose.",
            "ordinary words, with punctuation!",
            "space at end ",
        ] {
            for suffix in [
                "*a* _b_",
                "1. item",
                "1) item",
                "- item",
                "> quote",
                "# title",
                "| table |",
                "[a@b.com",
                "[label](url)",
                "\\[math\\] (details)",
                "`code`",
                "x {color=\"red\"}",
                "中*文*。",
                "   indented text *",
                "*styled*\nthird line",
            ] {
                let value = format!("{prefix}\n{suffix}");
                for marker in ["", "- ", "> ", "# ", "| "] {
                    let wrap = |s: &str| format!("{marker}{s}");
                    let encoded = Text::escaped(&value);
                    assert_eq!(
                        encoded.clone().minimize(wrap, true, None),
                        encoded.minimize(wrap, false, None),
                        "{marker}{value:?}"
                    );
                }
            }
        }
    }
}
