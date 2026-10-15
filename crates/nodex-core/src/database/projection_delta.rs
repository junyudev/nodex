use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::database::DatabaseRowSummary;
use nodex_core_contracts::{LocalProjectionPatch, LocalProjectionScope, ProjectionImpact};
use rusqlite::{Connection, OptionalExtension};

use crate::infrastructure::local_commit::{self, CommitContext};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::window::{ViewGroupsRead, exact_primary_board_row_by_id, view_groups};

const MAX_ACTIVE_PROJECTION_AUDIENCES: usize = 200;
const MAX_INLINE_PROJECTION_PATCH_BYTES: usize = 128 * 1024;
const MAX_INLINE_VIEW_CANDIDATES: i64 = 128;

/// Bounded work counters returned by the audience compiler. They are useful to
/// performance gates and deliberately describe semantic work rather than wall
/// clock timing.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ProjectionAudienceCompilation {
    pub candidate_audiences: usize,
    pub fingerprint_groups: usize,
    pub patch_blobs: usize,
    pub budget_fallbacks: usize,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ProjectionInputFingerprint {
    pre_visible_page_ids: Vec<String>,
    post_visible_page_ids: Vec<String>,
    visible_view_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct ProjectionAudience {
    project_id: String,
    input: ProjectionInputFingerprint,
}

#[derive(Clone, Debug)]
struct CompiledViewDelta {
    database_id: String,
    data_source_id: String,
    view_id: String,
    content: ViewDeltaContent,
}

#[derive(Clone, Debug)]
enum ViewDeltaContent {
    ReadRequired {
        budget_exceeded: bool,
    },
    Upsert {
        row: Box<DatabaseRowSummary>,
        total_rows: i64,
        group_total: Option<i64>,
    },
}

/// Compiles every active Project audience from one canonical transaction
/// snapshot. Projects with the same affected-resource visibility share View
/// work. Relation previews are the deliberate exception: their target
/// redaction depends on recipient authority, so those rows compile per
/// Project while each Project still receives its own revision and effect.
pub(crate) fn record_local_projection_delta(
    connection: &Connection,
    commit: &CommitContext,
    library_id: &str,
    impact: &ProjectionImpact,
) -> Result<ProjectionAudienceCompilation, StoreError> {
    let ProjectionImpact::Resources {
        page_ids, view_ids, ..
    } = impact
    else {
        return match impact {
            ProjectionImpact::None => Ok(ProjectionAudienceCompilation::default()),
            ProjectionImpact::All => record_all_projection_resets(connection, commit, library_id),
            ProjectionImpact::Resources { .. } => unreachable!(),
        };
    };

    let affected_page_ids = canonical_strings(page_ids);
    let affected_view_ids = canonical_strings(view_ids);
    if !affected_page_ids.is_empty() || !affected_view_ids.is_empty() {
        local_commit::require_projection_read(
            connection,
            commit,
            LocalProjectionScope::Library {
                library_id: library_id.to_owned(),
            },
        )?;
    }
    let audiences = compile_audiences(
        connection,
        library_id,
        &affected_page_ids,
        &affected_view_ids,
    )?;
    let mut grouped = BTreeMap::<ProjectionInputFingerprint, Vec<String>>::new();
    for audience in audiences {
        grouped
            .entry(audience.input)
            .or_default()
            .push(audience.project_id);
    }
    let mut metrics = ProjectionAudienceCompilation {
        candidate_audiences: grouped.values().map(Vec::len).sum(),
        fingerprint_groups: grouped.len(),
        ..ProjectionAudienceCompilation::default()
    };

    for (input, mut project_ids) in grouped {
        project_ids.sort();
        let representative = project_ids
            .first()
            .ok_or_else(|| internal("Projection audience group is empty"))?;
        let projection_page_ids =
            canonical_union(&input.pre_visible_page_ids, &input.post_visible_page_ids);
        let representative_views = input
            .visible_view_ids
            .iter()
            .map(|view_id| {
                compile_view_delta(
                    connection,
                    commit,
                    library_id,
                    representative,
                    view_id,
                    &projection_page_ids,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        metrics.patch_blobs += input.post_visible_page_ids.len() + representative_views.len();
        for project_id in project_ids {
            let compiled_views = &representative_views;
            record_page_deltas(
                connection,
                commit,
                &project_id,
                &input.post_visible_page_ids,
            )?;
            for compiled in compiled_views {
                record_compiled_view_delta(
                    connection,
                    commit,
                    &project_id,
                    compiled,
                    &mut metrics,
                )?;
            }
        }
    }
    Ok(metrics)
}

/// Advances the exact Page and DatabaseView projection scopes affected by a
/// Page Document edit without materializing relational View rows on the
/// document writer's hot path.
///
/// Database and Data Source identities in the durable impact are routing
/// evidence for the affected Views. An ordinary title or body edit does not
/// change their shared descriptors, so it must not promote to a Project reset.
pub(crate) fn record_page_document_projection_delta(
    connection: &Connection,
    commit: &CommitContext,
    library_id: &str,
    impact: &ProjectionImpact,
) -> Result<(), StoreError> {
    let ProjectionImpact::Resources {
        page_ids, view_ids, ..
    } = impact
    else {
        return match impact {
            ProjectionImpact::None => Ok(()),
            ProjectionImpact::All => {
                record_all_projection_resets(connection, commit, library_id).map(|_| ())
            }
            ProjectionImpact::Resources { .. } => unreachable!(),
        };
    };
    let page_ids = canonical_strings(page_ids);
    let view_ids = canonical_strings(view_ids);
    if page_ids.is_empty() && view_ids.is_empty() {
        return Ok(());
    }
    local_commit::require_projection_read(
        connection,
        commit,
        LocalProjectionScope::Library {
            library_id: library_id.to_owned(),
        },
    )?;
    let view_coordinates = view_ids
        .iter()
        .map(|view_id| {
            let coordinates = connection
                .query_row(
                    "SELECT view.database_block_id, view.data_source_id
                     FROM database_views view
                     JOIN data_sources source ON source.id = view.data_source_id
                     WHERE view.id = ?1 AND source.library_id = ?2
                       AND source.lifecycle = 'active'",
                    rusqlite::params![view_id, library_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            Ok((view_id.clone(), coordinates))
        })
        .collect::<Result<BTreeMap<_, _>, StoreError>>()?;

    for project_id in active_project_ids(connection, library_id)? {
        record_page_deltas(connection, commit, &project_id, &page_ids)?;
        for view_id in view_ids.iter().cloned() {
            let Some(Some((database_id, data_source_id))) = view_coordinates.get(&view_id) else {
                continue;
            };
            local_commit::require_projection_read(
                connection,
                commit,
                LocalProjectionScope::DatabaseView {
                    project_id: project_id.clone(),
                    database_id: database_id.clone(),
                    data_source_id: data_source_id.clone(),
                    view_id,
                },
            )?;
        }
    }
    Ok(())
}

/// Advances shared Page Detail dependency authority without conflating it with
/// row-local Page or DatabaseView changes.
pub(crate) fn record_page_detail_projection_delta(
    connection: &Connection,
    commit: &CommitContext,
    library_id: &str,
    data_source_ids: &[String],
    database_ids: &[String],
) -> Result<(), StoreError> {
    let data_source_ids = canonical_strings(data_source_ids);
    let database_ids = canonical_strings(database_ids);
    if data_source_ids.is_empty() && database_ids.is_empty() {
        return Ok(());
    }
    let mut data_source_coordinates = Vec::new();
    for data_source_id in &data_source_ids {
        let database_id = connection
            .query_row(
                "SELECT home_database_block_id FROM data_sources \
                 WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
                [data_source_id, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(database_id) = database_id {
            data_source_coordinates.push((data_source_id.clone(), database_id));
        }
    }
    let mut page_database_ids = Vec::new();
    for database_id in database_ids {
        let exists = connection
            .query_row(
                "SELECT 1 FROM database_containers \
                 WHERE block_id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
                [&database_id, library_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            page_database_ids.push(database_id);
        }
    }
    for project_id in active_project_ids(connection, library_id)? {
        for (data_source_id, database_id) in &data_source_coordinates {
            local_commit::require_projection_read(
                connection,
                commit,
                LocalProjectionScope::PageDetailDataSource {
                    project_id: project_id.clone(),
                    database_id: database_id.clone(),
                    data_source_id: data_source_id.clone(),
                },
            )?;
        }
        for database_id in &page_database_ids {
            local_commit::require_projection_read(
                connection,
                commit,
                LocalProjectionScope::PageDetailDatabase {
                    project_id: project_id.clone(),
                    database_id: database_id.clone(),
                },
            )?;
        }
    }
    Ok(())
}

fn record_all_projection_resets(
    connection: &Connection,
    commit: &CommitContext,
    library_id: &str,
) -> Result<ProjectionAudienceCompilation, StoreError> {
    local_commit::require_projection_read(
        connection,
        commit,
        LocalProjectionScope::Library {
            library_id: library_id.to_owned(),
        },
    )?;
    let project_ids = active_project_ids(connection, library_id)?;
    for project_id in &project_ids {
        local_commit::require_projection_read(
            connection,
            commit,
            LocalProjectionScope::Project {
                project_id: project_id.clone(),
            },
        )?;
    }
    Ok(ProjectionAudienceCompilation {
        candidate_audiences: project_ids.len(),
        fingerprint_groups: usize::from(!project_ids.is_empty()),
        patch_blobs: 0,
        budget_fallbacks: 0,
    })
}

fn compile_audiences(
    connection: &Connection,
    library_id: &str,
    affected_page_ids: &[String],
    affected_view_ids: &[String],
) -> Result<Vec<ProjectionAudience>, StoreError> {
    let active_views = affected_view_ids.iter().filter_map(|view_id| {
        let visible = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM database_views view JOIN database_containers container ON container.block_id=view.database_block_id JOIN data_sources source ON source.id=view.data_source_id WHERE view.id=?1 AND container.library_id=?2 AND view.lifecycle='active' AND container.lifecycle='active' AND source.lifecycle='active')",
            rusqlite::params![view_id,library_id], |row| row.get::<_,bool>(0));
        match visible {Ok(true)=>Some(Ok(view_id.clone())), Ok(false)=>None, Err(error)=>Some(Err(StoreError::from(error)))}
    }).collect::<Result<Vec<_>,_>>()?;
    active_project_ids(connection, library_id)?
        .into_iter()
        .map(|project_id| {
            Ok(ProjectionAudience {
                project_id,
                input: ProjectionInputFingerprint {
                    pre_visible_page_ids: affected_page_ids.to_vec(),
                    post_visible_page_ids: affected_page_ids.to_vec(),
                    visible_view_ids: active_views.clone(),
                },
            })
        })
        .collect()
}

fn active_project_ids(
    connection: &Connection,
    library_id: &str,
) -> Result<Vec<String>, StoreError> {
    let project_ids = connection
        .prepare_cached(
            "SELECT id FROM projects
             WHERE library_id = ?1 AND lifecycle = 'active' ORDER BY id",
        )?
        .query_map([library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if project_ids.len() > MAX_ACTIVE_PROJECTION_AUDIENCES {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Projection audience count exceeds the active Project bound",
            false,
        ));
    }
    Ok(project_ids)
}

fn compile_view_delta(
    connection: &Connection,
    commit: &CommitContext,
    library_id: &str,
    representative_project_id: &str,
    view_id: &str,
    page_ids: &[String],
) -> Result<CompiledViewDelta, StoreError> {
    let mut compiled = connection
        .query_row(
            "SELECT view.database_block_id, view.data_source_id FROM database_views view
         JOIN database_containers container
           ON container.block_id = view.database_block_id AND container.library_id = ?1
         JOIN data_sources source
           ON source.id = view.data_source_id AND source.library_id = container.library_id
         WHERE view.id = ?2 AND view.lifecycle = 'active'
           AND container.lifecycle = 'active' AND source.lifecycle = 'active'",
            rusqlite::params![library_id, view_id],
            |row| {
                Ok(CompiledViewDelta {
                    database_id: row.get(0)?,
                    data_source_id: row.get(1)?,
                    view_id: view_id.to_owned(),
                    content: ViewDeltaContent::ReadRequired {
                        budget_exceeded: false,
                    },
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "An active Database View has no canonical projection",
                false,
            )
        })?;
    // Only a complete single-row reduction can be delivered inline. Decide
    // before computing group totals or absolute order: both inspect candidates,
    // including rows excluded by lifecycle, filters, or projection freshness.
    let [page_id] = page_ids else {
        return Ok(compiled);
    };
    if !fits_inline_view_work(connection, &compiled)? {
        compiled.content = ViewDeltaContent::ReadRequired {
            budget_exceeded: true,
        };
        return Ok(compiled);
    }
    let groups = match view_groups(
        connection,
        library_id,
        view_id,
        ViewGroupsRead {
            commit_head: commit.commit_seq(),
            project_id: Some(representative_project_id),
            store_epoch: commit.store_epoch(),
        },
    ) {
        Ok(groups) => groups,
        Err(error) if error.code == StoreErrorCode::NotFound => {
            return Err(StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "An active Database View has no canonical projection",
                false,
            ));
        }
        Err(error) => return Err(error),
    };
    // A packet may carry only a complete reduction of this View scope. The
    // identity read used for relation hydration does not prove filtered or
    // independently sorted View membership, so ambiguous and multi-row
    // transitions deliberately fall back to the canonical read floor.
    let Some(row) = exact_primary_board_row_by_id(connection, library_id, view_id, page_id)? else {
        return Ok(compiled);
    };
    let mut rows = vec![row];
    super::relation_projection::hydrate_row_previews(
        connection,
        library_id,
        Some(representative_project_id),
        &groups.data_source_id,
        &mut rows,
    )?;
    let row = rows
        .pop()
        .ok_or_else(|| internal("Exact projection row hydration returned no row"))?;
    let group_total = groups
        .groups
        .iter()
        .find(|group| {
            group.group_key == row.effective_group_key
                && group.subgroup_key == row.effective_subgroup_key
        })
        .map(|group| group.total_rows);
    if groups.grouped && group_total.is_none() {
        return Ok(compiled);
    }
    compiled.content = ViewDeltaContent::Upsert {
        row: Box::new(row),
        group_total,
        total_rows: groups.total_rows,
    };
    Ok(compiled)
}

/// Bound input work, not output cardinality. Both probes use an owner-key
/// index prefix and stop before lifecycle/visibility joins can discard rows.
fn fits_inline_view_work(
    connection: &Connection,
    view: &CompiledViewDelta,
) -> Result<bool, StoreError> {
    let generation = connection
        .query_row(
            "SELECT active_generation FROM database_view_order_state
             WHERE view_id = ?1 AND phase = 'ready'",
            [&view.view_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(generation) = generation else {
        return Ok(false);
    };
    let memberships: i64 = connection.query_row(
        "SELECT count(*) FROM (SELECT 1 FROM data_source_page_memberships
         WHERE data_source_id = ?1 LIMIT ?2)",
        rusqlite::params![view.data_source_id, MAX_INLINE_VIEW_CANDIDATES + 1],
        |row| row.get(0),
    )?;
    if memberships > MAX_INLINE_VIEW_CANDIDATES {
        return Ok(false);
    }
    let positions: i64 = connection.query_row(
        "SELECT count(*) FROM (SELECT 1 FROM database_view_order_rows
         WHERE view_id = ?1 AND generation = ?2 LIMIT ?3)",
        rusqlite::params![view.view_id, generation, MAX_INLINE_VIEW_CANDIDATES + 1],
        |row| row.get(0),
    )?;
    Ok(positions <= MAX_INLINE_VIEW_CANDIDATES)
}

fn record_page_deltas(
    connection: &Connection,
    commit: &CommitContext,
    project_id: &str,
    page_ids: &[String],
) -> Result<(), StoreError> {
    if page_ids.is_empty() {
        return Ok(());
    }
    local_commit::record_projection_batch(
        connection,
        commit,
        page_ids
            .iter()
            .map(|page_id| LocalProjectionPatch::PageChanged {
                project_id: project_id.to_owned(),
                page_id: page_id.clone(),
            }),
        page_ids.iter().map(|page_id| LocalProjectionScope::Page {
            project_id: project_id.to_owned(),
            page_id: page_id.clone(),
        }),
    )
}

fn record_compiled_view_delta(
    connection: &Connection,
    commit: &CommitContext,
    project_id: &str,
    compiled: &CompiledViewDelta,
    metrics: &mut ProjectionAudienceCompilation,
) -> Result<(), StoreError> {
    let template = compiled;
    let scope = LocalProjectionScope::DatabaseView {
        project_id: project_id.to_owned(),
        database_id: template.database_id.clone(),
        data_source_id: template.data_source_id.clone(),
        view_id: template.view_id.clone(),
    };
    let (row, group_total, total_rows) = match &template.content {
        ViewDeltaContent::ReadRequired { budget_exceeded } => {
            metrics.budget_fallbacks += usize::from(*budget_exceeded);
            return local_commit::require_projection_read(connection, commit, scope);
        }
        ViewDeltaContent::Upsert {
            row,
            group_total,
            total_rows,
        } => (row, group_total, total_rows),
    };
    let patch = LocalProjectionPatch::DatabaseRowUpsert {
        project_id: project_id.to_owned(),
        database_id: template.database_id.clone(),
        data_source_id: template.data_source_id.clone(),
        view_id: template.view_id.clone(),
        row: row.clone(),
        total_rows: *total_rows,
        group_total: *group_total,
    };
    let encoded =
        serde_json::to_vec(&patch).map_err(|_| internal("Projection patch cannot be encoded"))?;
    if encoded.len() > MAX_INLINE_PROJECTION_PATCH_BYTES {
        metrics.budget_fallbacks += 1;
        return local_commit::require_projection_read(connection, commit, scope);
    }
    local_commit::record_projection_patch(connection, commit, patch)?;
    local_commit::require_projection_read(connection, commit, scope)
}

fn canonical_strings(values: &[String]) -> Vec<String> {
    values
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn canonical_union(left: &[String], right: &[String]) -> Vec<String> {
    left.iter()
        .chain(right)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use rusqlite::Connection;

    use super::*;

    #[test]
    fn inline_view_budget_counts_complete_published_candidates() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE database_view_order_state(view_id TEXT PRIMARY KEY, active_generation INTEGER, phase TEXT);
             CREATE TABLE database_view_order_rows(view_id TEXT, generation INTEGER, page_block_id TEXT,
               PRIMARY KEY(view_id, generation, page_block_id)) WITHOUT ROWID;
             CREATE TABLE data_source_page_memberships(data_source_id TEXT, page_block_id TEXT);
             CREATE INDEX memberships_source ON data_source_page_memberships(data_source_id);
             INSERT INTO data_source_page_memberships VALUES ('source', 'page');"
        ).unwrap();
        let view = CompiledViewDelta {
            database_id: "database".into(),
            data_source_id: "source".into(),
            view_id: "view".into(),
            content: ViewDeltaContent::ReadRequired {
                budget_exceeded: false,
            },
        };
        assert!(!fits_inline_view_work(&connection, &view).unwrap());
        connection
            .execute(
                "INSERT INTO database_view_order_state VALUES ('view', 1, 'rebalance')",
                [],
            )
            .unwrap();
        assert!(!fits_inline_view_work(&connection, &view).unwrap());
        connection
            .execute("UPDATE database_view_order_state SET phase = 'ready'", [])
            .unwrap();
        connection
            .execute_batch(
                "WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<129)
             INSERT INTO database_view_order_rows SELECT 'view', 2, CAST(n AS TEXT) FROM ids;",
            )
            .unwrap();
        assert!(
            fits_inline_view_work(&connection, &view).unwrap(),
            "other generations do not enter the candidate budget"
        );
        connection
            .execute(
                "UPDATE database_view_order_state SET active_generation = 2",
                [],
            )
            .unwrap();
        assert!(
            !fits_inline_view_work(&connection, &view).unwrap(),
            "all physical candidates count, even when nullable projection would omit them"
        );
    }

    fn audience_fixture(project_count: usize) -> Connection {
        let connection = Connection::open_in_memory().expect("audience fixture");
        connection
            .execute_batch(
                "CREATE TABLE projects(
                   id TEXT PRIMARY KEY, library_id TEXT, lifecycle TEXT,
                   database_block_id TEXT
                 );
                 CREATE TABLE blocks(
                   id TEXT PRIMARY KEY, library_id TEXT, lifecycle TEXT
                 );

                 CREATE TABLE pages(
                   block_id TEXT PRIMARY KEY, library_id TEXT, document_id TEXT
                 );",
            )
            .expect("audience schema");
        for index in 0..project_count {
            connection
                .execute(
                    "INSERT INTO projects(id, library_id, lifecycle, database_block_id)
                     VALUES (?1, 'library:audiences', 'active', NULL)",
                    [format!("project:{index:03}")],
                )
                .expect("seed audience");
        }
        connection
    }

    fn grouped_count(audiences: Vec<ProjectionAudience>) -> usize {
        audiences
            .into_iter()
            .map(|audience| audience.input)
            .collect::<BTreeSet<_>>()
            .len()
    }

    #[test]
    fn two_hundred_equivalent_projects_share_one_projection_input() {
        let connection = audience_fixture(200);
        let started = Instant::now();
        let audiences = compile_audiences(
            &connection,
            "library:audiences",
            &["page:moved".to_owned()],
            &[],
        )
        .expect("compile bounded audiences");
        assert_eq!(audiences.len(), 200);
        assert_eq!(grouped_count(audiences), 1);
        eprintln!(
            "projection_audience candidate_projects=200 affected_pages=1 fingerprint_groups=1 elapsed_ms={:.3}",
            started.elapsed().as_secs_f64() * 1_000.0,
        );
    }

    #[test]
    fn audience_bound_fails_before_patch_computation() {
        let connection = audience_fixture(201);
        let error = compile_audiences(&connection, "library:audiences", &[], &[])
            .expect_err("audience overflow");
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
    }
}
