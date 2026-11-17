use super::{loose_candidates, strong_candidates};
use crate::analyzer::{AnalyzedSegment, analyze_with_offsets, fold};
use crate::text_match::{
    TextKind, TextPart, highlight_parts, matches_in_order, query_words, strong_word,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Deserialize)]
pub(super) struct ChatDocument {
    id: String,
    fields: Vec<ChatField>,
}

#[derive(Deserialize)]
pub(super) struct ChatField {
    text: String,
    kind: ChatFieldKind,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChatFieldKind {
    Title,
    Branch,
    Project,
    PullRequest,
    Reference,
    Prompt,
}

struct PreparedField {
    text: String,
    segments: Vec<AnalyzedSegment>,
    kind: ChatFieldKind,
    reference: Option<String>,
}

#[derive(Serialize)]
pub(super) struct ChatEvidence {
    title: Vec<TextPart>,
    hint: Option<ChatHint>,
}

#[derive(Serialize)]
struct ChatHint {
    label: &'static str,
    text: String,
    parts: Vec<TextPart>,
}

impl PreparedField {
    fn searchable(&self, reference_query: Option<&str>, reference_contains: bool) -> bool {
        match self.kind {
            ChatFieldKind::Prompt => false,
            ChatFieldKind::Reference => reference_query.is_some_and(|needle| {
                self.reference.as_deref().is_some_and(|reference| {
                    reference.starts_with(needle)
                        || (reference_contains && reference.contains(needle))
                })
            }),
            _ => true,
        }
    }
}

fn reference_query(query: &str) -> (Option<String>, bool) {
    let reference = (query.encode_utf16().count() >= 8).then(|| fold(query));
    let contains = reference
        .as_deref()
        .is_some_and(|value| value.chars().any(|ch| ch.is_ascii_digit()));
    (reference, contains)
}

#[derive(Default)]
pub(super) struct ChatMetadataIndex {
    documents: HashMap<String, Vec<PreparedField>>,
    postings: BTreeMap<String, HashSet<String>>,
}

impl ChatMetadataIndex {
    pub(super) fn apply_delta(&mut self, upserts: Vec<ChatDocument>, removals: &[String]) {
        for id in removals {
            self.remove(id);
        }
        for ChatDocument { id, fields } in upserts {
            self.remove(&id);
            let fields = fields
                .into_iter()
                .map(|field| PreparedField {
                    segments: analyze_with_offsets(&field.text),
                    kind: field.kind,
                    reference: matches!(field.kind, ChatFieldKind::Reference)
                        .then(|| fold(&field.text)),
                    text: field.text,
                })
                .collect::<Vec<_>>();
            for segment in fields.iter().flat_map(|field| &field.segments) {
                self.postings
                    .entry(segment.segment.folded.clone())
                    .or_default()
                    .insert(id.clone());
            }
            self.documents.insert(id, fields);
        }
    }

    fn remove(&mut self, id: &str) {
        let Some(fields) = self.documents.remove(id) else {
            return;
        };
        for segment in fields.into_iter().flat_map(|field| field.segments) {
            if self
                .postings
                .get_mut(&segment.segment.folded)
                .is_some_and(|ids| {
                    ids.remove(id);
                    ids.is_empty()
                })
            {
                self.postings.remove(&segment.segment.folded);
            }
        }
    }

    // Partial metadata and prompt matches can contribute terms to a history match.
    pub(super) fn candidates(&self, query: &str) -> HashSet<&str> {
        query_words(query)
            .iter()
            .flat_map(|word| {
                strong_candidates(&self.postings, word)
                    .into_iter()
                    .chain(loose_candidates(&self.postings, word, true))
            })
            .map(String::as_str)
            .collect()
    }

    pub(super) fn strong_matches(&self, query: &str) -> Vec<(&str, usize, bool)> {
        let words = query_words(query);
        let mut required = words.iter();
        let Some(first) = required.next() else {
            return Vec::new();
        };
        let mut ids = strong_candidates(&self.postings, first);
        for word in required {
            let candidates = strong_candidates(&self.postings, word);
            ids.retain(|id| candidates.contains(id));
            if ids.is_empty() {
                return Vec::new();
            }
        }
        let (reference, contains) = reference_query(query);
        ids.into_iter()
            .filter_map(|id| {
                let fields = &self.documents[id];
                let eligible = || {
                    fields
                        .iter()
                        .filter(|field| field.searchable(reference.as_deref(), contains))
                };
                let mut weakest = 0;
                for word in &words {
                    let best = eligible()
                        .filter_map(|field| {
                            let matched = strong_word(word, &field.segments)?;
                            let order = usize::from(!matches!(field.kind, ChatFieldKind::Title));
                            Some(matched.quality.rank(order))
                        })
                        .min()?;
                    weakest = weakest.max(best);
                }
                let ordered = eligible()
                    .any(|field| matches_in_order(&words, &field.segments, TextKind::Metadata));
                Some((id.as_str(), weakest, ordered))
            })
            .collect()
    }

    pub(super) fn evidence(&self, query: &str, ids: &[String]) -> Vec<ChatEvidence> {
        let words = query_words(query);
        let (reference, contains) = reference_query(query);
        ids.iter()
            .map(|id| {
                let mut evidence = ChatEvidence {
                    title: Vec::new(),
                    hint: None,
                };
                let Some(fields) = self.documents.get(id) else {
                    return evidence;
                };
                for field in fields
                    .iter()
                    .filter(|field| field.searchable(reference.as_deref(), contains))
                {
                    let ranges = words
                        .iter()
                        .filter_map(|word| strong_word(word, &field.segments))
                        .flat_map(|matched| matched.ranges)
                        .collect::<Vec<_>>();
                    if ranges.is_empty() {
                        continue;
                    }
                    let label = match field.kind {
                        ChatFieldKind::Title => {
                            evidence.title = highlight_parts(&field.text, ranges);
                            break;
                        }
                        ChatFieldKind::Branch => "Branch",
                        ChatFieldKind::Project => "Project",
                        ChatFieldKind::PullRequest => "PR",
                        ChatFieldKind::Reference => "ID or link",
                        ChatFieldKind::Prompt => continue,
                    };
                    evidence.hint = Some(ChatHint {
                        label,
                        text: field.text.clone(),
                        parts: highlight_parts(&field.text, ranges),
                    });
                    break;
                }
                evidence
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_indexed_fields_and_applies_replacements_and_removals() {
        let doc = |id: &str, title: &str| ChatDocument {
            id: id.into(),
            fields: vec![
                ChatField {
                    text: title.into(),
                    kind: ChatFieldKind::Title,
                },
                ChatField {
                    text: "部署 release".into(),
                    kind: ChatFieldKind::Project,
                },
                ChatField {
                    text: "private opening needle".into(),
                    kind: ChatFieldKind::Prompt,
                },
            ],
        };
        let mut index = ChatMetadataIndex::default();
        index.apply_delta(
            vec![
                doc("first", "Database migration"),
                doc("second", "Different"),
            ],
            &[],
        );
        assert_eq!(index.strong_matches("migrate 部署"), [("first", 4, false)]);
        let evidence = index.evidence("部署", &["first".into()]);
        let hint = evidence[0].hint.as_ref().unwrap();
        assert_eq!(hint.label, "Project");
        assert_eq!(hint.parts[0].text, "部署");
        assert!(hint.parts[0].highlighted);
        assert!(index.strong_matches("needle").is_empty());
        assert!(index.candidates("nedle").contains("first"));
        index.apply_delta(vec![doc("first", "Editor")], &["second".into()]);
        assert!(index.strong_matches("migration").is_empty());
        assert_eq!(index.strong_matches("部署 release"), [("first", 4, true)]);
    }
}
