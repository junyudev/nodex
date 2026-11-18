use std::ops::Range;

use icu_properties::{
    CodePointMapData, CodePointSetData,
    props::{EmojiPresentation, ExtendedPictographic, GeneralCategory, Script},
};
use serde::{Deserialize, Serialize};
use unicode_normalization::{
    UnicodeNormalization,
    char::{canonical_combining_class, compose, is_combining_mark},
};
use unicode_segmentation::UnicodeSegmentation;

/// Bump when folding or segmentation output changes. Persisted indexes use this identity.
pub const ANALYZER_VERSION: u32 = 1;

/// A folded segment and its half-open UTF-8 byte range in the original text.
/// Compatibility expansions can produce several segments with the same range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Segment {
    pub folded: String,
    pub start: usize,
    pub end: usize,
}

pub(crate) struct AnalyzedSegment {
    pub segment: Segment,
    // Each folded unit maps back to a whole original grapheme.
    units: Vec<(Range<usize>, Range<usize>)>,
}

impl AnalyzedSegment {
    pub fn original_range(&self, folded: Range<usize>) -> Range<usize> {
        let mut overlapping = self
            .units
            .iter()
            .filter(|(range, _)| range.start < folded.end && range.end > folded.start);
        let (_, first) = overlapping.next().expect("nonempty folded match");
        let end = overlapping
            .next_back()
            .map_or(first.end, |(_, last)| last.end);
        first.start..end
    }
}

pub fn analyze(text: &str) -> Vec<Segment> {
    analyze_with_offsets(text)
        .into_iter()
        .map(|item| item.segment)
        .collect()
}

/// Fold text while preserving whitespace and punctuation. Use `analyze` for
/// segmentation, which also removes apostrophes internal to a word.
pub fn fold(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    fold_normalized(&text.nfkc().collect::<String>())
}

fn fold_normalized(text: &str) -> String {
    let mut strip_marks = false;
    text.nfd()
        .filter_map(|ch| {
            if is_combining_mark(ch) {
                return (!strip_marks).then_some(ch);
            }
            strip_marks = ch.is_alphabetic()
                && matches!(script(ch), Script::Latin | Script::Greek | Script::Cyrillic);
            Some(match ch {
                '‘' | '’' => '\'',
                _ => ch,
            })
        })
        .flat_map(char::to_lowercase)
        .nfc()
        .collect()
}

fn script(ch: char) -> Script {
    CodePointMapData::<Script>::new().get(ch)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Letter,
    Digit,
    Solo,
    Apostrophe,
    Separator,
}

struct Unit {
    kind: Kind,
    ch: char,
    folded: String,
    original: Range<usize>,
}

fn emoji(grapheme: &str) -> bool {
    grapheme.ends_with('\u{20e3}')
        || grapheme.chars().any(|ch| {
            CodePointSetData::new::<EmojiPresentation>().contains(ch)
                || CodePointSetData::new::<ExtendedPictographic>().contains(ch)
        })
}

// A compatibility decomposition can compose across an original grapheme
// boundary, for example Korean compatibility jamo ㄱㅏ. Extend that source
// range before applying the ordinary segment rules.
fn normalized_graphemes(text: &str) -> Vec<(String, Range<usize>)> {
    let mut graphemes = Vec::<(String, Range<usize>)>::new();
    for (start, grapheme) in text.grapheme_indices(true) {
        let normalized = grapheme.nfkc().collect::<String>();
        let end = start + grapheme.len();
        if let Some((previous, range)) = graphemes.last_mut()
            && let Some(first) = normalized.chars().next()
            && (canonical_combining_class(first) != 0
                || previous
                    .chars()
                    .next_back()
                    .is_some_and(|last| compose(last, first).is_some()))
        {
            previous.push_str(&normalized);
            *previous = previous.nfkc().collect();
            range.end = end;
        } else {
            graphemes.push((normalized, start..end));
        }
    }
    graphemes
}

fn unicode_units(text: &str) -> Vec<Unit> {
    let mut units = Vec::<Unit>::new();
    for (normalized, original) in normalized_graphemes(text) {
        if emoji(&normalized) {
            units.push(Unit {
                kind: Kind::Solo,
                ch: '\0',
                folded: normalized,
                original,
            });
            continue;
        }
        let mut chars = normalized.chars().peekable();
        while let Some(ch) = chars.next() {
            let kind = match ch {
                '\'' | '‘' | '’' => Kind::Apostrophe,
                _ if matches!(
                    script(ch),
                    Script::Han | Script::Hiragana | Script::Katakana
                ) || matches!(ch, 'ー' | 'ｰ') =>
                {
                    Kind::Solo
                }
                _ if !is_combining_mark(ch) && ch.is_alphabetic() => Kind::Letter,
                _ if CodePointMapData::<GeneralCategory>::new().get(ch)
                    == GeneralCategory::DecimalNumber =>
                {
                    Kind::Digit
                }
                _ => Kind::Separator,
            };
            let spelling = std::iter::once(ch)
                .chain(std::iter::from_fn(|| {
                    chars.next_if(|c| is_combining_mark(*c))
                }))
                .collect::<String>();
            units.push(Unit {
                kind,
                ch,
                folded: fold_normalized(&spelling),
                original: original.clone(),
            });
        }
    }

    units
}

fn ascii_units(text: &str) -> Vec<Unit> {
    text.bytes()
        .enumerate()
        .map(|(index, byte)| Unit {
            kind: match byte {
                b'a'..=b'z' | b'A'..=b'Z' => Kind::Letter,
                b'0'..=b'9' => Kind::Digit,
                b'\'' => Kind::Apostrophe,
                _ => Kind::Separator,
            },
            ch: char::from(byte),
            folded: char::from(byte.to_ascii_lowercase()).to_string(),
            original: index..index + 1,
        })
        .collect()
}

pub(crate) fn analyze_with_offsets(text: &str) -> Vec<AnalyzedSegment> {
    let units = if text.is_ascii() {
        ascii_units(text)
    } else {
        unicode_units(text)
    };
    segment_units(&units)
}

fn segment_units(units: &[Unit]) -> Vec<AnalyzedSegment> {
    let mut segments = Vec::<AnalyzedSegment>::new();
    let mut previous: Option<&Unit> = None;
    let mut joined_apostrophe = false;
    for (i, unit) in units.iter().enumerate() {
        let next = units.get(i + 1);
        if unit.kind == Kind::Apostrophe
            && previous.is_some_and(is_letter)
            && next.is_some_and(is_letter)
        {
            joined_apostrophe = true;
            continue;
        }
        if matches!(unit.kind, Kind::Separator | Kind::Apostrophe) {
            previous = None;
            continue;
        }
        if previous.is_none_or(|p| starts_segment(p, unit, next, joined_apostrophe)) {
            segments.push(AnalyzedSegment {
                segment: Segment {
                    folded: String::new(),
                    start: unit.original.start,
                    end: unit.original.end,
                },
                units: Vec::new(),
            });
        }
        let segment = segments.last_mut().expect("segment was started");
        let offset = segment.segment.folded.len();
        segment.segment.folded.push_str(&unit.folded);
        segment.segment.end = unit.original.end;
        segment
            .units
            .push((offset..segment.segment.folded.len(), unit.original.clone()));
        previous = Some(unit);
        joined_apostrophe = false;
    }
    segments
}

fn is_letter(unit: &Unit) -> bool {
    unit.ch.is_alphabetic()
}

fn starts_segment(
    previous: &Unit,
    current: &Unit,
    next: Option<&Unit>,
    joined_apostrophe: bool,
) -> bool {
    previous.kind != current.kind
        || current.kind == Kind::Solo
        || (!joined_apostrophe
            && current.ch.is_uppercase()
            && (previous.ch.is_lowercase()
                || (previous.ch.is_uppercase() && next.is_some_and(|n| n.ch.is_lowercase()))))
}

/// Find nonoverlapping literal occurrences after folding. The returned
/// half-open ranges use UTF-16 offsets for editors and the DOM.
#[cfg(any(test, feature = "wasm"))]
pub(crate) fn find_literal_ranges(query: &str, text: &str) -> Vec<Range<usize>> {
    let needle = fold(query);
    if needle.is_empty() {
        return Vec::new();
    }
    if text.is_ascii() {
        return text
            .to_ascii_lowercase()
            .match_indices(&needle)
            .map(|(start, matched)| start..start + matched.len())
            .collect();
    }
    let mut folded = String::new();
    let mut offsets = Vec::new();
    let mut offset = 0;
    for (normalized, original) in normalized_graphemes(text) {
        let end = offset + text[original].encode_utf16().count();
        let start = folded.len();
        folded.push_str(&fold_normalized(&normalized));
        if folded.len() > start {
            offsets.push((folded.len(), offset..end));
        }
        offset = end;
    }

    let mut ranges = Vec::<Range<usize>>::new();
    for (start, matched) in folded.match_indices(&needle) {
        let first = offsets.partition_point(|(end, _)| *end <= start);
        let last = offsets.partition_point(|(end, _)| *end < start + matched.len());
        let range = offsets[first].1.start..offsets[last].1.end;
        if ranges
            .last()
            .is_none_or(|previous| previous.end <= range.start)
        {
            ranges.push(range);
        }
    }
    ranges
}

#[cfg(test)]
mod literal_tests {
    use super::*;

    #[test]
    fn ascii_words_preserve_unicode_word_rules_and_offsets() {
        let all_bytes = (0..128).map(char::from).collect::<String>();
        for text in [all_bytes.as_str(), "Don't use PageSearch_123.\r\n#LAB-13 *"] {
            assert_eq!(
                segment_units(&ascii_units(text))
                    .into_iter()
                    .map(|item| (item.segment, item.units))
                    .collect::<Vec<_>>(),
                segment_units(&unicode_units(text))
                    .into_iter()
                    .map(|item| (item.segment, item.units))
                    .collect::<Vec<_>>(),
            );
            assert_eq!(fold(text), fold_normalized(text));
        }
    }

    #[test]
    // Every expectation is a list of matched ranges, including the one that matches once.
    #[allow(clippy::single_range_in_vec_init)]
    fn literal_ranges_keep_original_utf16_offsets_when_folding_changes_length() {
        assert_eq!(
            find_literal_ranges("cafe", "😀 ＣＡＦÉ Cafe\u{301}"),
            [3..7, 8..13]
        );
        assert_eq!(find_literal_ranges("ff", "xﬃy"), [1..2]);
        assert_eq!(find_literal_ranges("ㄱㅏ", "x가 ㄱㅏ"), [1..2, 3..5]);
        assert!(find_literal_ranges("か", "が").is_empty());
    }
}

#[cfg(test)]
#[test]
fn analyzer_output_is_versioned() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/analyzer-output.json")).unwrap();
    assert_eq!(fixture["version"], ANALYZER_VERSION);
    let actual = fixture["corpus"]
        .as_array()
        .unwrap()
        .iter()
        .map(|text| {
            let text = text.as_str().unwrap();
            serde_json::json!([
                fold(text),
                analyze(text)
                    .into_iter()
                    .map(|segment| (segment.folded, segment.start, segment.end))
                    .collect::<Vec<_>>()
            ])
        })
        .collect::<Vec<_>>();
    assert_eq!(
        fixture["output"],
        serde_json::json!(actual),
        "Bump ANALYZER_VERSION and refresh the analyzer fixture when output changes"
    );
}
