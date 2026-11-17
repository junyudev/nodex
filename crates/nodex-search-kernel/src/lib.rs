mod analyzer;
#[cfg(any(test, feature = "wasm"))]
mod chat_metadata;
mod text_match;

use analyzer::fold;
pub use analyzer::{ANALYZER_VERSION, Segment, analyze};
pub use text_match::{
    MatchQuality, QueryWord, RowMatch, TextKind, TextMatch, TextPart, match_text_rows, match_words,
    matches_ordered, query_words,
};

use analyzer::{AnalyzedSegment, analyze_with_offsets};
use text_match::{
    WordMatch, highlight_parts, infix, loose_word, matches_in_order, strong_word, typo_prefix,
};

use nodex_core_contracts::library::PageAssignee;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

const MAX_QUERY_BYTES: usize = 512;
const MAX_QUERY_TERMS: usize = 32;
const MAX_RESULTS: usize = 100;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataProperty {
    pub property_id: String,
    pub property_name: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOption {
    pub data_source_id: String,
    pub property_id: String,
    pub option_id: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Triage,
    Plan,
    Doing,
    Review,
    Done,
    Canceled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataDocument {
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub preview: String,
    pub status: Option<WorkflowStatus>,
    pub priority: Option<String>,
    pub tags: Vec<SearchOption>,
    pub assignee: Option<PageAssignee>,
    pub owner: Option<String>,
    pub location_label: String,
    pub updated_at: String,
    pub properties: Vec<MetadataProperty>,
    pub project_ids: Vec<String>,
    pub data_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionIdentity {
    pub data_source_id: String,
    pub property_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub project_filter_ids: Option<Vec<String>>,
    pub query: String,
    pub preferred_project_id: Option<String>,
    pub recent_page_ids: Vec<String>,
    pub limit: Option<u32>,
    pub exclude_page_ids: Vec<String>,
    #[serde(default)]
    pub data_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SearchMatch {
    PageKey {
        quality: MatchQuality,
        page_key: String,
        is_current: bool,
        parts: Vec<TextPart>,
    },
    Identity {
        quality: MatchQuality,
        parts: Vec<TextPart>,
    },
    Title {
        quality: MatchQuality,
        parts: Vec<TextPart>,
    },
    Property {
        quality: MatchQuality,
        property_id: String,
        property_name: String,
        parts: Vec<TextPart>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub project_id: Option<String>,
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub status: Option<WorkflowStatus>,
    pub priority: Option<String>,
    pub tags: Vec<SearchOption>,
    pub assignee: Option<PageAssignee>,
    pub owner: Option<String>,
    pub location_label: String,
    pub title_parts: Vec<TextPart>,
    pub excerpt: Option<String>,
    pub excerpt_parts: Vec<TextPart>,
    pub matches: Vec<SearchMatch>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MetadataMatchSource {
    PageKey {
        page_key: String,
    },
    Identity,
    Title,
    Property {
        property_id: String,
        property_name: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataMatchEvidence {
    pub term: String,
    pub source: MetadataMatchSource,
    pub quality: MatchQuality,
    pub edit_distance: usize,
    pub parts: Vec<TextPart>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataMatch {
    pub page_id: String,
    pub evidence: Vec<MetadataMatchEvidence>,
    pub ordered: bool,
}

#[derive(Default)]
struct Aggregate {
    terms: HashSet<String>,
    evidence: Vec<MetadataMatchEvidence>,
    ordered: bool,
}

struct IndexedDocument {
    document: MetadataDocument,
    fields: Vec<Arc<[AnalyzedSegment]>>,
}

#[derive(Default)]
pub struct MetadataSearchIndex {
    documents: BTreeMap<String, IndexedDocument>,
    identities: BTreeMap<String, String>,
    page_keys: BTreeMap<String, String>,
    postings: BTreeMap<String, HashSet<String>>,
}

impl MetadataSearchIndex {
    pub fn new(documents: Vec<MetadataDocument>) -> Self {
        let mut index = Self::default();
        index.replace(documents);
        index
    }

    pub fn replace(&mut self, documents: Vec<MetadataDocument>) {
        *self = Self::default();
        self.apply_delta(documents, &[]);
    }

    pub fn apply_delta(&mut self, upserts: Vec<MetadataDocument>, removals: &[String]) {
        for id in removals {
            self.remove(id);
        }
        // Batch indexes repeat many Property labels and option values. Analyze
        // short, identical text once, preserving its exact original offsets.
        let mut property_fields = HashMap::<String, Arc<[AnalyzedSegment]>>::new();
        for document in upserts {
            let id = document.page_id.clone();
            self.remove(&id);
            let mut fields = Vec::with_capacity(1 + document.properties.len());
            fields.push(Arc::from(analyze_with_offsets(&document.title)));
            fields.extend(document.properties.iter().map(|property| {
                if let Some(field) = property_fields.get(&property.text) {
                    return field.clone();
                }
                let field: Arc<[AnalyzedSegment]> = Arc::from(analyze_with_offsets(&property.text));
                if property.text.len() <= 128 && property_fields.len() < 4_096 {
                    property_fields.insert(property.text.clone(), field.clone());
                }
                field
            }));
            for spelling in spellings(&fields) {
                self.postings
                    .entry(spelling.to_owned())
                    .or_default()
                    .insert(id.clone());
            }
            self.identities.insert(fold(&id), id.clone());
            if let Some(key) = &document.page_key {
                self.page_keys.insert(fold(key), id.clone());
            }
            self.documents
                .insert(id, IndexedDocument { document, fields });
        }
    }

    fn remove(&mut self, id: &str) {
        let Some(indexed) = self.documents.remove(id) else {
            return;
        };
        let identity = fold(id);
        if self
            .identities
            .get(&identity)
            .is_some_and(|owner| owner == id)
        {
            self.identities.remove(&identity);
        }
        if let Some(key) = indexed.document.page_key.as_deref().map(fold)
            && self.page_keys.get(&key).is_some_and(|owner| owner == id)
        {
            self.page_keys.remove(&key);
        }
        for spelling in spellings(&indexed.fields) {
            if self.postings.get_mut(spelling).is_some_and(|ids| {
                ids.remove(id);
                ids.is_empty()
            }) {
                self.postings.remove(spelling);
            }
        }
    }

    pub fn search(&self, request: &SearchRequest) -> Result<Vec<SearchHit>, String> {
        validate_request(request)?;
        let words = page_query_words(&request.query)?;
        let query = fold(request.query.trim());
        let excluded = request
            .exclude_page_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let in_scope = |id: &str| {
            let document = &self.documents[id].document;
            !excluded.contains(id)
                && request
                    .project_filter_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| document.project_ids.contains(id)))
                && (request.data_source_ids.is_empty()
                    || request
                        .data_source_ids
                        .iter()
                        .any(|id| document.data_source_ids.contains(id)))
        };
        let mut aggregates = self.aggregate_query(&query, &words, in_scope, |_| false, true);
        if query.is_empty() {
            aggregates.extend(
                self.documents
                    .keys()
                    .filter(|id| in_scope(id))
                    .map(|id| (id.clone(), Aggregate::default())),
            );
        }
        Ok(self.finish(request, &query, &words, aggregates))
    }

    /// Collect partial metadata evidence for scoped Pages. The caller can
    /// supply strong matches from other fields before enabling typo fallback.
    pub fn match_documents(
        &self,
        query: &str,
        in_scope: impl Fn(&str) -> bool,
        has_external_strong: impl Fn(&QueryWord) -> bool,
    ) -> Result<Vec<MetadataMatch>, String> {
        let words = page_query_words(query)?;
        let mut matches = self
            .aggregate_query(
                &fold(query.trim()),
                &words,
                in_scope,
                has_external_strong,
                false,
            )
            .into_iter()
            .map(|(page_id, aggregate)| MetadataMatch {
                page_id,
                evidence: aggregate.evidence,
                ordered: aggregate.ordered,
            })
            .collect::<Vec<_>>();
        matches.sort_unstable_by(|left, right| left.page_id.cmp(&right.page_id));
        Ok(matches)
    }

    fn aggregate_query(
        &self,
        query: &str,
        words: &[QueryWord],
        in_scope: impl Fn(&str) -> bool,
        has_external_strong: impl Fn(&QueryWord) -> bool,
        include_keys: bool,
    ) -> HashMap<String, Aggregate> {
        let mut aggregates = HashMap::<String, Aggregate>::new();
        let key_query = query.trim_start_matches('#');
        if key_query.is_empty() || words.is_empty() {
            return aggregates;
        }
        for (key, id) in
            prefixed(&self.page_keys, key_query).filter(|(_, id)| include_keys && in_scope(id))
        {
            let original = self.documents[id]
                .document
                .page_key
                .as_ref()
                .expect("indexed key");
            add_evidence(
                &mut aggregates,
                id,
                identity_evidence(
                    &words[0],
                    original,
                    key,
                    key_query,
                    MetadataMatchSource::PageKey {
                        page_key: original.clone(),
                    },
                ),
            );
        }
        if query.starts_with('#') {
            return aggregates;
        }
        let key_matched = !aggregates.is_empty();
        for word in words {
            let mut has_strong = (words.len() == 1 && key_matched) || has_external_strong(word);
            for (identity, id) in
                prefixed(&self.identities, word.text()).filter(|(_, id)| in_scope(id))
            {
                has_strong = true;
                add_evidence(
                    &mut aggregates,
                    id,
                    identity_evidence(
                        word,
                        &self.documents[id].document.page_id,
                        identity,
                        word.text(),
                        MetadataMatchSource::Identity,
                    ),
                );
            }
            let mut strong_fields = HashSet::new();
            for id in strong_candidates(&self.postings, word)
                .into_iter()
                .map(String::as_str)
                .filter(|id| in_scope(id))
            {
                let indexed = &self.documents[id];
                for (field, segments) in indexed.fields.iter().enumerate() {
                    let Some(matched) = strong_word(word, segments) else {
                        continue;
                    };
                    has_strong = true;
                    strong_fields.insert((id, field));
                    add_evidence(&mut aggregates, id, indexed.evidence(word, field, matched));
                }
            }
            for id in loose_candidates(&self.postings, word, !has_strong)
                .into_iter()
                .map(String::as_str)
                .filter(|id| in_scope(id))
            {
                let indexed = &self.documents[id];
                for (field, segments) in indexed.fields.iter().enumerate() {
                    if strong_fields.contains(&(id, field)) {
                        continue;
                    }
                    if let Some(matched) = loose_word(word, segments, !has_strong) {
                        add_evidence(&mut aggregates, id, indexed.evidence(word, field, matched));
                    }
                }
            }
        }
        if words.len() > 1 {
            for (id, aggregate) in &mut aggregates {
                aggregate.ordered = self.documents[id]
                    .fields
                    .iter()
                    .any(|field| matches_in_order(words, field, TextKind::Metadata));
            }
        }
        aggregates
    }

    fn finish(
        &self,
        request: &SearchRequest,
        query: &str,
        words: &[QueryWord],
        aggregates: HashMap<String, Aggregate>,
    ) -> Vec<SearchHit> {
        let recent = request
            .recent_page_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i))
            .collect::<HashMap<_, _>>();
        let projects = preferred_projects(
            request.project_filter_ids.as_deref().unwrap_or_default(),
            request.preferred_project_id.as_deref(),
        );
        let mut rows = aggregates
            .into_iter()
            .filter(|(_, a)| {
                query.starts_with('#') || words.iter().all(|word| a.terms.contains(word.text()))
            })
            .filter_map(|(id, aggregate)| {
                let document = &self.documents.get(&id)?.document;
                let project_id = projects
                    .iter()
                    .find(|project| document.project_ids.contains(project))
                    .or_else(|| {
                        request
                            .preferred_project_id
                            .as_ref()
                            .filter(|id| document.project_ids.contains(id))
                    })
                    .or_else(|| document.project_ids.first());
                Some((
                    document,
                    project_id,
                    recent.get(id.as_str()).copied(),
                    aggregate,
                ))
            })
            .collect::<Vec<_>>();
        rows.sort_by_cached_key(|(document, project, recent, aggregate)| {
            let (worst_word, relevance) = aggregate_rank(aggregate);
            (
                worst_word,
                !aggregate.ordered,
                context_rank(
                    project.map(String::as_str),
                    *recent,
                    request.preferred_project_id.as_deref(),
                ),
                relevance,
                std::cmp::Reverse(document.updated_at.as_str()),
                document.page_id.as_str(),
            )
        });
        rows.into_iter()
            .take(request.limit.unwrap_or(20) as usize)
            .map(|(document, project_id, _, aggregate)| {
                hit(document, project_id.cloned(), aggregate)
            })
            .collect()
    }
}

impl IndexedDocument {
    fn evidence(
        &self,
        word: &QueryWord,
        field: usize,
        matched: WordMatch,
    ) -> MetadataMatchEvidence {
        let (source, text) = if field == 0 {
            (MetadataMatchSource::Title, &self.document.title)
        } else {
            let property = &self.document.properties[field - 1];
            (
                MetadataMatchSource::Property {
                    property_id: property.property_id.clone(),
                    property_name: property.property_name.clone(),
                },
                &property.text,
            )
        };
        MetadataMatchEvidence {
            term: word.text().to_owned(),
            source,
            quality: matched.quality,
            edit_distance: matched.distance,
            parts: highlight_parts(text, matched.ranges),
        }
    }
}

fn spellings(fields: &[Arc<[AnalyzedSegment]>]) -> HashSet<&str> {
    fields
        .iter()
        .flat_map(|field| field.iter())
        .map(|s| s.segment.folded.as_str())
        .collect()
}

fn strong_candidates<'a, T: Eq + std::hash::Hash>(
    postings: &'a BTreeMap<String, HashSet<T>>,
    word: &QueryWord,
) -> HashSet<&'a T> {
    let mut candidates = HashSet::new();
    let [first, rest @ ..] = word.segments() else {
        return candidates;
    };
    if !rest.is_empty() {
        candidates.extend(postings.get(first).into_iter().flatten());
        return candidates;
    }
    let prefixes = |term: &str| {
        postings
            .range::<str, _>((std::ops::Bound::Included(term), std::ops::Bound::Unbounded))
            .take_while(move |(spelling, _)| spelling.starts_with(term))
            .flat_map(|(_, ids)| ids)
            .collect::<Vec<_>>()
    };
    candidates.extend(prefixes(first));
    if let Some(stem) = word.stem()
        && stem != first
    {
        candidates.extend(prefixes(stem));
    }
    // Joined matches begin with a segment that is a proper prefix of
    // the query word. The ordered field verifies the remaining segments.
    for (end, _) in first.char_indices().skip(1) {
        candidates.extend(postings.get(&first[..end]).into_iter().flatten());
    }
    candidates
}

fn loose_candidates<'a, T: Eq + std::hash::Hash>(
    postings: &'a BTreeMap<String, HashSet<T>>,
    word: &QueryWord,
    allow_typo: bool,
) -> HashSet<&'a T> {
    let [needle] = word.segments() else {
        return HashSet::new();
    };
    if needle.chars().count() < 4 {
        return HashSet::new();
    }
    postings
        .iter()
        .filter(|(token, _)| {
            infix(needle, token).is_some() || (allow_typo && typo_prefix(needle, token).is_some())
        })
        .flat_map(|(_, ids)| ids)
        .collect()
}

/// The indexed prefix key used for Page identities.
pub fn metadata_identity_key(id: &str) -> String {
    fold(id)
}

/// Candidate lookup for distinct metadata fields, without Page ranking or excerpts.
pub struct MetadataTextIndex {
    fields: Vec<Vec<AnalyzedSegment>>,
    postings: BTreeMap<String, HashSet<usize>>,
}

impl MetadataTextIndex {
    pub fn new<'a>(fields: impl IntoIterator<Item = &'a str>) -> Self {
        let mut postings = BTreeMap::<_, HashSet<_>>::new();
        let fields = fields
            .into_iter()
            .enumerate()
            .map(|(index, text)| {
                let segments = analyze_with_offsets(text);
                for segment in &segments {
                    postings
                        .entry(segment.segment.folded.clone())
                        .or_default()
                        .insert(index);
                }
                segments
            })
            .collect();
        Self { fields, postings }
    }

    pub fn strong<'a>(&'a self, word: &'a QueryWord) -> impl Iterator<Item = usize> + 'a {
        strong_candidates(&self.postings, word)
            .into_iter()
            .copied()
            .filter(move |index| strong_word(word, &self.fields[*index]).is_some())
    }

    pub fn loose<'a>(
        &'a self,
        word: &'a QueryWord,
        allow_typo: bool,
    ) -> impl Iterator<Item = usize> + 'a {
        loose_candidates(&self.postings, word, allow_typo)
            .into_iter()
            .copied()
            .filter(move |index| loose_word(word, &self.fields[*index], allow_typo).is_some())
    }
}

fn prefixed<'a>(
    map: &'a BTreeMap<String, String>,
    term: &'a str,
) -> impl Iterator<Item = (&'a String, &'a String)> {
    map.range::<str, _>((std::ops::Bound::Included(term), std::ops::Bound::Unbounded))
        .take_while(move |(key, _)| key.starts_with(term))
        .filter(move |(key, _)| key.as_str() == term || term.chars().count() >= 2)
}

fn identity_evidence(
    word: &QueryWord,
    original: &str,
    folded: &str,
    query: &str,
    source: MetadataMatchSource,
) -> MetadataMatchEvidence {
    MetadataMatchEvidence {
        term: word.text().to_owned(),
        source,
        quality: if folded == query {
            MatchQuality::Exact
        } else {
            MatchQuality::Prefix
        },
        edit_distance: 0,
        parts: vec![TextPart {
            text: original.to_owned(),
            highlighted: true,
        }],
    }
}

fn add_evidence(
    aggregates: &mut HashMap<String, Aggregate>,
    page_id: &str,
    evidence: MetadataMatchEvidence,
) {
    let aggregate = aggregates.entry(page_id.to_owned()).or_default();
    aggregate.terms.insert(evidence.term.clone());
    aggregate.evidence.push(evidence);
}

fn evidence_rank(evidence: &MetadataMatchEvidence) -> usize {
    let field = match evidence.source {
        MetadataMatchSource::PageKey { .. } => 0,
        MetadataMatchSource::Identity => 1,
        MetadataMatchSource::Title => 2,
        MetadataMatchSource::Property { .. } => 3,
    };
    evidence.quality.rank(field)
}

fn aggregate_rank(aggregate: &Aggregate) -> (usize, (usize, usize, usize)) {
    let mut best = HashMap::<&str, (usize, usize)>::new();
    for evidence in &aggregate.evidence {
        let candidate = (evidence_rank(evidence), evidence.edit_distance);
        best.entry(&evidence.term)
            .and_modify(|rank| *rank = (*rank).min(candidate))
            .or_insert(candidate);
    }
    (
        best.values()
            .map(|&(rank, _)| rank)
            .max()
            .unwrap_or(usize::MAX),
        (
            best.values().map(|&(_, distance)| distance).sum(),
            best.values().map(|&(rank, _)| rank).sum(),
            usize::MAX - aggregate.evidence.len(),
        ),
    )
}

fn hit(document: &MetadataDocument, project_id: Option<String>, aggregate: Aggregate) -> SearchHit {
    let mut evidence = aggregate.evidence;
    evidence.sort_by(|a, b| {
        evidence_rank(a)
            .cmp(&evidence_rank(b))
            .then_with(|| a.edit_distance.cmp(&b.edit_distance))
            .then_with(|| a.term.cmp(&b.term))
            .then_with(|| source_key(&a.source).cmp(source_key(&b.source)))
    });
    let title_parts = merge_highlights(
        &document.title,
        evidence
            .iter()
            .filter(|e| e.source == MetadataMatchSource::Title)
            .map(|e| e.parts.as_slice()),
    );
    let property = evidence
        .iter()
        .find(|e| matches!(e.source, MetadataMatchSource::Property { .. }));
    let (excerpt, excerpt_parts) = if let Some(property) = property {
        (Some(join_parts(&property.parts)), property.parts.clone())
    } else if !evidence.is_empty() {
        (Some(document.title.clone()), title_parts.clone())
    } else if document.preview.is_empty() {
        (None, Vec::new())
    } else {
        (
            Some(document.preview.clone()),
            vec![TextPart {
                text: document.preview.clone(),
                highlighted: false,
            }],
        )
    };
    SearchHit {
        project_id,
        page_id: document.page_id.clone(),
        page_key: document.page_key.clone(),
        title: document.title.clone(),
        status: document.status,
        priority: document.priority.clone(),
        tags: document.tags.clone(),
        assignee: document.assignee.clone(),
        owner: document.owner.clone(),
        location_label: document.location_label.clone(),
        title_parts,
        excerpt,
        excerpt_parts,
        matches: evidence
            .into_iter()
            .map(|e| match e.source {
                MetadataMatchSource::PageKey { page_key } => SearchMatch::PageKey {
                    quality: e.quality,
                    page_key,
                    is_current: true,
                    parts: e.parts,
                },
                MetadataMatchSource::Identity => SearchMatch::Identity {
                    quality: e.quality,
                    parts: e.parts,
                },
                MetadataMatchSource::Title => SearchMatch::Title {
                    quality: e.quality,
                    parts: e.parts,
                },
                MetadataMatchSource::Property {
                    property_id,
                    property_name,
                } => SearchMatch::Property {
                    quality: e.quality,
                    property_id,
                    property_name,
                    parts: e.parts,
                },
            })
            .collect(),
        updated_at: document.updated_at.clone(),
    }
}

fn source_key(source: &MetadataMatchSource) -> &str {
    match source {
        MetadataMatchSource::PageKey { page_key } => page_key,
        MetadataMatchSource::Property { property_id, .. } => property_id,
        _ => "",
    }
}

fn context_rank(
    project: Option<&str>,
    recent: Option<usize>,
    preferred: Option<&str>,
) -> (usize, usize) {
    (
        usize::from(project != preferred || preferred.is_none()),
        recent.unwrap_or(usize::MAX),
    )
}
fn preferred_projects(ids: &[String], preferred: Option<&str>) -> Vec<String> {
    let mut out = ids.to_vec();
    if let Some(p) = preferred
        && let Some(i) = out.iter().position(|id| id == p)
    {
        let v = out.remove(i);
        out.insert(0, v)
    }
    out
}
fn validate_request(request: &SearchRequest) -> Result<(), String> {
    if request.query.len() > MAX_QUERY_BYTES {
        return Err("query exceeds its UTF-8 byte bound".into());
    }
    if request
        .project_filter_ids
        .as_ref()
        .is_some_and(Vec::is_empty)
    {
        return Err("Project filter is empty".into());
    }
    let limit = request.limit.unwrap_or(20) as usize;
    if limit == 0 || limit > MAX_RESULTS {
        return Err("limit is out of range".into());
    }
    Ok(())
}

pub fn page_query_words(query: &str) -> Result<Vec<QueryWord>, String> {
    if query.len() > MAX_QUERY_BYTES {
        return Err("query exceeds its UTF-8 byte bound".into());
    }
    let words = query_words(query);
    if words.len() > MAX_QUERY_TERMS {
        return Err("query has too many terms".into());
    }
    Ok(words)
}

/// Merge evidence for several words in the same original field.
fn merge_highlights<'a>(
    text: &str,
    matches: impl IntoIterator<Item = &'a [TextPart]>,
) -> Vec<TextPart> {
    let ranges = matches
        .into_iter()
        .flat_map(|parts| {
            let mut start = 0;
            parts.iter().filter_map(move |part| {
                let range = start..start + part.text.len();
                start = range.end;
                part.highlighted.then_some(range)
            })
        })
        .collect();
    highlight_parts(text, ranges)
}

fn join_parts(parts: &[TextPart]) -> String {
    parts.iter().map(|p| p.text.as_str()).collect()
}

#[cfg(feature = "wasm")]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(typescript_custom_section)]
    const TEXT_API: &'static str = r#"
export type SearchTextKind = "metadata" | "long_text";
export type SearchField = readonly [text: string, kind: SearchTextKind];
export interface SearchRowMatch { index: number; rank: number; }
/** Half-open UTF-16 offsets in the original input. */
export interface SearchLiteralRange { start: number; end: number; }
export type SearchMatchQuality = "exact" | "prefix" | "joined" | "stem" | "typo" | "infix";
export interface SearchTextMatch {
    quality: SearchMatchQuality;
    parts: { text: string; highlighted: boolean }[];
}
export interface SearchQueryWord { segments: string[]; stem: string | null; allowsPrefix: boolean; }
export interface SearchFieldEvidence {
    words: (SearchTextMatch | null)[];
    ordered: boolean;
    orderedRange: SearchLiteralRange | null;
}
export interface ChatMetadataEvidence {
    title: SearchTextMatch["parts"];
    hint: { label: string; text: string; parts: SearchTextMatch["parts"] } | null;
}
"#;

    #[wasm_bindgen(js_name = analyzerVersion)]
    pub fn analyzer_version() -> u32 {
        ANALYZER_VERSION
    }

    #[wasm_bindgen(js_name = foldText)]
    pub fn fold_text(text: &str) -> String {
        fold(text)
    }

    /// A compact representation for SQLite's exact-token tokenizer.
    #[wasm_bindgen(js_name = indexText)]
    pub fn index_text(text: &str) -> String {
        analyze(text)
            .into_iter()
            .map(|segment| segment.folded)
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Rank within a corpus whose field order is the same in both tiers.
    #[wasm_bindgen(js_name = rankMatch)]
    pub fn rank_match(
        #[wasm_bindgen(unchecked_param_type = "SearchMatchQuality")] quality: JsValue,
        field: usize,
        fields: usize,
    ) -> Result<usize, JsValue> {
        let quality: MatchQuality = serde_wasm_bindgen::from_value(quality)?;
        Ok(if quality.is_strong() {
            field * 4 + quality as usize
        } else {
            fields * 4 + field * 2 + (quality as usize - MatchQuality::Typo as usize)
        })
    }

    #[wasm_bindgen]
    pub struct SearchTextQuery(Vec<QueryWord>);

    #[wasm_bindgen]
    impl SearchTextQuery {
        #[wasm_bindgen(constructor)]
        pub fn new(query: &str) -> Self {
            Self(query_words(query))
        }

        #[wasm_bindgen(unchecked_return_type = "SearchQueryWord[]")]
        pub fn words(&self) -> Result<JsValue, JsValue> {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Word<'a> {
                segments: &'a [String],
                stem: Option<&'a str>,
                allows_prefix: bool,
            }
            let words = self
                .0
                .iter()
                .map(|word| Word {
                    segments: word.segments(),
                    stem: word.stem(),
                    allows_prefix: word.allows_prefix(TextKind::LongText),
                })
                .collect::<Vec<_>>();
            let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
            Ok(words.serialize(&serializer)?)
        }

        #[wasm_bindgen(unchecked_return_type = "(SearchMatchQuality | null)[]")]
        pub fn classify(
            &self,
            word: usize,
            terms: Vec<String>,
            allow_typo: bool,
        ) -> Result<JsValue, JsValue> {
            let classes = terms
                .iter()
                .map(|term| {
                    self.0
                        .get(word)?
                        .classify_segment(term, TextKind::LongText, allow_typo)
                })
                .collect::<Vec<_>>();
            let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
            Ok(classes.serialize(&serializer)?)
        }

        #[wasm_bindgen(unchecked_return_type = "SearchFieldEvidence")]
        pub fn evidence(
            &self,
            text: &str,
            #[wasm_bindgen(unchecked_param_type = "SearchTextKind")] kind: JsValue,
            allow_typo: bool,
        ) -> Result<JsValue, JsValue> {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Evidence {
                words: Vec<Option<TextMatch>>,
                ordered: bool,
                ordered_range: Option<LiteralRange>,
            }
            #[derive(Serialize)]
            struct LiteralRange {
                start: usize,
                end: usize,
            }
            let kind = serde_wasm_bindgen::from_value(kind)?;
            let segments = analyze_with_offsets(text);
            let words = self
                .0
                .iter()
                .map(|word| {
                    text_match::match_word(word, &segments, kind, allow_typo).map(|matched| {
                        TextMatch {
                            quality: matched.quality,
                            parts: highlight_parts(text, matched.ranges),
                        }
                    })
                })
                .collect();
            let ordered_range =
                text_match::ordered_phrase(&self.0, &segments, kind).map(|(_, range)| {
                    let start = text[..range.start].encode_utf16().count();
                    LiteralRange {
                        start,
                        end: start + text[range].encode_utf16().count(),
                    }
                });
            let evidence = Evidence {
                words,
                ordered: ordered_range.is_some(),
                ordered_range,
            };
            let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
            Ok(evidence.serialize(&serializer)?)
        }
    }

    #[wasm_bindgen(js_name = matchTextRows, unchecked_return_type = "SearchRowMatch[]")]
    pub fn match_text_rows_js(
        query: &str,
        #[wasm_bindgen(unchecked_param_type = "readonly (readonly SearchField[])[]")] rows: JsValue,
    ) -> Result<JsValue, JsValue> {
        let rows: Vec<Vec<(String, TextKind)>> = serde_wasm_bindgen::from_value(rows)?;
        let rows = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|(text, kind)| (text.as_str(), *kind))
                    .collect()
            })
            .collect::<Vec<_>>();
        Ok(serde_wasm_bindgen::to_value(&match_text_rows(
            query, &rows,
        ))?)
    }

    #[wasm_bindgen(js_name = findLiteralRanges, unchecked_return_type = "SearchLiteralRange[]")]
    pub fn find_literal_ranges_js(query: &str, text: &str) -> Result<JsValue, JsValue> {
        Ok(serde_wasm_bindgen::to_value(
            &analyzer::find_literal_ranges(query, text),
        )?)
    }

    #[wasm_bindgen]
    pub struct ChatMetadataSearchIndex {
        inner: chat_metadata::ChatMetadataIndex,
    }

    #[wasm_bindgen]
    impl ChatMetadataSearchIndex {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: chat_metadata::ChatMetadataIndex::default(),
            }
        }

        #[wasm_bindgen(js_name = applyDelta)]
        pub fn apply_delta(
            &mut self,
            upserts: JsValue,
            removals: Vec<String>,
        ) -> Result<(), JsValue> {
            self.inner
                .apply_delta(serde_wasm_bindgen::from_value(upserts)?, &removals);
            Ok(())
        }

        #[wasm_bindgen(js_name = strongMatches, unchecked_return_type = "[string, number, boolean][]")]
        pub fn strong_matches(&self, query: &str) -> Result<JsValue, JsValue> {
            Ok(serde_wasm_bindgen::to_value(
                &self.inner.strong_matches(query),
            )?)
        }

        pub fn candidates(&self, query: &str) -> Vec<String> {
            self.inner
                .candidates(query)
                .into_iter()
                .map(str::to_owned)
                .collect()
        }

        #[wasm_bindgen(unchecked_return_type = "ChatMetadataEvidence[]")]
        pub fn evidence(&self, query: &str, ids: Vec<String>) -> Result<JsValue, JsValue> {
            let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
            Ok(self.inner.evidence(query, &ids).serialize(&serializer)?)
        }
    }

    #[wasm_bindgen]
    pub struct PageSearchPreviewIndex {
        inner: MetadataSearchIndex,
    }

    #[wasm_bindgen]
    impl PageSearchPreviewIndex {
        #[wasm_bindgen(constructor)]
        pub fn new(documents: JsValue) -> Result<PageSearchPreviewIndex, JsValue> {
            Ok(Self {
                inner: MetadataSearchIndex::new(serde_wasm_bindgen::from_value(documents)?),
            })
        }
        pub fn replace(&mut self, documents: JsValue) -> Result<(), JsValue> {
            self.inner
                .replace(serde_wasm_bindgen::from_value(documents)?);
            Ok(())
        }
        #[wasm_bindgen(js_name = applyDelta)]
        pub fn apply_delta(&mut self, upserts: JsValue, removals: JsValue) -> Result<(), JsValue> {
            let removals: Vec<String> = serde_wasm_bindgen::from_value(removals)?;
            self.inner
                .apply_delta(serde_wasm_bindgen::from_value(upserts)?, &removals);
            Ok(())
        }
        pub fn search(&self, request: JsValue) -> Result<JsValue, JsValue> {
            let request = serde_wasm_bindgen::from_value(request)?;
            let hits = self
                .inner
                .search(&request)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(serde_wasm_bindgen::to_value(&hits)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityFixture {
        documents: Vec<MetadataDocument>,
        cases: Vec<ParityCase>,
        text_cases: Vec<TextCase>,
        analysis_cases: Vec<AnalysisCase>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityCase {
        name: String,
        request: SearchRequest,
        expected_page_ids: Vec<String>,
        expected_qualities: Option<Vec<MatchQuality>>,
    }
    #[derive(Deserialize)]
    struct TextCase {
        name: String,
        query: String,
        text: String,
        kind: TextKind,
        expected: Option<TextMatch>,
    }
    #[derive(Deserialize)]
    struct AnalysisCase {
        text: String,
        expected: Vec<Segment>,
    }
    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            project_filter_ids: Some(vec!["p".into()]),
            query: query.into(),
            preferred_project_id: Some("p".into()),
            recent_page_ids: Vec::new(),
            limit: Some(20),
            exclude_page_ids: Vec::new(),
            data_source_ids: Vec::new(),
        }
    }
    fn document(id: &str, title: &str) -> MetadataDocument {
        MetadataDocument {
            page_id: id.into(),
            page_key: Some("NDX-42".into()),
            title: title.into(),
            preview: String::new(),
            status: None,
            priority: None,
            tags: Vec::new(),
            assignee: None,
            owner: None,
            location_label: "Pages".into(),
            updated_at: "2026-01-01".into(),
            properties: Vec::new(),
            project_ids: vec!["p".into()],
            data_source_ids: Vec::new(),
        }
    }
    #[test]
    fn metadata_highlights_keep_original_unicode() {
        let index = MetadataSearchIndex::new(vec![document("page-1", "讨论 Canonical ✅")]);
        let hit = &index.search(&request("canoncal")).unwrap()[0];
        assert_eq!(hit.page_id, "page-1");
        assert!(hit.title_parts.iter().any(|p| p.highlighted));
    }
    #[test]
    fn page_key_and_multi_term_and_are_stable() {
        let mut second = document("b", "Canonical");
        second.page_key = Some("NDX-43".into());
        let index = MetadataSearchIndex::new(vec![document("a", "Canonical plan"), second]);
        assert_eq!(index.search(&request("#ndx-42")).unwrap()[0].page_id, "a");
        assert_eq!(
            index
                .search(&request("canonical plan"))
                .unwrap()
                .iter()
                .map(|h| h.page_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
    }

    #[test]
    fn delta_unindexes_replaced_and_removed_documents() {
        let mut index = MetadataSearchIndex::new(vec![document("a", "Old canonical")]);
        index.apply_delta(vec![document("a", "New projection")], &[]);

        assert!(index.search(&request("old")).unwrap().is_empty());
        assert_eq!(index.search(&request("new")).unwrap()[0].page_id, "a");

        index.apply_delta(Vec::new(), &["a".into()]);
        assert!(index.search(&request("new")).unwrap().is_empty());
        assert!(index.search(&request("#ndx-42")).unwrap().is_empty());
    }

    #[test]
    fn native_adapter_satisfies_the_cross_runtime_fixture() {
        let fixture: ParityFixture =
            serde_json::from_str(include_str!("../tests/fixtures/parity.json"))
                .expect("parity fixture");
        let index = MetadataSearchIndex::new(fixture.documents);
        for case in fixture.cases {
            let actual = index
                .search(&case.request)
                .unwrap_or_else(|error| panic!("{}: {error}", case.name));
            let ids = actual
                .iter()
                .map(|hit| hit.page_id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(ids, case.expected_page_ids, "{}", case.name);
            if let Some(expected) = case.expected_qualities {
                let qualities = actual
                    .iter()
                    .map(|hit| {
                        let SearchMatch::Title { quality, .. } = &hit.matches[0] else {
                            panic!("{}: expected title evidence", case.name);
                        };
                        *quality
                    })
                    .collect::<Vec<_>>();
                assert_eq!(qualities, expected, "{}", case.name);
            }
        }
        for case in fixture.text_cases {
            assert_eq!(
                query_words(&case.query)[0].match_text(&case.text, case.kind, true),
                case.expected,
                "{}",
                case.name
            );
        }
        for case in fixture.analysis_cases {
            assert_eq!(analyze(&case.text), case.expected, "{}", case.text);
        }
    }

    #[test]
    fn typo_rules_protect_short_words_numbers_and_the_first_letter() {
        use MatchQuality::Typo;
        for (query, text, expected) in [
            ("apge", "page", Some(Typo)),
            ("past", "post", None),
            ("migartio", "migration", Some(Typo)),
            ("migartoin", "migration", Some(Typo)),
            ("migartoi", "migration", None),
            ("bigration", "migration", None),
            ("12345", "12354", None),
        ] {
            assert_eq!(
                query_words(query)[0]
                    .match_text(text, TextKind::Metadata, true)
                    .map(|result| result.quality),
                expected,
                "{query} against {text}",
            );
        }
    }

    #[test]
    fn dictionary_terms_and_original_text_use_the_same_word_rules() {
        let words = query_words("migrate");
        let word = &words[0];
        assert_eq!(
            word.classify_segment("migration", TextKind::LongText, false),
            Some(MatchQuality::Stem)
        );
        assert_eq!(
            word.match_text("Migration notes", TextKind::LongText, false)
                .unwrap()
                .quality,
            MatchQuality::Stem
        );
        assert_eq!(fold("É Ώ Й が ㄱㅏ عَرَبِيّ"), "e ω и が 가 عَرَبِيّ");
    }

    #[test]
    fn typo_fallback_uses_this_scope_and_other_strong_fields() {
        let mut strong = document("strong", "Migartion");
        strong.project_ids = vec!["elsewhere".into()];
        let mut property = document("property", "Maintenance");
        property.properties.push(MetadataProperty {
            property_id: "topic".into(),
            property_name: "Topic".into(),
            text: "Migration Roadmap".into(),
        });
        let index = MetadataSearchIndex::new(vec![strong, property]);

        let mut request = request("migartion");
        assert_eq!(index.search(&request).unwrap()[0].page_id, "property");
        request
            .project_filter_ids
            .as_mut()
            .unwrap()
            .push("elsewhere".into());
        let all = index.search(&request).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].page_id, "strong");

        let partial = index
            .match_documents("maintenance migartion", |id| id == "property", |_| true)
            .unwrap();
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].evidence.len(), 1);
        assert_eq!(partial[0].evidence[0].term, "maintenance");
    }

    #[test]
    fn ordered_field_wins_before_recent_use() {
        let index = MetadataSearchIndex::new(vec![
            document("reverse", "Plan Release"),
            document("ordered", "Release Plan"),
        ]);
        let mut request = request("release plan");
        request.recent_page_ids = vec!["reverse".into()];
        request.limit = Some(1);
        assert_eq!(index.search(&request).unwrap()[0].page_id, "ordered");
    }
}
