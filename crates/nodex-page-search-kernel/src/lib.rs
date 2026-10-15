use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

const MAX_QUERY_BYTES: usize = 512;
const MAX_QUERY_TERMS: usize = 32;
const MAX_PREFIX_MATCHES: usize = 512;
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
    Build,
    Review,
    Ship,
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
    pub assignee: Option<String>,
    pub location_label: String,
    pub updated_at: String,
    pub properties: Vec<MetadataProperty>,
    pub project_ids: Vec<String>,
    pub data_source_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TagMode {
    Any,
    All,
    None,
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
pub struct SearchFilters {
    pub statuses: Option<Vec<WorkflowStatus>>,
    pub priorities: Option<Vec<String>>,
    pub include_empty_priority: bool,
    pub tags: Vec<OptionIdentity>,
    pub tag_mode: TagMode,
    pub assignees: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub project_ids: Vec<String>,
    pub query: String,
    pub filters: Option<SearchFilters>,
    pub preferred_project_id: Option<String>,
    pub recent_page_ids: Vec<String>,
    pub limit: Option<u32>,
    pub exclude_page_ids: Vec<String>,
    #[serde(default)]
    pub data_source_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchQuality {
    Exact,
    Prefix,
    Fuzzy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    pub text: String,
    pub highlighted: bool,
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
    pub project_id: String,
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub status: Option<WorkflowStatus>,
    pub priority: Option<String>,
    pub tags: Vec<SearchOption>,
    pub assignee: Option<String>,
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
    pub matched_token: String,
    pub source: MetadataMatchSource,
    pub quality: MatchQuality,
    pub edit_distance: usize,
    pub parts: Vec<TextPart>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataMatch {
    pub page_id: String,
    pub evidence: Vec<MetadataMatchEvidence>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum Field {
    Title,
    Property { id: String, name: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Posting {
    page_id: String,
    field: Field,
}

#[derive(Default)]
struct TrieNode {
    children: BTreeMap<char, TrieNode>,
    postings: Vec<Posting>,
}

#[derive(Default)]
struct TokenTrie {
    root: TrieNode,
}

impl TokenTrie {
    fn insert(&mut self, token: &str, posting: Posting) {
        if token.is_empty() {
            return;
        }
        let mut node = &mut self.root;
        for c in token.chars() {
            node = node.children.entry(c).or_default();
        }
        node.postings.push(posting);
    }

    fn matches(&self, term: &str) -> Vec<TokenMatch> {
        let mut found = Vec::new();
        if let Some(node) = self.node(term) {
            if !node.postings.is_empty() {
                found.push(TokenMatch::new(
                    term,
                    MatchQuality::Exact,
                    0,
                    &node.postings,
                ));
            }
            if term.chars().count() >= 2 {
                collect_prefix(
                    node,
                    &mut term.to_owned(),
                    term,
                    &mut found,
                    MAX_PREFIX_MATCHES,
                );
            }
        }
        let maximum = fuzzy_distance(term);
        if maximum > 0 {
            collect_fuzzy(
                &self.root,
                &term.chars().collect::<Vec<_>>(),
                &(0..=term.chars().count()).collect::<Vec<_>>(),
                maximum,
                &mut String::new(),
                &mut found,
            );
        }
        let mut best = BTreeMap::<(String, String, String), TokenMatch>::new();
        for matched in found {
            for posting in &matched.postings {
                let key = match &posting.field {
                    Field::Title => (posting.page_id.clone(), "title".into(), String::new()),
                    Field::Property { id, name } => {
                        (posting.page_id.clone(), id.clone(), name.clone())
                    }
                };
                let one = TokenMatch {
                    token: matched.token.clone(),
                    quality: matched.quality,
                    distance: matched.distance,
                    postings: vec![posting.clone()],
                };
                if best.get(&key).is_none_or(|old| {
                    (quality_rank(one.quality), one.distance)
                        < (quality_rank(old.quality), old.distance)
                }) {
                    best.insert(key, one);
                }
            }
        }
        best.into_values().collect()
    }

    fn remove(&mut self, token: &str, posting: &Posting) {
        let characters = token.chars().collect::<Vec<_>>();
        remove_posting(&mut self.root, &characters, 0, posting);
    }

    fn node(&self, token: &str) -> Option<&TrieNode> {
        let mut node = &self.root;
        for c in token.chars() {
            node = node.children.get(&c)?;
        }
        Some(node)
    }
}

fn remove_posting(node: &mut TrieNode, token: &[char], offset: usize, posting: &Posting) -> bool {
    if offset == token.len() {
        node.postings.retain(|candidate| candidate != posting);
        return node.postings.is_empty() && node.children.is_empty();
    }
    let character = token[offset];
    let remove_child = node
        .children
        .get_mut(&character)
        .is_some_and(|child| remove_posting(child, token, offset + 1, posting));
    if remove_child {
        node.children.remove(&character);
    }
    node.postings.is_empty() && node.children.is_empty()
}

struct TokenMatch {
    token: String,
    quality: MatchQuality,
    distance: usize,
    postings: Vec<Posting>,
}
impl TokenMatch {
    fn new(token: &str, quality: MatchQuality, distance: usize, postings: &[Posting]) -> Self {
        Self {
            token: token.into(),
            quality,
            distance,
            postings: postings.to_vec(),
        }
    }
}

fn collect_prefix(
    node: &TrieNode,
    token: &mut String,
    exact: &str,
    out: &mut Vec<TokenMatch>,
    maximum: usize,
) {
    if out.len() >= maximum {
        return;
    }
    for (c, child) in &node.children {
        if out.len() >= maximum {
            break;
        }
        token.push(*c);
        if !child.postings.is_empty() && token != exact {
            out.push(TokenMatch::new(
                token,
                MatchQuality::Prefix,
                0,
                &child.postings,
            ));
        }
        collect_prefix(child, token, exact, out, maximum);
        token.pop();
    }
}

fn collect_fuzzy(
    node: &TrieNode,
    target: &[char],
    previous: &[usize],
    maximum: usize,
    token: &mut String,
    out: &mut Vec<TokenMatch>,
) {
    for (c, child) in &node.children {
        let mut current = Vec::with_capacity(previous.len());
        current.push(previous[0] + 1);
        for (i, target_c) in target.iter().enumerate() {
            current.push(
                (previous[i + 1] + 1)
                    .min(current[i] + 1)
                    .min(previous[i] + usize::from(c != target_c)),
            );
        }
        if current.iter().copied().min().unwrap_or(usize::MAX) > maximum {
            continue;
        }
        token.push(*c);
        let distance = *current.last().unwrap_or(&usize::MAX);
        if distance <= maximum && !child.postings.is_empty() {
            out.push(TokenMatch::new(
                token,
                MatchQuality::Fuzzy,
                distance,
                &child.postings,
            ));
        }
        collect_fuzzy(child, target, &current, maximum, token, out);
        token.pop();
    }
}

#[derive(Clone)]
struct Evidence {
    term: String,
    token: String,
    kind: EvidenceKind,
    quality: MatchQuality,
    distance: usize,
    parts: Vec<TextPart>,
}
#[derive(Clone)]
enum EvidenceKind {
    PageKey(String),
    Identity,
    Title,
    Property(String, String),
}
#[derive(Default)]
struct Aggregate {
    terms: HashSet<String>,
    evidence: Vec<Evidence>,
}

#[derive(Default)]
pub struct MetadataSearchIndex {
    documents: BTreeMap<String, MetadataDocument>,
    identities: BTreeMap<String, String>,
    page_keys: BTreeMap<String, String>,
    titles: TokenTrie,
    properties: TokenTrie,
}

impl MetadataSearchIndex {
    pub fn new(documents: Vec<MetadataDocument>) -> Self {
        let mut index = Self::default();
        index.replace(documents);
        index
    }

    pub fn replace(&mut self, documents: Vec<MetadataDocument>) {
        self.documents = documents
            .into_iter()
            .map(|d| (d.page_id.clone(), d))
            .collect();
        self.rebuild();
    }

    pub fn apply_delta(&mut self, upserts: Vec<MetadataDocument>, removals: &[String]) {
        for id in removals {
            if let Some(document) = self.documents.remove(id) {
                self.unindex_document(&document);
            }
        }
        for document in upserts {
            if let Some(previous) = self.documents.remove(&document.page_id) {
                self.unindex_document(&previous);
            }
            self.index_document(&document);
            self.documents.insert(document.page_id.clone(), document);
        }
    }

    fn rebuild(&mut self) {
        self.identities.clear();
        self.page_keys.clear();
        self.titles = TokenTrie::default();
        self.properties = TokenTrie::default();
        for document in self.documents.values().cloned().collect::<Vec<_>>() {
            self.index_document(&document);
        }
    }

    fn index_document(&mut self, document: &MetadataDocument) {
        self.identities.insert(
            normalize_search_text(&document.page_id),
            document.page_id.clone(),
        );
        if let Some(key) = &document.page_key {
            self.page_keys
                .insert(normalize_search_text(key), document.page_id.clone());
        }
        for token in search_tokens(&document.title)
            .into_iter()
            .collect::<HashSet<_>>()
        {
            self.titles.insert(
                &token,
                Posting {
                    page_id: document.page_id.clone(),
                    field: Field::Title,
                },
            );
        }
        let mut indexed_properties = HashSet::new();
        for property in &document.properties {
            for token in search_tokens(&property.text) {
                if !indexed_properties.insert((
                    token.clone(),
                    property.property_id.clone(),
                    property.property_name.clone(),
                )) {
                    continue;
                }
                self.properties.insert(
                    &token,
                    Posting {
                        page_id: document.page_id.clone(),
                        field: Field::Property {
                            id: property.property_id.clone(),
                            name: property.property_name.clone(),
                        },
                    },
                );
            }
        }
    }

    fn unindex_document(&mut self, document: &MetadataDocument) {
        let identity = normalize_search_text(&document.page_id);
        if self.identities.get(&identity) == Some(&document.page_id) {
            self.identities.remove(&identity);
        }
        if let Some(key) = &document.page_key {
            let key = normalize_search_text(key);
            if self.page_keys.get(&key) == Some(&document.page_id) {
                self.page_keys.remove(&key);
            }
        }
        for token in search_tokens(&document.title) {
            self.titles.remove(
                &token,
                &Posting {
                    page_id: document.page_id.clone(),
                    field: Field::Title,
                },
            );
        }
        for property in &document.properties {
            for token in search_tokens(&property.text) {
                self.properties.remove(
                    &token,
                    &Posting {
                        page_id: document.page_id.clone(),
                        field: Field::Property {
                            id: property.property_id.clone(),
                            name: property.property_name.clone(),
                        },
                    },
                );
            }
        }
    }

    pub fn search(&self, request: &SearchRequest) -> Result<Vec<SearchHit>, String> {
        validate_request(request)?;
        let query = normalize_search_text(&request.query);
        let terms = unique_terms(&query)?;
        let aggregates = self.aggregate_query(&query, &terms);
        Ok(self.finish(
            request,
            if query.starts_with('#') {
                Vec::new()
            } else {
                terms
            },
            aggregates,
        ))
    }

    /// Returns the shared metadata evidence before authorization, filters and
    /// top-K. Native Core applies those authority rules; WASM uses `search`.
    pub fn match_documents(&self, query: &str) -> Result<Vec<MetadataMatch>, String> {
        if query.len() > MAX_QUERY_BYTES {
            return Err("query exceeds its UTF-8 byte bound".into());
        }
        let query = normalize_search_text(query);
        let terms = unique_terms(&query)?;
        let mut matches = self
            .aggregate_query(&query, &terms)
            .into_iter()
            .filter(|(_, aggregate)| {
                query.starts_with('#') || terms.iter().all(|term| aggregate.terms.contains(term))
            })
            .map(|(page_id, aggregate)| MetadataMatch {
                page_id,
                evidence: aggregate
                    .evidence
                    .into_iter()
                    .map(|evidence| MetadataMatchEvidence {
                        term: evidence.term,
                        matched_token: evidence.token,
                        source: match evidence.kind {
                            EvidenceKind::PageKey(page_key) => {
                                MetadataMatchSource::PageKey { page_key }
                            }
                            EvidenceKind::Identity => MetadataMatchSource::Identity,
                            EvidenceKind::Title => MetadataMatchSource::Title,
                            EvidenceKind::Property(property_id, property_name) => {
                                MetadataMatchSource::Property {
                                    property_id,
                                    property_name,
                                }
                            }
                        },
                        quality: evidence.quality,
                        edit_distance: evidence.distance,
                        parts: evidence.parts,
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| left.page_id.cmp(&right.page_id));
        Ok(matches)
    }

    fn aggregate_query(&self, query: &str, terms: &[String]) -> HashMap<String, Aggregate> {
        let mut aggregates = HashMap::<String, Aggregate>::new();
        if terms.is_empty() {
            for id in self.documents.keys() {
                aggregates.entry(id.clone()).or_default();
            }
        } else {
            let page_key_query = query.trim_start_matches('#');
            for (key, page_id) in self
                .page_keys
                .range(page_key_query.to_owned()..)
                .take_while(|(key, _)| key.starts_with(page_key_query))
            {
                if key == page_key_query || page_key_query.chars().count() >= 2 {
                    add_evidence(
                        &mut aggregates,
                        page_id,
                        Evidence {
                            term: terms.join(" "),
                            token: key.clone(),
                            // The kernel indexes only the current document Page key;
                            // historical-key status is resolved by Core.
                            kind: EvidenceKind::PageKey(key.clone()),
                            quality: if key == page_key_query {
                                MatchQuality::Exact
                            } else {
                                MatchQuality::Prefix
                            },
                            distance: 0,
                            parts: highlight_text(key, std::slice::from_ref(key)),
                        },
                    );
                }
            }
            if query.starts_with('#') {
                return aggregates;
            }
            for term in terms {
                for (identity, page_id) in self
                    .identities
                    .range(term.clone()..)
                    .take_while(|(identity, _)| identity.starts_with(term))
                    .filter(|(identity, _)| identity.as_str() == term || term.chars().count() >= 2)
                {
                    let document = &self.documents[page_id];
                    add_evidence(
                        &mut aggregates,
                        page_id,
                        Evidence {
                            term: term.clone(),
                            token: identity.clone(),
                            kind: EvidenceKind::Identity,
                            quality: if identity == term {
                                MatchQuality::Exact
                            } else {
                                MatchQuality::Prefix
                            },
                            distance: 0,
                            parts: highlight_text(
                                &document.page_id,
                                std::slice::from_ref(identity),
                            ),
                        },
                    );
                }
                for matched in self.titles.matches(term) {
                    for posting in matched.postings {
                        let document = &self.documents[&posting.page_id];
                        add_evidence(
                            &mut aggregates,
                            &posting.page_id,
                            Evidence {
                                term: term.clone(),
                                token: matched.token.clone(),
                                kind: EvidenceKind::Title,
                                quality: matched.quality,
                                distance: matched.distance,
                                parts: highlight_text(
                                    &document.title,
                                    std::slice::from_ref(&matched.token),
                                ),
                            },
                        );
                    }
                }
                for matched in self.properties.matches(term) {
                    for posting in matched.postings {
                        let Field::Property { id, name } = posting.field else {
                            continue;
                        };
                        let document = &self.documents[&posting.page_id];
                        let Some(property) = document
                            .properties
                            .iter()
                            .find(|p| p.property_id == id && p.property_name == name)
                        else {
                            continue;
                        };
                        add_evidence(
                            &mut aggregates,
                            &posting.page_id,
                            Evidence {
                                term: term.clone(),
                                token: matched.token.clone(),
                                kind: EvidenceKind::Property(id, name),
                                quality: matched.quality,
                                distance: matched.distance,
                                parts: highlight_text(
                                    &property.text,
                                    std::slice::from_ref(&matched.token),
                                ),
                            },
                        );
                    }
                }
            }
        }
        aggregates
    }

    fn finish(
        &self,
        request: &SearchRequest,
        terms: Vec<String>,
        aggregates: HashMap<String, Aggregate>,
    ) -> Vec<SearchHit> {
        let excluded = request
            .exclude_page_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let recent = request
            .recent_page_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i))
            .collect::<HashMap<_, _>>();
        let projects = preferred_projects(
            &request.project_ids,
            request.preferred_project_id.as_deref(),
        );
        let mut rows = aggregates
            .into_iter()
            .filter(|(_, a)| terms.iter().all(|term| a.terms.contains(term)))
            .filter_map(|(id, aggregate)| {
                let document = self.documents.get(&id)?;
                if excluded.contains(id.as_str())
                    || !matches_filters(document, request.filters.as_ref())
                    || (!request.data_source_ids.is_empty()
                        && !request
                            .data_source_ids
                            .iter()
                            .any(|source| document.data_source_ids.contains(source)))
                {
                    return None;
                }
                let project_id = projects
                    .iter()
                    .find(|project| document.project_ids.contains(project))
                    .cloned()?;
                Some((
                    document,
                    project_id,
                    recent.get(id.as_str()).copied(),
                    aggregate,
                ))
            })
            .collect::<Vec<_>>();
        rows.sort_by(|(a, ap, ar, aa), (b, bp, br, ba)| {
            compare_aggregate(aa, ba)
                .then_with(|| {
                    context_rank(ap, *ar, request.preferred_project_id.as_deref()).cmp(
                        &context_rank(bp, *br, request.preferred_project_id.as_deref()),
                    )
                })
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.page_id.cmp(&b.page_id))
        });
        rows.into_iter()
            .take(request.limit.unwrap_or(20) as usize)
            .map(|(document, project_id, _, aggregate)| hit(document, project_id, aggregate))
            .collect()
    }
}

fn hit(document: &MetadataDocument, project_id: String, aggregate: Aggregate) -> SearchHit {
    let mut evidence = aggregate.evidence;
    evidence.sort_by(|a, b| {
        evidence_rank(a)
            .cmp(&evidence_rank(b))
            .then_with(|| a.term.cmp(&b.term))
            .then_with(|| evidence_key(&a.kind).cmp(&evidence_key(&b.kind)))
    });
    let mut seen = HashSet::new();
    evidence.retain(|e| seen.insert((e.term.clone(), evidence_key(&e.kind))));
    let title_tokens = evidence
        .iter()
        .filter(|e| matches!(e.kind, EvidenceKind::Title))
        .map(|e| e.token.clone())
        .collect::<Vec<_>>();
    let property = evidence
        .iter()
        .find(|e| matches!(e.kind, EvidenceKind::Property(_, _)));
    let title_parts = highlight_text(&document.title, &title_tokens);
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
        location_label: document.location_label.clone(),
        title_parts,
        excerpt,
        excerpt_parts,
        matches: evidence
            .into_iter()
            .map(|e| match e.kind {
                EvidenceKind::PageKey(page_key) => SearchMatch::PageKey {
                    quality: e.quality,
                    page_key,
                    is_current: true,
                    parts: e.parts,
                },
                EvidenceKind::Identity => SearchMatch::Identity {
                    quality: e.quality,
                    parts: e.parts,
                },
                EvidenceKind::Title => SearchMatch::Title {
                    quality: e.quality,
                    parts: e.parts,
                },
                EvidenceKind::Property(id, name) => SearchMatch::Property {
                    quality: e.quality,
                    property_id: id,
                    property_name: name,
                    parts: e.parts,
                },
            })
            .collect(),
        updated_at: document.updated_at.clone(),
    }
}

fn add_evidence(aggregates: &mut HashMap<String, Aggregate>, page_id: &str, evidence: Evidence) {
    let aggregate = aggregates.entry(page_id.to_owned()).or_default();
    aggregate.terms.insert(evidence.term.clone());
    if !aggregate.evidence.iter().any(|e| {
        e.term == evidence.term
            && e.token == evidence.token
            && evidence_key(&e.kind) == evidence_key(&evidence.kind)
    }) {
        aggregate.evidence.push(evidence);
    }
}
fn evidence_key(kind: &EvidenceKind) -> String {
    match kind {
        EvidenceKind::PageKey(k) => format!("page_key:{k}"),
        EvidenceKind::Identity => "identity".into(),
        EvidenceKind::Title => "title".into(),
        EvidenceKind::Property(id, _) => format!("property:{id}"),
    }
}
fn evidence_rank(e: &Evidence) -> usize {
    match (&e.kind, e.quality) {
        (EvidenceKind::PageKey(_), _) => 0,
        (EvidenceKind::Identity, MatchQuality::Exact) => 1,
        (EvidenceKind::Identity, _) => 2,
        (EvidenceKind::Title, MatchQuality::Exact) => 3,
        (EvidenceKind::Title, MatchQuality::Prefix) => 4,
        (EvidenceKind::Title, MatchQuality::Fuzzy) => 5,
        (EvidenceKind::Property(_, _), MatchQuality::Exact) => 6,
        (EvidenceKind::Property(_, _), MatchQuality::Prefix) => 7,
        (EvidenceKind::Property(_, _), MatchQuality::Fuzzy) => 8,
    }
}
fn aggregate_rank(a: &Aggregate) -> (usize, usize, usize, usize, usize) {
    let mut best = HashMap::<&str, (usize, usize)>::new();
    for e in &a.evidence {
        let candidate = (evidence_rank(e), e.distance);
        best.entry(&e.term)
            .and_modify(|v| *v = (*v).min(candidate))
            .or_insert(candidate);
    }
    let mut ranks = best.into_values().collect::<Vec<_>>();
    ranks.sort_unstable();
    (
        ranks.iter().map(|v| v.0).max().unwrap_or(usize::MAX),
        ranks.iter().map(|v| v.1).max().unwrap_or(0),
        ranks.iter().map(|v| v.0).sum(),
        ranks.iter().map(|v| v.1).sum(),
        usize::MAX - a.evidence.len(),
    )
}
fn compare_aggregate(a: &Aggregate, b: &Aggregate) -> Ordering {
    aggregate_rank(a).cmp(&aggregate_rank(b))
}
fn context_rank(project: &str, recent: Option<usize>, preferred: Option<&str>) -> (usize, usize) {
    (
        usize::from(Some(project) != preferred || preferred.is_none()),
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
fn matches_filters(d: &MetadataDocument, f: Option<&SearchFilters>) -> bool {
    let Some(f) = f else { return true };
    if let Some(statuses) = &f.statuses
        && !d.status.is_some_and(|s| statuses.contains(&s))
    {
        return false;
    }
    if let Some(priorities) = &f.priorities {
        match &d.priority {
            Some(p) if priorities.contains(p) => {}
            None if f.include_empty_priority => {}
            _ => return false,
        }
    }
    if !f.assignees.is_empty() && !d.assignee.as_ref().is_some_and(|a| f.assignees.contains(a)) {
        return false;
    }
    if f.tags.is_empty() {
        return true;
    }
    let selected = d
        .tags
        .iter()
        .map(|t| (&t.data_source_id, &t.property_id, &t.option_id))
        .collect::<HashSet<_>>();
    let count = f
        .tags
        .iter()
        .filter(|t| selected.contains(&(&t.data_source_id, &t.property_id, &t.option_id)))
        .count();
    match f.tag_mode {
        TagMode::Any => count > 0,
        TagMode::All => count == f.tags.len(),
        TagMode::None => count == 0,
    }
}
fn validate_request(r: &SearchRequest) -> Result<(), String> {
    if r.query.len() > MAX_QUERY_BYTES {
        return Err("query exceeds its UTF-8 byte bound".into());
    }
    if r.project_ids.is_empty() {
        return Err("project scope is empty".into());
    }
    let limit = r.limit.unwrap_or(20) as usize;
    if limit == 0 || limit > MAX_RESULTS {
        return Err("limit is out of range".into());
    }
    Ok(())
}
fn unique_terms(query: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for term in search_tokens(query) {
        if !out.contains(&term) {
            out.push(term)
        }
    }
    if out.len() > MAX_QUERY_TERMS {
        return Err("query has too many terms".into());
    }
    Ok(out)
}
pub fn normalize_search_text(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn search_tokens(value: &str) -> Vec<String> {
    normalize_search_text(value)
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect()
}
pub fn fuzzy_distance(term: &str) -> usize {
    let length = term.chars().count();
    if length <= 3 {
        return 0;
    }
    let threshold = if length <= 5 { 0.1 } else { 0.2 };
    (((length as f64) * threshold).round() as usize).min(6)
}
fn quality_rank(q: MatchQuality) -> usize {
    match q {
        MatchQuality::Exact => 0,
        MatchQuality::Prefix => 1,
        MatchQuality::Fuzzy => 2,
    }
}
fn highlight_text(text: &str, tokens: &[String]) -> Vec<TextPart> {
    if text.is_empty() {
        return Vec::new();
    }
    let matched = tokens
        .iter()
        .map(|t| normalize_search_text(t))
        .collect::<HashSet<_>>();
    let mut out = Vec::new();
    let mut buffer = String::new();
    let mut state = None;
    for token in split_preserving_whitespace(text) {
        let highlighted = !normalize_search_text(token).is_empty()
            && matched.contains(&normalize_search_text(token));
        if state.is_none() || state == Some(highlighted) {
            buffer.push_str(token);
            state = Some(highlighted);
            continue;
        }
        push_part(
            &mut out,
            std::mem::take(&mut buffer),
            state.unwrap_or(false),
        );
        buffer.push_str(token);
        state = Some(highlighted)
    }
    push_part(&mut out, buffer, state.unwrap_or(false));
    out
}
fn split_preserving_whitespace(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut whitespace = None;
    for (i, c) in value.char_indices() {
        let next = c.is_whitespace();
        if whitespace.is_some_and(|v| v != next) {
            out.push(&value[start..i]);
            start = i
        }
        whitespace = Some(next)
    }
    if start < value.len() {
        out.push(&value[start..])
    }
    out
}
fn push_part(out: &mut Vec<TextPart>, text: String, highlighted: bool) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.highlighted == highlighted
    {
        last.text.push_str(&text)
    } else {
        out.push(TextPart { text, highlighted })
    }
}
fn join_parts(parts: &[TextPart]) -> String {
    parts.iter().map(|p| p.text.as_str()).collect()
}

#[cfg(feature = "wasm")]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

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
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityCase {
        name: String,
        request: SearchRequest,
        expected_page_ids: Vec<String>,
    }
    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            project_ids: vec!["p".into()],
            query: query.into(),
            filters: None,
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
            location_label: "Pages".into(),
            updated_at: "2026-01-01".into(),
            properties: Vec::new(),
            project_ids: vec!["p".into()],
            data_source_ids: Vec::new(),
        }
    }
    #[test]
    fn unicode_fuzzy_and_highlights_share_one_contract() {
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
                .unwrap_or_else(|error| panic!("{}: {error}", case.name))
                .into_iter()
                .map(|hit| hit.page_id)
                .collect::<Vec<_>>();
            assert_eq!(actual, case.expected_page_ids, "{}", case.name);
        }
    }
}
