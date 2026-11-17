use std::{collections::HashSet, ops::Range};

use rust_stemmers::{Algorithm, Stemmer};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::analyzer::{AnalyzedSegment, analyze, analyze_with_offsets, fold};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchQuality {
    Exact,
    Prefix,
    Joined,
    Stem,
    Typo,
    Infix,
}

impl MatchQuality {
    pub fn is_strong(self) -> bool {
        self <= Self::Stem
    }

    /// The field ordinal runs from Page key through body (0 through 4).
    pub fn rank(self, field: usize) -> usize {
        if self.is_strong() {
            return field * 4 + self as usize;
        }
        20 + (self as usize - Self::Typo as usize) * 5 + field
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextKind {
    Metadata,
    LongText,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TextPart {
    pub text: String,
    pub highlighted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TextMatch {
    pub quality: MatchQuality,
    pub parts: Vec<TextPart>,
}

#[derive(Debug)]
pub struct QueryWord {
    text: String,
    original: String,
    segments: Vec<String>,
    stem: Option<String>,
}

impl QueryWord {
    pub fn text(&self) -> &str {
        &self.text
    }

    /// NFKC spelling with case preserved, before segment folding.
    pub fn original(&self) -> &str {
        &self.original
    }

    /// Verify an analyzed dictionary term for a single-segment query word.
    /// Enable typo only if the word has no strong evidence in the corpus.
    pub fn classify_segment(
        &self,
        segment: &str,
        kind: TextKind,
        allow_typo: bool,
    ) -> Option<MatchQuality> {
        let [needle] = self.segments.as_slice() else {
            return None;
        };
        self.direct_quality(needle, segment, kind)
            .or_else(|| self.stem_prefix(segment).map(|_| MatchQuality::Stem))
            .or_else(|| loose_segment(needle, segment, allow_typo).map(|(_, quality, _)| quality))
    }

    /// Match this word against original text using the caller's corpus-wide
    /// typo decision. Multi-segment words still require an ordered phrase.
    pub fn match_text(&self, text: &str, kind: TextKind, allow_typo: bool) -> Option<TextMatch> {
        let matched = match_word(self, &analyze_with_offsets(text), kind, allow_typo)?;
        Some(TextMatch {
            quality: matched.quality,
            parts: highlight_parts(text, matched.ranges),
        })
    }

    fn direct_quality(&self, needle: &str, segment: &str, kind: TextKind) -> Option<MatchQuality> {
        if segment == needle {
            Some(MatchQuality::Exact)
        } else if segment.starts_with(needle) && self.allows_prefix(kind) {
            Some(MatchQuality::Prefix)
        } else {
            None
        }
    }

    fn stem_prefix(&self, segment: &str) -> Option<usize> {
        let stem = self.stem()?;
        segment.starts_with(stem).then_some(stem.len())
    }

    /// Whether this word's final segment may be a prefix in an indexed phrase.
    pub fn allows_prefix(&self, kind: TextKind) -> bool {
        if kind == TextKind::Metadata || self.segments.len() != 1 {
            return true;
        }
        let mut chars = self.segments[0].chars();
        let first = chars.next().expect("nonempty segment");
        chars.next().is_some()
            || (!first.is_numeric()
                && icu_properties::CodePointMapData::<icu_properties::props::Script>::new()
                    .get(first)
                    != icu_properties::props::Script::Latin)
    }

    pub fn stem(&self) -> Option<&str> {
        self.stem.as_deref()
    }

    pub fn segments(&self) -> &[String] {
        &self.segments
    }
}

const OPTIONAL_WORDS: &[&str] = &[
    "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
];

/// Parse the required query words. Optional words are required in an
/// all-optional query. Words with no searchable segments are ignored.
pub fn query_words(query: &str) -> Vec<QueryWord> {
    let normalized = query.nfkc().collect::<String>();
    let mut seen = HashSet::new();
    let mut words = normalized
        .split_whitespace()
        .map(|word| word.trim_matches(['"', '“', '”', '‘', '’', '\'']))
        .filter_map(|word| {
            let text = fold(word);
            let segments = analyze(word)
                .into_iter()
                .map(|segment| segment.folded)
                .collect::<Vec<_>>();
            if segments.is_empty() || !seen.insert(text.clone()) {
                return None;
            }
            let stem = match segments.as_slice() {
                [segment]
                    if segment.len() >= 5 && segment.bytes().all(|ch| ch.is_ascii_alphabetic()) =>
                {
                    Some(
                        Stemmer::create(Algorithm::English)
                            .stem(segment)
                            .into_owned(),
                    )
                }
                _ => None,
            };
            Some(QueryWord {
                text,
                original: word.to_owned(),
                segments,
                stem,
            })
        })
        .collect::<Vec<_>>();
    if words
        .iter()
        .any(|word| !OPTIONAL_WORDS.contains(&word.text()))
    {
        words.retain(|word| !OPTIONAL_WORDS.contains(&word.text()));
    }
    words
}

pub(crate) struct WordMatch {
    pub quality: MatchQuality,
    pub distance: usize,
    pub ranges: Vec<Range<usize>>,
}

#[derive(Clone, Copy)]
enum MatchPass {
    Strong,
    Loose { allow_typo: bool },
}

pub(crate) fn match_word(
    word: &QueryWord,
    segments: &[AnalyzedSegment],
    kind: TextKind,
    allow_typo: bool,
) -> Option<WordMatch> {
    match_word_pass(word, segments, kind, MatchPass::Strong)
        .or_else(|| match_word_pass(word, segments, kind, MatchPass::Loose { allow_typo }))
}

pub(crate) fn strong_word(word: &QueryWord, segments: &[AnalyzedSegment]) -> Option<WordMatch> {
    match_word_pass(word, segments, TextKind::Metadata, MatchPass::Strong)
}

pub(crate) fn loose_word(
    word: &QueryWord,
    segments: &[AnalyzedSegment],
    allow_typo: bool,
) -> Option<WordMatch> {
    match_word_pass(
        word,
        segments,
        TextKind::Metadata,
        MatchPass::Loose { allow_typo },
    )
}

fn match_word_pass(
    word: &QueryWord,
    segments: &[AnalyzedSegment],
    kind: TextKind,
    pass: MatchPass,
) -> Option<WordMatch> {
    let mut best: Option<WordMatch> = None;
    for (i, segment) in segments.iter().enumerate() {
        let hit = match pass {
            MatchPass::Strong => direct_match(word, &segments[i..], kind)
                .map(|(_, range, quality)| (range, quality, 0))
                .or_else(|| {
                    (kind == TextKind::Metadata)
                        .then(|| joined_match(word, &segments[i..]))
                        .flatten()
                        .map(|range| (range, MatchQuality::Joined, 0))
                })
                .or_else(|| {
                    let end = word.stem_prefix(&segment.segment.folded)?;
                    Some((segment.original_range(0..end), MatchQuality::Stem, 0))
                }),
            MatchPass::Loose { allow_typo } => {
                let [needle] = word.segments.as_slice() else {
                    return None;
                };
                loose_segment(needle, &segment.segment.folded, allow_typo).map(
                    |(range, quality, distance)| (segment.original_range(range), quality, distance),
                )
            }
        };
        let Some((range, quality, distance)) = hit else {
            continue;
        };
        if let Some(best) = &mut best
            && (quality, distance) >= (best.quality, best.distance)
        {
            if (quality, distance) == (best.quality, best.distance) {
                best.ranges.push(range);
            }
            continue;
        }
        best = Some(WordMatch {
            quality,
            distance,
            ranges: vec![range],
        });
    }
    best
}

fn direct_match(
    word: &QueryWord,
    field: &[AnalyzedSegment],
    kind: TextKind,
) -> Option<(usize, Range<usize>, MatchQuality)> {
    let (last, head) = word.segments.split_last()?;
    let tail = field.get(head.len())?;
    if !head
        .iter()
        .zip(field)
        .all(|(needle, segment)| needle == &segment.segment.folded)
    {
        return None;
    }
    let quality = word.direct_quality(last, &tail.segment.folded, kind)?;
    Some((
        word.segments.len(),
        field[0].segment.start..tail.original_range(0..last.len()).end,
        quality,
    ))
}

fn joined_match(word: &QueryWord, field: &[AnalyzedSegment]) -> Option<Range<usize>> {
    let [needle] = word.segments.as_slice() else {
        return None;
    };
    let mut rest = needle.as_str();
    for (i, segment) in field.iter().enumerate() {
        rest = rest.strip_prefix(&segment.segment.folded)?;
        if rest.is_empty() {
            return (i > 0).then(|| field[0].segment.start..segment.segment.end);
        }
    }
    None
}

/// Checks whether all required query words appear consecutively in one field.
pub fn matches_ordered(words: &[QueryWord], text: &str, kind: TextKind) -> bool {
    matches_in_order(words, &analyze_with_offsets(text), kind)
}

/// Highlight the first ordered phrase, or each word's best spelling match.
pub fn match_words(
    text: &str,
    words: &[QueryWord],
    kind: TextKind,
    allow_typo: impl Fn(usize) -> bool,
) -> Option<Vec<TextMatch>> {
    let field = analyze_with_offsets(text);
    if let Some((mut offset, _)) = ordered_phrase(words, &field, kind) {
        return words
            .iter()
            .map(|word| {
                let (used, range, quality) = direct_match(word, &field[offset..], kind)?;
                offset += used;
                Some(TextMatch {
                    quality,
                    parts: highlight_parts(text, vec![range]),
                })
            })
            .collect();
    }
    words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let matched = match_word(word, &field, kind, allow_typo(index))?;
            Some(TextMatch {
                quality: matched.quality,
                parts: highlight_parts(text, matched.ranges),
            })
        })
        .collect()
}

pub(crate) fn matches_in_order(
    words: &[QueryWord],
    field: &[AnalyzedSegment],
    kind: TextKind,
) -> bool {
    ordered_phrase(words, field, kind).is_some()
}

pub(crate) fn ordered_phrase(
    words: &[QueryWord],
    field: &[AnalyzedSegment],
    kind: TextKind,
) -> Option<(usize, Range<usize>)> {
    if words.len() < 2 {
        return None;
    }
    (0..field.len()).find_map(|start| {
        let mut offset = start;
        let first = field[start].segment.start;
        let mut end = first;
        for word in words {
            let (used, range, _) = direct_match(word, &field[offset..], kind)?;
            offset += used;
            end = range.end;
        }
        Some((start, first..end))
    })
}

pub(crate) fn highlight_parts(text: &str, mut ranges: Vec<Range<usize>>) -> Vec<TextPart> {
    ranges.sort_unstable_by_key(|range| (range.start, range.end));
    let mut parts = Vec::new();
    let mut cursor = 0;
    for range in ranges {
        if range.end <= cursor {
            continue;
        }
        if range.start > cursor {
            parts.push(TextPart {
                text: text[cursor..range.start].to_owned(),
                highlighted: false,
            });
        }
        if range.start <= cursor
            && let Some(last) = parts.last_mut()
        {
            last.text.push_str(&text[cursor..range.end]);
        } else {
            parts.push(TextPart {
                text: text[range.start..range.end].to_owned(),
                highlighted: true,
            });
        }
        cursor = range.end;
    }
    if cursor < text.len() {
        parts.push(TextPart {
            text: text[cursor..].to_owned(),
            highlighted: false,
        });
    }
    parts
}

fn loose_segment(
    needle: &str,
    field: &str,
    allow_typo: bool,
) -> Option<(Range<usize>, MatchQuality, usize)> {
    if allow_typo && let Some((end, distance)) = typo_prefix(needle, field) {
        return Some((0..end, MatchQuality::Typo, distance));
    }
    infix(needle, field).map(|range| (range, MatchQuality::Infix, 0))
}

pub(crate) fn infix(needle: &str, field: &str) -> Option<Range<usize>> {
    if needle.chars().count() < 4 || field.starts_with(needle) {
        return None;
    }
    let start = field.find(needle)?;
    Some(start..start + needle.len())
}

pub(crate) fn typo_prefix(needle: &str, field: &str) -> Option<(usize, usize)> {
    let mut query_chars = needle.chars();
    let first = query_chars.next()?;
    let second = query_chars.next()?;
    let mut field_chars = field.chars();
    let field_first = field_chars.next()?;
    let field_second = field_chars.next()?;
    let swap_first = first != field_first && first == field_second && second == field_first;
    if first != field_first && !swap_first {
        return None;
    }
    let length = needle.chars().count();
    if length < 4 || !needle.chars().any(char::is_alphabetic) || field.starts_with(needle) {
        return None;
    }
    let query = needle.chars().collect::<Vec<_>>();
    let target = field.chars().take(length + 2).collect::<Vec<_>>();
    let (used, distance) = if length == 4 {
        let position = (0..3).find(|&i| {
            target.get(..4).is_some_and(|target| {
                query[i] != query[i + 1]
                    && query[..i] == target[..i]
                    && query[i] == target[i + 1]
                    && query[i + 1] == target[i]
                    && query[i + 2..] == target[i + 2..]
            })
        })?;
        debug_assert!(!swap_first || position == 0);
        (4, 1)
    } else {
        let budget = if length >= 9 { 2 } else { 1 };
        let (skip, spent) = if swap_first { (2, 1) } else { (1, 0) };
        let (used, edits) = bounded_prefix(&query[skip..], &target[skip..], budget - spent)?;
        (used + skip, edits + spent)
    };
    Some((
        target[..used].iter().map(|ch| ch.len_utf8()).sum(),
        distance,
    ))
}

// At the first mismatch, try one edit. The budget (at most two) bounds the
// branching, and stopping when the query is consumed permits a target prefix.
fn bounded_prefix(query: &[char], target: &[char], budget: usize) -> Option<(usize, usize)> {
    let common = query.iter().zip(target).take_while(|(a, b)| a == b).count();
    let (query, target) = (&query[common..], &target[common..]);
    if query.is_empty() {
        return Some((common, 0));
    }
    if budget == 0 {
        return None;
    }
    let mut edits = vec![(1, 0)];
    if !target.is_empty() {
        edits.extend([(0, 1), (1, 1)]);
    }
    if query.len() >= 2 && target.len() >= 2 && query[0] == target[1] && query[1] == target[0] {
        edits.push((2, 2));
    }
    edits
        .into_iter()
        .filter_map(|(q, t)| {
            let (used, distance) = bounded_prefix(&query[q..], &target[t..], budget - 1)?;
            Some((common + t + used, distance + 1))
        })
        .min_by_key(|(used, distance)| (*distance, std::cmp::Reverse(*used)))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RowMatch {
    pub index: usize,
    /// Lower scores rank first. Equal scores preserve input order.
    pub rank: usize,
}

/// Search a collection of short projections. Fields are ordered by priority,
/// with fields of the same priority kept at the same position in every row.
pub fn match_text_rows(query: &str, rows: &[Vec<(&str, TextKind)>]) -> Vec<RowMatch> {
    if query.trim().is_empty() {
        return (0..rows.len())
            .map(|index| RowMatch { index, rank: 0 })
            .collect();
    }
    let words = query_words(query);
    if words.is_empty() {
        return Vec::new();
    }
    let field_count = rows.iter().map(Vec::len).max().unwrap_or_default();
    let rows = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|(text, kind)| (analyze_with_offsets(text), *kind))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut ranks = vec![Some(0); rows.len()];
    for word in &words {
        let strong = rows
            .iter()
            .map(|row| {
                row.iter()
                    .enumerate()
                    .find_map(|(field, (segments, kind))| {
                        let matched = match_word_pass(word, segments, *kind, MatchPass::Strong)?;
                        Some(field * 4 + matched.quality as usize)
                    })
            })
            .collect::<Vec<_>>();
        let allow_typo = strong.iter().all(Option::is_none);
        for ((rank, row), strong) in ranks.iter_mut().zip(&rows).zip(strong) {
            let Some(previous) = *rank else { continue };
            let best = strong.or_else(|| {
                row.iter()
                    .enumerate()
                    .find_map(|(field, (segments, kind))| {
                        let matched = match_word_pass(
                            word,
                            segments,
                            *kind,
                            MatchPass::Loose { allow_typo },
                        )?;
                        Some(
                            field_count * 4 + field * 2 + matched.quality as usize
                                - MatchQuality::Typo as usize,
                        )
                    })
            });
            *rank = best.map(|best| previous.max(best));
        }
    }
    let mut hits = ranks
        .into_iter()
        .enumerate()
        .filter_map(|(index, rank)| {
            let rank = rank?;
            let ordered = rows[index]
                .iter()
                .any(|(segments, kind)| matches_in_order(&words, segments, *kind));
            Some(RowMatch {
                index,
                rank: rank * 2 + usize::from(!ordered),
            })
        })
        .collect::<Vec<_>>();
    hits.sort_by_key(|hit| hit.rank);
    hits
}

#[cfg(test)]
mod row_tests {
    use super::*;

    #[test]
    fn rows_rank_by_weakest_word_and_can_match_across_fields() {
        use TextKind::{LongText, Metadata};
        let rows = [
            vec![("Café", Metadata), ("数据库迁移方案", LongText)],
            vec![("Café 数据库迁移方案", Metadata)],
            vec![("Cáfe", Metadata), ("other", LongText)],
        ];
        assert_eq!(
            match_text_rows("Ｃａｆｅ 迁移", &rows)
                .iter()
                .map(|hit| hit.index)
                .collect::<Vec<_>>(),
            [1, 0]
        );
    }

    #[test]
    fn a_strong_word_anywhere_disables_only_that_words_typos() {
        use TextKind::Metadata;
        let rows = [
            vec![("ProjectMigartion", Metadata)],
            vec![("ProjectMigration", Metadata), ("Café", Metadata)],
            vec![("premigartion", Metadata), ("Café", Metadata)],
        ];
        let indexes = |query| {
            match_text_rows(query, &rows)
                .into_iter()
                .map(|hit| hit.index)
                .collect::<Vec<_>>()
        };
        assert_eq!(indexes("migartion cafe"), [2]);
        assert_eq!(indexes("migration cfae"), [1]);
        assert_eq!(indexes("ｍｉｇｒａｉｏｎ"), [1]);
    }
}
