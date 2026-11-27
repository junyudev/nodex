//! Comment marks survive projection through Markdown without entering the Markdown language.
use std::collections::BTreeSet;
use std::ops::Range;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use sha2::Digest;
use similar::{Algorithm, DiffOp, capture_diff_slices_deadline};
use unicode_segmentation::UnicodeSegmentation;

use crate::domain::block_materialization::is_comment_mark;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

type Marks = Map<String, Value>;

fn marks(item: &Value) -> Marks {
    item["styles"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| is_comment_mark(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub(crate) fn ids(content: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    visit(content, &mut |item| {
        ids.extend(
            marks(item)
                .values()
                .filter_map(|mark| mark["threadId"].as_str().map(str::to_owned)),
        );
    });
    ids
}

pub(crate) fn quote(content: &Value, id: &str) -> String {
    let mut text = String::new();
    visit(content, &mut |item| {
        if marks(item).values().any(|mark| mark["threadId"] == id) {
            text.push_str(item["text"].as_str().unwrap_or_default());
        }
    });
    text
}

fn visit(value: &Value, text: &mut impl FnMut(&Value)) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| visit(item, text)),
        Value::Object(_) if value["type"] == "text" => text(value),
        Value::Object(fields) => fields.values().for_each(|value| visit(value, text)),
        _ => {}
    }
}

/// Apply (or remove) marks per scalar, coalescing equal adjacent runs.
fn rewrite(value: &mut Value, edit: &mut impl FnMut(char, &Marks) -> Option<Marks>) {
    match value {
        Value::Array(items) => {
            let mut result = Vec::with_capacity(items.len());
            for mut item in std::mem::take(items) {
                if item["type"] == "text" && item["text"].is_string() {
                    let original = marks(&item);
                    let text = item["text"].as_str().unwrap_or_default();
                    let mut runs = Vec::<(Marks, String)>::new();
                    for character in text.chars() {
                        let marks = edit(character, &original).unwrap_or_else(|| original.clone());
                        if let Some((_, run)) =
                            runs.last_mut().filter(|(current, _)| current == &marks)
                        {
                            run.push(character);
                        } else {
                            runs.push((marks, character.to_string()));
                        }
                    }
                    for (marks, text) in runs {
                        let mut run = item.clone();
                        run["text"] = json!(text);
                        let styles = run["styles"]
                            .as_object_mut()
                            .expect("canonical text has styles");
                        styles.retain(|key, _| !is_comment_mark(key));
                        styles.extend(marks);
                        result.push(run);
                    }
                } else {
                    rewrite(&mut item, edit);
                    result.push(item);
                }
            }
            *items = result;
        }
        Value::Object(fields) => fields.values_mut().for_each(|value| rewrite(value, edit)),
        _ => {}
    }
}

pub(crate) fn mark_range(
    content: &mut Value,
    id: &str,
    range: &nodex_core_contracts::discussions::DiscussionTextRange,
) -> Result<String, StoreError> {
    if !content.is_array() || range.from >= range.to || range.expected_text.is_empty() {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Select text in one inline Block",
            false,
        ));
    }
    let mut offset = 0;
    let mut selected = String::new();
    let key = format!(
        "comment--{}",
        STANDARD.encode(&sha2::Sha256::digest(id.as_bytes())[..6])
    );
    let mark = json!({ "orphan": false, "threadId": id });
    let mut exact = true;
    rewrite_inline_range(
        content,
        &mut offset,
        &mut |character, start, end, original| {
            if end <= range.from || start >= range.to {
                return None;
            }
            if start < range.from || end > range.to {
                exact = false;
                return None;
            }
            selected.push(character);
            let mut next = original.clone();
            next.insert(key.clone(), mark.clone());
            Some(next)
        },
    );
    if !exact || offset < range.to || selected != range.expected_text {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "The selected text changed",
            true,
        ));
    }
    Ok(selected)
}

fn rewrite_inline_range(
    content: &mut Value,
    offset: &mut u32,
    edit: &mut impl FnMut(char, u32, u32, &Marks) -> Option<Marks>,
) {
    let Some(items) = content.as_array_mut() else {
        return;
    };
    let mut result = Vec::with_capacity(items.len());
    for item in std::mem::take(items) {
        if matches!(item["type"].as_str(), Some("text" | "link")) {
            let mut run = json!([item]);
            rewrite(&mut run, &mut |character, original| {
                let start = *offset;
                *offset += character.len_utf16() as u32;
                edit(character, start, *offset, original)
            });
            result.extend(run.as_array_mut().into_iter().flatten().map(std::mem::take));
        } else {
            *offset += 1;
            result.push(item);
        }
    }
    *items = result;
}

pub(crate) fn clear_copied_marks(content: &mut Value) {
    if !ids(content).is_empty() {
        rewrite(content, &mut |_, _| Some(Marks::new()));
    }
}

struct WordTokens<'a> {
    tokens: Vec<&'a str>,
    scalar_offsets: Vec<usize>,
}

impl<'a> WordTokens<'a> {
    fn new(text: &'a str) -> Self {
        let tokens: Vec<_> = text.split_word_bounds().collect();
        let scalar_offsets = std::iter::once(0)
            .chain(tokens.iter().scan(0, |offset, token| {
                *offset += token.chars().count();
                Some(*offset)
            }))
            .collect();
        Self {
            tokens,
            scalar_offsets,
        }
    }

    fn scalars(&self, tokens: Range<usize>) -> Range<usize> {
        self.scalar_offsets[tokens.start]..self.scalar_offsets[tokens.end]
    }

    fn content_tokens(&self) -> (Vec<usize>, Vec<&'a str>) {
        self.tokens
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, token)| !token.trim().is_empty())
            .unzip()
    }
}

fn equal_tokens(old: &[&str], new: &[&str]) -> impl Iterator<Item = (usize, usize)> {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let tail = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_end = old.len() - tail;
    let new_end = new.len() - tail;
    // Keep wide edits from holding the Store writer even if the token diff is expensive.
    let deadline = ((old_end - prefix).saturating_mul(new_end - prefix) > 1_000_000)
        .then(|| Instant::now() + Duration::from_millis(100));
    let changes = capture_diff_slices_deadline(
        Algorithm::Myers,
        &old[prefix..old_end],
        &new[prefix..new_end],
        deadline,
    );
    (0..prefix)
        .map(|index| (index, index))
        .chain(changes.into_iter().flat_map(move |op| {
            let (old_index, new_index, len) = match op {
                DiffOp::Equal {
                    old_index,
                    new_index,
                    len,
                } => (old_index, new_index, len),
                _ => (0, 0, 0),
            };
            (0..len).map(move |i| (prefix + old_index + i, prefix + new_index + i))
        }))
        .chain((0..tail).map(move |i| (old_end + i, new_end + i)))
}

fn has_mark(marks: &Marks, id: &str) -> bool {
    marks
        .values()
        .any(|value| value["threadId"].as_str() == Some(id))
}

fn covering_marks<'a>(mut scalars: impl Iterator<Item = &'a Marks>) -> Marks {
    let Some(first) = scalars.next() else {
        return Marks::new();
    };
    let mut common = first.clone();
    for marks in scalars {
        if common.is_empty() {
            break;
        }
        common.retain(|_, mark| {
            mark["threadId"]
                .as_str()
                .is_some_and(|id| has_mark(marks, id))
        });
    }
    common
}

fn replacement_mark(chars: &[char], marks: &[Marks], range: Range<usize>) -> Option<Marks> {
    let common = covering_marks(
        range
            .clone()
            .filter(|&i| !chars[i].is_whitespace())
            .map(|i| &marks[i]),
    );
    let (key, mark) = common.iter().next()?;
    let id = mark["threadId"].as_str()?;
    if common
        .values()
        .any(|other| other["threadId"].as_str() != Some(id))
    {
        return None;
    }
    let before = chars[..range.start]
        .iter()
        .rposition(|c| !c.is_whitespace());
    let after = chars[range.end..]
        .iter()
        .position(|c| !c.is_whitespace())
        .map(|i| range.end + i);
    if before
        .into_iter()
        .chain(after)
        .any(|i| has_mark(&marks[i], id))
    {
        return None;
    }
    Some(Marks::from_iter([(key.clone(), mark.clone())]))
}

pub(crate) fn preserve(old: &Value, new: &mut Value) {
    if ids(old).is_empty() {
        return;
    }
    let mut old_text = String::new();
    let mut old_marks = Vec::new();
    visit(old, &mut |item| {
        let marks = marks(item);
        let text = item["text"].as_str().unwrap_or_default();
        old_text.push_str(text);
        old_marks.resize(old_marks.len() + text.chars().count(), marks);
    });
    let mut new_text = String::new();
    visit(new, &mut |item| {
        new_text.push_str(item["text"].as_str().unwrap_or_default());
    });
    let old_chars: Vec<_> = old_text.chars().collect();
    let new_chars: Vec<_> = new_text.chars().collect();
    let old = WordTokens::new(&old_text);
    let target = WordTokens::new(&new_text);
    let mut restored = vec![None; new_chars.len()];
    let mut old_start = 0;
    let mut new_start = 0;

    // Align words and punctuation first. Repeated spaces must not cause the diff to skip
    // a matching word, or split the replacement of a whole marked phrase.
    let (old_indices, old_content) = old.content_tokens();
    let (new_indices, new_content) = target.content_tokens();
    let end = (old.tokens.len(), target.tokens.len());
    let matches = equal_tokens(&old_content, &new_content)
        .map(|(i, j)| (old_indices[i], new_indices[j]))
        .chain([end]);
    let equal_space =
        |i: usize, j: usize| old.tokens[i] == target.tokens[j] && old.tokens[i].trim().is_empty();
    let retain = |i, j, restored: &mut [Option<Marks>]| {
        let common = covering_marks(old_marks[old.scalars(i..i + 1)].iter());
        if !common.is_empty() {
            restored[target.scalars(j..j + 1)].fill(Some(common));
        }
    };

    for (old_index, new_index) in matches {
        let (mut old_end, mut new_end) = (old_index, new_index);
        while old_start < old_end && new_start < new_end && equal_space(old_start, new_start) {
            retain(old_start, new_start, &mut restored);
            old_start += 1;
            new_start += 1;
        }
        while old_start < old_end && new_start < new_end && equal_space(old_end - 1, new_end - 1) {
            old_end -= 1;
            new_end -= 1;
            retain(old_end, new_end, &mut restored);
        }

        let changed_source = old.scalars(old_start..old_end);
        let changed_target = target.scalars(new_start..new_end);
        let replacement = &new_chars[changed_target.clone()];
        if let Some(first) = replacement.iter().position(|c| !c.is_whitespace())
            && let Some(mark) = replacement_mark(&old_chars, &old_marks, changed_source)
        {
            let last = replacement
                .iter()
                .rposition(|c| !c.is_whitespace())
                .unwrap();
            restored[changed_target.start + first..=changed_target.start + last].fill(Some(mark));
        }
        if (old_index, new_index) != end {
            retain(old_index, new_index, &mut restored);
        }

        old_start = old_index + 1;
        new_start = new_index + 1;
    }

    let mut restored = restored.into_iter();
    rewrite(new, &mut |_, existing| {
        restored.next().flatten().map(|mut previous| {
            previous.extend(existing.clone());
            previous
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preserved_quote(before: &str, marked: &str, after: &str, replacement: &str) -> String {
        let old = json!([
            {"type":"text", "text":before, "styles":{}},
            {"type":"text", "text":marked, "styles":{"comment":{"threadId":"discussion"}}},
            {"type":"text", "text":after, "styles":{}},
        ]);
        let mut new = json!([{"type":"text", "text":replacement, "styles":{}}]);
        preserve(&old, &mut new);
        quote(&new, "discussion")
    }

    #[test]
    fn a_fact_check_moves_the_anchor_to_the_full_replacement() {
        assert_eq!(
            preserved_quote(
                "Usage ",
                "doubled every week",
                " after the launch of in-place Ask.",
                "Usage grew 2.4x in four weeks after in-place Ask launched.",
            ),
            "grew 2.4x in four weeks"
        );
    }

    #[test]
    fn a_partial_replacement_marks_only_the_surviving_words() {
        assert_eq!(
            preserved_quote("Set the ", "red switch", " now", "Set the blue switch now").trim(),
            "switch"
        );
    }

    #[test]
    fn changed_words_do_not_keep_marks_on_shared_letter_sequences() {
        assert_eq!(
            preserved_quote("A ", "water", " line", "A waterfront and water line"),
            "water"
        );
        assert_eq!(preserved_quote("A wat", "er", " line", "A water valve"), "");
    }

    #[test]
    fn cjk_ideographs_keep_their_own_boundaries() {
        assert_eq!(preserved_quote("明日", "東京", "へ", "明日東北へ"), "東");
        assert_eq!(preserved_quote("明日", "東京", "へ", "明日大阪へ"), "大阪");
    }

    #[test]
    fn an_emoji_sequence_moves_as_a_whole() {
        assert_eq!(
            preserved_quote("Set ", "👩🏽‍💻", " later", "Set 👨🏿‍🚒 later"),
            "👨🏿‍🚒"
        );
    }

    #[test]
    fn a_long_rewrite_preserves_an_unchanged_mark_between_edits() {
        let before = "a ".repeat(1200);
        let after = " b".repeat(1200);
        assert_eq!(
            preserved_quote(
                &format!("Old {before}"),
                "marked words",
                &format!("{after} start"),
                &format!("New {before}marked words{after} finish"),
            ),
            "marked words"
        );
    }
}
