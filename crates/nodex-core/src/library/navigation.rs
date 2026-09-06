use std::collections::{BTreeSet, HashMap, HashSet};

use nodex_core_contracts::agent::{AgentAuthorizationTarget, AgentProjectResourceAction};
use nodex_core_contracts::library::{
    LibraryAgentBlockTarget, LibraryAgentSiblingAnchor, LibraryCanvasLocation,
    LibraryCanvasSummary, LibraryCanvasTarget, LibraryCatalogEntry, LibraryCatalogKind,
    LibraryLifecycle, LibraryMoveDestinationEntry, LibraryMoveDestinationScope,
    LibraryNavigationNode, LibraryNavigationParent, LibraryPageAccessContext, LibraryPageBacklink,
    LibraryPageDataSourceContext, LibraryPageDetail, LibraryPageDocumentDescriptor,
    LibraryPageIntrinsicProperty, LibraryPageKeyTarget, LibraryPageLocation, LibraryPageMembership,
    LibraryPageMentionDestinationHead, LibraryPageOwnershipPath, LibraryPageOwnershipPathAncestor,
    LibraryPageReferencePresentation, LibraryPageRelocationDestinationEntry,
    LibraryPageRelocationDestinationKind, LibraryPageRelocationDestinationScope, LibraryPageTarget,
    LibraryPageWriteDestination, LibraryPlacedResourceTarget, LibraryRead, LibraryReadValue,
    LibraryRouteTarget, LibraryViewLocation,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;

use crate::database::read::{page_data_source_projection, page_layout, page_record};
use crate::database::resolve_page_key_matches_in_library;
use crate::document::is_primary_canvas_block_id;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::{cursor, page_search};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;

fn page_mention_destination(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<LibraryReadValue, StoreError> {
    let value = connection
        .query_row(
            "SELECT page.document_id, document.generation, document.head_seq \
             FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             JOIN documents document \
               ON document.id = page.document_id AND document.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle = 'active' AND document.readiness = 'ready'",
            params![page_id, library_id],
            |row| {
                Ok(LibraryPageMentionDestinationHead {
                    page_id: page_id.to_owned(),
                    document_id: row.get(0)?,
                    document_generation: row.get(1)?,
                    document_head_seq: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Page mention destination is unavailable"))?;
    Ok(LibraryReadValue::PageMentionDestination { value })
}

pub(super) fn read(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    context: &BoundModuleContext,
    page_search_registry: &page_search::PageSearchIndexRegistry,
    request: LibraryRead,
) -> Result<LibraryReadValue, StoreError> {
    let requesting_project_id = context
        .project_id
        .as_ref()
        .map(|project| project.0.as_str());
    let requesting_adapter = &context.adapter;
    match request {
        LibraryRead::PageFileInventory {
            page_id,
            query,
            cursor,
            limit,
        } => Ok(LibraryReadValue::PageFileInventory {
            value: super::page_file_inventory::list(
                connection,
                context,
                &page_id,
                query.as_deref(),
                cursor.as_deref(),
                limit,
            )?,
        }),
        LibraryRead::ResolvePageFile { page_id, selector } => {
            Ok(LibraryReadValue::ResolvedPageFile {
                value: super::page_file_inventory::resolve(
                    connection, context, &page_id, &selector,
                )?,
            })
        }
        LibraryRead::Files {
            query,
            lifecycle,
            usage,
            cursor,
            limit,
        } => Ok(LibraryReadValue::Files {
            value: super::file_queries::catalog(
                connection,
                context,
                query.as_deref(),
                lifecycle,
                usage,
                cursor.as_deref(),
                limit,
            )?,
        }),
        LibraryRead::File { file_id } => Ok(LibraryReadValue::File {
            value: super::file_queries::metadata(connection, context, &file_id)?,
        }),
        LibraryRead::FilePresentation {
            file_id,
            source,
            version,
        } => Ok(LibraryReadValue::FilePresentation {
            value: super::file_queries::presentation(
                connection, context, &file_id, &source, version,
            )?,
        }),
        LibraryRead::FileUsages {
            file_id,
            cursor,
            limit,
        } => Ok(LibraryReadValue::FileUsages {
            value: super::file_usages::read(
                connection,
                context,
                &file_id,
                cursor.as_deref(),
                limit,
            )?,
        }),
        LibraryRead::FileVersions {
            file_id,
            cursor,
            limit,
        } => Ok(LibraryReadValue::FileVersions {
            value: super::file_queries::versions(
                connection,
                context,
                &file_id,
                cursor.as_deref(),
                limit,
            )?,
        }),
        LibraryRead::Metadata
        | LibraryRead::StructuralHistoryStates { .. }
        | LibraryRead::ResourceProjectAccess { .. }
        | LibraryRead::FilterProjectionImpactForProject { .. } => {
            Err(invalid("Read is assembled by the Library Module"))
        }
        LibraryRead::Children {
            parent,
            cursor: requested_cursor,
            limit,
            force_include_target,
        } => {
            if let LibraryNavigationParent::Page { page_id } = &parent {
                require_bound_page_read_access(
                    connection,
                    library_id,
                    requesting_project_id,
                    requesting_adapter,
                    page_id,
                )?;
            }
            children(
                connection,
                library_id,
                parent,
                requested_cursor,
                limit,
                force_include_target,
            )
        }
        LibraryRead::StandaloneRoots {
            cursor: requested_cursor,
            limit,
            force_include_target,
        } => standalone_roots(
            connection,
            library_id,
            requested_cursor,
            limit,
            force_include_target,
        ),
        LibraryRead::Path { target } => {
            if let (Some(project_id), LibraryRouteTarget::Page { page_id }) =
                (requesting_project_id, &target)
            {
                super::require_page_read_access(connection, library_id, project_id, page_id)?;
            } else if matches!(&target, LibraryRouteTarget::Page { .. })
                && !trusted_root_adapter(requesting_adapter)
            {
                return Err(unauthorized(
                    "Library Page paths require a trusted root or bound Project Adapter",
                ));
            }
            if let LibraryRouteTarget::Canvas { canvas_id } = &target {
                require_bound_canvas_read_access(
                    connection,
                    library_id,
                    requesting_project_id,
                    requesting_adapter,
                    canvas_id,
                )?;
            }
            Ok(LibraryReadValue::Path {
                nodes: path(connection, library_id, &target)?,
                target,
            })
        }
        LibraryRead::Catalog {
            query,
            kinds,
            lifecycle,
            cursor: requested_cursor,
            limit,
        } => catalog(
            connection,
            library_id,
            query,
            kinds,
            lifecycle,
            requested_cursor,
            limit,
        ),
        LibraryRead::MoveDestinations {
            target,
            scope,
            cursor: requested_cursor,
            limit,
        } => {
            if !trusted_root_adapter(requesting_adapter) {
                return Err(unauthorized(
                    "Library move destinations require a trusted root Adapter",
                ));
            }
            move_destinations(
                connection,
                library_id,
                target,
                scope,
                requested_cursor,
                limit,
            )
        }
        LibraryRead::PageRelocationDestinations {
            page_id,
            scope,
            cursor: requested_cursor,
            limit,
        } => {
            if !trusted_root_adapter(requesting_adapter) {
                return Err(unauthorized(
                    "Page relocation destinations require a trusted root Adapter",
                ));
            }
            page_relocation_destinations(
                connection,
                library_id,
                store_epoch,
                &page_id,
                scope,
                requested_cursor,
                limit,
            )
        }
        LibraryRead::PageMentionDestination { page_id } => {
            let Some(project_id) = requesting_project_id else {
                if !trusted_root_adapter(requesting_adapter) {
                    return Err(unauthorized(
                        "Page mention destinations require a Project or trusted root Adapter",
                    ));
                }
                return page_mention_destination(connection, library_id, &page_id);
            };
            super::history::require_page_write_access(
                connection, library_id, project_id, &page_id,
            )?;
            page_mention_destination(connection, library_id, &page_id)
        }
        LibraryRead::PageDetail { page_id } => {
            require_bound_page_read_access(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_id,
            )?;
            Ok(LibraryReadValue::PageDetail {
                value: Box::new(page_detail(
                    connection,
                    library_id,
                    store_epoch,
                    commit_head,
                    &page_id,
                    requesting_project_id,
                )?),
            })
        }
        LibraryRead::PageContent { page_id } => {
            require_bound_page_read_access(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_id,
            )?;
            Ok(LibraryReadValue::PageContent {
                value: Box::new(super::content::page_content(
                    connection,
                    library_id,
                    store_epoch,
                    commit_head,
                    &page_id,
                )?),
            })
        }
        LibraryRead::PageProjectionFile {
            page_id,
            file_kind,
            prepare,
        } => {
            require_bound_page_read_access(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_id,
            )?;
            Ok(LibraryReadValue::PageProjectionFile {
                value: Box::new(super::page_projection::page_projection_file(
                    connection,
                    library_id,
                    store_epoch,
                    super::page_projection::PageProjectionFileRequest {
                        commit_head,
                        requesting_project_id,
                        page_id: &page_id,
                        kind: file_kind,
                        prepare,
                    },
                )?),
            })
        }
        LibraryRead::PageDraftProjection { page_id } => {
            require_bound_page_read_access(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_id,
            )?;
            Ok(LibraryReadValue::PageDraftProjection {
                value: Box::new(super::page_projection::page_draft_projection(
                    connection,
                    library_id,
                    store_epoch,
                    commit_head,
                    &page_id,
                    requesting_project_id,
                )?),
            })
        }
        LibraryRead::AgentBlockTarget {
            block_id,
            authorization,
        } => {
            super::agent_authorization::authorize_execution(
                connection,
                context,
                library_id,
                &authorization,
                &AgentAuthorizationTarget::PageOrBlock {
                    id: block_id.clone(),
                },
                AgentProjectResourceAction::Read,
            )?;
            let value = agent_block_target(
                connection,
                library_id,
                store_epoch,
                commit_head,
                &block_id,
                requesting_project_id,
            )?;
            Ok(LibraryReadValue::AgentBlockTarget { value })
        }
        LibraryRead::AgentSearch {
            authorization,
            query,
            target,
            scope,
            block_types,
            include_archived,
            cursor,
            limit,
        } => {
            let page_search_index = (target
                == nodex_core_contracts::library::LibraryAgentSearchTarget::Pages)
                .then(|| {
                    page_search_registry.snapshot(connection, library_id, store_epoch, commit_head)
                })
                .transpose()?;
            super::agent_search::read(
                connection,
                context,
                library_id,
                &authorization,
                &query,
                target,
                scope,
                block_types,
                include_archived,
                cursor.as_deref(),
                limit,
                page_search_index.as_deref(),
            )
        }
        LibraryRead::PageTarget { page_id } => Ok(LibraryReadValue::PageTarget {
            value: page_target(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_id,
            )?
            .map(Box::new),
        }),
        LibraryRead::PageKeyTarget { page_key } => Ok(LibraryReadValue::PageKeyTarget {
            value: page_key_target(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_key,
            )?,
        }),
        LibraryRead::PageOwnershipPath { page_id } => Ok(LibraryReadValue::PageOwnershipPath {
            value: page_ownership_path(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &page_id,
            )?
            .map(Box::new),
        }),
        LibraryRead::PageLocation { page_id } => {
            if requesting_project_id.is_some() || !trusted_root_adapter(requesting_adapter) {
                return Err(unauthorized(
                    "Page location requires a trusted local root Adapter",
                ));
            }
            validate_identity(&page_id, "Page location")?;
            let exists = connection
                .query_row(
                    "SELECT page.block_id FROM pages page \
                     JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
                     WHERE page.block_id = ?1 AND page.library_id = ?2 \
                       AND block.library_id = page.library_id \
                       AND block.lifecycle = 'active' LIMIT 1",
                    params![page_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let value = exists
                .map(|page_id| {
                    first_active_project_with_page_access(connection, library_id, &page_id).map(
                        |project_id| {
                            project_id.map(|project_id| LibraryPageLocation {
                                page_id,
                                access_project_id: project_id,
                            })
                        },
                    )
                })
                .transpose()?
                .flatten();
            Ok(LibraryReadValue::PageLocation { value })
        }
        LibraryRead::CanvasTarget { canvas_id } => Ok(LibraryReadValue::CanvasTarget {
            value: Box::new(canvas_target(
                connection,
                library_id,
                requesting_project_id,
                requesting_adapter,
                &canvas_id,
            )?),
        }),
        LibraryRead::ViewLocation { view_id } => {
            if requesting_project_id.is_some() || !trusted_root_adapter(requesting_adapter) {
                return Err(unauthorized(
                    "View location requires a trusted local root Adapter",
                ));
            }
            validate_identity(&view_id, "View location")?;
            let coordinates = connection
                .query_row(
                    "SELECT view.id, view.data_source_id, view.database_block_id \
                     FROM database_views view \
                     JOIN data_sources source \
                       ON source.id = view.data_source_id \
                       AND source.home_database_block_id = view.database_block_id \
                       AND source.library_id = ?2 \
                     JOIN database_containers container \
                       ON container.block_id = view.database_block_id \
                       AND container.library_id = source.library_id \
                     JOIN blocks block \
                       ON block.id = container.block_id AND block.type = 'database' \
                       AND block.library_id = source.library_id \
                     WHERE view.id = ?1 \
                       AND view.lifecycle = 'active' \
                       AND source.lifecycle = 'active' \
                       AND container.lifecycle = 'active' \
                       AND block.lifecycle = 'active' \
                     LIMIT 1",
                    params![view_id, library_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let value = coordinates
                .map(|(view_id, data_source_id, database_id)| {
                    first_active_project_with_database_access(connection, library_id, &database_id)
                        .map(|project_id| {
                            project_id.map(|project_id| LibraryViewLocation {
                                view_id,
                                data_source_id,
                                database_id,
                                access_project_id: project_id,
                            })
                        })
                })
                .transpose()?
                .flatten();
            Ok(LibraryReadValue::ViewLocation { value })
        }
        LibraryRead::Search {
            query,
            include_archived,
            source_kinds,
            block_types,
            cursor,
            limit,
        } => super::content::search(
            connection,
            library_id,
            &query,
            include_archived,
            source_kinds,
            block_types,
            cursor,
            limit,
        ),
        LibraryRead::ProjectPageSearch {
            project_ids,
            query,
            filters,
            preferred_project_id,
            recent_page_ids,
            limit,
        } => {
            let native_bound_search = matches!(requesting_adapter, AdapterKind::NativeCli)
                && requesting_project_id.is_some_and(|project_id| {
                    project_ids.as_slice() == [project_id]
                        && preferred_project_id
                            .as_deref()
                            .is_none_or(|preferred| preferred == project_id)
                });
            if !native_bound_search {
                require_trusted_root_only(
                    requesting_project_id,
                    requesting_adapter,
                    "Project Page search requires a trusted root or the Native CLI's exact bound Project",
                )?;
            }
            let index =
                page_search_registry.snapshot(connection, library_id, store_epoch, commit_head)?;
            Ok(LibraryReadValue::ProjectPageSearch {
                items: page_search::search_projects(
                    connection,
                    &index,
                    library_id,
                    page_search::ProjectSearchRequest {
                        project_ids: &project_ids,
                        query: &query,
                        filters: filters.as_ref(),
                        preferred_project_id: preferred_project_id.as_deref(),
                        recent_page_ids: &recent_page_ids,
                        limit,
                    },
                )?,
            })
        }
        LibraryRead::ProjectPageSearchFacets { project_ids } => {
            require_trusted_root_only(
                requesting_project_id,
                requesting_adapter,
                "Project Page search facets require a trusted local root Adapter",
            )?;
            let index =
                page_search_registry.snapshot(connection, library_id, store_epoch, commit_head)?;
            Ok(LibraryReadValue::ProjectPageSearchFacets {
                value: page_search::project_facets(&index, &project_ids)?,
            })
        }
        LibraryRead::ProjectPageSearchMetadata {
            project_ids,
            page_ids,
        } => {
            require_trusted_root_only(
                requesting_project_id,
                requesting_adapter,
                "Project Page search metadata requires a trusted local root Adapter",
            )?;
            let index =
                page_search_registry.snapshot(connection, library_id, store_epoch, commit_head)?;
            Ok(LibraryReadValue::ProjectPageSearchMetadata {
                items: page_search::project_metadata(&index, &project_ids, page_ids.as_deref())?,
            })
        }
        LibraryRead::PageReferenceCandidates {
            query,
            limit,
            source_page_id,
        } => {
            if context.project_id.is_none() && !trusted_root_adapter(&context.adapter) {
                return Err(unauthorized(
                    "Page reference candidates require a trusted root or bound Project Adapter",
                ));
            }
            let index =
                page_search_registry.snapshot(connection, library_id, store_epoch, commit_head)?;
            Ok(LibraryReadValue::PageReferenceCandidates {
                items: page_search::search_references(
                    connection,
                    &index,
                    library_id,
                    context,
                    &query,
                    limit,
                    source_page_id.as_deref(),
                )?,
            })
        }
        LibraryRead::PageBacklinks {
            target_page_id,
            cursor,
            limit,
        } => page_backlinks(
            connection,
            library_id,
            context,
            &target_page_id,
            cursor,
            limit,
        ),
        LibraryRead::PageHistory {
            page_id,
            before,
            limit,
        } => Ok(LibraryReadValue::PageHistory {
            value: Box::new(super::history::page_history(
                connection,
                library_id,
                requesting_project_id,
                &page_id,
                before,
                limit,
            )?),
        }),
        LibraryRead::PlanAgentResourceAccess { .. } => Err(invalid(
            "Agent resource planning is assembled by the Library Module",
        )),
        LibraryRead::PrepareAgentPageCopy { .. } => Err(invalid(
            "Agent Page copy preparation is assembled by the Library Module",
        )),
        LibraryRead::PrepareAgentCreatePages { .. } => Err(invalid(
            "Agent Page creation preparation is assembled by the Library Module",
        )),
        LibraryRead::PrepareAgentMovePages { .. } => Err(invalid(
            "Agent Page movement preparation is assembled by the Library Module",
        )),
        LibraryRead::PageLifecyclePreflight { .. } => Err(invalid(
            "Page lifecycle preflight is assembled by the Library Module",
        )),
        LibraryRead::AcquireSearchSnapshot { .. } | LibraryRead::ReleaseSearchSnapshot { .. } => {
            Err(invalid(
                "Search snapshot leases are assembled by the Library Module",
            ))
        }
    }
}

#[derive(Debug)]
struct PageBacklinkAccumulator {
    source_page_id: String,
    source_block_id: String,
    source_title: String,
    updated_at: String,
    presentations: BTreeSet<String>,
    occurrence_count: u32,
}

fn page_backlinks(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    target_page_id: &str,
    requested_cursor: Option<String>,
    requested_limit: Option<u32>,
) -> Result<LibraryReadValue, StoreError> {
    require_bound_page_read_access(
        connection,
        library_id,
        context
            .project_id
            .as_ref()
            .map(|project| project.0.as_str()),
        &context.adapter,
        target_page_id,
    )?;
    let limit = read_limit(requested_limit)?;
    let subject = vec!["page_backlinks".to_owned(), target_page_id.to_owned()];
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let (after_updated_at, after_id) = keyset_text_coordinate(after.as_ref())?;
    let mut statement = connection.prepare(
        "SELECT reference.source_owner_block_id, reference.source_block_id, \
                    materialization.title, reference.presentation, \
                    reference.occurrence_count, reference.updated_at \
             FROM document_page_references reference \
             JOIN pages source_page ON source_page.block_id = reference.source_owner_block_id \
               AND source_page.library_id = ?1 \
             JOIN blocks source_block ON source_block.id = source_page.block_id \
               AND source_block.library_id = source_page.library_id \
               AND source_block.type = 'page' AND source_block.lifecycle = 'active' \
             JOIN documents source_document ON source_document.id = source_page.document_id \
             JOIN document_materializations materialization \
               ON materialization.document_id = source_document.id \
               AND materialization.generation = source_document.generation \
               AND materialization.projected_seq = source_document.head_seq \
               AND materialization.schema_version = source_document.schema_version \
             WHERE reference.target_page_id = ?2 \
             ORDER BY reference.updated_at DESC, reference.source_owner_block_id, \
                      reference.source_block_id, reference.presentation",
    )?;
    let mut rows = statement.query(params![library_id, target_page_id])?;
    let mut grouped = HashMap::<String, PageBacklinkAccumulator>::new();
    let mut authorized_pages = HashSet::<String>::new();
    while let Some(row) = rows.next()? {
        let source_page_id = row.get::<_, String>(0)?;
        let source_block_id = row.get::<_, String>(1)?;
        let source_title = row.get::<_, String>(2)?;
        let presentation = row.get::<_, String>(3)?;
        let count = row.get::<_, u32>(4)?;
        let updated_at = row.get::<_, String>(5)?;
        let allowed = if let Some(project_id) = context.project_id.as_ref() {
            authorized_pages.contains(&source_page_id)
                || super::page_read_authorization_roots(
                    connection,
                    library_id,
                    &project_id.0,
                    &source_page_id,
                )?
                .is_some()
        } else {
            true
        };
        if !allowed {
            continue;
        }
        authorized_pages.insert(source_page_id.clone());
        let stable_id = format!("{source_page_id}\0{source_block_id}");
        if !grouped.contains_key(&stable_id) && grouped.len() == 100_000 {
            return Err(StoreError::new(
                StoreErrorCode::ResourceExhausted,
                "Authorized Page backlink projection exceeds its read bound",
                false,
            ));
        }
        let entry = grouped
            .entry(stable_id)
            .or_insert_with(|| PageBacklinkAccumulator {
                source_page_id,
                source_block_id,
                source_title,
                updated_at,
                presentations: BTreeSet::new(),
                occurrence_count: 0,
            });
        entry.presentations.insert(presentation);
        entry.occurrence_count = entry.occurrence_count.saturating_add(count);
    }
    let mut authorized = grouped.into_iter().collect::<Vec<_>>();
    authorized.sort_by(|(left_id, left), (right_id, right)| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left_id.cmp(right_id))
    });
    let total =
        u64::try_from(authorized.len()).map_err(|_| corrupt("Page backlink count overflowed"))?;
    let source_page_count = u64::try_from(
        authorized
            .iter()
            .map(|(_, item)| item.source_page_id.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
    )
    .map_err(|_| corrupt("Page backlink source Page count overflowed"))?;
    if let (Some(after_updated_at), Some(after_id)) = (after_updated_at, after_id) {
        authorized.retain(|(stable_id, item)| {
            item.updated_at < after_updated_at
                || (item.updated_at == after_updated_at && stable_id > &after_id)
        });
    }
    let has_more = authorized.len() > limit;
    authorized.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let (stable_id, item) = authorized
                .last()
                .ok_or_else(|| corrupt("Page backlink continuation has no entry"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text {
                        value: item.updated_at.clone(),
                    }],
                    stable_id: stable_id.clone(),
                },
            )
        })
        .transpose()?;
    let items = authorized
        .into_iter()
        .map(|(_, item)| {
            let presentations = item
                .presentations
                .into_iter()
                .map(|presentation| match presentation.as_str() {
                    "mention" => Ok(LibraryPageReferencePresentation::Mention),
                    "reference_block" => Ok(LibraryPageReferencePresentation::ReferenceBlock),
                    "link" => Ok(LibraryPageReferencePresentation::Link),
                    _ => Err(corrupt("Page backlink presentation is invalid")),
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            Ok(LibraryPageBacklink {
                location_label: move_destination_path(
                    connection,
                    library_id,
                    &item.source_page_id,
                )?
                .join(" / "),
                source_page_id: item.source_page_id,
                source_block_id: item.source_block_id,
                source_title: item.source_title,
                presentations,
                occurrence_count: item.occurrence_count,
                updated_at: item.updated_at,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(LibraryReadValue::PageBacklinks {
        target_page_id: target_page_id.to_owned(),
        items,
        next_cursor,
        has_more,
        total,
        source_page_count,
    })
}

fn require_bound_page_read_access(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    page_id: &str,
) -> Result<(), StoreError> {
    if let Some(project_id) = requesting_project_id {
        return super::require_page_read_access(connection, library_id, project_id, page_id);
    }
    if trusted_root_adapter(requesting_adapter) {
        return Ok(());
    }
    Err(unauthorized(
        "Library Page reads require a trusted root or bound Project Adapter",
    ))
}

fn require_bound_canvas_read_access(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    canvas_id: &str,
) -> Result<(), StoreError> {
    let row = connection
        .query_row(
            "SELECT host_page.block_id, block.lifecycle \
             FROM canvas_owners canvas \
             JOIN blocks block ON block.id = canvas.block_id \
               AND block.library_id = canvas.library_id \
             LEFT JOIN document_block_index containing ON containing.block_id = block.id \
             LEFT JOIN block_documents host_ownership \
               ON host_ownership.document_id = containing.document_id \
             LEFT JOIN pages host_page ON host_page.block_id = host_ownership.block_id \
             WHERE block.id = ?1 AND canvas.library_id = ?2 AND block.type = 'canvas'",
            params![canvas_id, library_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Library Canvas is unavailable"))?;
    authorize_canvas_row(
        connection,
        library_id,
        requesting_project_id,
        requesting_adapter,
        canvas_id,
        row.0.as_deref(),
        row.1 == "deleted",
    )
}

fn authorize_canvas_row(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    canvas_id: &str,
    host_page_id: Option<&str>,
    include_deleted: bool,
) -> Result<(), StoreError> {
    if let Some(project_id) = requesting_project_id {
        if let Some(page_id) = host_page_id {
            return super::require_page_read_access(connection, library_id, project_id, page_id);
        }
        return if include_deleted {
            super::require_canvas_lifecycle_read_access(
                connection, library_id, project_id, canvas_id,
            )
        } else {
            super::require_canvas_read_access(connection, library_id, project_id, canvas_id)
        };
    }
    if trusted_root_adapter(requesting_adapter) {
        return Ok(());
    }
    Err(unauthorized(
        "Library Canvas reads require a trusted root or bound Project Adapter",
    ))
}

fn trusted_root_adapter(adapter: &AdapterKind) -> bool {
    matches!(
        adapter,
        AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
    )
}

fn require_trusted_root_only(
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    message: &str,
) -> Result<(), StoreError> {
    if requesting_project_id.is_none() && trusted_root_adapter(requesting_adapter) {
        return Ok(());
    }
    Err(unauthorized(message))
}

fn agent_block_target(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    block_id: &str,
    requesting_project_id: Option<&str>,
) -> Result<Option<LibraryAgentBlockTarget>, StoreError> {
    validate_identity(block_id, "Agent Block target")?;
    let row = connection
        .query_row(
            "SELECT block.id, block.type, block.lifecycle, \
               CASE WHEN page.block_id IS NOT NULL THEN page.block_id ELSE owner_page.block_id END, \
               CASE WHEN page.block_id IS NOT NULL THEN page.document_id ELSE containing.document_id END, \
               CASE WHEN page.block_id IS NOT NULL THEN page_document.generation ELSE owner_document.generation END, \
               CASE WHEN page.block_id IS NOT NULL THEN page_document.head_seq ELSE owner_document.head_seq END \
             FROM blocks block \
             LEFT JOIN pages page ON page.block_id = block.id AND page.library_id = ?2 \
             LEFT JOIN documents page_document ON page_document.id = page.document_id \
               AND page_document.library_id = page.library_id \
             LEFT JOIN document_block_index containing ON containing.block_id = block.id \
             LEFT JOIN block_documents ownership \
               ON ownership.document_id = containing.document_id \
             LEFT JOIN pages owner_page \
               ON owner_page.block_id = ownership.block_id AND owner_page.library_id = ?2 \
             LEFT JOIN documents owner_document \
               ON owner_document.id = containing.document_id \
              AND owner_document.library_id = block.library_id \
             WHERE block.id = ?1 AND block.library_id = ?2 \
               AND (page.block_id IS NOT NULL OR owner_page.block_id IS NOT NULL) \
             LIMIT 1",
            params![block_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        block_id,
        block_type,
        lifecycle,
        owner_page_id,
        document_id,
        document_generation,
        document_head_seq,
    )) = row
    else {
        return Ok(None);
    };
    let owner_page = page_detail(
        connection,
        library_id,
        store_epoch,
        commit_head,
        &owner_page_id,
        requesting_project_id,
    )?;
    Ok(Some(LibraryAgentBlockTarget {
        block_id,
        block_type,
        lifecycle,
        owner_page_id,
        document_id,
        document_generation,
        document_head_seq,
        owner_page: Box::new(owner_page),
    }))
}

fn page_target(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    page_id: &str,
) -> Result<Option<LibraryPageTarget>, StoreError> {
    validate_identity(page_id, "Page target")?;
    let Some(authority) = page_projection_authority(
        connection,
        library_id,
        requesting_project_id,
        requesting_adapter,
    )?
    else {
        return Ok(None);
    };
    if let PageProjectionAuthority::Project(project_id) = authority
        && let Err(error) =
            super::require_page_read_access(connection, library_id, project_id, page_id)
    {
        if error.code == StoreErrorCode::NotFound {
            return Ok(Some(LibraryPageTarget::Missing {
                target_page_id: page_id.to_owned(),
            }));
        }
        return Err(error);
    }
    let row = connection
        .query_row(
            "SELECT block.type, block.lifecycle, page.library_id, page.block_id IS NOT NULL, \
               document.readiness, document.schema_key, document.schema_version \
             FROM blocks block LEFT JOIN pages page ON page.block_id = block.id \
             LEFT JOIN documents document ON document.id = page.document_id \
             WHERE block.id = ?1 LIMIT 1",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        block_type,
        lifecycle,
        page_library_id,
        is_page,
        readiness,
        schema_key,
        schema_version,
    )) = row
    else {
        return Ok(Some(LibraryPageTarget::Missing {
            target_page_id: page_id.to_owned(),
        }));
    };
    if block_type != "page" {
        return Ok(Some(LibraryPageTarget::InvalidTarget {
            target_page_id: page_id.to_owned(),
            actual_block_type: block_type,
        }));
    }
    let page_library_id =
        page_library_id.ok_or_else(|| corrupt("Page target has no Library authority"))?;
    if !is_page {
        return Err(corrupt("Page target has no typed Page authority"));
    }
    if page_library_id != library_id {
        return Ok(Some(LibraryPageTarget::Missing {
            target_page_id: page_id.to_owned(),
        }));
    }
    if lifecycle == "deleted" {
        return Ok(Some(LibraryPageTarget::Deleted {
            target_page_id: page_id.to_owned(),
            library_id: page_library_id,
        }));
    }
    if !matches!(lifecycle.as_str(), "active" | "archived") {
        return Err(corrupt("Page target has an invalid lifecycle"));
    }
    let readiness = readiness.ok_or_else(|| corrupt("Page target has no Document readiness"))?;
    let schema_key = schema_key.ok_or_else(|| corrupt("Page target has no Document schema"))?;
    let schema_version =
        schema_version.ok_or_else(|| corrupt("Page target has no Document schema version"))?;
    if !matches!(readiness.as_str(), "pending_genesis" | "ready" | "failed")
        || schema_key.is_empty()
        || schema_version < 1
    {
        return Err(corrupt("Page target Document descriptor is invalid"));
    }
    Ok(Some(LibraryPageTarget::Available {
        target_page_id: page_id.to_owned(),
        page: page_record(connection, page_id)?,
        document: LibraryPageDocumentDescriptor {
            readiness,
            schema_key,
            schema_version,
        },
    }))
}

fn page_key_target(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    page_key: &str,
) -> Result<LibraryPageKeyTarget, StoreError> {
    let Some(authority) = page_projection_authority(
        connection,
        library_id,
        requesting_project_id,
        requesting_adapter,
    )?
    else {
        return Ok(LibraryPageKeyTarget::NotFound);
    };
    let mut authorized = Vec::new();
    for resolution in resolve_page_key_matches_in_library(connection, library_id, page_key)? {
        if resolution.page_lifecycle == "deleted" {
            continue;
        }
        if let PageProjectionAuthority::Project(project_id) = &authority
            && let Err(error) = super::require_page_read_access(
                connection,
                library_id,
                project_id,
                &resolution.page_block_id,
            )
        {
            if error.code == StoreErrorCode::NotFound {
                continue;
            }
            return Err(error);
        }
        authorized.push(resolution);
    }
    Ok(page_key_target_from_authorized(authorized))
}

fn page_key_target_from_authorized(
    mut authorized: Vec<crate::database::page_key::PageKeyResolution>,
) -> LibraryPageKeyTarget {
    match authorized.len() {
        0 => LibraryPageKeyTarget::NotFound,
        1 => {
            let resolution = authorized.pop().expect("one authorized Page-key target");
            LibraryPageKeyTarget::Resolved {
                page_id: resolution.page_block_id,
                current_page_key: resolution.current_page_key,
                matched_page_key: resolution.matched_page_key,
                is_current: resolution.is_current,
            }
        }
        _ => LibraryPageKeyTarget::Ambiguous,
    }
}

#[cfg(test)]
mod page_key_target_tests {
    use super::*;
    use crate::database::page_key::PageKeyResolution;

    fn resolution(page_id: &str, matched_page_key: &str) -> PageKeyResolution {
        PageKeyResolution {
            page_block_id: page_id.to_owned(),
            matched_page_key: matched_page_key.to_owned(),
            current_page_key: Some(matched_page_key.to_owned()),
            matched_database_block_id: "database:test".to_owned(),
            current_database_block_id: Some("database:test".to_owned()),
            page_lifecycle: "active".to_owned(),
            is_current: true,
        }
    }

    #[test]
    fn page_key_target_reports_authorized_ambiguity_without_page_metadata() {
        assert_eq!(
            page_key_target_from_authorized(vec![
                resolution("page:lab", "LAB-13"),
                resolution("page:lab1", "LAB1-3"),
            ]),
            LibraryPageKeyTarget::Ambiguous,
        );
    }
}

fn page_ownership_path(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    page_id: &str,
) -> Result<Option<LibraryPageOwnershipPath>, StoreError> {
    validate_identity(page_id, "Page ownership path")?;
    let Some(authority) = page_projection_authority(
        connection,
        library_id,
        requesting_project_id,
        requesting_adapter,
    )?
    else {
        return Ok(None);
    };
    let Some(hierarchy) = page_hierarchy(connection, library_id, page_id)? else {
        return Ok(Some(LibraryPageOwnershipPath::Missing {
            target_page_id: page_id.to_owned(),
        }));
    };
    let visible = match authority {
        PageProjectionAuthority::TrustedLibrary => hierarchy,
        PageProjectionAuthority::Project(project_id) => {
            let mut visible = Vec::new();
            for page in hierarchy {
                match super::require_page_read_access(
                    connection,
                    library_id,
                    project_id,
                    &page.page_id,
                ) {
                    Ok(()) => visible.push(page),
                    Err(error) if error.code == StoreErrorCode::NotFound => break,
                    Err(error) => return Err(error),
                }
            }
            visible
        }
    };
    if visible.first().is_none_or(|page| page.page_id != page_id) {
        return Ok(Some(LibraryPageOwnershipPath::Missing {
            target_page_id: page_id.to_owned(),
        }));
    }
    let ancestors = visible
        .into_iter()
        .skip(1)
        .rev()
        .map(|page| LibraryPageOwnershipPathAncestor {
            page_id: page.page_id,
            title: page.title,
            lifecycle: page.lifecycle,
        })
        .collect();
    Ok(Some(LibraryPageOwnershipPath::Available {
        target_page_id: page_id.to_owned(),
        ancestors,
    }))
}

#[derive(Clone, Copy)]
enum PageProjectionAuthority<'a> {
    TrustedLibrary,
    Project(&'a str),
}

fn page_projection_authority<'a>(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&'a str>,
    requesting_adapter: &AdapterKind,
) -> Result<Option<PageProjectionAuthority<'a>>, StoreError> {
    if let Some(project_id) = requesting_project_id {
        return Ok(project_scope_exists(connection, library_id, project_id)?
            .then_some(PageProjectionAuthority::Project(project_id)));
    }
    if trusted_root_adapter(requesting_adapter) {
        return Ok(Some(PageProjectionAuthority::TrustedLibrary));
    }
    Err(unauthorized(
        "Page projections require a trusted root or bound Project Adapter",
    ))
}

struct PageHierarchyEntry {
    page_id: String,
    title: String,
    lifecycle: LibraryLifecycle,
}

fn page_hierarchy(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<Vec<PageHierarchyEntry>>, StoreError> {
    let mut current = page_id.to_owned();
    let mut hierarchy = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if hierarchy.len() >= 512 {
            return Err(corrupt("Library Page hierarchy exceeds 512 Page levels"));
        }
        if !seen.insert(current.clone()) {
            return Err(corrupt("Library Page hierarchy contains a cycle"));
        }
        let row = connection
            .query_row(
                "SELECT page.library_id, page.parent_kind, page.parent_id, block.lifecycle, \
                   materialization.title \
                 FROM pages page \
                 JOIN blocks block ON block.id = page.block_id \
                   AND block.library_id = page.library_id \
                 JOIN documents document ON document.id = page.document_id \
                   AND document.library_id = page.library_id \
                 LEFT JOIN document_materializations materialization \
                   ON materialization.document_id = document.id \
                   AND materialization.generation = document.generation \
                   AND materialization.projected_seq = document.head_seq \
                   AND materialization.schema_version = document.schema_version \
                 WHERE page.block_id = ?1",
                [&current],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((page_library_id, parent_kind, parent_id, lifecycle, title)) = row else {
            if hierarchy.is_empty() {
                return Ok(None);
            }
            return Err(corrupt(
                "Library Page hierarchy points to a missing parent Page",
            ));
        };
        if page_library_id != library_id {
            return Err(corrupt("Library Page hierarchy crosses Library authority"));
        }
        let lifecycle = match lifecycle.as_str() {
            "active" => LibraryLifecycle::Active,
            "archived" => LibraryLifecycle::Archived,
            "deleted" if hierarchy.is_empty() => return Ok(None),
            "deleted" => {
                return Err(corrupt(
                    "Library Page hierarchy points through a deleted parent Page",
                ));
            }
            _ => return Err(corrupt("Library Page has an invalid lifecycle")),
        };
        let title = title.ok_or_else(|| corrupt("Library Page projection is unavailable"))?;
        hierarchy.push(PageHierarchyEntry {
            page_id: current.clone(),
            title,
            lifecycle,
        });
        match parent_kind.as_str() {
            "page" => current = parent_id,
            "library" if parent_id == library_id => return Ok(Some(hierarchy)),
            "data_source" => {
                let source_exists = connection
                    .query_row(
                        "SELECT 1 FROM data_sources \
                         WHERE id = ?1 AND library_id = ?2 AND lifecycle <> 'deleted'",
                        params![parent_id, library_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if source_exists {
                    return Ok(Some(hierarchy));
                }
                return Err(corrupt("Library Page has no matching owning Data Source"));
            }
            _ => return Err(corrupt("Library Page has an invalid ownership parent")),
        }
    }
}

fn project_scope_exists(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<bool, StoreError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2 LIMIT 1",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn active_project_ids(
    connection: &Connection,
    library_id: &str,
) -> Result<Vec<String>, StoreError> {
    connection
        .prepare(
            "SELECT id FROM projects WHERE library_id = ?1 AND lifecycle = 'active' \
             ORDER BY id",
        )?
        .query_map([library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn first_active_project_with_page_access(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<String>, StoreError> {
    for project_id in active_project_ids(connection, library_id)? {
        if super::page_read_authorization_roots(connection, library_id, &project_id, page_id)?
            .is_some()
        {
            return Ok(Some(project_id));
        }
    }
    Ok(None)
}

fn first_active_project_with_database_access(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<Option<String>, StoreError> {
    for project_id in active_project_ids(connection, library_id)? {
        let primary = crate::database::authorization::project_primary_database(
            connection,
            library_id,
            &project_id,
        )?;
        if crate::database::authorization::authorize_database(
            connection,
            &project_id,
            primary.as_deref(),
            database_id,
        )? {
            return Ok(Some(project_id));
        }
    }
    Ok(None)
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= 512 && value.trim() == value {
        return Ok(());
    }
    Err(invalid(&format!(
        "{label} requires a canonical bounded identity"
    )))
}

fn page_detail(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    page_id: &str,
    requesting_project_id: Option<&str>,
) -> Result<LibraryPageDetail, StoreError> {
    if page_id.is_empty() || page_id.len() > 512 || page_id.trim() != page_id {
        return Err(invalid("Page detail requires a canonical bounded identity"));
    }
    let document = connection
        .query_row(
            "SELECT document.readiness, document.schema_key, document.schema_version, \
               page.parent_kind, page.parent_id \
             FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| {
                Ok((
                    LibraryPageDocumentDescriptor {
                        readiness: row.get(0)?,
                        schema_key: row.get(1)?,
                        schema_version: row.get(2)?,
                    },
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library Page is unavailable"))?;
    if !matches!(
        document.0.readiness.as_str(),
        "pending_genesis" | "ready" | "failed"
    ) || document.0.schema_key.is_empty()
        || document.0.schema_version < 1
    {
        return Err(corrupt("Library Page Document descriptor is invalid"));
    }
    let intrinsic_properties = connection
        .prepare(
            "SELECT property_key, value_type, value_json, revision FROM block_properties \
             WHERE block_id = ?1 ORDER BY property_key",
        )?
        .query_map([page_id], |row| {
            let key = row.get::<_, String>(0)?;
            let value_type = row.get::<_, String>(1)?;
            let serialized = row.get::<_, String>(2)?;
            let value = parse_json(&serialized, "Page intrinsic Property")?;
            if !valid_intrinsic_value(&value_type, &value) {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    serialized.len(),
                    rusqlite::types::Type::Text,
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Page intrinsic Property diverges from its value type",
                    )
                    .into(),
                ));
            }
            Ok(LibraryPageIntrinsicProperty {
                key,
                value_type,
                value,
                revision: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let data_source_context = match document.1.as_str() {
        "library" | "page" => LibraryPageDataSourceContext::Standalone,
        "data_source" => {
            let projection = page_data_source_projection(
                connection,
                library_id,
                page_id,
                &document.2,
                requesting_project_id,
            )?;
            let page_layout = page_layout(connection, &projection.data_source_id)?;
            LibraryPageDataSourceContext::Member {
                page_key: projection.page_key,
                membership: Box::new(LibraryPageMembership {
                    membership_id: projection.membership_id,
                    data_source_id: projection.data_source_id,
                    revision: projection.membership_revision,
                    created_at: projection.membership_created_at,
                }),
                database: projection.database,
                data_source: projection.data_source,
                properties: projection.properties,
                page_layout,
                values: projection.values,
            }
        }
        _ => return Err(corrupt("Library Page has an invalid parent kind")),
    };
    Ok(LibraryPageDetail {
        library_id: library_id.to_owned(),
        store_epoch: store_epoch.to_owned(),
        commit_seq: commit_head,
        page: page_record(connection, page_id)?,
        document: document.0,
        intrinsic_properties,
        data_source_context,
        access_context: LibraryPageAccessContext::Library,
    })
}

fn valid_intrinsic_value(value_type: &str, value: &Value) -> bool {
    match value_type {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "string" => value.is_null() || value.is_string(),
        "json" => value.is_null() || value.is_array() || value.is_object(),
        _ => false,
    }
}

fn parse_json(serialized: &str, label: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(serialized).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            serialized.len(),
            rusqlite::types::Type::Text,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{label} is invalid JSON"),
            )
            .into(),
        )
    })
}

/// The semantic cursor exposed by Library snapshots.
pub(super) fn commit_head(connection: &Connection) -> Result<i64, StoreError> {
    crate::infrastructure::local_commit::head(connection)
}

fn children(
    connection: &Connection,
    library_id: &str,
    parent: LibraryNavigationParent,
    requested_cursor: Option<String>,
    limit: Option<u32>,
    force_include_target: Option<LibraryRouteTarget>,
) -> Result<LibraryReadValue, StoreError> {
    let subject = match &parent {
        LibraryNavigationParent::Library => vec!["children".to_owned(), "library".to_owned()],
        LibraryNavigationParent::Page { page_id } => {
            vec!["children".to_owned(), "page".to_owned(), page_id.clone()]
        }
        LibraryNavigationParent::Database { database_id } => vec![
            "children".to_owned(),
            "database".to_owned(),
            database_id.clone(),
        ],
    };
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let limit = read_limit(limit)?;
    let (mut ordered, total) = match &parent {
        LibraryNavigationParent::Library => {
            root_node_window(connection, library_id, after.as_ref(), limit)?
        }
        LibraryNavigationParent::Page { page_id } => {
            page_child_node_window(connection, library_id, page_id, after.as_ref(), limit)?
        }
        LibraryNavigationParent::Database { database_id } => {
            view_node_window(connection, library_id, database_id, after.as_ref(), limit)?
        }
    };
    let has_more = ordered.len() > limit;
    ordered.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let last = ordered
                .last()
                .ok_or_else(|| corrupt("Library child continuation has no node"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text {
                        value: last.sort_key.clone(),
                    }],
                    stable_id: navigation_node_id(&last.node).to_owned(),
                },
            )
        })
        .transpose()?;
    let mut items = ordered
        .into_iter()
        .map(|ordered| ordered.node)
        .collect::<Vec<_>>();
    if let Some(target) = force_include_target
        && !items.iter().any(|node| matches_target(node, &target))
        && let Some(forced) = forced_child_node(connection, library_id, &parent, &target)?
    {
        items.push(forced);
    }
    Ok(LibraryReadValue::Children {
        parent,
        items,
        next_cursor,
        has_more,
        total,
    })
}

fn standalone_roots(
    connection: &Connection,
    library_id: &str,
    requested_cursor: Option<String>,
    limit: Option<u32>,
    force_include_target: Option<LibraryPlacedResourceTarget>,
) -> Result<LibraryReadValue, StoreError> {
    let subject = vec!["standalone_roots".to_owned()];
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let limit = read_limit(limit)?;
    let (mut ordered, total) =
        standalone_root_node_window(connection, library_id, after.as_ref(), limit)?;
    let has_more = ordered.len() > limit;
    ordered.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let last = ordered
                .last()
                .ok_or_else(|| corrupt("Standalone root continuation has no node"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text {
                        value: last.sort_key.clone(),
                    }],
                    stable_id: navigation_node_id(&last.node).to_owned(),
                },
            )
        })
        .transpose()?;
    let mut items = ordered
        .into_iter()
        .map(|ordered| ordered.node)
        .collect::<Vec<_>>();
    if let Some(target) = force_include_target {
        let route_target = resource_route_target(&target);
        if !items.iter().any(|node| matches_target(node, &route_target))
            && standalone_root_is_eligible(connection, library_id, &target)?
            && let Some(forced) = forced_child_node(
                connection,
                library_id,
                &LibraryNavigationParent::Library,
                &route_target,
            )?
        {
            items.push(forced);
        }
    }
    Ok(LibraryReadValue::StandaloneRoots {
        items,
        next_cursor,
        has_more,
        total,
    })
}

struct OrderedNavigationNode {
    node: LibraryNavigationNode,
    sort_key: String,
}

fn root_node_window(
    connection: &Connection,
    library_id: &str,
    after: Option<&cursor::KeysetCoordinate>,
    limit: usize,
) -> Result<(Vec<OrderedNavigationNode>, u64), StoreError> {
    let (after_sort_key, after_id) = keyset_text_coordinate(after)?;
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| invalid("Library limit overflowed"))?;
    let nodes = connection
        .prepare(
            "SELECT block.type, block.id, placement.rank_key, \
               materialization.title, block.placement_revision, block.metadata_revision, \
               document.generation, document.head_seq, page.updated_at, \
               EXISTS(SELECT 1 FROM document_block_index child \
                 INNER JOIN blocks child_block ON child_block.id = child.block_id \
                 WHERE child.document_id = page.document_id \
                   AND child_block.type IN ('page', 'database', 'canvas') \
                   AND child_block.lifecycle = 'active'), \
               container.name, container.default_view_id, container.metadata_revision, \
               block.placement_revision, container.updated_at, \
               (SELECT COUNT(*) FROM database_views view \
                 WHERE view.database_block_id = container.block_id \
                   AND view.lifecycle = 'active'), \
               json_extract(canvas_name.value_json, '$'), block.metadata_revision, \
               block.placement_revision, canvas.updated_at, canvas_document.generation, \
               canvas_document.head_seq, (SELECT project.id FROM projects project \
                 WHERE project.library_id = block.library_id \
                   AND block.id = 'canvas:primary:' || project.id LIMIT 1) \
             FROM library_block_placements placement \
             INNER JOIN blocks block ON block.id = placement.block_id \
             LEFT JOIN pages page ON page.block_id = block.id \
             LEFT JOIN documents document ON document.id = page.document_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             LEFT JOIN database_containers container ON container.block_id = block.id \
             LEFT JOIN canvas_owners canvas ON canvas.block_id = block.id \
             LEFT JOIN block_documents canvas_ownership ON canvas_ownership.block_id = block.id \
             LEFT JOIN documents canvas_document ON canvas_document.id = canvas_ownership.document_id \
             LEFT JOIN block_properties canvas_name ON canvas_name.block_id = block.id \
               AND canvas_name.property_key = 'document.display_name' \
             WHERE placement.library_id = ?1 AND block.type IN ('page', 'database', 'canvas') \
               AND block.lifecycle = 'active' \
               AND COALESCE(container.lifecycle, block.lifecycle) = 'active' \
               AND (?2 IS NULL OR placement.rank_key > ?2 \
                 OR (placement.rank_key = ?2 AND block.id > ?3)) \
             ORDER BY placement.rank_key, block.id LIMIT ?4",
        )?
        .query_map(
            params![library_id, after_sort_key, after_id, query_limit],
            navigation_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total = connection.query_row(
        "SELECT COUNT(*) FROM library_block_placements placement \
         INNER JOIN blocks block ON block.id = placement.block_id \
         LEFT JOIN pages page ON page.block_id = block.id \
         LEFT JOIN database_containers container ON container.block_id = block.id \
         LEFT JOIN canvas_owners canvas ON canvas.block_id = block.id \
         WHERE placement.library_id = ?1 AND block.type IN ('page', 'database', 'canvas') \
           AND block.lifecycle = 'active' \
           AND COALESCE(container.lifecycle, block.lifecycle) = 'active'",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok((nodes, count_to_u64(total)?))
}

fn standalone_root_node_window(
    connection: &Connection,
    library_id: &str,
    after: Option<&cursor::KeysetCoordinate>,
    limit: usize,
) -> Result<(Vec<OrderedNavigationNode>, u64), StoreError> {
    let (after_sort_key, after_id) = keyset_text_coordinate(after)?;
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| invalid("Library limit overflowed"))?;
    let eligibility = "NOT (block.type = 'database' AND EXISTS( \
          SELECT 1 FROM project_database_bindings binding \
          INNER JOIN projects project \
            ON project.id = binding.project_id \
            AND project.library_id = binding.library_id \
          WHERE binding.database_block_id = block.id \
            AND binding.library_id = placement.library_id \
            AND binding.lifecycle = 'active' \
            AND project.lifecycle <> 'archived' \
        )) AND NOT (block.type = 'canvas' AND EXISTS( \
          SELECT 1 FROM projects project \
          WHERE project.library_id = placement.library_id \
            AND project.lifecycle <> 'archived' \
            AND block.id = 'canvas:primary:' || project.id \
        ))";
    let rows_sql = format!(
        "SELECT block.type, block.id, placement.rank_key, \
           materialization.title, block.placement_revision, block.metadata_revision, \
           document.generation, document.head_seq, page.updated_at, \
           EXISTS(SELECT 1 FROM document_block_index child \
             INNER JOIN blocks child_block ON child_block.id = child.block_id \
             WHERE child.document_id = page.document_id \
               AND child_block.type IN ('page', 'database', 'canvas') \
               AND child_block.lifecycle = 'active'), \
           container.name, container.default_view_id, container.metadata_revision, \
           block.placement_revision, container.updated_at, \
           (SELECT COUNT(*) FROM database_views view \
             WHERE view.database_block_id = container.block_id \
               AND view.lifecycle = 'active'), \
           json_extract(canvas_name.value_json, '$'), block.metadata_revision, \
           block.placement_revision, canvas.updated_at, canvas_document.generation, \
           canvas_document.head_seq, (SELECT project.id FROM projects project \
             WHERE project.library_id = block.library_id \
               AND block.id = 'canvas:primary:' || project.id LIMIT 1) \
         FROM library_block_placements placement \
         INNER JOIN blocks block ON block.id = placement.block_id \
         LEFT JOIN pages page ON page.block_id = block.id \
         LEFT JOIN documents document ON document.id = page.document_id \
         LEFT JOIN document_materializations materialization \
           ON materialization.document_id = page.document_id \
         LEFT JOIN database_containers container ON container.block_id = block.id \
         LEFT JOIN canvas_owners canvas ON canvas.block_id = block.id \
         LEFT JOIN block_documents canvas_ownership ON canvas_ownership.block_id = block.id \
         LEFT JOIN documents canvas_document ON canvas_document.id = canvas_ownership.document_id \
         LEFT JOIN block_properties canvas_name ON canvas_name.block_id = block.id \
           AND canvas_name.property_key = 'document.display_name' \
         WHERE placement.library_id = ?1 AND block.type IN ('page', 'database', 'canvas') \
           AND block.lifecycle = 'active' \
           AND COALESCE(container.lifecycle, block.lifecycle) = 'active' \
           AND {eligibility} \
           AND (?2 IS NULL OR placement.rank_key > ?2 \
             OR (placement.rank_key = ?2 AND block.id > ?3)) \
         ORDER BY placement.rank_key, block.id LIMIT ?4"
    );
    let nodes = connection
        .prepare(&rows_sql)?
        .query_map(
            params![library_id, after_sort_key, after_id, query_limit],
            navigation_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let count_sql = format!(
        "SELECT COUNT(*) FROM library_block_placements placement \
         INNER JOIN blocks block ON block.id = placement.block_id \
         LEFT JOIN pages page ON page.block_id = block.id \
         LEFT JOIN database_containers container ON container.block_id = block.id \
         WHERE placement.library_id = ?1 AND block.type IN ('page', 'database', 'canvas') \
           AND block.lifecycle = 'active' \
           AND COALESCE(container.lifecycle, block.lifecycle) = 'active' \
           AND {eligibility}"
    );
    let total = connection.query_row(&count_sql, [library_id], |row| row.get::<_, i64>(0))?;
    Ok((nodes, count_to_u64(total)?))
}

fn standalone_root_is_eligible(
    connection: &Connection,
    library_id: &str,
    target: &LibraryPlacedResourceTarget,
) -> Result<bool, StoreError> {
    let (block_type, block_id) = match target {
        LibraryPlacedResourceTarget::Page { page_id } => ("page", page_id),
        LibraryPlacedResourceTarget::Database { database_id } => ("database", database_id),
        LibraryPlacedResourceTarget::Canvas { canvas_id } => ("canvas", canvas_id),
    };
    connection
        .query_row(
            "SELECT EXISTS( \
               SELECT 1 FROM library_block_placements placement \
               INNER JOIN blocks block ON block.id = placement.block_id \
               LEFT JOIN pages page ON page.block_id = block.id \
               LEFT JOIN database_containers container ON container.block_id = block.id \
               WHERE placement.library_id = ?1 AND block.id = ?2 AND block.type = ?3 \
                 AND block.lifecycle = 'active' \
                 AND COALESCE(container.lifecycle, block.lifecycle) = 'active' \
                 AND NOT (block.type = 'database' AND EXISTS( \
                   SELECT 1 FROM project_database_bindings binding \
                   INNER JOIN projects project \
                     ON project.id = binding.project_id \
                     AND project.library_id = binding.library_id \
                   WHERE binding.database_block_id = block.id \
                     AND binding.library_id = placement.library_id \
                     AND binding.lifecycle = 'active' \
                     AND project.lifecycle <> 'archived' \
                 )) \
                 AND NOT (block.type = 'canvas' AND EXISTS( \
                   SELECT 1 FROM projects project \
                   WHERE project.library_id = placement.library_id \
                     AND project.lifecycle <> 'archived' \
                     AND block.id = 'canvas:primary:' || project.id \
                 )) \
             )",
            params![library_id, block_id, block_type],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn resource_route_target(target: &LibraryPlacedResourceTarget) -> LibraryRouteTarget {
    match target {
        LibraryPlacedResourceTarget::Page { page_id } => LibraryRouteTarget::Page {
            page_id: page_id.clone(),
        },
        LibraryPlacedResourceTarget::Database { database_id } => LibraryRouteTarget::Database {
            database_id: database_id.clone(),
        },
        LibraryPlacedResourceTarget::Canvas { canvas_id } => LibraryRouteTarget::Canvas {
            canvas_id: canvas_id.clone(),
        },
    }
}

fn page_child_node_window(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    after: Option<&cursor::KeysetCoordinate>,
    limit: usize,
) -> Result<(Vec<OrderedNavigationNode>, u64), StoreError> {
    let document_id = connection
        .query_row(
            "SELECT page.document_id FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.lifecycle = 'active'",
            params![page_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Library Page is unavailable"))?;
    let (after_sort_key, after_id) = keyset_text_coordinate(after)?;
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| invalid("Library limit overflowed"))?;
    let nodes = connection
        .prepare(
            "WITH RECURSIVE ordered(block_id, path) AS ( \
               SELECT block_id, printf('%010d', ordinal) || ':' || block_id \
               FROM document_block_index \
               WHERE document_id = ?1 AND parent_block_id IS NULL \
               UNION ALL \
               SELECT child.block_id, ordered.path || '/' || \
                 printf('%010d', child.ordinal) || ':' || child.block_id \
               FROM ordered INNER JOIN document_block_index child \
                 ON child.document_id = ?1 AND child.parent_block_id = ordered.block_id \
             ) \
             SELECT block.type, block.id, ordered.path, \
               materialization.title, block.placement_revision, block.metadata_revision, \
               document.generation, document.head_seq, page.updated_at, \
               EXISTS(SELECT 1 FROM document_block_index child \
                 INNER JOIN blocks child_block ON child_block.id = child.block_id \
                 WHERE child.document_id = page.document_id \
                   AND child_block.type IN ('page', 'database', 'canvas') \
                   AND child_block.lifecycle = 'active'), \
               container.name, container.default_view_id, container.metadata_revision, \
               block.placement_revision, container.updated_at, \
               (SELECT COUNT(*) FROM database_views view \
                 WHERE view.database_block_id = container.block_id \
                   AND view.lifecycle = 'active'), \
               json_extract(canvas_name.value_json, '$'), block.metadata_revision, \
               block.placement_revision, canvas.updated_at, canvas_document.generation, \
               canvas_document.head_seq, (SELECT project.id FROM projects project \
                 WHERE project.library_id = block.library_id \
                   AND block.id = 'canvas:primary:' || project.id LIMIT 1) \
             FROM ordered \
             INNER JOIN blocks block ON block.id = ordered.block_id \
             LEFT JOIN pages page ON page.block_id = block.id \
             LEFT JOIN documents document ON document.id = page.document_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             LEFT JOIN database_containers container ON container.block_id = block.id \
             LEFT JOIN canvas_owners canvas ON canvas.block_id = block.id \
             LEFT JOIN block_documents canvas_ownership ON canvas_ownership.block_id = block.id \
             LEFT JOIN documents canvas_document ON canvas_document.id = canvas_ownership.document_id \
             LEFT JOIN block_properties canvas_name ON canvas_name.block_id = block.id \
               AND canvas_name.property_key = 'document.display_name' \
             WHERE block.type IN ('page', 'database', 'canvas') AND block.lifecycle = 'active' \
               AND COALESCE(container.lifecycle, block.lifecycle) = 'active' \
               AND (?2 IS NULL OR ordered.path > ?2 \
                 OR (ordered.path = ?2 AND block.id > ?3)) \
             ORDER BY ordered.path, block.id LIMIT ?4",
        )?
        .query_map(
            params![document_id, after_sort_key, after_id, query_limit],
            navigation_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total = connection.query_row(
        "WITH RECURSIVE ordered(block_id) AS ( \
           SELECT block_id FROM document_block_index \
           WHERE document_id = ?1 AND parent_block_id IS NULL \
           UNION ALL \
           SELECT child.block_id FROM ordered \
           INNER JOIN document_block_index child \
             ON child.document_id = ?1 AND child.parent_block_id = ordered.block_id \
         ) \
         SELECT COUNT(*) FROM ordered \
         INNER JOIN blocks block ON block.id = ordered.block_id \
         LEFT JOIN pages page ON page.block_id = block.id \
         LEFT JOIN database_containers container ON container.block_id = block.id \
         LEFT JOIN canvas_owners canvas ON canvas.block_id = block.id \
         WHERE block.type IN ('page', 'database', 'canvas') AND block.lifecycle = 'active' \
           AND COALESCE(container.lifecycle, block.lifecycle) = 'active'",
        [document_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok((nodes, count_to_u64(total)?))
}

fn page_node(connection: &Connection, page_id: &str) -> Result<LibraryNavigationNode, StoreError> {
    connection
        .query_row(
            "SELECT page.block_id, materialization.title, block.placement_revision, \
               block.metadata_revision, document.generation, document.head_seq, page.updated_at, \
               EXISTS(SELECT 1 FROM document_block_index child \
                 INNER JOIN blocks block ON block.id = child.block_id \
                 WHERE child.document_id = page.document_id \
                   AND block.type IN ('page', 'database', 'canvas') AND block.lifecycle = 'active') \
             FROM pages page \
             INNER JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id \
             INNER JOIN documents document ON document.id = page.document_id \
             INNER JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             WHERE page.block_id = ?1 AND block.lifecycle <> 'deleted'",
            [page_id],
            |row| {
                Ok(LibraryNavigationNode::Page {
                    page_id: row.get(0)?,
                    title: row.get(1)?,
                    parent_revision: row.get(2)?,
                    metadata_revision: row.get(3)?,
                    document_generation: row.get(4)?,
                    document_head_seq: row.get(5)?,
                    updated_at: row.get(6)?,
                    has_children: row.get::<_, i64>(7)? == 1,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library Page projection is unavailable"))
}

fn database_node(
    connection: &Connection,
    database_id: &str,
) -> Result<LibraryNavigationNode, StoreError> {
    connection
        .query_row(
            "SELECT container.block_id, container.name, container.default_view_id, \
               container.metadata_revision, block.placement_revision, container.updated_at, \
               COUNT(view.id) \
             FROM database_containers container \
             INNER JOIN blocks block ON block.id = container.block_id \
             LEFT JOIN database_views view ON view.database_block_id = container.block_id \
               AND view.lifecycle = 'active' \
             WHERE container.block_id = ?1 AND container.lifecycle <> 'deleted' \
             GROUP BY container.block_id",
            [database_id],
            |row| {
                let default_view_id = row.get::<_, Option<String>>(2)?.ok_or_else(|| {
                    rusqlite::Error::InvalidColumnType(
                        2,
                        "default_view_id".to_owned(),
                        rusqlite::types::Type::Null,
                    )
                })?;
                Ok(LibraryNavigationNode::Database {
                    database_id: row.get(0)?,
                    title: row.get(1)?,
                    default_view_id,
                    metadata_revision: row.get(3)?,
                    location_revision: row.get(4)?,
                    updated_at: row.get(5)?,
                    has_multiple_views: row.get::<_, i64>(6)? > 1,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library Database projection is unavailable"))
}

fn canvas_node(
    connection: &Connection,
    library_id: &str,
    canvas_id: &str,
) -> Result<LibraryNavigationNode, StoreError> {
    connection
        .query_row(
            "SELECT block.id, json_extract(property.value_json, '$'), \
                    block.metadata_revision, block.placement_revision, canvas.updated_at, \
                    document.generation, document.head_seq, \
                    (SELECT project.id FROM projects project \
                     WHERE project.library_id = block.library_id \
                       AND block.id = 'canvas:primary:' || project.id LIMIT 1) \
             FROM canvas_owners canvas \
             JOIN blocks block ON block.id = canvas.block_id \
             JOIN block_documents ownership ON ownership.block_id = block.id \
             JOIN documents document ON document.id = ownership.document_id \
             LEFT JOIN block_properties property ON property.block_id = block.id \
               AND property.property_key = 'document.display_name' \
             WHERE block.id = ?1 AND canvas.library_id = ?2 \
               AND block.type = 'canvas' AND block.lifecycle <> 'deleted' \
               AND document.sync_engine = 'canvas_scene'",
            params![canvas_id, library_id],
            |row| {
                let canvas_id = row.get::<_, String>(0)?;
                let project_id = row.get::<_, Option<String>>(7)?;
                Ok(LibraryNavigationNode::Canvas {
                    is_primary: project_id.as_deref().is_some_and(|project_id| {
                        is_primary_canvas_block_id(&canvas_id, project_id)
                    }),
                    canvas_id,
                    title: row
                        .get::<_, Option<String>>(1)?
                        .unwrap_or_else(|| "Canvas".to_owned()),
                    metadata_revision: row.get(2)?,
                    location_revision: row.get(3)?,
                    updated_at: row.get(4)?,
                    document_generation: row.get(5)?,
                    document_head_seq: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library Canvas projection is unavailable"))
}

fn canvas_target(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    requesting_adapter: &AdapterKind,
    canvas_id: &str,
) -> Result<LibraryCanvasTarget, StoreError> {
    let row = connection
        .query_row(
            "SELECT (SELECT project.id FROM projects project \
                      WHERE project.library_id = block.library_id \
                        AND block.id = 'canvas:primary:' || project.id LIMIT 1), \
                    block.lifecycle, containing.document_id, block.metadata_revision, \
                    block.placement_revision, json_extract(property.value_json, '$'), \
                    document.generation, document.head_seq, block.updated_at, \
                    host_page.block_id \
             FROM canvas_owners canvas \
             JOIN blocks block ON block.id = canvas.block_id \
               AND block.library_id = canvas.library_id \
             JOIN block_documents ownership ON ownership.block_id = block.id \
               AND ownership.library_id = block.library_id \
             JOIN documents document ON document.id = ownership.document_id \
               AND document.library_id = ownership.library_id \
             LEFT JOIN document_block_index containing ON containing.block_id = block.id \
             LEFT JOIN block_documents host_ownership \
               ON host_ownership.document_id = containing.document_id \
             LEFT JOIN block_properties property ON property.block_id = block.id \
               AND property.library_id = block.library_id \
               AND property.property_key = 'document.display_name' \
             LEFT JOIN pages host_page ON host_page.block_id = host_ownership.block_id \
             WHERE block.id = ?1 AND canvas.library_id = ?2 \
               AND block.type = 'canvas' AND document.sync_engine = 'canvas_scene'",
            params![canvas_id, library_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()?;
    let Some((
        primary_project_id,
        lifecycle,
        containing_document_id,
        metadata_revision,
        location_revision,
        title,
        document_generation,
        document_head_seq,
        updated_at,
        host_page_id,
    )) = row
    else {
        return Ok(LibraryCanvasTarget::Missing {
            canvas_id: canvas_id.to_owned(),
        });
    };
    authorize_canvas_row(
        connection,
        library_id,
        requesting_project_id,
        requesting_adapter,
        canvas_id,
        host_page_id.as_deref(),
        lifecycle == "deleted",
    )?;
    if lifecycle == "deleted" {
        return Ok(LibraryCanvasTarget::Deleted {
            canvas_id: canvas_id.to_owned(),
            library_id: library_id.to_owned(),
        });
    }
    let is_primary = primary_project_id.is_some();
    let location = match containing_document_id {
        None => LibraryCanvasLocation::Library,
        Some(document_id) => LibraryCanvasLocation::Page {
            page_id: host_page_id
                .ok_or_else(|| corrupt("Document-placed Canvas has no Page owner"))?,
            document_id,
        },
    };
    Ok(LibraryCanvasTarget::Available {
        summary: LibraryCanvasSummary {
            canvas_id: canvas_id.to_owned(),
            title: title.unwrap_or_else(|| "Canvas".to_owned()),
            lifecycle,
            is_primary,
            location,
            metadata_revision,
            location_revision,
            document_generation,
            document_head_seq,
            updated_at,
        },
    })
}

fn view_node_window(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
    after: Option<&cursor::KeysetCoordinate>,
    limit: usize,
) -> Result<(Vec<OrderedNavigationNode>, u64), StoreError> {
    let default_view_id = connection
        .query_row(
            "SELECT default_view_id FROM database_containers \
             WHERE block_id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![database_id, library_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Library Database is unavailable"))?;
    let (after_sort_key, after_id) = keyset_text_coordinate(after)?;
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| invalid("Library limit overflowed"))?;
    let nodes = connection
        .prepare(
            "SELECT id, database_block_id, data_source_id, name, layout, revision, rank_key \
             FROM database_views WHERE database_block_id = ?1 AND lifecycle = 'active' \
               AND (?2 IS NULL OR rank_key > ?2 OR (rank_key = ?2 AND id > ?3)) \
             ORDER BY rank_key, id LIMIT ?4",
        )?
        .query_map(
            params![database_id, after_sort_key, after_id, query_limit],
            |row| {
                let view_id = row.get::<_, String>(0)?;
                Ok(OrderedNavigationNode {
                    node: LibraryNavigationNode::View {
                        is_default: default_view_id.as_ref() == Some(&view_id),
                        view_id,
                        database_id: row.get(1)?,
                        data_source_id: row.get(2)?,
                        title: row.get(3)?,
                        layout: row.get(4)?,
                        revision: row.get(5)?,
                    },
                    sort_key: row.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total = connection.query_row(
        "SELECT COUNT(*) FROM database_views \
         WHERE database_block_id = ?1 AND lifecycle = 'active'",
        [database_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok((nodes, count_to_u64(total)?))
}

fn navigation_row(row: &Row<'_>) -> rusqlite::Result<OrderedNavigationNode> {
    let kind = row.get::<_, String>(0)?;
    let id = row.get::<_, String>(1)?;
    let sort_key = row.get::<_, String>(2)?;
    let node = match kind.as_str() {
        "page" => LibraryNavigationNode::Page {
            page_id: id,
            title: row.get(3)?,
            parent_revision: row.get(4)?,
            metadata_revision: row.get(5)?,
            document_generation: row.get(6)?,
            document_head_seq: row.get(7)?,
            updated_at: row.get(8)?,
            has_children: row.get::<_, i64>(9)? == 1,
        },
        "database" => LibraryNavigationNode::Database {
            database_id: id,
            title: row.get(10)?,
            default_view_id: row.get::<_, Option<String>>(11)?.ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(
                    11,
                    "default_view_id".to_owned(),
                    rusqlite::types::Type::Null,
                )
            })?,
            metadata_revision: row.get(12)?,
            location_revision: row.get(13)?,
            updated_at: row.get(14)?,
            has_multiple_views: row.get::<_, i64>(15)? > 1,
        },
        "canvas" => {
            let project_id = row.get::<_, Option<String>>(22)?;
            LibraryNavigationNode::Canvas {
                is_primary: project_id
                    .as_deref()
                    .is_some_and(|project_id| is_primary_canvas_block_id(&id, project_id)),
                canvas_id: id,
                title: row
                    .get::<_, Option<String>>(16)?
                    .unwrap_or_else(|| "Canvas".to_owned()),
                metadata_revision: row.get(17)?,
                location_revision: row.get(18)?,
                updated_at: row.get(19)?,
                document_generation: row.get(20)?,
                document_head_seq: row.get(21)?,
            }
        }
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                0,
                "block.type".to_owned(),
                rusqlite::types::Type::Text,
            ));
        }
    };
    Ok(OrderedNavigationNode { node, sort_key })
}

fn view_node(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
    view_id: &str,
) -> Result<LibraryNavigationNode, StoreError> {
    connection
        .query_row(
            "SELECT view.id, view.database_block_id, view.data_source_id, view.name, \
               view.layout, view.revision, view.id = container.default_view_id \
             FROM database_views view \
             INNER JOIN database_containers container \
               ON container.block_id = view.database_block_id \
             WHERE view.id = ?1 AND view.database_block_id = ?2 \
               AND container.library_id = ?3 AND view.lifecycle = 'active' \
               AND container.lifecycle = 'active'",
            params![view_id, database_id, library_id],
            |row| {
                Ok(LibraryNavigationNode::View {
                    view_id: row.get(0)?,
                    database_id: row.get(1)?,
                    data_source_id: row.get(2)?,
                    title: row.get(3)?,
                    layout: row.get(4)?,
                    revision: row.get(5)?,
                    is_default: row.get::<_, i64>(6)? == 1,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library View is unavailable"))
}

fn forced_child_node(
    connection: &Connection,
    library_id: &str,
    parent: &LibraryNavigationParent,
    target: &LibraryRouteTarget,
) -> Result<Option<LibraryNavigationNode>, StoreError> {
    match (parent, target) {
        (LibraryNavigationParent::Library, LibraryRouteTarget::Page { page_id }) => {
            let exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_block_placements placement \
                 INNER JOIN pages page ON page.block_id = placement.block_id \
                 INNER JOIN blocks block ON block.id = page.block_id \
                   AND block.library_id = page.library_id \
                 WHERE placement.library_id = ?1 AND placement.block_id = ?2 \
                   AND block.lifecycle = 'active')",
                params![library_id, page_id],
                |row| row.get::<_, bool>(0),
            )?;
            exists.then(|| page_node(connection, page_id)).transpose()
        }
        (LibraryNavigationParent::Library, LibraryRouteTarget::Database { database_id }) => {
            let exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_block_placements placement \
                 INNER JOIN database_containers container \
                   ON container.block_id = placement.block_id \
                 WHERE placement.library_id = ?1 AND placement.block_id = ?2 \
                   AND container.lifecycle = 'active')",
                params![library_id, database_id],
                |row| row.get::<_, bool>(0),
            )?;
            exists
                .then(|| database_node(connection, database_id))
                .transpose()
        }
        (LibraryNavigationParent::Library, LibraryRouteTarget::Canvas { canvas_id }) => {
            let exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_block_placements placement \
                 INNER JOIN canvas_owners canvas ON canvas.block_id = placement.block_id \
                 INNER JOIN blocks block ON block.id = canvas.block_id \
                 WHERE placement.library_id = ?1 AND placement.block_id = ?2 \
                   AND block.lifecycle = 'active')",
                params![library_id, canvas_id],
                |row| row.get::<_, bool>(0),
            )?;
            exists
                .then(|| canvas_node(connection, library_id, canvas_id))
                .transpose()
        }
        (
            LibraryNavigationParent::Page {
                page_id: parent_page_id,
            },
            LibraryRouteTarget::Page { page_id },
        ) => forced_document_child(connection, library_id, parent_page_id, page_id)?
            .then(|| page_node(connection, page_id))
            .transpose(),
        (
            LibraryNavigationParent::Page {
                page_id: parent_page_id,
            },
            LibraryRouteTarget::Database { database_id },
        ) => forced_document_child(connection, library_id, parent_page_id, database_id)?
            .then(|| database_node(connection, database_id))
            .transpose(),
        (
            LibraryNavigationParent::Page {
                page_id: parent_page_id,
            },
            LibraryRouteTarget::Canvas { canvas_id },
        ) => forced_document_child(connection, library_id, parent_page_id, canvas_id)?
            .then(|| canvas_node(connection, library_id, canvas_id))
            .transpose(),
        (
            LibraryNavigationParent::Database { database_id },
            LibraryRouteTarget::View { view_id },
        ) => {
            let exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM database_views view \
                 INNER JOIN database_containers container \
                   ON container.block_id = view.database_block_id \
                 WHERE view.id = ?1 AND view.database_block_id = ?2 \
                   AND container.library_id = ?3 AND view.lifecycle = 'active' \
                   AND container.lifecycle = 'active')",
                params![view_id, database_id, library_id],
                |row| row.get::<_, bool>(0),
            )?;
            exists
                .then(|| view_node(connection, library_id, database_id, view_id))
                .transpose()
        }
        _ => Ok(None),
    }
}

fn forced_document_child(
    connection: &Connection,
    library_id: &str,
    parent_page_id: &str,
    target_id: &str,
) -> Result<bool, StoreError> {
    connection
        .query_row(
            "WITH RECURSIVE ordered(block_id) AS ( \
               SELECT child.block_id FROM pages page \
               INNER JOIN blocks page_block ON page_block.id = page.block_id \
                 AND page_block.library_id = page.library_id \
               INNER JOIN document_block_index child \
                 ON child.document_id = page.document_id \
               WHERE page.block_id = ?1 AND page.library_id = ?2 \
                 AND page_block.lifecycle = 'active' AND child.parent_block_id IS NULL \
               UNION ALL \
               SELECT child.block_id FROM ordered \
               INNER JOIN document_block_index child \
                 ON child.parent_block_id = ordered.block_id \
             ) \
             SELECT EXISTS(SELECT 1 FROM ordered \
               INNER JOIN blocks block ON block.id = ordered.block_id \
               WHERE ordered.block_id = ?3 AND block.lifecycle = 'active' \
                 AND block.type IN ('page', 'database', 'canvas'))",
            params![parent_page_id, library_id, target_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn path(
    connection: &Connection,
    library_id: &str,
    target: &LibraryRouteTarget,
) -> Result<Vec<LibraryNavigationNode>, StoreError> {
    match target {
        LibraryRouteTarget::Page { page_id } => page_path(connection, library_id, page_id),
        LibraryRouteTarget::Database { database_id } => {
            database_path(connection, library_id, database_id)
        }
        LibraryRouteTarget::Canvas { canvas_id } => canvas_path(connection, library_id, canvas_id),
        LibraryRouteTarget::View { view_id } => {
            let database_id = connection
                .query_row(
                    "SELECT database_block_id FROM database_views \
                     WHERE id = ?1 AND lifecycle = 'active'",
                    [view_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| not_found("Library View is unavailable"))?;
            let mut nodes = database_path(connection, library_id, &database_id)?;
            let view = view_node(connection, library_id, &database_id, view_id)?;
            nodes.push(view);
            Ok(nodes)
        }
    }
}

fn page_path(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Vec<LibraryNavigationNode>, StoreError> {
    let mut current = page_id.to_owned();
    let mut page_ids = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if page_ids.len() >= 512 {
            return Err(corrupt("Library Page hierarchy exceeds 512 Page levels"));
        }
        if !seen.insert(current.clone()) {
            return Err(corrupt("Library Page hierarchy contains a cycle"));
        }
        let row = connection
            .query_row(
                "SELECT page.parent_kind, page.parent_id FROM pages page \
                 INNER JOIN blocks block ON block.id = page.block_id \
                   AND block.library_id = page.library_id \
                 WHERE page.block_id = ?1 AND page.library_id = ?2 \
                   AND block.lifecycle <> 'deleted'",
                params![current, library_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| not_found("Library Page is unavailable"))?;
        page_ids.push(current.clone());
        match row.0.as_str() {
            "library" => break,
            "page" => current = row.1,
            "data_source" => {
                let database_id = connection
                    .query_row(
                        "SELECT home_database_block_id FROM data_sources \
                         WHERE id = ?1 AND library_id = ?2 AND lifecycle <> 'deleted'",
                        params![row.1, library_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| corrupt("Library Page has no owning Data Source"))?;
                return database_path(connection, library_id, &database_id);
            }
            _ => return Err(corrupt("Library Page has an invalid parent")),
        }
    }
    page_ids.reverse();
    page_ids
        .into_iter()
        .map(|page_id| page_node(connection, &page_id))
        .collect()
}

fn database_path(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<Vec<LibraryNavigationNode>, StoreError> {
    let database = database_node(connection, database_id)?;
    let host_page = connection
        .query_row(
            "SELECT page.block_id FROM document_block_index entry \
             INNER JOIN block_documents ownership \
               ON ownership.document_id = entry.document_id \
             INNER JOIN pages page ON page.block_id = ownership.block_id \
               AND page.library_id = ownership.library_id \
             WHERE entry.block_id = ?1 AND ownership.library_id = ?2",
            params![database_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let mut nodes = host_page
        .map(|page_id| page_path(connection, library_id, &page_id))
        .transpose()?
        .unwrap_or_default();
    nodes.push(database);
    Ok(nodes)
}

fn canvas_path(
    connection: &Connection,
    library_id: &str,
    canvas_id: &str,
) -> Result<Vec<LibraryNavigationNode>, StoreError> {
    let canvas = canvas_node(connection, library_id, canvas_id)?;
    let host_page = connection
        .query_row(
            "SELECT page.block_id FROM document_block_index entry \
             INNER JOIN block_documents ownership \
               ON ownership.document_id = entry.document_id \
             INNER JOIN pages page ON page.block_id = ownership.block_id \
               AND page.library_id = ownership.library_id \
             WHERE entry.block_id = ?1 AND ownership.library_id = ?2",
            params![canvas_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let mut nodes = host_page
        .map(|page_id| page_path(connection, library_id, &page_id))
        .transpose()?
        .unwrap_or_default();
    nodes.push(canvas);
    Ok(nodes)
}

struct PageRelocationSource {
    parent_kind: String,
    parent_id: String,
    validator_view_id: Option<String>,
}

fn page_relocation_destinations(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    page_id: &str,
    scope: LibraryPageRelocationDestinationScope,
    requested_cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryReadValue, StoreError> {
    let source = connection
        .query_row(
            "SELECT page.parent_kind, page.parent_id \
             FROM pages page JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id AND block.type = 'page' \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle = 'active' AND document.readiness = 'ready'",
            params![page_id, library_id],
            |row| {
                Ok(PageRelocationSource {
                    parent_kind: row.get(0)?,
                    parent_id: row.get(1)?,
                    validator_view_id: None,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Page relocation source is unavailable"))?;
    let source = PageRelocationSource {
        validator_view_id: crate::database::default_page_move_view_id(
            connection, library_id, page_id,
        )?,
        ..source
    };
    let actor_project_id =
        super::mutation::resolve_library_actor_project_id(connection, library_id)?;
    match scope {
        LibraryPageRelocationDestinationScope::Databases { query } => {
            page_relocation_database_destinations(
                connection,
                library_id,
                store_epoch,
                page_id,
                &actor_project_id,
                &source,
                query,
                requested_cursor,
                limit,
            )
        }
        LibraryPageRelocationDestinationScope::PageSuggested => page_relocation_page_destinations(
            connection,
            library_id,
            store_epoch,
            page_id,
            &actor_project_id,
            &source,
            PageRelocationPageScope::Suggested,
            requested_cursor,
            limit,
        ),
        LibraryPageRelocationDestinationScope::PageChildren { parent } => {
            page_relocation_page_destinations(
                connection,
                library_id,
                store_epoch,
                page_id,
                &actor_project_id,
                &source,
                PageRelocationPageScope::Children(parent),
                requested_cursor,
                limit,
            )
        }
        LibraryPageRelocationDestinationScope::PageSearch { query } => {
            page_relocation_page_destinations(
                connection,
                library_id,
                store_epoch,
                page_id,
                &actor_project_id,
                &source,
                PageRelocationPageScope::Search(query),
                requested_cursor,
                limit,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn page_relocation_database_destinations(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    page_id: &str,
    actor_project_id: &str,
    source: &PageRelocationSource,
    query: Option<String>,
    requested_cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryReadValue, StoreError> {
    let query = query.unwrap_or_default().trim().to_lowercase();
    if query.len() > 256 {
        return Err(invalid("Page relocation Database query exceeds its bound"));
    }
    let scope = LibraryPageRelocationDestinationScope::Databases {
        query: (!query.is_empty()).then(|| query.clone()),
    };
    let subject = vec![
        "page_relocation_destinations".to_owned(),
        page_id.to_owned(),
        "databases".to_owned(),
        query.clone(),
    ];
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let (after_updated_at, after_id) = keyset_text_coordinate(after.as_ref())?;
    let limit = read_limit(limit)?;
    let (rows, has_more, total) = crate::database::page_relocation_database_targets(
        connection,
        library_id,
        &query,
        after_updated_at.as_deref(),
        after_id.as_deref(),
        limit,
    )?;
    let next_cursor = has_more
        .then(|| {
            let last = rows
                .last()
                .ok_or_else(|| corrupt("Database relocation continuation has no entry"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text {
                        value: last.updated_at.clone(),
                    }],
                    stable_id: last.database_id.clone(),
                },
            )
        })
        .transpose()?;
    let items = rows
        .into_iter()
        .map(|row| {
            let expected_move_etag = crate::database::mint_page_move_etag_prevalidated(
                connection,
                library_id,
                actor_project_id,
                store_epoch,
                page_id,
                Some(&row.view_id),
            )?;
            Ok(LibraryPageRelocationDestinationEntry {
                key: format!("database:{}", row.database_id),
                kind: LibraryPageRelocationDestinationKind::Database,
                title: row.title,
                path: row.primary_project_names,
                has_children: false,
                is_current: source.parent_kind == "data_source"
                    && source.parent_id == row.data_source_id,
                updated_at: row.updated_at,
                destination: LibraryPageWriteDestination::DataSource {
                    data_source_id: row.data_source_id,
                    view_id: Some(row.view_id),
                    group: None,
                    at: Some(LibraryAgentSiblingAnchor::End),
                },
                expected_move_etag,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(LibraryReadValue::PageRelocationDestinations {
        page_id: page_id.to_owned(),
        scope,
        items,
        next_cursor,
        has_more,
        total: count_to_u64(total)?,
    })
}

enum PageRelocationPageScope {
    Suggested,
    Children(LibraryNavigationParent),
    Search(String),
}

#[allow(clippy::too_many_arguments)]
fn page_relocation_page_destinations(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    page_id: &str,
    actor_project_id: &str,
    source: &PageRelocationSource,
    requested_scope: PageRelocationPageScope,
    requested_cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryReadValue, StoreError> {
    let (scope, scope_kind, parent_id, query, scope_subject, include_library_root) =
        match requested_scope {
            PageRelocationPageScope::Suggested => (
                LibraryPageRelocationDestinationScope::PageSuggested,
                "suggested",
                if source.parent_kind == "page" {
                    source.parent_id.clone()
                } else {
                    String::new()
                },
                String::new(),
                "suggested".to_owned(),
                false,
            ),
            PageRelocationPageScope::Children(parent) => match &parent {
                LibraryNavigationParent::Library => (
                    LibraryPageRelocationDestinationScope::PageChildren {
                        parent: parent.clone(),
                    },
                    "children_library",
                    library_id.to_owned(),
                    String::new(),
                    "children:library".to_owned(),
                    true,
                ),
                LibraryNavigationParent::Page { page_id } => (
                    LibraryPageRelocationDestinationScope::PageChildren {
                        parent: parent.clone(),
                    },
                    "children_page",
                    page_id.clone(),
                    String::new(),
                    format!("children:page:{page_id}"),
                    false,
                ),
                LibraryNavigationParent::Database { .. } => {
                    return Err(invalid(
                        "Database rows are not Page relocation tree parents",
                    ));
                }
            },
            PageRelocationPageScope::Search(query) => {
                let query = query.trim().to_lowercase();
                if query.is_empty() {
                    return Err(invalid("Page relocation search is empty"));
                }
                if query.len() > 256 {
                    return Err(invalid("Page relocation query exceeds its bound"));
                }
                (
                    LibraryPageRelocationDestinationScope::PageSearch {
                        query: query.clone(),
                    },
                    "search",
                    String::new(),
                    query.clone(),
                    format!("search:{query}"),
                    false,
                )
            }
        };
    let subject = vec![
        "page_relocation_destinations".to_owned(),
        page_id.to_owned(),
        scope_subject,
    ];
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let (after_updated_at, after_id) = keyset_text_coordinate(after.as_ref())?;
    let limit = read_limit(limit)?;
    let destinations_cte = "WITH RECURSIVE excluded(page_id) AS ( \
        SELECT ?2 UNION \
        SELECT page.block_id FROM pages page \
        JOIN excluded parent ON page.parent_kind = 'page' AND page.parent_id = parent.page_id \
        WHERE page.library_id = ?1 \
      ), destinations AS ( \
        SELECT page.block_id, materialization.title, page.updated_at, \
          EXISTS( \
            SELECT 1 FROM pages child \
            JOIN blocks child_block ON child_block.id = child.block_id \
            JOIN documents child_document ON child_document.id = child.document_id \
            JOIN document_materializations child_materialization \
              ON child_materialization.document_id = child_document.id \
              AND child_materialization.generation = child_document.generation \
              AND child_materialization.projected_seq = child_document.head_seq \
              AND child_materialization.schema_version = child_document.schema_version \
            WHERE child.library_id = ?1 AND child_block.lifecycle = 'active' \
              AND child_block.library_id = child.library_id \
              AND child.parent_kind = 'page' AND child.parent_id = page.block_id \
              AND NOT EXISTS(SELECT 1 FROM excluded WHERE page_id = child.block_id) \
          ) AS has_children \
        FROM pages page \
        JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
        JOIN documents document ON document.id = page.document_id \
          AND document.library_id = page.library_id \
        JOIN document_materializations materialization \
          ON materialization.document_id = document.id \
          AND materialization.generation = document.generation \
          AND materialization.projected_seq = document.head_seq \
          AND materialization.schema_version = document.schema_version \
        WHERE page.library_id = ?1 AND block.lifecycle = 'active' \
          AND document.readiness = 'ready' \
          AND NOT EXISTS(SELECT 1 FROM excluded WHERE page_id = page.block_id) \
          AND ((?3 = 'suggested' AND page.block_id != ?4) \
            OR (?3 = 'children_library' AND page.parent_kind = 'library' AND page.parent_id = ?4) \
            OR (?3 = 'children_page' AND page.parent_kind = 'page' AND page.parent_id = ?4) \
            OR (?3 = 'search' AND instr(lower(materialization.title), ?5) > 0)) \
      ) ";
    let rows_sql = format!(
        "{destinations_cte} SELECT block_id, title, updated_at, has_children \
         FROM destinations WHERE (?6 IS NULL OR updated_at < ?6 \
           OR (updated_at = ?6 AND block_id > ?7)) \
         ORDER BY updated_at DESC, block_id LIMIT ?8"
    );
    let include_current_page =
        scope_kind == "suggested" && requested_cursor.is_none() && source.parent_kind == "page";
    let page_limit = limit.saturating_sub(usize::from(include_current_page));
    let query_limit = i64::try_from(page_limit.saturating_add(1))
        .map_err(|_| invalid("Page relocation target limit overflowed"))?;
    let mut rows = connection
        .prepare(&rows_sql)?
        .query_map(
            params![
                library_id,
                page_id,
                scope_kind,
                parent_id,
                query,
                after_updated_at,
                after_id,
                query_limit,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > page_limit;
    let continuation_coordinate = has_more.then(|| {
        if page_limit == 0 {
            let first = rows
                .first()
                .ok_or_else(|| corrupt("Page relocation continuation has no entry"))?;
            // The current parent occupied the complete first window, so the
            // next cursor starts immediately before the first recent row.
            return Ok((first.2.clone(), "0".to_owned()));
        }
        let last = rows
            .get(page_limit - 1)
            .ok_or_else(|| corrupt("Page relocation continuation has no entry"))?;
        Ok((last.2.clone(), last.0.clone()))
    });
    rows.truncate(page_limit);
    let next_cursor = continuation_coordinate
        .map(|coordinate: Result<(String, String), StoreError>| {
            let (updated_at, stable_id) = coordinate?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text { value: updated_at }],
                    stable_id,
                },
            )
        })
        .transpose()?;
    let count_sql = format!("{destinations_cte} SELECT COUNT(*) FROM destinations");
    let page_total = connection.query_row(
        &count_sql,
        params![library_id, page_id, scope_kind, parent_id, query],
        |row| row.get::<_, i64>(0),
    )?;
    let expected_move_etag = crate::database::mint_page_move_etag_prevalidated(
        connection,
        library_id,
        actor_project_id,
        store_epoch,
        page_id,
        source.validator_view_id.as_deref(),
    )?;
    let mut items = Vec::with_capacity(
        rows.len() + usize::from(include_library_root) + usize::from(include_current_page),
    );
    if include_library_root && requested_cursor.is_none() {
        let updated_at = connection.query_row(
            "SELECT updated_at FROM libraries WHERE id = ?1",
            [library_id],
            |row| row.get::<_, String>(0),
        )?;
        items.push(LibraryPageRelocationDestinationEntry {
            key: format!("library:{library_id}"),
            kind: LibraryPageRelocationDestinationKind::Library,
            title: "Pages".to_owned(),
            path: Vec::new(),
            has_children: page_total > 0,
            is_current: source.parent_kind == "library" && source.parent_id == library_id,
            updated_at,
            destination: LibraryPageWriteDestination::Library {
                at: Some(LibraryAgentSiblingAnchor::End),
            },
            expected_move_etag: expected_move_etag.clone(),
        });
    }
    let mut included_current_page = false;
    if include_current_page {
        let current = connection
            .query_row(
                "SELECT materialization.title, page.updated_at, EXISTS( \
                   SELECT 1 FROM pages child \
                   JOIN blocks child_block ON child_block.id = child.block_id \
                   JOIN documents child_document ON child_document.id = child.document_id \
                   JOIN document_materializations child_materialization \
                     ON child_materialization.document_id = child_document.id \
                     AND child_materialization.generation = child_document.generation \
                     AND child_materialization.projected_seq = child_document.head_seq \
                     AND child_materialization.schema_version = child_document.schema_version \
                   WHERE child.library_id = ?1 AND child_block.lifecycle = 'active' \
                     AND child.parent_kind = 'page' AND child.parent_id = page.block_id \
                     AND child.block_id != ?3 \
                 ) AS has_children \
                 FROM pages page \
                 JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
                 JOIN documents document ON document.id = page.document_id \
                   AND document.library_id = page.library_id \
                 JOIN document_materializations materialization \
                   ON materialization.document_id = document.id \
                   AND materialization.generation = document.generation \
                   AND materialization.projected_seq = document.head_seq \
                   AND materialization.schema_version = document.schema_version \
                 WHERE page.library_id = ?1 AND page.block_id = ?2 \
                   AND block.lifecycle = 'active' AND document.readiness = 'ready'",
                params![library_id, source.parent_id, page_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((title, updated_at, has_children)) = current {
            included_current_page = true;
            items.push(LibraryPageRelocationDestinationEntry {
                key: format!("page:{}", source.parent_id),
                kind: LibraryPageRelocationDestinationKind::Page,
                title,
                path: move_destination_path(connection, library_id, &source.parent_id)?,
                has_children,
                is_current: true,
                updated_at,
                destination: LibraryPageWriteDestination::Page {
                    page_id: source.parent_id.clone(),
                    at: Some(LibraryAgentSiblingAnchor::End),
                },
                expected_move_etag: expected_move_etag.clone(),
            });
        }
    }
    for (destination_page_id, title, updated_at, has_children) in rows {
        items.push(LibraryPageRelocationDestinationEntry {
            key: format!("page:{destination_page_id}"),
            kind: LibraryPageRelocationDestinationKind::Page,
            title,
            path: move_destination_path(connection, library_id, &destination_page_id)?,
            has_children,
            is_current: source.parent_kind == "page" && source.parent_id == destination_page_id,
            updated_at,
            destination: LibraryPageWriteDestination::Page {
                page_id: destination_page_id,
                at: Some(LibraryAgentSiblingAnchor::End),
            },
            expected_move_etag: expected_move_etag.clone(),
        });
    }
    let total = page_total + i64::from(include_library_root) + i64::from(included_current_page);
    Ok(LibraryReadValue::PageRelocationDestinations {
        page_id: page_id.to_owned(),
        scope,
        items,
        next_cursor,
        has_more,
        total: count_to_u64(total)?,
    })
}

struct MoveDestinationRow {
    page_id: String,
    title: String,
    has_children: bool,
    document_generation: i64,
    document_head_seq: i64,
    updated_at: String,
}

fn move_destinations(
    connection: &Connection,
    library_id: &str,
    target: LibraryPlacedResourceTarget,
    scope: LibraryMoveDestinationScope,
    requested_cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryReadValue, StoreError> {
    let authority = super::mutation::read_resource_authority(connection, library_id, &target)?;
    if authority.lifecycle != "active" {
        return Err(not_found("Only an active Library resource can move"));
    }
    if authority.parent_kind == "data_source" {
        return Err(invalid(
            "A Data Source row Page must move through the Database Module",
        ));
    }

    let (target_id, target_is_page) = match &target {
        LibraryPlacedResourceTarget::Page { page_id } => (page_id.as_str(), true),
        LibraryPlacedResourceTarget::Database { database_id } => (database_id.as_str(), false),
        LibraryPlacedResourceTarget::Canvas { canvas_id } => (canvas_id.as_str(), false),
    };
    let current_parent_page_id =
        (authority.parent_kind == "page").then(|| authority.parent_id.clone());
    let root_is_current = authority.parent_kind == "library";

    let (scope_kind, scope_parent_id, query, scope_subject) = match &scope {
        LibraryMoveDestinationScope::Suggested => (
            "suggested",
            String::new(),
            String::new(),
            "suggested".to_owned(),
        ),
        LibraryMoveDestinationScope::Children { parent } => match parent {
            LibraryNavigationParent::Library => (
                "children_library",
                library_id.to_owned(),
                String::new(),
                "children:library".to_owned(),
            ),
            LibraryNavigationParent::Page { page_id } => (
                "children_page",
                page_id.clone(),
                String::new(),
                format!("children:page:{page_id}"),
            ),
            LibraryNavigationParent::Database { .. } => {
                return Err(invalid("Database rows are not Library move destinations"));
            }
        },
        LibraryMoveDestinationScope::Search { query } => {
            let query = query.trim().to_lowercase();
            if query.is_empty() {
                return Err(invalid("Library move destination search is empty"));
            }
            if query.len() > 256 {
                return Err(invalid("Library move destination query exceeds its bound"));
            }
            (
                "search",
                String::new(),
                query.clone(),
                format!("search:{query}"),
            )
        }
    };
    let subject = vec![
        "move_destinations".to_owned(),
        authority.resource_kind.to_owned(),
        authority.id.clone(),
        scope_subject,
    ];
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let (after_updated_at, after_id) = keyset_text_coordinate(after.as_ref())?;
    let limit = read_limit(limit)?;
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| invalid("Library limit overflowed"))?;
    let destinations_cte = "WITH RECURSIVE excluded(page_id) AS ( \
        SELECT ?2 WHERE ?3 \
        UNION \
        SELECT page.block_id FROM pages page \
        INNER JOIN excluded parent ON page.parent_kind = 'page' \
          AND page.parent_id = parent.page_id \
        WHERE page.library_id = ?1 \
      ), destinations AS ( \
        SELECT page.block_id, materialization.title, page.updated_at, \
          document.generation, document.head_seq, \
          EXISTS( \
            SELECT 1 FROM pages child \
            INNER JOIN blocks child_block ON child_block.id = child.block_id \
            INNER JOIN documents child_document ON child_document.id = child.document_id \
            INNER JOIN document_materializations child_materialization \
              ON child_materialization.document_id = child_document.id \
              AND child_materialization.generation = child_document.generation \
              AND child_materialization.projected_seq = child_document.head_seq \
              AND child_materialization.schema_version = child_document.schema_version \
            WHERE child.library_id = ?1 \
              AND child_block.lifecycle = 'active' \
              AND child_block.library_id = child.library_id \
              AND child.parent_kind = 'page' AND child.parent_id = page.block_id \
              AND NOT EXISTS(SELECT 1 FROM excluded WHERE page_id = child.block_id) \
          ) AS has_children \
        FROM pages page \
        INNER JOIN blocks block ON block.id = page.block_id \
        INNER JOIN documents document ON document.id = page.document_id \
        INNER JOIN document_materializations materialization \
          ON materialization.document_id = document.id \
          AND materialization.generation = document.generation \
          AND materialization.projected_seq = document.head_seq \
          AND materialization.schema_version = document.schema_version \
        WHERE page.library_id = ?1 \
          AND block.lifecycle = 'active' AND block.library_id = page.library_id \
          AND NOT EXISTS(SELECT 1 FROM excluded WHERE page_id = page.block_id) \
          AND ( \
            ?4 = 'suggested' \
            OR (?4 = 'search' AND instr(lower(materialization.title), ?6) > 0) \
            OR (?4 = 'children_library' AND page.parent_kind = 'library' \
              AND page.parent_id = ?5) \
            OR (?4 = 'children_page' AND page.parent_kind = 'page' \
              AND page.parent_id = ?5) \
          ) \
      ) ";
    let rows_sql = format!(
        "{destinations_cte} \
         SELECT block_id, title, updated_at, generation, head_seq, has_children \
         FROM destinations \
         WHERE (?7 IS NULL OR updated_at < ?7 \
           OR (updated_at = ?7 AND block_id > ?8)) \
         ORDER BY updated_at DESC, block_id LIMIT ?9"
    );
    let mut rows = connection
        .prepare(&rows_sql)?
        .query_map(
            params![
                library_id,
                target_id,
                target_is_page,
                scope_kind,
                scope_parent_id,
                query,
                after_updated_at,
                after_id,
                query_limit,
            ],
            |row| {
                Ok(MoveDestinationRow {
                    page_id: row.get(0)?,
                    title: row.get(1)?,
                    updated_at: row.get(2)?,
                    document_generation: row.get(3)?,
                    document_head_seq: row.get(4)?,
                    has_children: row.get(5)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let last = rows
                .last()
                .ok_or_else(|| corrupt("Move destination continuation has no entry"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text {
                        value: last.updated_at.clone(),
                    }],
                    stable_id: last.page_id.clone(),
                },
            )
        })
        .transpose()?;
    let count_sql = format!("{destinations_cte} SELECT COUNT(*) FROM destinations");
    let total = connection.query_row(
        &count_sql,
        params![
            library_id,
            target_id,
            target_is_page,
            scope_kind,
            scope_parent_id,
            query,
        ],
        |row| row.get::<_, i64>(0),
    )?;
    let items = rows
        .into_iter()
        .map(|row| {
            move_destination_entry(
                connection,
                library_id,
                row,
                current_parent_page_id.as_deref(),
            )
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let current_destination = current_parent_page_id
        .as_deref()
        .map(|page_id| {
            exact_move_destination_row(connection, library_id, target_id, target_is_page, page_id)?
                .map(|row| {
                    move_destination_entry(
                        connection,
                        library_id,
                        row,
                        current_parent_page_id.as_deref(),
                    )
                })
                .transpose()
        })
        .transpose()?
        .flatten();
    Ok(LibraryReadValue::MoveDestinations {
        target,
        scope,
        items,
        current_destination,
        next_cursor,
        has_more,
        total: count_to_u64(total)?,
        root_is_current,
    })
}

fn exact_move_destination_row(
    connection: &Connection,
    library_id: &str,
    target_id: &str,
    target_is_page: bool,
    page_id: &str,
) -> Result<Option<MoveDestinationRow>, StoreError> {
    connection
        .query_row(
            "WITH RECURSIVE excluded(page_id) AS ( \
               SELECT ?2 WHERE ?3 \
               UNION \
               SELECT page.block_id FROM pages page \
               INNER JOIN excluded parent ON page.parent_kind = 'page' \
                 AND page.parent_id = parent.page_id \
               WHERE page.library_id = ?1 \
             ) \
             SELECT page.block_id, materialization.title, page.updated_at, \
               document.generation, document.head_seq, \
               EXISTS( \
                 SELECT 1 FROM pages child \
                 INNER JOIN blocks child_block ON child_block.id = child.block_id \
                 INNER JOIN documents child_document ON child_document.id = child.document_id \
                 INNER JOIN document_materializations child_materialization \
                   ON child_materialization.document_id = child_document.id \
                   AND child_materialization.generation = child_document.generation \
                   AND child_materialization.projected_seq = child_document.head_seq \
                   AND child_materialization.schema_version = child_document.schema_version \
                 WHERE child.library_id = ?1 \
                   AND child_block.lifecycle = 'active' \
                   AND child_block.library_id = child.library_id \
                   AND child.parent_kind = 'page' AND child.parent_id = page.block_id \
                   AND NOT EXISTS( \
                     SELECT 1 FROM excluded WHERE page_id = child.block_id \
                   ) \
               ) AS has_children \
             FROM pages page \
             INNER JOIN blocks block ON block.id = page.block_id \
             INNER JOIN documents document ON document.id = page.document_id \
             INNER JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             WHERE page.library_id = ?1 AND page.block_id = ?4 \
               AND block.lifecycle = 'active' AND block.library_id = page.library_id \
               AND NOT EXISTS(SELECT 1 FROM excluded WHERE page_id = page.block_id)",
            params![library_id, target_id, target_is_page, page_id],
            |row| {
                Ok(MoveDestinationRow {
                    page_id: row.get(0)?,
                    title: row.get(1)?,
                    updated_at: row.get(2)?,
                    document_generation: row.get(3)?,
                    document_head_seq: row.get(4)?,
                    has_children: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn move_destination_entry(
    connection: &Connection,
    library_id: &str,
    row: MoveDestinationRow,
    current_parent_page_id: Option<&str>,
) -> Result<LibraryMoveDestinationEntry, StoreError> {
    let path = move_destination_path(connection, library_id, &row.page_id)?;
    Ok(LibraryMoveDestinationEntry {
        is_current: current_parent_page_id == Some(row.page_id.as_str()),
        page_id: row.page_id,
        title: row.title,
        path,
        has_children: row.has_children,
        document_generation: row.document_generation,
        document_head_seq: row.document_head_seq,
        updated_at: row.updated_at,
    })
}

pub(super) fn move_destination_path(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Vec<String>, StoreError> {
    let hierarchy = page_hierarchy(connection, library_id, page_id)?
        .ok_or_else(|| not_found("Library move destination is unavailable"))?;
    let boundary_page = hierarchy
        .last()
        .ok_or_else(|| corrupt("Library move destination hierarchy is empty"))?;
    let (parent_kind, parent_id) = connection.query_row(
        "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
        [&boundary_page.page_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    let boundary = match parent_kind.as_str() {
        "library" if parent_id == library_id => "Pages".to_owned(),
        "data_source" => connection
            .query_row(
                "SELECT container.name FROM data_sources source \
                 INNER JOIN database_containers container \
                   ON container.block_id = source.home_database_block_id \
                 WHERE source.id = ?1 AND source.library_id = ?2",
                params![parent_id, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| corrupt("Library move destination has no Database boundary"))?,
        _ => return Err(corrupt("Library move destination has an invalid boundary")),
    };
    let mut path = vec![boundary];
    path.extend(
        hierarchy
            .iter()
            .rev()
            .take(hierarchy.len().saturating_sub(1))
            .map(|entry| entry.title.clone()),
    );
    Ok(path)
}

#[allow(clippy::too_many_arguments)]
fn catalog(
    connection: &Connection,
    library_id: &str,
    query: Option<String>,
    kinds: Option<Vec<LibraryCatalogKind>>,
    lifecycle: Option<LibraryLifecycle>,
    requested_cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryReadValue, StoreError> {
    let query = query.unwrap_or_default().trim().to_lowercase();
    if query.len() > 256 {
        return Err(invalid("Library catalog query exceeds its bound"));
    }
    let lifecycle = lifecycle.unwrap_or(LibraryLifecycle::Active);
    let lifecycle_value = match lifecycle {
        LibraryLifecycle::Active => "active",
        LibraryLifecycle::Archived => "archived",
    };
    let kinds = kinds.unwrap_or_else(|| {
        vec![
            LibraryCatalogKind::Page,
            LibraryCatalogKind::Database,
            LibraryCatalogKind::Canvas,
        ]
    });
    let kind_subject = kinds
        .iter()
        .map(|kind| match kind {
            LibraryCatalogKind::Page => "page",
            LibraryCatalogKind::Database => "database",
            LibraryCatalogKind::Canvas => "canvas",
        })
        .collect::<Vec<_>>()
        .join(",");
    let subject = vec![
        "catalog".to_owned(),
        lifecycle_value.to_owned(),
        kind_subject,
        query.clone(),
    ];
    let after = cursor_coordinate(
        connection,
        requested_cursor.as_deref(),
        library_id,
        &subject,
    )?;
    let limit = read_limit(limit)?;
    let (after_updated_at, after_id) = keyset_text_coordinate(after.as_ref())?;
    let include_pages = kinds.contains(&LibraryCatalogKind::Page);
    let include_databases = kinds.contains(&LibraryCatalogKind::Database);
    let include_canvases = kinds.contains(&LibraryCatalogKind::Canvas);
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| invalid("Library limit overflowed"))?;
    let catalog_cte = "\
      WITH catalog(id, kind, title, updated_at, location_revision, metadata_revision, location_label) AS ( \
        SELECT page.block_id, 'page', materialization.title, page_block.updated_at, \
          page_block.placement_revision, page_block.metadata_revision, \
          CASE page.parent_kind \
            WHEN 'library' THEN 'Library' \
            WHEN 'page' THEN COALESCE(( \
              SELECT parent_materialization.title FROM pages parent_page \
              INNER JOIN document_materializations parent_materialization \
                ON parent_materialization.document_id = parent_page.document_id \
              WHERE parent_page.block_id = page.parent_id \
            ), 'Page') \
            WHEN 'data_source' THEN COALESCE(( \
              SELECT container.name FROM data_sources source \
              INNER JOIN database_containers container \
                ON container.block_id = source.home_database_block_id \
              WHERE source.id = page.parent_id \
            ), 'Database') \
            ELSE 'Library' \
          END \
        FROM pages page \
        INNER JOIN blocks page_block ON page_block.id = page.block_id \
          AND page_block.library_id = page.library_id \
        INNER JOIN document_materializations materialization \
          ON materialization.document_id = page.document_id \
        WHERE ?3 AND page.library_id = ?1 AND page_block.lifecycle = ?2 \
        UNION ALL \
        SELECT container.block_id, 'database', container.name, container.updated_at, \
          block.placement_revision, container.metadata_revision, \
          COALESCE(( \
            SELECT host_materialization.title FROM document_block_index containing \
            INNER JOIN block_documents ownership \
              ON ownership.document_id = containing.document_id \
            INNER JOIN pages host_page ON host_page.block_id = ownership.block_id \
            INNER JOIN document_materializations host_materialization \
              ON host_materialization.document_id = host_page.document_id \
            WHERE containing.block_id = block.id LIMIT 1 \
          ), 'Library') \
        FROM database_containers container \
        INNER JOIN blocks block ON block.id = container.block_id \
        WHERE ?4 AND container.library_id = ?1 AND container.lifecycle = ?2 \
        UNION ALL \
        SELECT block.id, 'canvas', COALESCE(json_extract(property.value_json, '$'), 'Canvas'), \
          canvas.updated_at, block.placement_revision, block.metadata_revision, \
          COALESCE(( \
            SELECT host_materialization.title FROM document_block_index containing \
            INNER JOIN block_documents ownership \
              ON ownership.document_id = containing.document_id \
            INNER JOIN pages host_page ON host_page.block_id = ownership.block_id \
            INNER JOIN document_materializations host_materialization \
              ON host_materialization.document_id = host_page.document_id \
            WHERE containing.block_id = block.id LIMIT 1 \
          ), 'Library') \
        FROM canvas_owners canvas \
        INNER JOIN blocks block ON block.id = canvas.block_id \
        LEFT JOIN block_properties property ON property.block_id = block.id \
          AND property.property_key = 'document.display_name' \
        WHERE ?5 AND canvas.library_id = ?1 AND block.lifecycle = ?2 \
      ) ";
    let rows_sql = format!(
        "{catalog_cte} \
         SELECT id, kind, title, updated_at, location_revision, metadata_revision, location_label \
         FROM catalog WHERE (?6 = '' OR instr(lower(title), ?6) > 0) \
           AND (?7 IS NULL OR updated_at < ?7 \
             OR (updated_at = ?7 AND id > ?8)) \
         ORDER BY updated_at DESC, id LIMIT ?9"
    );
    let mut entries = connection
        .prepare(&rows_sql)?
        .query_map(
            params![
                library_id,
                lifecycle_value,
                include_pages,
                include_databases,
                include_canvases,
                query,
                after_updated_at,
                after_id,
                query_limit
            ],
            |row| {
                let id = row.get::<_, String>(0)?;
                let kind = match row.get::<_, String>(1)?.as_str() {
                    "page" => LibraryCatalogKind::Page,
                    "database" => LibraryCatalogKind::Database,
                    "canvas" => LibraryCatalogKind::Canvas,
                    _ => unreachable!("catalog CTE emits fixed kinds"),
                };
                let target = match kind {
                    LibraryCatalogKind::Page => LibraryPlacedResourceTarget::Page { page_id: id },
                    LibraryCatalogKind::Database => {
                        LibraryPlacedResourceTarget::Database { database_id: id }
                    }
                    LibraryCatalogKind::Canvas => {
                        LibraryPlacedResourceTarget::Canvas { canvas_id: id }
                    }
                };
                Ok(LibraryCatalogEntry {
                    target,
                    kind,
                    lifecycle,
                    title: row.get(2)?,
                    updated_at: row.get(3)?,
                    location_revision: row.get(4)?,
                    metadata_revision: row.get(5)?,
                    location_label: row.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            let last = entries
                .last()
                .ok_or_else(|| corrupt("Library catalog continuation has no entry"))?;
            cursor::mint(
                connection,
                library_id,
                &subject,
                cursor::KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Text {
                        value: last.updated_at.clone(),
                    }],
                    stable_id: catalog_id(last).to_owned(),
                },
            )
        })
        .transpose()?;
    let total_sql = format!(
        "{catalog_cte} \
         SELECT COUNT(*) FROM catalog \
         WHERE (?6 = '' OR instr(lower(title), ?6) > 0)"
    );
    let total = connection.query_row(
        &total_sql,
        params![
            library_id,
            lifecycle_value,
            include_pages,
            include_databases,
            include_canvases,
            query
        ],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(LibraryReadValue::Catalog {
        items: entries,
        next_cursor,
        has_more,
        total: count_to_u64(total)?,
    })
}

fn cursor_coordinate(
    connection: &Connection,
    requested_cursor: Option<&str>,
    library_id: &str,
    subject: &[String],
) -> Result<Option<cursor::KeysetCoordinate>, StoreError> {
    let Some(requested_cursor) = requested_cursor else {
        return Ok(None);
    };
    cursor::decode(connection, requested_cursor, library_id, subject).map(Some)
}

fn keyset_text_coordinate(
    coordinate: Option<&cursor::KeysetCoordinate>,
) -> Result<(Option<String>, Option<String>), StoreError> {
    let Some(coordinate) = coordinate else {
        return Ok((None, None));
    };
    let [cursor::KeysetValue::Text { value: sort_key }] = coordinate.values.as_slice() else {
        return Err(invalid("Library cursor coordinate is invalid"));
    };
    Ok((Some(sort_key.clone()), Some(coordinate.stable_id.clone())))
}

fn count_to_u64(count: i64) -> Result<u64, StoreError> {
    u64::try_from(count).map_err(|_| corrupt("Library collection count is invalid"))
}

fn read_limit(limit: Option<u32>) -> Result<usize, StoreError> {
    let limit = usize::try_from(limit.unwrap_or(DEFAULT_LIMIT as u32))
        .map_err(|_| invalid("Library read limit is invalid"))?;
    if (1..=MAX_LIMIT).contains(&limit) {
        return Ok(limit);
    }
    Err(invalid("Library read limit is out of range"))
}

fn matches_target(node: &LibraryNavigationNode, target: &LibraryRouteTarget) -> bool {
    match (node, target) {
        (
            LibraryNavigationNode::Page { page_id, .. },
            LibraryRouteTarget::Page { page_id: target },
        ) => page_id == target,
        (
            LibraryNavigationNode::Database { database_id, .. },
            LibraryRouteTarget::Database {
                database_id: target,
            },
        ) => database_id == target,
        (
            LibraryNavigationNode::Canvas { canvas_id, .. },
            LibraryRouteTarget::Canvas { canvas_id: target },
        ) => canvas_id == target,
        (
            LibraryNavigationNode::View { view_id, .. },
            LibraryRouteTarget::View { view_id: target },
        ) => view_id == target,
        _ => false,
    }
}

fn navigation_node_id(node: &LibraryNavigationNode) -> &str {
    match node {
        LibraryNavigationNode::Page { page_id, .. } => page_id,
        LibraryNavigationNode::Database { database_id, .. } => database_id,
        LibraryNavigationNode::Canvas { canvas_id, .. } => canvas_id,
        LibraryNavigationNode::View { view_id, .. } => view_id,
    }
}

fn catalog_id(entry: &LibraryCatalogEntry) -> &str {
    match &entry.target {
        LibraryPlacedResourceTarget::Page { page_id } => page_id,
        LibraryPlacedResourceTarget::Database { database_id } => database_id,
        LibraryPlacedResourceTarget::Canvas { canvas_id } => canvas_id,
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::valid_intrinsic_value;

    #[test]
    fn accepts_nullable_string_and_json_intrinsic_values() {
        assert!(valid_intrinsic_value("string", &json!(null)));
        assert!(valid_intrinsic_value("json", &json!(null)));
        assert!(valid_intrinsic_value("string", &json!("value")));
        assert!(valid_intrinsic_value("json", &json!({ "key": "value" })));
        assert!(!valid_intrinsic_value("string", &json!(42)));
        assert!(!valid_intrinsic_value("json", &json!("value")));
    }
}
