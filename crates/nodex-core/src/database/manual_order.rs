//! Complete View order and its bounded preparation lifecycle.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::fractional_rank::rank_run_between;
use crate::domain::ordered_position::LogicalPositionRun;
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const PREPARATION_SLICE: usize = 512;
const MAX_POSITION_PAGES: usize = 4_096;
const MAX_REPAIR_PEERS: usize = 128;

#[derive(Clone, Debug)]
pub(super) struct ReadyOrder {
    view_id: String,
    generation: i64,
    default_epoch: i64,
}

pub(super) fn ready(
    connection: &Connection,
    view_id: &str,
) -> Result<Option<ReadyOrder>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT active_generation, default_epoch FROM database_view_order_state
         WHERE view_id = ?1 AND phase = 'ready'",
            [view_id],
            |row| {
                Ok(ReadyOrder {
                    view_id: view_id.to_owned(),
                    generation: row.get(0)?,
                    default_epoch: row.get(1)?,
                })
            },
        )
        .optional()?)
}

/// Physical keyset coordinates expire when a generation is published or the
/// nullable default tail becomes explicitly positioned.
pub(super) fn keyset_identity(
    connection: &Connection,
    view_id: &str,
) -> Result<Option<(Option<i64>, i64)>, StoreError> {
    Ok(connection.query_row(
        "SELECT active_generation, default_epoch FROM database_view_order_state WHERE view_id = ?1",
        [view_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?)
}

fn require_current_order(connection: &Connection, order: &ReadyOrder) -> Result<(), StoreError> {
    let current = ready(connection, &order.view_id)?
        .ok_or_else(|| rank_preparation_required(&order.view_id))?;
    if current.generation != order.generation || current.default_epoch != order.default_epoch {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "View order observation is no longer current",
            true,
        ));
    }
    Ok(())
}

pub(super) fn require_ready(
    connection: &Connection,
    view_id: &str,
) -> Result<ReadyOrder, StoreError> {
    if let Some(order) = ready(connection, view_id)? {
        return Ok(order);
    }
    enqueue_initialization(connection, view_id)?;
    // Each call examines at most 32 candidates, including candidates that do
    // not produce a row. Large Views finish on the maintenance writer.
    for _ in 0..4 {
        if prepare_view_slice(connection, view_id, 32)? {
            return ready(connection, view_id)?.ok_or_else(|| rank_preparation_required(view_id));
        }
    }
    Err(rank_preparation_required(view_id))
}

pub(crate) fn finish_order_attempt<T>(
    connection: &mut Connection,
    result: Result<T, StoreError>,
) -> Result<T, StoreError> {
    let Err(error) = &result else {
        return result;
    };
    let Some(nodex_core_contracts::CoreErrorRecovery::DatabaseViewOrderPreparation { view_id }) =
        &error.recovery
    else {
        return result;
    };
    crate::infrastructure::sqlite::with_immediate_transaction(connection, |transaction| {
        enqueue_rebalance(transaction, view_id)
    })?;
    result
}

#[derive(Clone, Debug)]
struct OrderPosition {
    page_id: String,
    rank_key: String,
    revision: i64,
}

pub(super) fn position_revision(
    connection: &Connection,
    order: &ReadyOrder,
    page_id: &str,
) -> Result<i64, StoreError> {
    Ok(active_position(connection, order, page_id)?.revision)
}

/// Durable position evidence excludes physical generations and default freezing.
/// The caller authorizes the complete Page/View scope before capturing it.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetainedPositionWitness {
    pub(crate) view_id: String,
    pub(crate) semantic_reset_epoch: i64,
    pub(crate) revision: i64,
}

/// Includes inactive retained rows even after Page capability or membership
/// removal. An unpublished relevant View is preparation, never an empty order.
pub(crate) fn retained_position_witnesses(
    connection: &Connection,
    page_id: &str,
) -> Result<Vec<RetainedPositionWitness>, StoreError> {
    let unpublished = connection
        .query_row(
            "WITH relevant(view_id) AS (
           SELECT view_id FROM database_view_order_rows WHERE page_block_id = ?1
           UNION SELECT view.id FROM data_source_page_memberships membership
             JOIN pages page ON page.block_id = membership.page_block_id
               AND page.parent_kind = 'data_source' AND page.parent_id = membership.data_source_id
             JOIN database_views view ON view.data_source_id = membership.data_source_id
             WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL
         ) SELECT view.id FROM relevant JOIN database_views view ON view.id = relevant.view_id
           LEFT JOIN database_view_order_state state ON state.view_id = view.id
         WHERE view.lifecycle = 'active' AND state.active_generation IS NULL
           AND coalesce(state.phase, '') <> 'retired' ORDER BY view.id LIMIT 1",
            [page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(view_id) = unpublished {
        return Err(rank_preparation_required(&view_id));
    }
    Ok(connection
        .prepare(
            "SELECT position.view_id, state.semantic_reset_epoch, position.revision
         FROM database_view_order_rows position
         JOIN database_view_order_state state ON state.view_id = position.view_id
           AND state.active_generation = position.generation
         JOIN database_views view ON view.id = position.view_id AND view.lifecycle = 'active'
         WHERE position.page_block_id = ?1 ORDER BY position.view_id",
        )?
        .query_map([page_id], |row| {
            Ok(RetainedPositionWitness {
                view_id: row.get(0)?,
                semantic_reset_epoch: row.get(1)?,
                revision: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// A removed Page returns relative to surviving identities, never an expired
/// physical rank. Reset is semantic; generation publication is not.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PageOrderAnchors {
    pub(crate) semantic_reset_epoch: i64,
    pub(crate) previous_page_id: Option<String>,
    pub(crate) next_page_id: Option<String>,
}

pub(crate) fn capture_page_order_anchors(
    connection: &Connection,
    view_id: &str,
    page_id: &str,
) -> Result<PageOrderAnchors, StoreError> {
    let order = require_ready(connection, view_id)?;
    let position = active_position(connection, &order, page_id)?;
    let semantic_reset_epoch = connection.query_row(
        "SELECT semantic_reset_epoch FROM database_view_order_state WHERE view_id = ?1",
        [view_id],
        |row| row.get(0),
    )?;
    Ok(PageOrderAnchors {
        semantic_reset_epoch,
        previous_page_id: seek_position(
            connection,
            &order,
            Some(&position),
            true,
            OrderPopulation::Active,
        )?
        .map(|position| position.page_id),
        next_page_id: seek_position(
            connection,
            &order,
            Some(&position),
            false,
            OrderPopulation::Active,
        )?
        .map(|position| position.page_id),
    })
}

/// The caller restores membership first in the same transaction. Prefer the
/// surviving successor, then the predecessor; losing both anchors fails closed.
pub(crate) fn restore_page_order_anchors(
    connection: &Connection,
    view_id: &str,
    page_id: &str,
    anchors: &PageOrderAnchors,
    now: &str,
) -> Result<PositionedPage, StoreError> {
    let order = require_ready(connection, view_id)?;
    let reset_epoch: i64 = connection.query_row(
        "SELECT semantic_reset_epoch FROM database_view_order_state WHERE view_id = ?1",
        [view_id],
        |row| row.get(0),
    )?;
    if reset_epoch != anchors.semantic_reset_epoch {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "View order was reset after the Page moved",
            false,
        ));
    }
    let surviving = |id: Option<&str>| -> Result<Option<String>, StoreError> {
        let Some(id) = id else {
            return Ok(None);
        };
        match active_position(connection, &order, id) {
            Ok(position) => Ok(Some(position.page_id)),
            Err(error) if error.code == StoreErrorCode::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    };
    if let Some(next) = surviving(anchors.next_page_id.as_deref())? {
        return position_page(
            connection,
            view_id,
            page_id,
            ViewOrderPlacement::Before(&next),
            now,
        );
    }
    if let Some(previous) = surviving(anchors.previous_page_id.as_deref())? {
        return position_page(
            connection,
            view_id,
            page_id,
            ViewOrderPlacement::After(&previous),
            now,
        );
    }
    if anchors.previous_page_id.is_some() || anchors.next_page_id.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Page order anchors are no longer available",
            false,
        ));
    }
    position_page(connection, view_id, page_id, ViewOrderPlacement::End, now)
}

#[derive(Debug)]
pub(crate) struct PositionedPage {
    pub(crate) rank_key: String,
    pub(crate) revision: i64,
}

#[derive(Clone, Copy)]
pub(crate) enum ViewOrderPlacement<'a> {
    Start,
    End,
    Before(&'a str),
    After(&'a str),
}

/// Forget membership order through Page-indexed rows and legacy point lookups.
/// The caller owns the membership/lifecycle change in the same transaction.
pub(crate) fn forget_page(
    connection: &Connection,
    page_id: &str,
) -> Result<BTreeSet<String>, StoreError> {
    let mut views = connection
        .prepare("SELECT DISTINCT view_id FROM database_view_order_rows WHERE page_block_id = ?1")?
        .query_map([page_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let legacy_views = connection
        .prepare(
            "SELECT view.id FROM data_source_page_memberships membership
         JOIN database_views view ON view.data_source_id = membership.data_source_id
         WHERE membership.page_block_id = ?1",
        )?
        .query_map([page_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for view_id in legacy_views {
        check_request_interruption()?;
        if connection.execute(
            "DELETE FROM database_view_order_import_positions WHERE view_id = ?1 AND page_block_id = ?2",
            params![view_id, page_id],
        )? != 0 {
            views.insert(view_id);
        }
    }
    connection.execute(
        "DELETE FROM database_view_order_rows WHERE page_block_id = ?1",
        [page_id],
    )?;
    for view_id in &views {
        connection.execute(
            "UPDATE database_view_order_state SET order_revision = order_revision + 1 WHERE view_id = ?1",
            [view_id],
        )?;
    }
    Ok(views)
}

pub(crate) fn position_page(
    connection: &Connection,
    view_id: &str,
    page_id: &str,
    placement: ViewOrderPlacement<'_>,
    now: &str,
) -> Result<PositionedPage, StoreError> {
    position_page_in_population(
        connection,
        view_id,
        page_id,
        placement,
        now,
        OrderPopulation::Active,
    )
}

pub(crate) fn restore_page_position(
    connection: &Connection,
    view_id: &str,
    page_id: &str,
    placement: ViewOrderPlacement<'_>,
    now: &str,
) -> Result<PositionedPage, StoreError> {
    position_page_in_population(
        connection,
        view_id,
        page_id,
        placement,
        now,
        OrderPopulation::Retained,
    )
}

fn position_page_in_population(
    connection: &Connection,
    view_id: &str,
    page_id: &str,
    placement: ViewOrderPlacement<'_>,
    now: &str,
    population: OrderPopulation,
) -> Result<PositionedPage, StoreError> {
    join_page(connection, page_id, now)?;
    let order = require_ready(connection, view_id)?;
    let before_page_id = match placement {
        ViewOrderPlacement::Start => seek_unselected(
            connection,
            &order,
            None,
            false,
            &HashSet::from([page_id]),
            population,
        )?
        .map(|position| position.page_id),
        ViewOrderPlacement::End => None,
        ViewOrderPlacement::Before(page_id) => Some(page_id.to_owned()),
        ViewOrderPlacement::After(anchor) => {
            let anchor = position_in_population(connection, &order, anchor, population)?;
            seek_unselected(
                connection,
                &order,
                Some(&anchor),
                false,
                &HashSet::from([page_id]),
                population,
            )?
            .map(|position| position.page_id)
        }
    };
    position_runs_in_population(
        connection,
        &order,
        &[LogicalPositionRun {
            page_ids: vec![page_id.to_owned()],
            before_page_id,
        }],
        false,
        now,
        population,
    )?
    .remove(page_id)
    .ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "Page placement omitted its result",
            false,
        )
    })
}

fn decode_position(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrderPosition> {
    Ok(OrderPosition {
        page_id: row.get(0)?,
        rank_key: row.get(1)?,
        revision: row.get(2)?,
    })
}

fn active_position(
    connection: &Connection,
    order: &ReadyOrder,
    page_id: &str,
) -> Result<OrderPosition, StoreError> {
    position_in_population(connection, order, page_id, OrderPopulation::Active)
}

fn position_in_population(
    connection: &Connection,
    order: &ReadyOrder,
    page_id: &str,
    population: OrderPopulation,
) -> Result<OrderPosition, StoreError> {
    check_request_interruption()?;
    connection
        .query_row(
            &format!(
                "SELECT page_block_id, rank_key,
           CASE WHEN default_epoch = ?3 THEN 0 ELSE max(revision, 1) END
         FROM database_view_order_rows WHERE view_id = ?1 AND generation = ?2
           AND page_block_id = ?4 {}",
                population.predicate()
            ),
            params![
                order.view_id,
                order.generation,
                order.default_epoch,
                page_id
            ],
            decode_position,
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Page is not in the active View order",
                false,
            )
        })
}

#[derive(Clone, Copy)]
enum OrderPopulation {
    Active,
    ActiveRoots,
    Retained,
}

impl OrderPopulation {
    fn predicate(self) -> &'static str {
        match self {
            Self::Active => "AND is_active = 1",
            Self::ActiveRoots => "AND is_active = 1 AND is_task_root = 1",
            Self::Retained => "",
        }
    }
}

fn seek_position(
    connection: &Connection,
    order: &ReadyOrder,
    cursor: Option<&OrderPosition>,
    descending: bool,
    population: OrderPopulation,
) -> Result<Option<OrderPosition>, StoreError> {
    check_request_interruption()?;
    let (direction, comparison) = if descending {
        ("DESC", "<")
    } else {
        ("ASC", ">")
    };
    let active = population.predicate();
    let prefix = format!(
        "SELECT page_block_id, rank_key,
        CASE WHEN default_epoch = ?3 THEN 0 ELSE max(revision, 1) END
        FROM database_view_order_rows WHERE view_id = ?1 AND generation = ?2 {active}"
    );
    let order_by = format!("ORDER BY rank_key {direction}, page_block_id {direction} LIMIT 1");
    let Some(cursor) = cursor else {
        return Ok(connection
            .query_row(
                &format!("{prefix} {order_by}"),
                params![order.view_id, order.generation, order.default_epoch],
                decode_position,
            )
            .optional()?);
    };
    Ok(connection
        .query_row(
            &format!("{prefix} AND (rank_key, page_block_id) {comparison} (?4, ?5) {order_by}"),
            params![
                order.view_id,
                order.generation,
                order.default_epoch,
                cursor.rank_key,
                cursor.page_id
            ],
            decode_position,
        )
        .optional()?)
}

/// Observe selected identities and one immediate neighbor per Page. Sorting is
/// limited to the selection; neither a full View nor an exclusion scan is read.
pub(super) fn capture_runs(
    connection: &Connection,
    order: &ReadyOrder,
    selected: &HashSet<&str>,
    descending: bool,
) -> Result<Vec<LogicalPositionRun>, StoreError> {
    capture_runs_in_population(
        connection,
        order,
        selected,
        descending,
        OrderPopulation::Active,
    )
}

/// List root history observes canonical Task Parent roots, not all View rows
/// or the temporary depth-zero presentation of a child with an archived parent.
pub(super) fn capture_root_runs(
    connection: &Connection,
    order: &ReadyOrder,
    selected: &HashSet<&str>,
    descending: bool,
) -> Result<Vec<LogicalPositionRun>, StoreError> {
    capture_runs_in_population(
        connection,
        order,
        selected,
        descending,
        OrderPopulation::ActiveRoots,
    )
}

fn capture_runs_in_population(
    connection: &Connection,
    order: &ReadyOrder,
    selected: &HashSet<&str>,
    descending: bool,
    population: OrderPopulation,
) -> Result<Vec<LogicalPositionRun>, StoreError> {
    require_current_order(connection, order)?;
    if selected.len() > MAX_POSITION_PAGES {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "View selection exceeds its bound",
            false,
        ));
    }
    let mut positions = selected
        .iter()
        .map(|page_id| position_in_population(connection, order, page_id, population))
        .collect::<Result<Vec<_>, _>>()?;
    positions.sort_unstable_by(|left, right| {
        (&left.rank_key, &left.page_id).cmp(&(&right.rank_key, &right.page_id))
    });
    if descending {
        positions.reverse();
    }
    let mut runs = Vec::new();
    let mut page_ids = Vec::new();
    for position in &positions {
        page_ids.push(position.page_id.clone());
        let next = seek_position(connection, order, Some(position), descending, population)?;
        if next
            .as_ref()
            .is_some_and(|next| selected.contains(next.page_id.as_str()))
        {
            continue;
        }
        runs.push(LogicalPositionRun {
            page_ids: std::mem::take(&mut page_ids),
            before_page_id: next.map(|next| next.page_id),
        });
    }
    Ok(runs)
}

fn seek_unselected(
    connection: &Connection,
    order: &ReadyOrder,
    anchor: Option<&OrderPosition>,
    descending: bool,
    selected: &HashSet<&str>,
    population: OrderPopulation,
) -> Result<Option<OrderPosition>, StoreError> {
    let mut cursor = seek_position(connection, order, anchor, descending, population)?;
    while cursor
        .as_ref()
        .is_some_and(|position| selected.contains(position.page_id.as_str()))
    {
        cursor = seek_position(connection, order, cursor.as_ref(), descending, population)?;
    }
    Ok(cursor)
}

/// Plans every logical run against the same selected-set exclusion, then writes
/// the complete gesture in its caller's transaction. Distinct unselected anchors
/// partition the skipped selected chains: neighbor work is O(k + runs), not
/// one repeated View scan per run.
pub(super) fn position_runs(
    connection: &Connection,
    order: &ReadyOrder,
    runs: &[LogicalPositionRun],
    descending: bool,
    now: &str,
) -> Result<BTreeMap<String, PositionedPage>, StoreError> {
    position_runs_in_population(
        connection,
        order,
        runs,
        descending,
        now,
        OrderPopulation::Active,
    )
}

fn position_runs_in_population(
    connection: &Connection,
    order: &ReadyOrder,
    runs: &[LogicalPositionRun],
    descending: bool,
    now: &str,
    population: OrderPopulation,
) -> Result<BTreeMap<String, PositionedPage>, StoreError> {
    require_current_order(connection, order)?;
    let selected = runs
        .iter()
        .flat_map(|run| run.page_ids.iter().map(String::as_str))
        .collect::<HashSet<_>>();
    let count = runs.iter().map(|run| run.page_ids.len()).sum::<usize>();
    let anchors = runs
        .iter()
        .map(|run| run.before_page_id.as_deref())
        .collect::<HashSet<_>>();
    if count == 0
        || count > MAX_POSITION_PAGES
        || count != selected.len()
        || runs.iter().any(|run| run.page_ids.is_empty())
        || anchors.len() != runs.len()
        || anchors
            .iter()
            .flatten()
            .any(|anchor| selected.contains(anchor))
    {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "View runs require unique Pages and distinct outside anchors within the selection bound",
            false,
        ));
    }
    let current = selected
        .iter()
        .map(|page_id| {
            Ok((
                (*page_id).to_owned(),
                position_in_population(connection, order, page_id, population)?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
    let mut gaps = Vec::new();
    for run in runs {
        let anchor = run
            .before_page_id
            .as_deref()
            .map(|page_id| position_in_population(connection, order, page_id, population))
            .transpose()?;
        let neighbor = seek_unselected(
            connection,
            order,
            anchor.as_ref(),
            !descending,
            &selected,
            population,
        )?;
        let (left, right) = if descending {
            (anchor, neighbor)
        } else {
            (neighbor, anchor)
        };
        let mut page_ids = run.page_ids.clone();
        if descending {
            page_ids.reverse();
        }
        gaps.push(RankedRun {
            page_ids,
            left,
            right,
        });
    }
    let plan = plan_rank_space(connection, order, &gaps, &selected)?;
    let writes = plan
        .moved
        .into_iter()
        .map(|(page_id, rank_key)| {
            let revision = current[&page_id].revision.checked_add(1).ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::ResourceExhausted,
                    "View position revision is exhausted",
                    false,
                )
            })?;
            Ok((page_id, (rank_key, revision)))
        })
        .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
    freeze_defaults(connection, order)?;
    write_sibling_ranks(connection, order, &plan.siblings)?;
    let mut put = connection.prepare(&format!(
        "UPDATE database_view_order_rows SET rank_key = ?4, default_epoch = NULL, revision = ?5, updated_at = ?6
         WHERE view_id = ?1 AND generation = ?2 AND page_block_id = ?3 {}", population.predicate()
    ))?;
    let mut revisions = BTreeMap::new();
    for (page_id, (rank_key, revision)) in writes {
        check_request_interruption()?;
        let changed = put.execute(params![
            order.view_id,
            order.generation,
            page_id,
            rank_key,
            revision,
            now
        ])?;
        if changed != 1 {
            return Err(StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "View position disappeared before its planned write",
                false,
            ));
        }
        revisions.insert(page_id, PositionedPage { rank_key, revision });
    }
    Ok(revisions)
}

struct RankedRun {
    page_ids: Vec<String>,
    left: Option<OrderPosition>,
    right: Option<OrderPosition>,
}

struct OrderRankPlan {
    moved: BTreeMap<String, String>,
    siblings: BTreeMap<String, String>,
}

fn write_sibling_ranks(
    connection: &Connection,
    order: &ReadyOrder,
    siblings: &BTreeMap<String, String>,
) -> Result<(), StoreError> {
    let mut put = connection.prepare(
        "UPDATE database_view_order_rows SET rank_key = ?4 WHERE view_id = ?1 AND generation = ?2 AND page_block_id = ?3",
    )?;
    for (page_id, rank_key) in siblings {
        check_request_interruption()?;
        if put.execute(params![order.view_id, order.generation, page_id, rank_key])? != 1 {
            return Err(StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "Retained View position disappeared during rank repair",
                false,
            ));
        }
    }
    Ok(())
}

fn rank_at<'a>(
    position: Option<&'a OrderPosition>,
    overrides: &'a BTreeMap<String, String>,
) -> Option<&'a str> {
    position.map(|position| {
        overrides
            .get(&position.page_id)
            .unwrap_or(&position.rank_key)
            .as_str()
    })
}

fn allocate_gaps(
    gaps: &[RankedRun],
    overrides: &BTreeMap<String, String>,
) -> Result<(BTreeMap<String, String>, BTreeSet<usize>), StoreError> {
    let mut moved = BTreeMap::new();
    let mut exhausted = BTreeSet::new();
    for (index, gap) in gaps.iter().enumerate() {
        check_request_interruption()?;
        let Some(ranks) = allocate_run(
            rank_at(gap.left.as_ref(), overrides),
            rank_at(gap.right.as_ref(), overrides),
            gap.page_ids.len(),
        ) else {
            exhausted.insert(index);
            continue;
        };
        moved.extend(gap.page_ids.iter().cloned().zip(ranks));
    }
    Ok((moved, exhausted))
}

/// Repair a bounded union of retained neighbors. Candidate layouts reserve
/// space for every moved run inside the region, and keep outside ranks fixed.
/// Accept only strict progress that preserves every already-allocatable gap.
fn plan_rank_space(
    connection: &Connection,
    order: &ReadyOrder,
    gaps: &[RankedRun],
    selected: &HashSet<&str>,
) -> Result<OrderRankPlan, StoreError> {
    let mut siblings = BTreeMap::new();
    loop {
        let (moved, exhausted) = allocate_gaps(gaps, &siblings)?;
        let Some(index) = exhausted.first().copied() else {
            return Ok(OrderRankPlan { moved, siblings });
        };
        let gap = &gaps[index];
        let center = gap
            .right
            .as_ref()
            .or(gap.left.as_ref())
            .ok_or_else(|| rank_preparation_required(&order.view_id))?;
        let mut accepted = None;
        for radius in [4, 8, 16, 32, MAX_REPAIR_PEERS / 2] {
            let neighborhood = read_neighborhood(connection, order, center, selected, radius)?;
            let Some(candidate) = repair_candidate(&neighborhood, gaps, &siblings)? else {
                continue;
            };
            let (_, remaining) = allocate_gaps(gaps, &candidate)?;
            if !remaining.contains(&index) && remaining.is_subset(&exhausted) {
                accepted = Some(candidate);
                break;
            }
        }
        siblings = accepted.ok_or_else(|| rank_preparation_required(&order.view_id))?;
    }
}

fn rank_preparation_required(view_id: &str) -> StoreError {
    StoreError::new(
        StoreErrorCode::MaintenanceInProgress,
        "View order is preparing; retry after preparation completes",
        true,
    )
    .with_recovery(
        nodex_core_contracts::CoreErrorRecovery::DatabaseViewOrderPreparation {
            view_id: view_id.to_owned(),
        },
    )
}

struct Neighborhood {
    peers: Vec<OrderPosition>,
    left: Option<OrderPosition>,
    right: Option<OrderPosition>,
}

fn read_neighborhood(
    connection: &Connection,
    order: &ReadyOrder,
    center: &OrderPosition,
    selected: &HashSet<&str>,
    radius: usize,
) -> Result<Neighborhood, StoreError> {
    let (mut left_peers, left) =
        read_neighborhood_side(connection, order, center, selected, radius - 1, true)?;
    let (right_peers, right) =
        read_neighborhood_side(connection, order, center, selected, radius, false)?;
    left_peers.reverse();
    left_peers.push(center.clone());
    left_peers.extend(right_peers);
    Ok(Neighborhood {
        peers: left_peers,
        left,
        right,
    })
}

fn read_neighborhood_side(
    connection: &Connection,
    order: &ReadyOrder,
    center: &OrderPosition,
    selected: &HashSet<&str>,
    count: usize,
    descending: bool,
) -> Result<(Vec<OrderPosition>, Option<OrderPosition>), StoreError> {
    let mut peers = Vec::new();
    let mut cursor = center.clone();
    for index in 0..=count {
        let next = seek_unselected(
            connection,
            order,
            Some(&cursor),
            descending,
            selected,
            OrderPopulation::Retained,
        )?;
        if index == count || next.is_none() {
            return Ok((peers, next));
        }
        let next = next.expect("checked neighbor");
        cursor = next.clone();
        peers.push(next);
    }
    unreachable!()
}

fn repair_candidate(
    neighborhood: &Neighborhood,
    gaps: &[RankedRun],
    previous: &BTreeMap<String, String>,
) -> Result<Option<BTreeMap<String, String>>, StoreError> {
    check_request_interruption()?;
    let by_right = gaps
        .iter()
        .map(|gap| {
            (
                gap.right.as_ref().map(|position| position.page_id.as_str()),
                gap,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut sequence = Vec::new();
    let peers = neighborhood
        .peers
        .iter()
        .map(|position| position.page_id.as_str())
        .collect::<HashSet<_>>();
    for peer in &neighborhood.peers {
        if let Some(gap) = by_right.get(&Some(peer.page_id.as_str())) {
            sequence.extend(gap.page_ids.iter().map(String::as_str));
        }
        sequence.push(peer.page_id.as_str());
    }
    if neighborhood.right.is_none()
        && let Some(gap) = by_right.get(&None)
    {
        sequence.extend(gap.page_ids.iter().map(String::as_str));
    }
    let Some(ranks) = allocate_run(
        rank_at(neighborhood.left.as_ref(), previous),
        rank_at(neighborhood.right.as_ref(), previous),
        sequence.len(),
    ) else {
        return Ok(None);
    };
    let mut candidate = previous.clone();
    candidate.extend(
        sequence
            .into_iter()
            .zip(ranks)
            .filter_map(|(page_id, rank_key)| {
                peers
                    .contains(page_id)
                    .then(|| (page_id.to_owned(), rank_key))
            }),
    );
    if candidate.len() > MAX_REPAIR_PEERS {
        return Ok(None);
    }
    Ok(Some(candidate))
}

pub(super) fn enqueue_initialization(
    connection: &Connection,
    view_id: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO database_view_order_state(view_id, pending_generation, phase)
         VALUES (?1, 1, 'explicit') ON CONFLICT(view_id) DO NOTHING",
        [view_id],
    )?;
    Ok(())
}

pub(super) fn reset_view(connection: &Connection, view_id: &str) -> Result<(), StoreError> {
    enqueue_initialization(connection, view_id)?;
    let clock: i64 = connection.query_row(
        "SELECT generation_clock FROM database_view_order_state WHERE view_id = ?1",
        [view_id],
        |row| row.get(0),
    )?;
    let generation = clock.checked_add(1).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "View order generation is exhausted",
            false,
        )
    })?;
    let reset_epoch: i64 = connection.query_row(
        "SELECT semantic_reset_epoch FROM database_view_order_state WHERE view_id = ?1",
        [view_id],
        |row| row.get(0),
    )?;
    let reset_epoch = reset_epoch.checked_add(1).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "View semantic reset epoch is exhausted",
            false,
        )
    })?;
    retire_current_generations(connection, view_id)?;
    connection.execute(
        "UPDATE database_view_order_state SET active_generation = NULL, pending_generation = ?2,
           generation_clock = ?2, semantic_reset_epoch = ?3, import_enabled = 0, phase = 'implicit', default_epoch = 1,
           order_revision = order_revision + 1, source_revision = order_revision + 1,
           cursor_rank = '', cursor_page_id = '', next_ordinal = 0 WHERE view_id = ?1",
        params![view_id, generation, reset_epoch],
    )?;
    Ok(())
}

fn retire_current_generations(connection: &Connection, view_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO database_view_order_retired_generations(view_id, generation)
         SELECT view_id, active_generation FROM database_view_order_state WHERE view_id = ?1 AND active_generation IS NOT NULL
         UNION SELECT view_id, pending_generation FROM database_view_order_state WHERE view_id = ?1 AND pending_generation IS NOT NULL
         UNION SELECT view_id, 0 FROM database_view_order_state WHERE view_id = ?1 AND import_enabled = 1
         ON CONFLICT DO NOTHING", [view_id],
    )?;
    Ok(())
}

pub(super) fn retire_view(connection: &Connection, view_id: &str) -> Result<(), StoreError> {
    retire_current_generations(connection, view_id)?;
    connection.execute(
        "UPDATE database_view_order_state SET active_generation = NULL, pending_generation = NULL,
           import_enabled = 0, phase = 'retired', order_revision = order_revision + 1,
           source_revision = order_revision + 1, cursor_rank = '', cursor_page_id = '', next_ordinal = 0
         WHERE view_id = ?1", [view_id],
    )?;
    Ok(())
}

pub(super) fn enqueue_rebalance(connection: &Connection, view_id: &str) -> Result<(), StoreError> {
    enqueue_initialization(connection, view_id)?;
    let exhausted = connection.query_row(
        "SELECT phase = 'ready' AND generation_clock = 9223372036854775807
         FROM database_view_order_state WHERE view_id = ?1",
        [view_id],
        |row| row.get::<_, bool>(0),
    )?;
    if exhausted {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "View order generation is exhausted",
            false,
        ));
    }
    connection.execute(
        "UPDATE database_view_order_state SET pending_generation = generation_clock + 1,
           generation_clock = generation_clock + 1,
           phase = 'rebalance', cursor_rank = '', cursor_page_id = '', next_ordinal = 0,
           source_revision = order_revision
         WHERE view_id = ?1 AND phase = 'ready' AND generation_clock < 9223372036854775807",
        [view_id],
    )?;
    Ok(())
}

/// One maintenance admission prepares one View slice and reclaims one retired
/// slice. Both candidate bounds are independent of Source and Profile size.
pub(super) fn maintain_order_slice(connection: &Connection) -> Result<bool, StoreError> {
    let view_id = connection
        .query_row(
            "SELECT view_id FROM database_view_order_state
         WHERE pending_generation IS NOT NULL ORDER BY view_id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(view_id) = &view_id {
        prepare_view_slice(connection, view_id, PREPARATION_SLICE)?;
    }
    let cleanup = cleanup_order_slice(connection, PREPARATION_SLICE)?;
    Ok(view_id.is_some() || cleanup)
}

struct Preparation {
    source_id: String,
    generation: i64,
    default_epoch: i64,
    phase: String,
    cursor_rank: String,
    cursor_page_id: String,
    ordinal: i64,
    source_revision: i64,
    current_revision: i64,
    import_enabled: bool,
    active_generation: Option<i64>,
}

pub(super) fn prepare_view_slice(
    connection: &Connection,
    view_id: &str,
    limit: usize,
) -> Result<bool, StoreError> {
    if limit == 0 || limit > PREPARATION_SLICE {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "View preparation slice is outside its bound",
            false,
        ));
    }
    let Some(mut work) = connection.query_row(
        "SELECT view.data_source_id, state.pending_generation, state.default_epoch,
           state.phase, state.cursor_rank, state.cursor_page_id, state.next_ordinal, state.source_revision,
           state.active_generation, state.order_revision, state.import_enabled
         FROM database_view_order_state state JOIN database_views view ON view.id = state.view_id
         WHERE state.view_id = ?1 AND state.pending_generation IS NOT NULL",
        [view_id],
        |row| Ok(Preparation {
            source_id: row.get(0)?, generation: row.get(1)?, default_epoch: row.get(2)?,
            phase: row.get(3)?, cursor_rank: row.get(4)?, cursor_page_id: row.get(5)?,
            ordinal: row.get(6)?, source_revision: row.get(7)?, active_generation: row.get(8)?,
            current_revision: row.get(9)?,
            import_enabled: row.get(10)?,
        }),
    ).optional()? else {
        return Ok(true);
    };
    if work.current_revision != work.source_revision {
        restart_preparation(connection, view_id, &work)?;
        return Ok(false);
    }
    if work.phase == "rebalance" {
        return rebalance_slice(connection, view_id, &mut work, limit);
    }
    if work.phase == "explicit" {
        import_explicit_slice(connection, view_id, &mut work, limit)?;
        return Ok(false);
    }
    if work.phase != "implicit" {
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "View preparation phase is unavailable",
            false,
        ));
    }
    let candidates = connection
        .prepare(
            "SELECT page_block_id, created_at FROM data_source_page_memberships
         WHERE data_source_id = ?1 AND removed_at IS NULL AND page_block_id > ?2
         ORDER BY page_block_id LIMIT ?3",
        )?
        .query_map(
            params![work.source_id, work.cursor_page_id, limit as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if candidates.is_empty() {
        publish_preparation(connection, view_id, &work)?;
        return Ok(true);
    }
    for (page_id, created_at) in candidates {
        let explicit = work.import_enabled && connection.query_row(
            "SELECT 1 FROM database_view_order_import_positions WHERE view_id = ?1 AND page_block_id = ?2",
            params![view_id, page_id], |_| Ok(()),
        ).optional()?.is_some();
        if !explicit {
            insert_prepared_row(
                connection,
                view_id,
                &mut work,
                &page_id,
                Some(created_at.as_str()),
                None,
            )?;
        }
        work.cursor_page_id = page_id;
    }
    save_cursor(connection, view_id, &work)?;
    Ok(false)
}

fn restart_preparation(
    connection: &Connection,
    view_id: &str,
    work: &Preparation,
) -> Result<(), StoreError> {
    let generation = work.generation.checked_add(1).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "View order generation is exhausted",
            false,
        )
    })?;
    connection.execute(
        "INSERT INTO database_view_order_retired_generations(view_id, generation) VALUES (?1, ?2)
         ON CONFLICT DO NOTHING",
        params![view_id, work.generation],
    )?;
    connection.execute(
        "UPDATE database_view_order_state SET pending_generation = ?2, generation_clock = ?2,
           phase = CASE WHEN active_generation IS NOT NULL THEN 'rebalance'
             WHEN import_enabled = 1 THEN 'explicit' ELSE 'implicit' END,
           cursor_rank = '', cursor_page_id = '', next_ordinal = 0, source_revision = order_revision
         WHERE view_id = ?1",
        params![view_id, generation],
    )?;
    Ok(())
}

/// Retired rows are their own durable deletion cursor. The caller commits each
/// slice independently, so generation publication never owns a full cleanup.
pub(super) fn cleanup_order_slice(
    connection: &Connection,
    limit: usize,
) -> Result<bool, StoreError> {
    if limit == 0 || limit > PREPARATION_SLICE {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "View cleanup slice is outside its bound",
            false,
        ));
    }
    check_request_interruption()?;
    let Some((view_id, generation)) = connection.query_row(
        "SELECT view_id, generation FROM database_view_order_retired_generations ORDER BY view_id, generation LIMIT 1",
        [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    ).optional()? else { return Ok(false); };
    let in_use = connection
        .query_row(
            "SELECT 1 FROM database_view_order_state WHERE view_id = ?1
         AND (active_generation = ?2 OR pending_generation = ?2)",
            params![view_id, generation],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if in_use {
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "View cleanup targets a live generation",
            false,
        ));
    }
    let (table, predicate) = if generation == 0 {
        (
            "database_view_order_import_positions",
            "view_id = ?1 AND ?2 = 0",
        )
    } else {
        (
            "database_view_order_rows",
            "view_id = ?1 AND generation = ?2",
        )
    };
    connection.execute(
        &format!(
            "DELETE FROM {table} WHERE {predicate} AND page_block_id IN
         (SELECT page_block_id FROM {table} WHERE {predicate} ORDER BY page_block_id LIMIT ?3)"
        ),
        params![view_id, generation, limit as i64],
    )?;
    let remaining = connection.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {predicate})"),
        params![view_id, generation],
        |row| row.get::<_, bool>(0),
    )?;
    if !remaining {
        connection.execute(
            "DELETE FROM database_view_order_retired_generations WHERE view_id = ?1 AND generation = ?2",
            params![view_id, generation],
        )?;
    }
    Ok(true)
}

fn publish_preparation(
    connection: &Connection,
    view_id: &str,
    work: &Preparation,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE database_view_order_state SET active_generation = pending_generation,
           pending_generation = NULL, import_enabled = 0, phase = 'ready', cursor_rank = '', cursor_page_id = ''
         WHERE view_id = ?1 AND pending_generation = ?2 AND order_revision = ?3",
        params![view_id, work.generation, work.source_revision],
    )?;
    if changed != 1 {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "View order changed during preparation",
            true,
        ));
    }
    connection.execute(
        "INSERT INTO database_view_order_retired_generations(view_id, generation) VALUES (?1, ?2)
         ON CONFLICT DO NOTHING",
        params![view_id, work.active_generation.unwrap_or(0)],
    )?;
    Ok(())
}

fn rebalance_slice(
    connection: &Connection,
    view_id: &str,
    work: &mut Preparation,
    limit: usize,
) -> Result<bool, StoreError> {
    let source_generation = work.active_generation.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "View rebalance has no published generation",
            false,
        )
    })?;
    let candidates = connection.prepare(
        "SELECT page_block_id, rank_key, default_epoch, revision, is_active, created_at, updated_at
         FROM database_view_order_rows WHERE view_id = ?1 AND generation = ?2
           AND (rank_key, page_block_id) > (?3, ?4) ORDER BY rank_key, page_block_id LIMIT ?5",
    )?.query_map(params![view_id, source_generation, work.cursor_rank, work.cursor_page_id, limit as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?,
            row.get::<_, i64>(3)?, row.get::<_, bool>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    if candidates.is_empty() {
        publish_preparation(connection, view_id, work)?;
        return Ok(true);
    }
    for (page_id, rank_key, default_epoch, revision, is_active, created_at, updated_at) in
        candidates
    {
        append_prepared_position(
            connection,
            view_id,
            work,
            PreparedPosition {
                page_id: &page_id,
                default_epoch,
                revision,
                is_active,
                created_at: &created_at,
                updated_at: &updated_at,
            },
        )?;
        work.cursor_rank = rank_key;
        work.cursor_page_id = page_id;
    }
    save_cursor(connection, view_id, work)?;
    Ok(false)
}

fn import_explicit_slice(
    connection: &Connection,
    view_id: &str,
    work: &mut Preparation,
    limit: usize,
) -> Result<(), StoreError> {
    let candidates = connection
        .prepare(
            "SELECT page_block_id, rank_key, revision, created_at, updated_at
         FROM database_view_order_import_positions
         WHERE view_id = ?1 AND (rank_key, page_block_id) > (?2, ?3)
         ORDER BY rank_key, page_block_id LIMIT ?4",
        )?
        .query_map(
            params![view_id, work.cursor_rank, work.cursor_page_id, limit as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if candidates.is_empty() {
        work.phase = "implicit".to_owned();
        work.cursor_rank.clear();
        work.cursor_page_id.clear();
        return save_cursor(connection, view_id, work);
    }
    for (page_id, rank_key, revision, created_at, updated_at) in candidates {
        insert_prepared_row(
            connection,
            view_id,
            work,
            &page_id,
            None,
            Some((revision, &created_at, &updated_at)),
        )?;
        work.cursor_rank = rank_key;
        work.cursor_page_id = page_id;
    }
    save_cursor(connection, view_id, work)
}

fn insert_prepared_row(
    connection: &Connection,
    view_id: &str,
    work: &mut Preparation,
    page_id: &str,
    implicit_created_at: Option<&str>,
    explicit: Option<(i64, &str, &str)>,
) -> Result<(), StoreError> {
    let is_active = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM data_source_page_memberships membership
         JOIN pages page ON page.block_id = membership.page_block_id
           AND page.parent_kind = 'data_source' AND page.parent_id = membership.data_source_id
         JOIN blocks block ON block.id = page.block_id AND block.lifecycle = 'active'
         WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 AND membership.removed_at IS NULL)",
        params![work.source_id, page_id], |row| row.get::<_, bool>(0),
    )?;
    let (revision, created_at, updated_at) = explicit.unwrap_or_else(|| {
        let now = implicit_created_at.unwrap_or("");
        (0, now, now)
    });
    append_prepared_position(
        connection,
        view_id,
        work,
        PreparedPosition {
            page_id,
            default_epoch: implicit_created_at.map(|_| work.default_epoch),
            revision,
            is_active,
            created_at,
            updated_at,
        },
    )
}

struct PreparedPosition<'a> {
    page_id: &'a str,
    default_epoch: Option<i64>,
    revision: i64,
    is_active: bool,
    created_at: &'a str,
    updated_at: &'a str,
}

fn is_task_root(connection: &Connection, view_id: &str, page_id: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT coalesce((SELECT is_task_root FROM database_view_order_member_activity
         WHERE view_id = ?1 AND page_block_id = ?2), 1)",
        params![view_id, page_id],
        |row| row.get(0),
    )?)
}

fn append_prepared_position(
    connection: &Connection,
    view_id: &str,
    work: &mut Preparation,
    position: PreparedPosition<'_>,
) -> Result<(), StoreError> {
    work.ordinal = work.ordinal.checked_add(1).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "View order exceeds its ordinal space",
            false,
        )
    })?;
    let rank_key = format!("{:032x}", (work.ordinal as u128) << 64);
    connection.execute(
        "INSERT INTO database_view_order_rows(view_id, generation, page_block_id, rank_key,
           default_epoch, revision, is_active, created_at, updated_at, is_task_root)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            view_id,
            work.generation,
            position.page_id,
            rank_key,
            position.default_epoch,
            position.revision,
            position.is_active,
            position.created_at,
            position.updated_at,
            is_task_root(connection, view_id, position.page_id)?
        ],
    )?;
    Ok(())
}

fn save_cursor(
    connection: &Connection,
    view_id: &str,
    work: &Preparation,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE database_view_order_state SET phase = ?1, cursor_rank = ?2, cursor_page_id = ?3, next_ordinal = ?4
         WHERE view_id = ?5 AND pending_generation = ?6",
        params![work.phase, work.cursor_rank, work.cursor_page_id, work.ordinal, view_id, work.generation],
    )?;
    Ok(())
}

pub(super) fn freeze_defaults(
    connection: &Connection,
    order: &ReadyOrder,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE database_view_order_state SET default_epoch = default_epoch + 1, order_revision = order_revision + 1
         WHERE view_id = ?1 AND active_generation = ?2 AND default_epoch = ?3 AND phase = 'ready'
           AND default_epoch < 9223372036854775807",
        params![order.view_id, order.generation, order.default_epoch],
    )?;
    if changed != 1 {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "View order changed before positioning",
            true,
        ));
    }
    Ok(())
}

/// The caller owns the surrounding membership/lifecycle transaction.
/// Default Pages join by identity inside the current physical suffix, not by
/// repeatedly probing the sparse nullable-position projection.
pub(super) fn insert_default(
    connection: &Connection,
    order: &ReadyOrder,
    page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    require_current_order(connection, order)?;
    let is_active = connection
        .query_row(
            "SELECT block.lifecycle = 'active' FROM database_views view
         JOIN data_source_page_memberships membership
           ON membership.data_source_id = view.data_source_id AND membership.page_block_id = ?2
           AND membership.removed_at IS NULL
         JOIN pages page ON page.block_id = membership.page_block_id
           AND page.parent_kind = 'data_source' AND page.parent_id = view.data_source_id
         JOIN blocks block ON block.id = page.block_id
         WHERE view.id = ?1 AND view.lifecycle = 'active'",
            params![order.view_id, page_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Page has no canonical View membership",
                false,
            )
        })?;
    let existing = connection.query_row(
        "SELECT 1 FROM database_view_order_rows WHERE view_id = ?1 AND generation = ?2 AND page_block_id = ?3",
        params![order.view_id, order.generation, page_id], |_| Ok(()),
    ).optional()?;
    if existing.is_some() {
        let changed = connection.execute(
            "UPDATE database_view_order_rows SET is_active = ?4, is_task_root = ?5
             WHERE view_id = ?1 AND generation = ?2 AND page_block_id = ?3
               AND (is_active <> ?4 OR is_task_root <> ?5)",
            params![
                order.view_id,
                order.generation,
                page_id,
                is_active,
                is_task_root(connection, &order.view_id, page_id)?
            ],
        )?;
        if changed == 1 {
            connection.execute(
                "UPDATE database_view_order_state SET order_revision = order_revision + 1 WHERE view_id = ?1",
                [&order.view_id],
            )?;
        }
        return Ok(());
    }
    // Dormant defaults keep their reserved identity order. Omitting them here
    // would let later joins cross their position before lifecycle restoration.
    let previous_default = connection
        .query_row(
            "SELECT page_block_id, rank_key, 0 FROM database_view_order_rows
         WHERE view_id = ?1 AND generation = ?2 AND default_epoch = ?3
           AND page_block_id < ?4 ORDER BY page_block_id DESC LIMIT 1",
            params![
                order.view_id,
                order.generation,
                order.default_epoch,
                page_id
            ],
            decode_position,
        )
        .optional()?;
    let next_default = connection
        .query_row(
            "SELECT page_block_id, rank_key, 0 FROM database_view_order_rows
         WHERE view_id = ?1 AND generation = ?2 AND default_epoch = ?3
           AND page_block_id > ?4 ORDER BY page_block_id LIMIT 1",
            params![
                order.view_id,
                order.generation,
                order.default_epoch,
                page_id
            ],
            decode_position,
        )
        .optional()?;
    let left = match (previous_default, next_default.as_ref()) {
        (Some(position), _) => Some(position),
        (None, next) => seek_position(connection, order, next, true, OrderPopulation::Retained)?,
    };
    let plan = plan_rank_space(
        connection,
        order,
        &[RankedRun {
            page_ids: vec![page_id.to_owned()],
            left,
            right: next_default,
        }],
        &HashSet::from([page_id]),
    )?;
    let rank = plan.moved.get(page_id).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "Default order plan omitted its new Page",
            false,
        )
    })?;
    write_sibling_ranks(connection, order, &plan.siblings)?;
    connection.execute(
        "INSERT INTO database_view_order_rows(view_id, generation, page_block_id, rank_key,
           default_epoch, revision, is_active, created_at, updated_at, is_task_root)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?7, ?6, ?6, ?8)",
        params![
            order.view_id,
            order.generation,
            page_id,
            rank,
            order.default_epoch,
            now,
            is_active,
            is_task_root(connection, &order.view_id, page_id)?
        ],
    )?;
    connection.execute(
        "UPDATE database_view_order_state SET order_revision = order_revision + 1 WHERE view_id = ?1",
        [&order.view_id],
    )?;
    Ok(())
}

/// Join every published Source order after canonical membership exists. A
/// sibling View that has never published an order remains on its fenced
/// initialization job; it cannot block unrelated ready Views from accepting Pages.
pub(crate) fn join_page(
    connection: &Connection,
    page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let views = connection.prepare(
        "SELECT view.id, state.active_generation FROM pages page
         JOIN data_source_page_memberships membership ON membership.page_block_id = page.block_id
           AND membership.data_source_id = page.parent_id AND membership.removed_at IS NULL
         JOIN database_views view ON view.data_source_id = membership.data_source_id AND view.lifecycle = 'active'
         JOIN database_view_order_state state ON state.view_id = view.id
         WHERE page.block_id = ?1 AND page.parent_kind = 'data_source' ORDER BY view.id",
    )?.query_map([page_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (view_id, generation) in views {
        if generation.is_none() {
            continue;
        }
        let order = require_ready(connection, &view_id)?;
        insert_default(connection, &order, page_id, now)?;
    }
    Ok(())
}

/// A captured rank is only a frozen sort encoding. Consumers never restore it
/// as a live key; a copied View receives fresh keys for its captured sequence.
pub(crate) fn initialize_copied_view_order(
    connection: &Connection,
    view_id: &str,
    page_ids: &[&str],
    now: &str,
) -> Result<(), StoreError> {
    if page_ids.iter().copied().collect::<HashSet<_>>().len() != page_ids.len() {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Copied View order repeats a Page",
            false,
        ));
    }
    let order = require_ready(connection, view_id)?;
    let occupied: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM database_view_order_rows WHERE view_id = ?1)",
        [view_id],
        |row| row.get(0),
    )?;
    if occupied {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Copied View order is already initialized",
            false,
        ));
    }
    for (index, page_id) in page_ids.iter().enumerate() {
        check_request_interruption()?;
        let (active, task_root): (bool, bool) = connection.query_row(
            "SELECT is_active, is_task_root FROM database_view_order_member_activity WHERE view_id = ?1 AND page_block_id = ?2",
            params![view_id, page_id], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let rank = format!("{:032x}", ((index as u128) + 1) << 64);
        connection.execute(
            "INSERT INTO database_view_order_rows(view_id, generation, page_block_id, rank_key,
             default_epoch, revision, is_active, is_task_root, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, 1, ?5, ?6, ?7, ?7)",
            params![
                view_id,
                order.generation,
                page_id,
                rank,
                active,
                task_root,
                now
            ],
        )?;
    }
    connection.execute("UPDATE database_view_order_state SET order_revision = order_revision + 1 WHERE view_id = ?1", [view_id])?;
    Ok(())
}

pub(crate) struct FrozenViewPosition {
    pub(crate) witness: RetainedPositionWitness,
    pub(crate) rank_key: String,
}

/// Snapshot a Page's complete published sequence coordinates. Rank bytes are
/// meaningful only within this transaction's frozen snapshot, never as guards.
pub(crate) fn capture_frozen_positions(
    connection: &Connection,
    page_id: &str,
) -> Result<Vec<FrozenViewPosition>, StoreError> {
    retained_position_witnesses(connection, page_id)?.into_iter().map(|witness| {
        let rank_key = connection.query_row(
            "SELECT position.rank_key FROM database_view_order_rows position
             JOIN database_view_order_state state ON state.view_id = position.view_id AND state.active_generation = position.generation
             WHERE position.view_id = ?1 AND position.page_block_id = ?2",
            params![witness.view_id, page_id], |row| row.get(0),
        )?;
        Ok(FrozenViewPosition { witness, rank_key })
    }).collect()
}

fn allocate_run(left: Option<&str>, right: Option<&str>, count: usize) -> Option<Vec<String>> {
    if right.is_some() {
        return rank_run_between(left, right, count);
    }
    // Preserve endpoint headroom for ordinary increasing-UUID Page creation.
    // Interior gaps still use all available space for the whole run.
    let lower = left
        .map(|rank| u128::from_str_radix(rank, 16).ok())
        .unwrap_or(Some(0))?;
    let upper = lower
        .checked_add((count as u128 + 1).checked_mul(1_u128 << 64)?)
        .map(|rank| format!("{rank:032x}"));
    rank_run_between(left, upper.as_deref(), count)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORDER_SCHEMA: &str = include_str!("../../tests/fixtures/manual-order.sql");

    fn install_order_fixture(connection: &Connection) {
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE database_views(id TEXT PRIMARY KEY, data_source_id TEXT, lifecycle TEXT);
             CREATE TABLE blocks(id TEXT PRIMARY KEY, lifecycle TEXT);
             CREATE TABLE pages(block_id TEXT PRIMARY KEY, parent_kind TEXT, parent_id TEXT);
             CREATE TABLE data_source_page_memberships(
               id TEXT PRIMARY KEY, data_source_id TEXT, page_block_id TEXT, removed_at TEXT, created_at TEXT);
             CREATE TABLE data_source_relation_edges(
               source_data_source_id TEXT, source_membership_id TEXT, property_id TEXT,
               target_page_block_id TEXT,
               PRIMARY KEY(source_data_source_id, source_membership_id, property_id));
             CREATE TABLE database_view_page_positions(
               view_id TEXT, page_block_id TEXT, rank_key TEXT, revision INTEGER, created_at TEXT, updated_at TEXT,
               PRIMARY KEY(view_id, page_block_id));
             CREATE INDEX idx_data_source_memberships_source_active ON data_source_page_memberships(data_source_id, removed_at, page_block_id);
             CREATE INDEX idx_database_view_page_positions_order ON database_view_page_positions(view_id, rank_key, page_block_id);
             INSERT INTO database_views VALUES ('view', 'source', 'active');
             INSERT INTO blocks VALUES ('page-b', 'active'), ('page-a', 'active'), ('page-c', 'active');
             INSERT INTO pages VALUES ('page-a', 'data_source', 'source'),
               ('page-b', 'data_source', 'source'), ('page-c', 'data_source', 'source');
             INSERT INTO data_source_page_memberships VALUES
               ('a', 'source', 'page-a', NULL, 'now'), ('b', 'source', 'page-b', NULL, 'now'),
               ('c', 'source', 'page-c', NULL, 'now');"
        ).expect("authoritative order input");
        connection
            .execute_batch(ORDER_SCHEMA)
            .expect("order schema");
        connection.execute(
            "INSERT INTO database_view_order_import_positions VALUES ('view', 'page-b', 'a', 7, 'now', 'now')",
            [],
        ).expect("one historical explicit position");
        enqueue_initialization(connection, "view").expect("preparation");
    }

    #[test]
    fn retained_witnesses_survive_default_freeze_and_dormant_rebalance() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        let order = require_ready(&connection, "view").unwrap();
        connection
            .execute(
                "INSERT INTO database_views VALUES ('sibling', 'source', 'active')",
                [],
            )
            .unwrap();
        require_ready(&connection, "sibling").unwrap();
        let original = retained_position_witnesses(&connection, "page-a").unwrap();
        assert_eq!(original.len(), 2);
        assert!(original.iter().all(|witness| witness.revision == 0));
        assert_eq!(position_revision(&connection, &order, "page-a").unwrap(), 0);
        freeze_defaults(&connection, &order).unwrap();
        let frozen = require_ready(&connection, "view").unwrap();
        assert_eq!(
            position_revision(&connection, &frozen, "page-a").unwrap(),
            1
        );
        assert_eq!(
            retained_position_witnesses(&connection, "page-a").unwrap(),
            original
        );

        connection.execute("UPDATE data_source_page_memberships SET removed_at = 'retired' WHERE page_block_id = 'page-a'", []).unwrap();
        connection
            .execute("DELETE FROM pages WHERE block_id = 'page-a'", [])
            .unwrap();
        connection
            .execute(
                "DELETE FROM data_source_page_memberships WHERE page_block_id = 'page-a'",
                [],
            )
            .unwrap();
        for view_id in ["view", "sibling"] {
            enqueue_rebalance(&connection, view_id).unwrap();
            assert!(!prepare_view_slice(&connection, view_id, 1).unwrap());
            assert_eq!(
                retained_position_witnesses(&connection, "page-a").unwrap(),
                original
            );
            while !prepare_view_slice(&connection, view_id, 1).unwrap() {}
        }
        while cleanup_order_slice(&connection, 1).unwrap() {}
        assert_eq!(
            retained_position_witnesses(&connection, "page-a").unwrap(),
            original
        );
        assert!(original.iter().all(|witness| !connection.query_row(
            "SELECT position.is_active FROM database_view_order_rows position JOIN database_view_order_state state ON state.view_id = position.view_id AND state.active_generation = position.generation WHERE position.view_id = ?1 AND position.page_block_id = 'page-a'",
            [&witness.view_id], |row| row.get::<_, bool>(0),
        ).unwrap()));
    }

    #[test]
    fn retained_witnesses_detect_positioning_reset_and_view_retirement() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        require_ready(&connection, "view").unwrap();
        let untouched = retained_position_witnesses(&connection, "page-a").unwrap();
        let moved = retained_position_witnesses(&connection, "page-c").unwrap();
        position_page(
            &connection,
            "view",
            "page-c",
            ViewOrderPlacement::Start,
            "now",
        )
        .unwrap();
        assert_ne!(
            retained_position_witnesses(&connection, "page-c").unwrap(),
            moved
        );
        assert_eq!(
            retained_position_witnesses(&connection, "page-a").unwrap(),
            untouched
        );
        reset_view(&connection, "view").unwrap();
        assert!(retained_position_witnesses(&connection, "page-a").is_err());
        require_ready(&connection, "view").unwrap();
        let reset = retained_position_witnesses(&connection, "page-a").unwrap();
        assert_eq!(reset[0].revision, untouched[0].revision);
        assert_eq!(
            reset[0].semantic_reset_epoch,
            untouched[0].semantic_reset_epoch + 1
        );
        assert_ne!(reset, untouched);
        retire_view(&connection, "view").unwrap();
        assert!(
            retained_position_witnesses(&connection, "page-a")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn retained_witnesses_never_omit_an_unpublished_canonical_view() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        assert!(retained_position_witnesses(&connection, "page-a").is_err());
        require_ready(&connection, "view").unwrap();
        connection
            .execute(
                "INSERT INTO database_views VALUES ('sibling', 'source', 'active')",
                [],
            )
            .unwrap();
        let error = retained_position_witnesses(&connection, "page-a").unwrap_err();
        assert!(
            matches!(error.recovery, Some(nodex_core_contracts::CoreErrorRecovery::DatabaseViewOrderPreparation { view_id }) if view_id == "sibling")
        );
        require_ready(&connection, "sibling").unwrap();
        assert_eq!(
            retained_position_witnesses(&connection, "page-a")
                .unwrap()
                .len(),
            2
        );
        connection
            .execute("DELETE FROM database_views WHERE id = 'sibling'", [])
            .unwrap();
        let remaining = retained_position_witnesses(&connection, "page-a").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].view_id, "view");
    }

    #[test]
    fn removed_page_anchors_restore_across_rebalance_and_surviving_predecessor() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        require_ready(&connection, "view").unwrap();
        let anchors = capture_page_order_anchors(&connection, "view", "page-a").unwrap();
        assert_eq!(anchors.previous_page_id.as_deref(), Some("page-b"));
        assert_eq!(anchors.next_page_id.as_deref(), Some("page-c"));
        forget_page(&connection, "page-a").unwrap();
        connection.execute("UPDATE pages SET parent_kind = 'library', parent_id = 'library' WHERE block_id = 'page-a'", []).unwrap();
        enqueue_rebalance(&connection, "view").unwrap();
        while !prepare_view_slice(&connection, "view", 1).unwrap() {}
        connection.execute("UPDATE pages SET parent_kind = 'data_source', parent_id = 'source' WHERE block_id = 'page-a'", []).unwrap();
        restore_page_order_anchors(&connection, "view", "page-a", &anchors, "now").unwrap();
        assert_eq!(
            ordered_ids(&connection, &require_ready(&connection, "view").unwrap()),
            ["page-b", "page-a", "page-c"]
        );

        forget_page(&connection, "page-a").unwrap();
        connection.execute("UPDATE pages SET parent_kind = 'library', parent_id = 'library' WHERE block_id = 'page-a'", []).unwrap();
        connection.execute("UPDATE data_source_page_memberships SET removed_at = 'removed' WHERE page_block_id = 'page-c'", []).unwrap();
        connection.execute("UPDATE pages SET parent_kind = 'data_source', parent_id = 'source' WHERE block_id = 'page-a'", []).unwrap();
        restore_page_order_anchors(&connection, "view", "page-a", &anchors, "now").unwrap();
        assert_eq!(
            ordered_ids(&connection, &require_ready(&connection, "view").unwrap()),
            ["page-b", "page-a"]
        );
        connection.execute("UPDATE data_source_page_memberships SET removed_at = 'removed' WHERE page_block_id = 'page-b'", []).unwrap();
        assert_eq!(
            restore_page_order_anchors(&connection, "view", "page-a", &anchors, "now")
                .unwrap_err()
                .code,
            StoreErrorCode::RevisionConflict
        );
    }

    #[test]
    fn removed_page_anchors_reject_semantic_reset_without_positioning() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        require_ready(&connection, "view").unwrap();
        let anchors = capture_page_order_anchors(&connection, "view", "page-a").unwrap();
        reset_view(&connection, "view").unwrap();
        let reset = require_ready(&connection, "view").unwrap();
        let before = ordered_ids(&connection, &reset);
        assert_eq!(
            restore_page_order_anchors(&connection, "view", "page-a", &anchors, "now")
                .unwrap_err()
                .code,
            StoreErrorCode::RevisionConflict
        );
        assert_eq!(ordered_ids(&connection, &reset), before);
    }

    #[test]
    fn task_root_history_anchors_ignore_interleaved_children_in_both_directions() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        connection.execute(
            "INSERT INTO data_source_relation_edges VALUES ('source', 'a', 'task_parent', 'page-b')",
            [],
        ).unwrap();
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 32).unwrap() {
                break;
            }
        }
        let order = require_ready(&connection, "view").unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        for (selected, descending, before) in
            [("page-b", false, "page-c"), ("page-c", true, "page-b")]
        {
            assert_eq!(
                capture_root_runs(&connection, &order, &HashSet::from([selected]), descending)
                    .unwrap(),
                [LogicalPositionRun {
                    page_ids: vec![selected.to_owned()],
                    before_page_id: Some(before.to_owned())
                }]
            );
        }
        assert_eq!(
            capture_runs(&connection, &order, &HashSet::from(["page-b"]), false).unwrap()[0]
                .before_page_id
                .as_deref(),
            Some("page-a")
        );
    }

    #[test]
    fn task_root_population_tracks_edges_and_membership_across_preparation() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        let order = require_ready(&connection, "view").unwrap();
        let successor = |order: &ReadyOrder| {
            capture_root_runs(&connection, order, &HashSet::from(["page-b"]), false).unwrap()[0]
                .before_page_id
                .clone()
        };
        assert_eq!(successor(&order).as_deref(), Some("page-a"));
        connection.execute("INSERT INTO data_source_relation_edges VALUES ('source', 'a', 'task_parent', 'page-b')", []).unwrap();
        assert_eq!(successor(&order).as_deref(), Some("page-c"));

        enqueue_rebalance(&connection, "view").unwrap();
        assert!(!prepare_view_slice(&connection, "view", 1).unwrap());
        connection
            .execute(
                "DELETE FROM data_source_relation_edges WHERE source_membership_id = 'a'",
                [],
            )
            .unwrap();
        let order = require_ready(&connection, "view").unwrap();
        assert_eq!(successor(&order).as_deref(), Some("page-a"));

        connection.execute("INSERT INTO data_source_relation_edges VALUES ('source', 'a', 'task_parent', 'page-b')", []).unwrap();
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'archived' WHERE id = 'page-b'",
                [],
            )
            .unwrap();
        assert!(
            capture_root_runs(&connection, &order, &HashSet::from(["page-a"]), false).is_err(),
            "an archived parent does not remove its canonical edge"
        );
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'active' WHERE id = 'page-b'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE data_source_page_memberships SET removed_at = 'left' WHERE id = 'a'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM data_source_relation_edges WHERE source_membership_id = 'a'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE data_source_page_memberships SET removed_at = NULL WHERE id = 'a'",
                [],
            )
            .unwrap();
        assert_eq!(successor(&order).as_deref(), Some("page-a"));
    }

    #[test]
    fn task_root_capture_work_is_independent_of_interleaved_child_count() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let mut first_steps = None;
        for size in [1_000, 10_000, 100_000] {
            let connection = Connection::open_in_memory().unwrap();
            install_order_fixture(&connection);
            let order = require_ready(&connection, "view").unwrap();
            // Explicit storage pressure: only the three seed Pages are roots.
            // All children sort between page-a and page-c in the complete order.
            connection.execute_batch(&format!(
                "WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<{size})
                 INSERT INTO blocks SELECT printf('child-%06d', n), 'active' FROM ids;
                 INSERT INTO pages SELECT id, 'data_source', 'source' FROM blocks WHERE id LIKE 'child-%';
                 INSERT INTO data_source_page_memberships SELECT block_id, 'source', block_id, NULL, 'now' FROM pages WHERE block_id LIKE 'child-%';
                 INSERT INTO data_source_relation_edges SELECT 'source', id, 'task_parent', 'page-b' FROM blocks WHERE id LIKE 'child-%';
                 WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<{size})
                 INSERT INTO database_view_order_rows SELECT 'view', 1, printf('child-%06d', n), printf('0000000000000002%08x00000000', n), 1, 0, 1, 0, 'now', 'now' FROM ids;"
            )).unwrap();
            let ticks = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&ticks);
            connection
                .progress_handler(
                    1,
                    Some(move || {
                        observed.fetch_add(1, Ordering::Relaxed);
                        false
                    }),
                )
                .unwrap();
            for (selected, descending, before) in
                [("page-a", false, "page-c"), ("page-c", true, "page-a")]
            {
                assert_eq!(
                    capture_root_runs(&connection, &order, &HashSet::from([selected]), descending)
                        .unwrap(),
                    [LogicalPositionRun {
                        page_ids: vec![selected.to_owned()],
                        before_page_id: Some(before.to_owned())
                    }]
                );
            }
            connection
                .progress_handler(0, None::<fn() -> bool>)
                .unwrap();
            let steps = ticks.load(Ordering::Relaxed);
            eprintln!("task_root_capture children={size} vm_steps={steps}");
            let small = *first_steps.get_or_insert(steps);
            assert!(
                steps > 0 && steps <= small * 4,
                "root capture must seek roots without scanning children"
            );
        }
    }

    #[test]
    fn preparation_keeps_default_tail_and_publishes_only_a_complete_generation() {
        let connection = Connection::open_in_memory().expect("order Store");
        install_order_fixture(&connection);
        assert!(ready(&connection, "view").expect("state").is_none());
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).expect("one durable slice") {
                break;
            }
            assert!(
                ready(&connection, "view")
                    .expect("not yet published")
                    .is_none()
            );
        }
        let order = ready(&connection, "view")
            .expect("state")
            .expect("published generation");
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        assert_eq!(visible_positions(&connection), [("page-b".to_owned(), 7)]);
        freeze_defaults(&connection, &order)
            .expect("one explicit gesture freezes its existing tail");
        assert_eq!(
            visible_positions(&connection),
            [
                ("page-b".to_owned(), 7),
                ("page-a".to_owned(), 1),
                ("page-c".to_owned(), 1),
            ]
        );
        let order = ready(&connection, "view").unwrap().unwrap();
        for page_id in ["page-z", "page-d", "page-m"] {
            connection
                .execute("INSERT INTO blocks VALUES (?1, 'active')", [page_id])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO pages VALUES (?1, 'data_source', 'source')",
                    [page_id],
                )
                .unwrap();
            connection.execute("INSERT INTO data_source_page_memberships VALUES (?1, 'source', ?1, NULL, 'now')", [page_id]).unwrap();
            insert_default(&connection, &order, page_id, "now")
                .expect("indexed implicit insertion");
        }
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c", "page-d", "page-m", "page-z"]
        );
        assert_eq!(
            visible_positions(&connection).len(),
            3,
            "new default tail stays nullable"
        );
    }

    #[test]
    fn restored_archived_page_keeps_its_position_without_becoming_active() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        require_ready(&connection, "view").unwrap();
        forget_page(&connection, "page-c").unwrap();
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'archived' WHERE id = 'page-c'",
                [],
            )
            .unwrap();
        restore_page_position(
            &connection,
            "view",
            "page-c",
            ViewOrderPlacement::Before("page-a"),
            "restored",
        )
        .unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        assert!(active_position(&connection, &order, "page-c").is_err());
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'active' WHERE id = 'page-c'",
                [],
            )
            .unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-c", "page-a"]
        );
        assert_eq!(position_revision(&connection, &order, "page-b").unwrap(), 7);
    }

    #[test]
    fn a_default_join_repairs_a_dense_gap_without_freezing_the_tail() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        for (page_id, rank) in [("page-b", 10), ("page-a", 20), ("page-c", 20)] {
            connection.execute("UPDATE database_view_order_rows SET rank_key = ?1 WHERE view_id='view' AND page_block_id = ?2", params![format!("{rank:032x}"), page_id]).unwrap();
        }
        connection
            .execute("INSERT INTO blocks VALUES ('page-ab', 'active')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO pages VALUES ('page-ab', 'data_source', 'source')",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO data_source_page_memberships VALUES ('ab', 'source', 'page-ab', NULL, 'now')", []).unwrap();
        insert_default(&connection, &order, "page-ab", "join").expect("repair the default gap");
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-ab", "page-c"]
        );
        assert_eq!(visible_positions(&connection), [("page-b".to_owned(), 7)]);
    }

    #[test]
    fn indexed_forward_undo_redo_work_stays_bounded_as_the_view_grows() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let mut samples = BTreeMap::new();
        for size in [1_000, 10_000, 100_000] {
            let mut connection = Connection::open_in_memory().unwrap();
            install_order_fixture(&connection);
            for _ in 0..16 {
                if prepare_view_slice(&connection, "view", 32).unwrap() {
                    break;
                }
            }
            freeze_defaults(&connection, &ready(&connection, "view").unwrap().unwrap()).unwrap();
            // Storage pressure complements the smaller canonical membership
            // and ordering examples; setup is outside the measured operation.
            connection.execute_batch(&format!(
                "WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<{size})
                 INSERT INTO blocks SELECT printf('pressure-%06d', n), 'active' FROM ids;
                 INSERT INTO pages SELECT id, 'data_source', 'source' FROM blocks WHERE id LIKE 'pressure-%';
                 INSERT INTO data_source_page_memberships SELECT block_id, 'source', block_id, NULL, 'now' FROM pages WHERE block_id LIKE 'pressure-%';
                 WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<{size})
                 INSERT INTO database_view_order_rows SELECT 'view', 1, printf('pressure-%06d', n), printf('%016x0000000000000000', n+4), NULL, 1, 1, 1, 'now', 'now' FROM ids;"
            )).unwrap();
            for descending in [false, true] {
                for (count, stride) in [(1, 1), (64, 1), (64, 2)] {
                    let transaction = connection.transaction().unwrap();
                    let ids = (0..count)
                        .map(|index| format!("pressure-{:06}", 100 + index * stride))
                        .collect::<Vec<_>>();
                    let selected = ids.iter().map(String::as_str).collect::<HashSet<_>>();
                    let expected = vec![LogicalPositionRun {
                        page_ids: ids.clone(),
                        before_page_id: Some(format!("pressure-{:06}", size - 2)),
                    }];
                    let ticks = Arc::new(AtomicUsize::new(0));
                    let observed = Arc::clone(&ticks);
                    transaction
                        .progress_handler(
                            1,
                            Some(move || {
                                observed.fetch_add(1, Ordering::Relaxed);
                                false
                            }),
                        )
                        .unwrap();
                    let order = ready(&transaction, "view").unwrap().unwrap();
                    let before = capture_runs(&transaction, &order, &selected, descending).unwrap();
                    position_runs(&transaction, &order, &expected, descending, "forward").unwrap();
                    let order = ready(&transaction, "view").unwrap().unwrap();
                    assert_eq!(
                        capture_runs(&transaction, &order, &selected, descending).unwrap(),
                        expected
                    );
                    let forward_steps = ticks.swap(0, Ordering::Relaxed);
                    position_runs(&transaction, &order, &before, descending, "undo").unwrap();
                    let order = ready(&transaction, "view").unwrap().unwrap();
                    assert_eq!(
                        capture_runs(&transaction, &order, &selected, descending).unwrap(),
                        before
                    );
                    let undo_steps = ticks.swap(0, Ordering::Relaxed);
                    position_runs(&transaction, &order, &expected, descending, "redo").unwrap();
                    let order = ready(&transaction, "view").unwrap().unwrap();
                    assert_eq!(
                        capture_runs(&transaction, &order, &selected, descending).unwrap(),
                        expected
                    );
                    transaction
                        .progress_handler(0, None::<fn() -> bool>)
                        .unwrap();
                    let steps = [forward_steps, undo_steps, ticks.load(Ordering::Relaxed)];
                    transaction.rollback().unwrap();
                    eprintln!(
                        "manual_order rows={size} selected={count} stride={stride} descending={descending} forward_undo_redo_vm_steps={steps:?}"
                    );
                    assert!(steps.iter().all(|steps| *steps > 0));
                    let first = samples.entry((count, stride, descending)).or_insert(steps);
                    assert!(
                        steps
                            .iter()
                            .zip(first.iter())
                            .all(|(actual, first)| *actual <= *first * 4)
                    );
                }
            }
        }
    }

    #[test]
    fn order_observations_are_fenced_by_readiness_and_published_generation() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        let keyset = keyset_identity(&connection, "view").unwrap();
        enqueue_rebalance(&connection, "view").unwrap();
        assert_eq!(keyset_identity(&connection, "view").unwrap(), keyset);
        let selected = HashSet::from(["page-a"]);
        assert_eq!(
            capture_runs(&connection, &order, &selected, false)
                .unwrap_err()
                .code,
            StoreErrorCode::MaintenanceInProgress
        );
        for _ in 0..16 {
            if !maintain_order_slice(&connection).unwrap() {
                break;
            }
        }
        assert_ne!(keyset_identity(&connection, "view").unwrap(), keyset);
        assert_eq!(
            capture_runs(&connection, &order, &selected, false)
                .unwrap_err()
                .code,
            StoreErrorCode::RevisionConflict
        );
        let current = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            capture_runs(&connection, &current, &selected, false).unwrap(),
            [LogicalPositionRun {
                page_ids: vec!["page-a".to_owned()],
                before_page_id: Some("page-c".to_owned()),
            }]
        );
    }

    #[test]
    fn a_dense_gap_repairs_local_ranks_without_advancing_sibling_revisions() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        for page_id in ["page-d", "page-e", "page-f"] {
            connection
                .execute("INSERT INTO blocks VALUES (?1, 'active')", [page_id])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO pages VALUES (?1, 'data_source', 'source')",
                    [page_id],
                )
                .unwrap();
            connection.execute("INSERT INTO data_source_page_memberships VALUES (?1, 'source', ?1, NULL, 'now')", [page_id]).unwrap();
            insert_default(&connection, &order, page_id, "now").unwrap();
        }
        freeze_defaults(&connection, &order).unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        for (page_id, rank) in [
            ("page-b", 10),
            ("page-a", 20),
            ("page-c", 20),
            ("page-d", 20),
            ("page-e", 40),
            ("page-f", 50),
        ] {
            connection.execute("UPDATE database_view_order_rows SET rank_key = ?1 WHERE view_id='view' AND page_block_id = ?2", params![format!("{rank:032x}"), page_id]).unwrap();
        }
        let selected = HashSet::from(["page-f"]);
        let before = capture_runs(&connection, &order, &selected, false).unwrap();
        position_runs(
            &connection,
            &order,
            &[LogicalPositionRun {
                page_ids: vec!["page-f".to_owned()],
                before_page_id: Some("page-c".to_owned()),
            }],
            false,
            "forward",
        )
        .expect("bounded dense-gap repair");
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            visible_positions(&connection),
            [
                ("page-b".to_owned(), 7),
                ("page-a".to_owned(), 1),
                ("page-f".to_owned(), 2),
                ("page-c".to_owned(), 1),
                ("page-d".to_owned(), 1),
                ("page-e".to_owned(), 1),
            ]
        );
        position_runs(&connection, &order, &before, false, "undo").unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c", "page-d", "page-e", "page-f"]
        );
    }

    #[test]
    fn multiple_restore_runs_share_one_order_observation_and_preserve_siblings() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        for page_id in ["page-d", "page-e", "page-f"] {
            connection
                .execute("INSERT INTO blocks VALUES (?1, 'active')", [page_id])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO pages VALUES (?1, 'data_source', 'source')",
                    [page_id],
                )
                .unwrap();
            connection.execute("INSERT INTO data_source_page_memberships VALUES (?1, 'source', ?1, NULL, 'now')", [page_id]).unwrap();
            insert_default(&connection, &order, page_id, "now").unwrap();
        }
        let selected = HashSet::from(["page-a", "page-e"]);
        let original = capture_runs(&connection, &order, &selected, false).unwrap();
        let moved = [LogicalPositionRun {
            page_ids: vec!["page-a".to_owned(), "page-e".to_owned()],
            before_page_id: Some("page-f".to_owned()),
        }];
        position_runs(&connection, &order, &moved, false, "forward").unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-c", "page-d", "page-a", "page-e", "page-f"]
        );
        let inverse = capture_runs(&connection, &order, &selected, false).unwrap();
        position_runs(&connection, &order, &original, false, "undo").unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c", "page-d", "page-e", "page-f"]
        );
        position_runs(&connection, &order, &inverse, false, "redo").unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-c", "page-d", "page-a", "page-e", "page-f"]
        );
        assert_eq!(
            visible_positions(&connection),
            [
                ("page-b".to_owned(), 7),
                ("page-c".to_owned(), 1),
                ("page-d".to_owned(), 1),
                ("page-a".to_owned(), 3),
                ("page-e".to_owned(), 3),
                ("page-f".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn selected_run_capture_uses_logical_neighbors_in_both_directions() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        let selected = std::collections::HashSet::from(["page-b", "page-c"]);
        assert_eq!(
            capture_runs(&connection, &order, &selected, false).unwrap(),
            [
                crate::domain::ordered_position::LogicalPositionRun {
                    page_ids: vec!["page-b".to_owned()],
                    before_page_id: Some("page-a".to_owned()),
                },
                crate::domain::ordered_position::LogicalPositionRun {
                    page_ids: vec!["page-c".to_owned()],
                    before_page_id: None,
                },
            ]
        );
        assert_eq!(
            capture_runs(&connection, &order, &selected, true).unwrap(),
            [
                crate::domain::ordered_position::LogicalPositionRun {
                    page_ids: vec!["page-c".to_owned()],
                    before_page_id: Some("page-a".to_owned()),
                },
                crate::domain::ordered_position::LogicalPositionRun {
                    page_ids: vec!["page-b".to_owned()],
                    before_page_id: None,
                },
            ]
        );
        assert_eq!(
            capture_runs(
                &connection,
                &order,
                &std::collections::HashSet::from(["page-a", "page-c"]),
                true
            )
            .unwrap(),
            [crate::domain::ordered_position::LogicalPositionRun {
                page_ids: vec!["page-c".to_owned(), "page-a".to_owned()],
                before_page_id: Some("page-b".to_owned()),
            },]
        );
    }

    #[test]
    fn a_dormant_default_page_rejoins_after_new_identity_ordered_neighbors() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        connection
            .execute(
                "UPDATE blocks SET lifecycle='archived' WHERE id='page-c'",
                [],
            )
            .unwrap();
        for _ in 0..16 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        for page_id in ["page-aa", "page-ab"] {
            connection
                .execute("INSERT INTO blocks VALUES (?1, 'active')", [page_id])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO pages VALUES (?1, 'data_source', 'source')",
                    [page_id],
                )
                .unwrap();
            connection.execute("INSERT INTO data_source_page_memberships VALUES (?1, 'source', ?1, NULL, 'now')", [page_id]).unwrap();
            insert_default(&connection, &order, page_id, "now").unwrap();
        }
        connection
            .execute("UPDATE blocks SET lifecycle='active' WHERE id='page-c'", [])
            .unwrap();
        insert_default(&connection, &order, "page-c", "later")
            .expect("restore retained default membership");
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-aa", "page-ab", "page-c"]
        );
        assert_eq!(visible_positions(&connection), [("page-b".to_owned(), 7)]);
    }

    #[test]
    fn preparation_resumes_after_rollback_and_reopen_without_exposing_partial_ranks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("order.db");
        let mut connection = Connection::open(&path).unwrap();
        install_order_fixture(&connection);
        {
            let transaction = connection.transaction().unwrap();
            assert!(!prepare_view_slice(&transaction, "view", 1).unwrap());
            transaction.commit().unwrap();
        }
        {
            let transaction = connection.transaction().unwrap();
            assert!(!prepare_view_slice(&transaction, "view", 1).unwrap());
            assert!(!prepare_view_slice(&transaction, "view", 1).unwrap());
            transaction.rollback().unwrap();
        }
        drop(connection);
        let mut connection = Connection::open(&path).unwrap();
        for _ in 0..16 {
            let transaction = connection.transaction().unwrap();
            let finished = prepare_view_slice(&transaction, "view", 1).unwrap();
            transaction.commit().unwrap();
            if finished {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        freeze_defaults(&connection, &order).unwrap();
        let order = ready(&connection, "view").unwrap().unwrap();
        let previous_positions = visible_positions(&connection);
        enqueue_rebalance(&connection, "view").expect("bounded rank preparation");
        assert!(ready(&connection, "view").unwrap().is_none());
        for _ in 0..16 {
            let transaction = connection.transaction().unwrap();
            let finished = prepare_view_slice(&transaction, "view", 1).unwrap();
            if !finished {
                assert_eq!(
                    visible_positions(&transaction),
                    previous_positions,
                    "published positions remain readable while rebuilding"
                );
            }
            transaction.commit().unwrap();
            if finished {
                break;
            }
        }
        let rebuilt = ready(&connection, "view").unwrap().unwrap();
        assert!(rebuilt.generation > order.generation);
        assert_eq!(
            ordered_ids(&connection, &rebuilt),
            ["page-b", "page-a", "page-c"]
        );
        assert_eq!(visible_positions(&connection), previous_positions);
    }

    #[test]
    fn preparation_restarts_after_its_source_changes_without_publishing_stale_rows() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        assert!(!prepare_view_slice(&connection, "view", 1).unwrap());
        connection.execute_batch(
            "UPDATE database_view_order_import_positions SET revision = 9 WHERE page_block_id = 'page-b';
             UPDATE database_view_order_state SET order_revision = order_revision + 1 WHERE view_id = 'view';"
        ).unwrap();
        for _ in 0..20 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view")
            .unwrap()
            .expect("restarted preparation publishes");
        assert!(order.generation > 1);
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        assert_eq!(visible_positions(&connection), [("page-b".to_owned(), 9)]);
    }

    #[test]
    fn retired_order_storage_is_reclaimed_in_bounded_slices_without_changing_visible_order() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        while !prepare_view_slice(&connection, "view", 1).unwrap() {}
        enqueue_rebalance(&connection, "view").unwrap();
        while !prepare_view_slice(&connection, "view", 1).unwrap() {}
        let order = ready(&connection, "view").unwrap().unwrap();
        let retained = || {
            connection
                .query_row(
                    "SELECT (SELECT count(*) FROM database_view_order_rows)
             + (SELECT count(*) FROM database_view_order_import_positions)",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(retained(), 7);
        for _ in 0..10 {
            let before = retained();
            let more = cleanup_order_slice(&connection, 1).unwrap();
            assert!(before - retained() <= 1, "one candidate per cleanup slice");
            assert_eq!(
                ordered_ids(&connection, &order),
                ["page-b", "page-a", "page-c"]
            );
            assert_eq!(visible_positions(&connection), [("page-b".to_owned(), 7)]);
            if !more {
                break;
            }
        }
        assert_eq!(retained(), 3, "only the published generation remains");
    }

    #[test]
    fn interactive_readiness_prepares_small_views_but_yields_large_views() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        let order = require_ready(&connection, "view").expect("small View prepares inline");
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        connection.execute_batch(
            "WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < 1000)
             INSERT INTO blocks SELECT printf('large-%04d', n), 'active' FROM ids;
             INSERT INTO pages SELECT id, 'data_source', 'large-source' FROM blocks WHERE id LIKE 'large-%';
             INSERT INTO data_source_page_memberships SELECT block_id, 'large-source', block_id, NULL, 'now'
             FROM pages WHERE parent_id = 'large-source';
             INSERT INTO database_views VALUES ('large', 'large-source', 'active');"
        ).unwrap();
        enqueue_initialization(&connection, "large").unwrap();
        let error = require_ready(&connection, "large").unwrap_err();
        assert_eq!(error.code, StoreErrorCode::MaintenanceInProgress);
        assert!(ready(&connection, "large").unwrap().is_none());
        let prepared: i64 = connection
            .query_row(
                "SELECT count(*) FROM database_view_order_rows WHERE view_id = 'large'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(prepared <= 128, "interactive candidate budget");
    }

    #[test]
    fn preparation_request_is_durable_after_the_semantic_transaction_rolls_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preparation.db");
        let mut connection = Connection::open(&path).unwrap();
        install_order_fixture(&connection);
        require_ready(&connection, "view").unwrap();
        let result: Result<(), StoreError> =
            crate::infrastructure::sqlite::with_immediate_transaction(
                &mut connection,
                |transaction| {
                    transaction.execute(
                        "UPDATE blocks SET lifecycle = 'archived' WHERE id = 'page-a'",
                        [],
                    )?;
                    Err(rank_preparation_required("view"))
                },
            );
        let error = finish_order_attempt(&mut connection, result).unwrap_err();
        assert_eq!(error.code, StoreErrorCode::MaintenanceInProgress);
        drop(connection);
        let connection = Connection::open(&path).unwrap();
        assert!(
            ready(&connection, "view").unwrap().is_none(),
            "preparation survives reopen"
        );
        let lifecycle: String = connection
            .query_row(
                "SELECT lifecycle FROM blocks WHERE id = 'page-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lifecycle, "active", "failed gesture is fully rolled back");
        while !prepare_view_slice(&connection, "view", 1).unwrap() {}
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
    }

    #[test]
    fn canonical_activity_tracks_page_lifecycle_and_membership_without_losing_positions() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        let order = require_ready(&connection, "view").unwrap();
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'archived' WHERE id = 'page-c'",
                [],
            )
            .unwrap();
        assert_eq!(ordered_ids(&connection, &order), ["page-b", "page-a"]);
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'active' WHERE id = 'page-c'",
                [],
            )
            .unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        connection.execute("UPDATE data_source_page_memberships SET removed_at = 'removed' WHERE page_block_id = 'page-a'", []).unwrap();
        assert_eq!(ordered_ids(&connection, &order), ["page-b", "page-c"]);
        connection.execute("UPDATE data_source_page_memberships SET removed_at = NULL WHERE page_block_id = 'page-a'", []).unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        connection.execute("UPDATE pages SET parent_kind = 'library', parent_id = 'library' WHERE block_id = 'page-b'", []).unwrap();
        assert_eq!(ordered_ids(&connection, &order), ["page-a", "page-c"]);
        connection.execute("UPDATE pages SET parent_kind = 'data_source', parent_id = 'source' WHERE block_id = 'page-b'", []).unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-b", "page-a", "page-c"]
        );
        assert_eq!(visible_positions(&connection), [("page-b".to_owned(), 7)]);
    }

    #[test]
    fn membership_changes_behind_the_preparation_cursor_are_reconsidered() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        for _ in 0..4 {
            assert!(!prepare_view_slice(&connection, "view", 1).unwrap());
        }
        connection
            .execute_batch(
                "INSERT INTO blocks VALUES ('page-0', 'active');
             INSERT INTO pages VALUES ('page-0', 'data_source', 'source');
             INSERT INTO data_source_page_memberships VALUES ('0', 'source', 'page-0', NULL, 'now');
             DELETE FROM data_source_page_memberships WHERE page_block_id = 'page-b';",
            )
            .unwrap();
        for _ in 0..20 {
            if prepare_view_slice(&connection, "view", 1).unwrap() {
                break;
            }
        }
        let order = ready(&connection, "view").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-0", "page-a", "page-c"]
        );
    }

    #[test]
    fn resetting_a_view_cancels_partial_preparation_and_clears_positions_without_an_import_revival()
    {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        assert!(!prepare_view_slice(&connection, "view", 1).unwrap());
        reset_view(&connection, "view").unwrap();
        assert!(
            visible_positions(&connection).is_empty(),
            "reset clears positions immediately"
        );
        let order = require_ready(&connection, "view").unwrap();
        assert!(order.generation > 1);
        assert_eq!(
            ordered_ids(&connection, &order),
            ["page-a", "page-b", "page-c"]
        );
        assert!(visible_positions(&connection).is_empty());
        reset_view(&connection, "view").unwrap();
        let next = require_ready(&connection, "view").unwrap();
        assert!(next.generation > order.generation);
        assert_eq!(
            capture_runs(&connection, &order, &HashSet::from(["page-a"]), false)
                .unwrap_err()
                .code,
            StoreErrorCode::RevisionConflict
        );
        assert_eq!(
            ordered_ids(&connection, &next),
            ["page-a", "page-b", "page-c"]
        );
        while cleanup_order_slice(&connection, 1).unwrap() {}
        assert_eq!(
            ordered_ids(&connection, &next),
            ["page-a", "page-b", "page-c"]
        );
    }

    #[test]
    fn new_views_are_ready_when_empty_and_otherwise_keep_a_durable_preparation_job() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        connection
            .execute(
                "INSERT INTO database_views VALUES ('empty', 'empty-source', 'active')",
                [],
            )
            .unwrap();
        let empty = ready(&connection, "empty")
            .unwrap()
            .expect("empty View is ready");
        assert!(ordered_ids(&connection, &empty).is_empty());
        connection
            .execute(
                "INSERT INTO database_views VALUES ('sibling', 'source', 'active')",
                [],
            )
            .unwrap();
        assert!(ready(&connection, "sibling").unwrap().is_none());
        for _ in 0..16 {
            if prepare_view_slice(&connection, "sibling", 1).unwrap() {
                break;
            }
        }
        let sibling = ready(&connection, "sibling").unwrap().unwrap();
        assert_eq!(
            ordered_ids(&connection, &sibling),
            ["page-a", "page-b", "page-c"]
        );
    }

    #[test]
    fn retired_views_stop_preparation_and_never_reuse_an_old_generation() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        let original = require_ready(&connection, "view").unwrap();
        enqueue_rebalance(&connection, "view").unwrap();
        assert!(!prepare_view_slice(&connection, "view", 1).unwrap());
        retire_view(&connection, "view").unwrap();
        assert!(
            prepare_view_slice(&connection, "view", 1).unwrap(),
            "retired View has no pending job"
        );
        assert!(visible_positions(&connection).is_empty());
        while cleanup_order_slice(&connection, 1).unwrap() {}
        reset_view(&connection, "view").unwrap();
        let restored = require_ready(&connection, "view").unwrap();
        assert!(restored.generation > original.generation + 1);
        assert_eq!(
            ordered_ids(&connection, &restored),
            ["page-a", "page-b", "page-c"]
        );
    }

    #[test]
    fn a_membership_join_updates_ready_views_without_waiting_for_sibling_initialization() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        let original = require_ready(&connection, "view").unwrap();
        connection.execute_batch(
            "INSERT INTO database_views VALUES ('sibling', 'source', 'active');
             INSERT INTO blocks VALUES ('page-0', 'active');
             INSERT INTO pages VALUES ('page-0', 'data_source', 'source');
             INSERT INTO data_source_page_memberships VALUES ('0', 'source', 'page-0', NULL, 'now');"
        ).unwrap();
        join_page(&connection, "page-0", "now").unwrap();
        assert_eq!(
            ordered_ids(&connection, &original),
            ["page-b", "page-0", "page-a", "page-c"]
        );
        assert!(
            ready(&connection, "sibling").unwrap().is_none(),
            "initialization remains a separate job"
        );
        let sibling = require_ready(&connection, "sibling").unwrap();
        assert_eq!(
            ordered_ids(&connection, &sibling),
            ["page-0", "page-a", "page-b", "page-c"]
        );
    }

    #[test]
    fn page_creation_placement_uses_canonical_start_end_and_before_anchors() {
        let connection = Connection::open_in_memory().unwrap();
        install_order_fixture(&connection);
        require_ready(&connection, "view").unwrap();
        connection.execute_batch(
            "INSERT INTO blocks VALUES ('page-0', 'active');
             INSERT INTO pages VALUES ('page-0', 'data_source', 'source');
             INSERT INTO data_source_page_memberships VALUES ('0', 'source', 'page-0', NULL, 'now');"
        ).unwrap();
        for (placement, expected) in [
            (
                ViewOrderPlacement::Start,
                ["page-0", "page-b", "page-a", "page-c"],
            ),
            (
                ViewOrderPlacement::End,
                ["page-b", "page-a", "page-c", "page-0"],
            ),
            (
                ViewOrderPlacement::Before("page-a"),
                ["page-b", "page-0", "page-a", "page-c"],
            ),
        ] {
            let positioned =
                position_page(&connection, "view", "page-0", placement, "now").unwrap();
            let current = active_position(
                &connection,
                &ready(&connection, "view").unwrap().unwrap(),
                "page-0",
            )
            .unwrap();
            assert_eq!(
                (positioned.rank_key, positioned.revision),
                (current.rank_key, current.revision)
            );
            assert_eq!(
                ordered_ids(&connection, &ready(&connection, "view").unwrap().unwrap()),
                expected
            );
        }
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'archived' WHERE id = 'page-c'",
                [],
            )
            .unwrap();
        assert_eq!(
            position_page(
                &connection,
                "view",
                "page-0",
                ViewOrderPlacement::Before("page-c"),
                "now"
            )
            .unwrap_err()
            .code,
            StoreErrorCode::NotFound
        );
    }

    fn ordered_ids(connection: &rusqlite::Connection, order: &ReadyOrder) -> Vec<String> {
        connection.prepare(
            "SELECT page_block_id FROM database_view_order_rows
             WHERE view_id = ?1 AND generation = ?2 AND is_active = 1 ORDER BY rank_key, page_block_id"
        ).unwrap().query_map(rusqlite::params![order.view_id, order.generation], |row| row.get(0))
            .unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    fn visible_positions(connection: &rusqlite::Connection) -> Vec<(String, i64)> {
        connection
            .prepare(
                "SELECT page_block_id, revision FROM database_view_page_positions
             WHERE view_id = 'view' ORDER BY rank_key, page_block_id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }
}
