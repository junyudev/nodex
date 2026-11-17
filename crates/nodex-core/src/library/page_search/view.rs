use super::*;
use nodex_core_contracts::database::{DatabasePageSearchEvidence, DatabaseViewSearchStatus};
use nodex_search_kernel::MetadataTextIndex;
use rusqlite::params;

pub(crate) const MAX_VIEW_MATCHES: usize = 100_000;

#[derive(Default)]
pub(super) struct ViewMetadataCache {
    last: Mutex<Option<(String, i64, String, Arc<ViewMetadata>)>>,
}

#[derive(Default)]
struct ViewMetadataBuilder {
    pages: HashMap<String, ViewMetadataPage>,
    field_slots: HashMap<String, usize>,
    texts: Vec<String>,
    owners: Vec<Vec<usize>>,
    schema_fields: Vec<usize>,
}

struct ViewMetadataPage {
    slot: usize,
    title: usize,
    exact_head: bool,
    document_id: String,
    document_generation: i64,
    document_head_seq: i64,
    document_ready: bool,
    has_task_parent_value: bool,
    properties: Vec<(String, String, usize)>,
}

struct ViewMetadata {
    pages: HashMap<String, ViewMetadataPage>,
    ids: Vec<String>,
    identities: BTreeMap<String, usize>,
    texts: Vec<String>,
    owners: Vec<Vec<usize>>,
    schema_fields: Vec<usize>,
    index: MetadataTextIndex,
}

impl ViewMetadataBuilder {
    fn field(&mut self, text: String) -> usize {
        *self.field_slots.entry(text).or_insert_with_key(|text| {
            let index = self.texts.len();
            self.texts.push(text.clone());
            self.owners.push(Vec::new());
            index
        })
    }

    fn property(&mut self, page_id: &str, id: &str, name: &str, text: String) {
        if text.is_empty() || !self.pages.contains_key(page_id) {
            return;
        }
        let field = self.field(text);
        let page = self.pages.get_mut(page_id).expect("known Page");
        self.owners[field].push(page.slot);
        page.properties
            .push((id.to_owned(), name.to_owned(), field));
    }

    fn finish(self, ids: Vec<String>) -> ViewMetadata {
        let identities = ids
            .iter()
            .enumerate()
            .map(|(slot, id)| (nodex_search_kernel::metadata_identity_key(id), slot))
            .collect();
        let index = MetadataTextIndex::new(self.texts.iter().map(String::as_str));
        ViewMetadata {
            pages: self.pages,
            ids,
            identities,
            texts: self.texts,
            owners: self.owners,
            schema_fields: self.schema_fields,
            index,
        }
    }
}

impl ViewMetadata {
    fn read(
        connection: &Connection,
        library_id: &str,
        data_source_id: &str,
    ) -> Result<Self, StoreError> {
        let mut metadata = ViewMetadataBuilder::default();
        let mut ids = Vec::new();
        let mut statement = connection.prepare(
            "SELECT model.page_block_id, model.title, materialization.document_id IS NOT NULL,
                    document.id, document.generation, document.head_seq, document.readiness = 'ready'
             FROM data_source_page_memberships membership
             CROSS JOIN page_read_model model ON model.page_block_id = membership.page_block_id
               AND model.membership_id = membership.id
             CROSS JOIN documents document ON document.id = model.document_id
             LEFT JOIN document_materializations materialization INDEXED BY idx_document_materializations_exact_head
               ON materialization.document_id = document.id
               AND document.generation = model.document_generation
               AND document.head_seq = model.document_projected_seq
               AND materialization.generation = document.generation
               AND materialization.projected_seq = document.head_seq
               AND materialization.schema_version = document.schema_version
             WHERE membership.data_source_id = ?1 AND membership.removed_at IS NULL
               AND model.library_id = ?2 AND model.lifecycle = 'active'",
        )?;
        let mut rows = statement.query(params![data_source_id, library_id])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let title = metadata.field(row.get(1)?);
            let slot = ids.len();
            metadata.owners[title].push(slot);
            metadata.pages.insert(
                id.clone(),
                ViewMetadataPage {
                    slot,
                    title,
                    exact_head: row.get(2)?,
                    document_id: row.get(3)?,
                    document_generation: row.get(4)?,
                    document_head_seq: row.get(5)?,
                    document_ready: row.get(6)?,
                    has_task_parent_value: false,
                    properties: Vec::new(),
                },
            );
            ids.push(id);
        }
        let properties = connection
            .prepare(
                "SELECT id, name, value_type, config_json FROM data_source_properties
             WHERE data_source_id = ?1 AND lifecycle = 'active'",
            )?
            .query_map([data_source_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ),
                ))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        for (name, _, _) in properties.values() {
            if !name.trim().is_empty() {
                let field = metadata.field(name.clone());
                metadata.schema_fields.push(field);
            }
        }
        metadata.schema_fields.sort_unstable();
        metadata.schema_fields.dedup();
        let mut statement = connection.prepare(
            "SELECT membership.page_block_id, value.property_id, value.value_json,
                    value.value_type = 'relation' AND json_type(value.value_json) = 'null'
             FROM data_source_property_values value
             CROSS JOIN data_source_page_memberships membership ON membership.id = value.membership_id
             WHERE value.data_source_id = ?1 AND membership.removed_at IS NULL
               AND (value.property_id = 'task_parent' OR
                    (value.value_type <> 'relation' AND value.value_json <> 'null'))",
        )?;
        let mut property_labels = HashMap::<(String, String), Option<String>>::new();
        let mut rows = statement.query([data_source_id])?;
        while let Some(row) = rows.next()? {
            let page_id: String = row.get(0)?;
            let id: String = row.get(1)?;
            if id == "task_parent" {
                if let Some(page) = metadata.pages.get_mut(&page_id) {
                    page.has_task_parent_value = row.get(3)?;
                }
                continue;
            }
            let Some((name, kind, config)) = properties.get(&id) else {
                continue;
            };
            let encoded: String = row.get(2)?;
            let label = |encoded: &str| {
                let decoded = serde_json::from_str(encoded)
                    .map_err(|_| corrupt("Page search Property value is invalid"))?;
                property_display_value(data_source_id, &id, kind, config, &decoded)
                    .map(|result| result.map(|(text, _)| text))
            };
            let text = if encoded.len() <= 128 {
                let key = (id.clone(), encoded);
                if let Some(text) = property_labels.get(&key) {
                    text.clone()
                } else {
                    let text = label(&key.1)?;
                    if property_labels.len() < 4_096 {
                        property_labels.insert(key, text.clone());
                    }
                    text
                }
            } else {
                label(&encoded)?
            };
            if let Some(text) = text {
                metadata.property(&page_id, &id, name, text);
            }
        }
        metadata.read_work(connection, library_id, data_source_id)?;
        for (page, values) in read_search_context(connection, library_id)? {
            for (index, text) in values.into_iter().enumerate() {
                metadata.property(
                    &page,
                    &format!("{CONTEXT_PROPERTY_PREFIX}{index}"),
                    "",
                    text,
                );
            }
        }
        Ok(metadata.finish(ids))
    }

    fn slots(&self, fields: impl Iterator<Item = usize>, slots: &mut HashSet<usize>) {
        for field in fields {
            if self.schema_fields.binary_search(&field).is_ok() {
                slots.extend(0..self.ids.len());
                return;
            }
            slots.extend(self.owners[field].iter().copied());
        }
    }

    fn document(&self, id: &str) -> KernelDocument {
        let page = &self.pages[id];
        let schema = self
            .schema_fields
            .iter()
            .enumerate()
            .map(|(index, field)| KernelProperty {
                property_id: format!("{CONTEXT_PROPERTY_PREFIX}schema:{index}"),
                property_name: String::new(),
                text: self.texts[*field].clone(),
            });
        let properties = page
            .properties
            .iter()
            .map(|(id, name, field)| KernelProperty {
                property_id: id.clone(),
                property_name: name.clone(),
                text: self.texts[*field].clone(),
            })
            .chain(schema)
            .collect();
        KernelDocument {
            page_id: id.to_owned(),
            title: self.texts[page.title].clone(),
            properties,
            page_key: None,
            preview: String::new(),
            status: None,
            priority: None,
            tags: Vec::new(),
            assignee: None,
            owner: None,
            location_label: String::new(),
            updated_at: String::new(),
            project_ids: Vec::new(),
            data_source_ids: Vec::new(),
        }
    }
}

impl ViewMetadataBuilder {
    fn read_work(
        &mut self,
        connection: &Connection,
        library_id: &str,
        data_source_id: &str,
    ) -> Result<(), StoreError> {
        let members = super::super::members::list(connection, library_id)?;
        let label = |assignment: &nodex_core_contracts::library::PageAssignee| match assignment {
            nodex_core_contracts::library::PageAssignee::Member { member_id } => members
                .iter()
                .find(|member| &member.id == member_id)
                .map(|member| member.display_name.clone())
                .unwrap_or_default(),
            nodex_core_contracts::library::PageAssignee::Agent {
                instance_id, model, ..
            } => format!("{instance_id} {model}"),
        };
        let mut statement = connection.prepare(
            "SELECT property.block_id, property.value_json FROM block_properties property
             JOIN data_source_page_memberships membership ON membership.page_block_id = property.block_id
             WHERE property.library_id = ?1 AND property.property_key = 'work'
               AND membership.data_source_id = ?2 AND membership.removed_at IS NULL",
        )?;
        let mut rows = statement.query(params![library_id, data_source_id])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let encoded: String = row.get(1)?;
            let value =
                serde_json::from_str(&encoded).map_err(|_| corrupt("Page work JSON is invalid"))?;
            let work = super::super::parse_page_work(&value)?;
            self.property(
                &id,
                "owner",
                "Owner",
                label(&nodex_core_contracts::library::PageAssignee::Member {
                    member_id: work.owner,
                }),
            );
            if let Some(assignee) = work.assignee {
                self.property(&id, "assignee", "Assignee", label(&assignee));
            }
        }
        Ok(())
    }
}

impl ViewMetadataCache {
    fn read(
        &self,
        connection: &Connection,
        library_id: &str,
        store_epoch: &str,
        commit_head: i64,
        data_source_id: &str,
    ) -> Result<Arc<ViewMetadata>, StoreError> {
        let mut last = self
            .last
            .lock()
            .map_err(|_| internal("View metadata cache is unavailable"))?;
        if let Some((epoch, revision, source, metadata)) = last.as_ref()
            && epoch == store_epoch
            && *revision == commit_head
            && source == data_source_id
        {
            return Ok(metadata.clone());
        }
        let metadata = Arc::new(ViewMetadata::read(connection, library_id, data_source_id)?);
        *last = Some((
            store_epoch.to_owned(),
            commit_head,
            data_source_id.to_owned(),
            metadata.clone(),
        ));
        Ok(metadata)
    }
}

/// Resolve membership first. Keep only Page IDs, the scoped typo policy,
/// and enough information to hydrate evidence for the returned window.
pub(crate) struct ViewPageMatches {
    metadata: Option<Arc<ViewMetadata>>,
    words: Vec<QueryWord>,
    strong: HashSet<String>,
    keys: HashMap<String, Evidence>,
    body_hits: HashMap<usize, block_search::ViewBodyHit>,
    ids: Vec<String>,
    pub(crate) exact_heads: bool,
    pub(crate) ids_json: String,
    pub(crate) located_ids_json: Option<String>,
    pub(crate) status: DatabaseViewSearchStatus,
}

impl ViewPageMatches {
    pub(crate) fn exceeds_bound(&self) -> bool {
        self.ids.len() > MAX_VIEW_MATCHES
    }

    pub(crate) fn bound(&mut self, eligible: Option<Vec<String>>) -> Result<(), StoreError> {
        if let Some(ids) = eligible {
            self.ids = ids;
        }
        self.status.truncated |= self.exceeds_bound();
        self.ids.truncate(MAX_VIEW_MATCHES);
        self.ids_json = serde_json::to_string(&self.ids)
            .map_err(|_| internal("Cannot encode View search candidates"))?;
        self.located_ids_json = locate_ids(&self.ids, self.metadata.as_deref())?;
        Ok(())
    }

    pub(crate) fn evidence<'a>(
        &self,
        connection: &Connection,
        rows: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<HashMap<String, DatabasePageSearchEvidence>, StoreError> {
        let rows = rows
            .into_iter()
            .filter(|(id, _)| {
                self.ids
                    .binary_search_by(|candidate| candidate.as_str().cmp(id))
                    .is_ok()
            })
            .collect::<HashMap<_, _>>();
        if rows.is_empty() {
            return Ok(HashMap::new());
        }
        let mut aggregates = HashMap::new();
        for &id in rows.keys() {
            if let Some(key) = self.keys.get(id) {
                add_evidence(&mut aggregates, id, key.clone());
            }
        }
        if let Some(metadata) = &self.metadata {
            let index =
                MetadataSearchIndex::new(rows.keys().map(|id| metadata.document(id)).collect());
            let evidence = index
                .match_documents(
                    &self.status.query,
                    |_| true,
                    |word| self.strong.contains(word.text()),
                )
                .map_err(|message| invalid(&message))?;
            add_metadata_evidence(&mut aggregates, evidence);
            for &id in rows.keys() {
                let Some(hit) = self.body_hits.get(&metadata.pages[id].slot) else {
                    continue;
                };
                let Some(body) = hit.reveal(connection, &self.words, &self.strong)? else {
                    continue;
                };
                let kind = if body.context {
                    EvidenceKind::Context
                } else {
                    EvidenceKind::Body {
                        block_id: body.block_id,
                        block_type: body.block_type,
                        combined: body.matches.len() > 1,
                    }
                };
                for (index, quality, parts) in body.matches {
                    add_evidence(
                        &mut aggregates,
                        id,
                        Evidence {
                            term: self.words[index].text().to_owned(),
                            kind: kind.clone(),
                            quality,
                            edit_distance: 0,
                            parts,
                        },
                    );
                }
            }
        }
        Ok(rows
            .into_iter()
            .filter_map(|(id, title)| {
                let evidence = aggregates.remove(id)?.evidence;
                Some((
                    id.to_owned(),
                    DatabasePageSearchEvidence {
                        title_parts: title_parts_for_text(title, &evidence),
                        excerpt_parts: compose_excerpt_parts(&evidence),
                        matches: representative_evidence(&evidence),
                    },
                ))
            })
            .collect())
    }
}

impl PageSearchIndexRegistry {
    pub(crate) fn search_view(
        &self,
        connection: &Connection,
        library_id: &str,
        store_epoch: &str,
        commit_head: i64,
        data_source_id: &str,
        query: &str,
    ) -> Result<ViewPageMatches, StoreError> {
        let words = page_query_words(query).map_err(|message| invalid(&message))?;
        let key_query = normalize_search_text(query);
        let keys = read_view_keys(
            connection,
            library_id,
            data_source_id,
            &key_query,
            words.first(),
        )?;
        let metadata = if words.is_empty() || is_explicit_page_key_search(&key_query) {
            None
        } else {
            Some(self.view_metadata.read(
                connection,
                library_id,
                store_epoch,
                commit_head,
                data_source_id,
            )?)
        };
        let coverage = if metadata.is_some() {
            block_search::view_coverage(connection, data_source_id)?
        } else {
            LibrarySearchCoverage::Complete
        };
        let mut truncated = false;
        let mut strong = HashSet::new();
        let mut body_hits = HashMap::new();
        let mut ids = if let Some(metadata) = &metadata {
            let mut matches: Option<HashSet<usize>> = None;
            for (word_index, word) in words.iter().enumerate() {
                let mut scoped = HashSet::new();
                metadata.slots(metadata.index.strong(word), &mut scoped);
                scoped.extend(
                    metadata
                        .identities
                        .range(word.text().to_owned()..)
                        .take_while(|(id, _)| id.starts_with(word.text()))
                        .filter(|(id, _)| {
                            id.as_str() == word.text() || word.text().chars().take(2).count() == 2
                        })
                        .map(|(_, slot)| *slot),
                );
                if word_index == 0 {
                    scoped.extend(
                        keys.keys()
                            .filter_map(|id| metadata.pages.get(id).map(|page| page.slot)),
                    );
                }
                let body = block_search::view_word_pages(
                    connection,
                    word,
                    library_id,
                    !scoped.is_empty(),
                    |id, document, generation, seq| {
                        let page = metadata.pages.get(id)?;
                        (page.document_ready
                            && page.document_id == document
                            && page.document_generation == generation
                            && seq <= page.document_head_seq)
                            .then_some(page.slot)
                    },
                )?;
                truncated |= body.truncated;
                if body.strong {
                    strong.insert(word.text().to_owned());
                }
                for (slot, hit) in body.hits {
                    scoped.insert(slot);
                    let best = body_hits.entry(slot).or_insert(hit);
                    *best = (*best).min(hit);
                }
                metadata.slots(metadata.index.loose(word, !body.strong), &mut scoped);
                if let Some(matched) = &mut matches {
                    matched.retain(|slot| scoped.contains(slot));
                } else {
                    matches = Some(scoped);
                }
                if matches.as_ref().is_some_and(HashSet::is_empty) {
                    break;
                }
            }
            matches
                .into_iter()
                .flatten()
                .map(|slot| &metadata.ids[slot])
                .filter(|id| metadata.pages[*id].exact_head)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            keys.keys().cloned().collect()
        };
        ids.sort_unstable();
        let located_ids_json = locate_ids(&ids, metadata.as_deref())?;
        Ok(ViewPageMatches {
            ids_json: serde_json::to_string(&ids)
                .map_err(|_| internal("Cannot encode View search candidates"))?,
            located_ids_json,
            ids,
            exact_heads: metadata.is_some(),
            metadata,
            words,
            strong,
            keys,
            body_hits,
            status: DatabaseViewSearchStatus {
                query: query.to_owned(),
                result_key: String::new(),
                coverage,
                truncated,
            },
        })
    }
}

fn locate_ids(
    ids: &[String],
    metadata: Option<&ViewMetadata>,
) -> Result<Option<String>, StoreError> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    if ids
        .iter()
        .all(|id| metadata.pages[id].has_task_parent_value)
    {
        return Ok(None);
    }
    let located = ids
        .iter()
        .filter(|id| metadata.pages[*id].has_task_parent_value)
        .collect::<Vec<_>>();
    serde_json::to_string(&located)
        .map(Some)
        .map_err(|_| internal("Cannot encode View search row coordinates"))
}

fn read_view_keys(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
    query: &str,
    word: Option<&QueryWord>,
) -> Result<HashMap<String, Evidence>, StoreError> {
    let mut keys = HashMap::new();
    let Some(word) = word else {
        return Ok(keys);
    };
    let mut member = connection.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM data_source_page_memberships membership
         JOIN page_read_model model ON model.page_block_id = membership.page_block_id
           AND model.membership_id = membership.id
         WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2
           AND membership.removed_at IS NULL AND model.lifecycle = 'active')",
    )?;
    for resolution in resolve_page_key_matches_in_library(connection, library_id, query)? {
        if member.query_row(params![data_source_id, resolution.page_block_id], |row| {
            row.get::<_, bool>(0)
        })? {
            keys.insert(
                resolution.page_block_id,
                Evidence {
                    term: word.text().to_owned(),
                    parts: vec![LibraryPageSearchTextPart {
                        text: resolution.matched_page_key.clone(),
                        highlighted: true,
                    }],
                    kind: EvidenceKind::PageKey {
                        page_key: resolution.matched_page_key,
                        is_current: resolution.is_current,
                    },
                    quality: SearchTermMatchQuality::Exact,
                    edit_distance: 0,
                },
            );
        }
    }
    Ok(keys)
}
