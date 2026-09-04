use std::collections::{BTreeMap, HashSet};

use super::fractional_rank::{FractionalRankError, materialize_order, rank_run_between};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogicalPositionItem {
    pub page_id: String,
    pub rank_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogicalPositionRun {
    pub page_ids: Vec<String>,
    pub before_page_id: Option<String>,
}

/// Snapshot only selected runs and their next unselected anchors. Technical
/// rank changes and unrelated edits outside these slots do not invalidate them.
pub fn capture_position_runs(
    ordered_page_ids: &[String],
    selected_page_ids: &HashSet<&str>,
) -> Result<Vec<LogicalPositionRun>, PositionPlanError> {
    let mut runs = Vec::new();
    let mut current = Vec::new();
    let mut present = 0;
    for page_id in ordered_page_ids {
        if selected_page_ids.contains(page_id.as_str()) {
            current.push(page_id.clone());
            present += 1;
            continue;
        }
        if current.is_empty() {
            continue;
        }
        runs.push(LogicalPositionRun {
            page_ids: std::mem::take(&mut current),
            before_page_id: Some(page_id.clone()),
        });
    }
    if present != selected_page_ids.len() {
        return Err(PositionPlanError::InvalidInput(
            "An affected Page is no longer in its ordered scope".to_owned(),
        ));
    }
    if !current.is_empty() {
        runs.push(LogicalPositionRun {
            page_ids: current,
            before_page_id: None,
        });
    }
    Ok(runs)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SiblingRankWriteKind {
    Materialize,
    Rebalance,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SiblingRankWrite {
    pub kind: SiblingRankWriteKind,
    pub page_id: String,
    pub rank_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionRunPlan {
    pub moved_rank_keys: BTreeMap<String, String>,
    pub sibling_writes: Vec<SiblingRankWrite>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PositionPlanError {
    InvalidInput(String),
    AnchorNotFound(String),
    FractionalRank(FractionalRankError),
}

pub fn plan_position_run(
    logical_group_order: &[LogicalPositionItem],
    moved_page_ids: &[String],
    before_page_id: Option<&str>,
    descending: bool,
) -> Result<PositionRunPlan, PositionPlanError> {
    if moved_page_ids.is_empty() {
        return Err(PositionPlanError::InvalidInput(
            "An ordered Page run requires at least one Page".to_owned(),
        ));
    }
    require_unique(moved_page_ids.iter().map(String::as_str), "Moved Page set")?;
    require_unique(
        logical_group_order.iter().map(|item| item.page_id.as_str()),
        "Ordered Page scope",
    )?;

    let moved = moved_page_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if before_page_id.is_some_and(|page_id| moved.contains(page_id)) {
        return Err(PositionPlanError::InvalidInput(
            "Ordered Page anchor must be outside the moved Page set".to_owned(),
        ));
    }
    let remaining = logical_group_order
        .iter()
        .filter(|item| !moved.contains(item.page_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let anchor_index = match before_page_id {
        Some(anchor) => remaining
            .iter()
            .position(|item| item.page_id == anchor)
            .ok_or_else(|| {
                PositionPlanError::AnchorNotFound(format!(
                    "Ordered Page anchor does not exist in the target scope: {anchor}"
                ))
            })?,
        None => remaining.len(),
    };

    let mut visual_page_ids = remaining
        .iter()
        .map(|item| item.page_id.clone())
        .collect::<Vec<_>>();
    visual_page_ids.splice(anchor_index..anchor_index, moved_page_ids.iter().cloned());
    let mut physical_page_ids = visual_page_ids;
    let mut physical_remaining = remaining.clone();
    let mut physical_moved_page_ids = moved_page_ids.to_vec();
    if descending {
        physical_page_ids.reverse();
        physical_remaining.reverse();
        physical_moved_page_ids.reverse();
    }
    let physical_moved_index = physical_page_ids
        .iter()
        .position(|page_id| moved.contains(page_id.as_str()))
        .ok_or_else(|| {
            PositionPlanError::InvalidInput("Rank plan omitted the moved Page run".to_owned())
        })?;
    let physical_before_page_id = physical_page_ids
        .get(physical_moved_index + physical_moved_page_ids.len())
        .map(String::as_str);

    if remaining.iter().any(|item| item.rank_key.is_none()) {
        return plan_materialized_run(&remaining, moved_page_ids, &physical_page_ids);
    }
    plan_ranked_run(
        &physical_remaining,
        &physical_moved_page_ids,
        physical_before_page_id,
    )
}

fn require_unique<'a>(
    ids: impl Iterator<Item = &'a str>,
    label: &str,
) -> Result<(), PositionPlanError> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(PositionPlanError::InvalidInput(format!(
                "{label} must contain unique Page IDs"
            )));
        }
    }
    Ok(())
}

fn plan_materialized_run(
    remaining: &[LogicalPositionItem],
    moved_page_ids: &[String],
    physical_page_ids: &[String],
) -> Result<PositionRunPlan, PositionPlanError> {
    let rank_keys =
        materialize_order(physical_page_ids).map_err(PositionPlanError::FractionalRank)?;
    let moved_rank_keys = moved_page_ids
        .iter()
        .map(|page_id| {
            rank_keys
                .get(page_id)
                .cloned()
                .map(|rank_key| (page_id.clone(), rank_key))
                .ok_or_else(|| {
                    PositionPlanError::InvalidInput(format!("Rank plan omitted Page {page_id}"))
                })
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let sibling_writes = remaining
        .iter()
        .filter_map(|item| {
            let rank_key = rank_keys.get(&item.page_id)?.clone();
            (item.rank_key.as_deref() != Some(rank_key.as_str())).then(|| SiblingRankWrite {
                kind: if item.rank_key.is_none() {
                    SiblingRankWriteKind::Materialize
                } else {
                    SiblingRankWriteKind::Rebalance
                },
                page_id: item.page_id.clone(),
                rank_key,
            })
        })
        .collect();
    Ok(PositionRunPlan {
        moved_rank_keys,
        sibling_writes,
    })
}

fn plan_ranked_run(
    remaining: &[LogicalPositionItem],
    moved_page_ids: &[String],
    before_page_id: Option<&str>,
) -> Result<PositionRunPlan, PositionPlanError> {
    let anchor = match before_page_id {
        None => remaining.len(),
        Some(id) => remaining
            .iter()
            .position(|item| item.page_id == id)
            .ok_or_else(|| {
                PositionPlanError::AnchorNotFound(format!(
                    "Ordered Page anchor does not exist: {id}"
                ))
            })?,
    };
    let left = anchor
        .checked_sub(1)
        .and_then(|index| remaining[index].rank_key.as_deref());
    let right = remaining
        .get(anchor)
        .and_then(|item| item.rank_key.as_deref());
    if let Some(ranks) = rank_run_between(left, right, moved_page_ids.len()) {
        return Ok(PositionRunPlan {
            moved_rank_keys: moved_page_ids.iter().cloned().zip(ranks).collect(),
            sibling_writes: Vec::new(),
        });
    }
    let mut physical_page_ids = remaining
        .iter()
        .map(|item| item.page_id.clone())
        .collect::<Vec<_>>();
    physical_page_ids.splice(anchor..anchor, moved_page_ids.iter().cloned());
    plan_materialized_run(remaining, moved_page_ids, &physical_page_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranked(page_id: &str, rank_key: &str) -> LogicalPositionItem {
        LogicalPositionItem {
            page_id: page_id.to_owned(),
            rank_key: Some(rank_key.to_owned()),
        }
    }

    #[test]
    fn preserves_localized_gaps_for_a_ranked_bulk_append() {
        let items = vec![
            ranked("source", "55555555555555555555555555555555"),
            ranked("anchor", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ];
        let plan = plan_position_run(
            &items,
            &["source".to_owned(), "anchor".to_owned()],
            None,
            false,
        )
        .expect("bulk append plan");

        assert!(plan.moved_rank_keys["source"] < plan.moved_rank_keys["anchor"]);
        assert!(plan.sibling_writes.is_empty());
    }

    #[test]
    fn materializes_unpositioned_siblings_in_complete_logical_order() {
        let items = vec![
            ranked("positioned", "40000000000000000000000000000000"),
            LogicalPositionItem {
                page_id: "unpositioned".to_owned(),
                rank_key: None,
            },
            LogicalPositionItem {
                page_id: "moved".to_owned(),
                rank_key: None,
            },
        ];
        let plan = plan_position_run(&items, &["moved".to_owned()], Some("unpositioned"), false)
            .expect("materialized plan");

        assert_eq!(
            plan.sibling_writes
                .iter()
                .filter(|write| write.kind == SiblingRankWriteKind::Materialize)
                .count(),
            1
        );
    }

    #[test]
    fn allocates_a_full_bulk_run_without_rebalancing_available_neighbor_space() {
        let items = vec![
            ranked("left", "00000000000000000000000000001000"),
            ranked("right", "00000000000000000000000000003000"),
        ];
        let moved = (0..4096)
            .map(|index| format!("moved-{index}"))
            .collect::<Vec<_>>();
        for descending in [false, true] {
            let mut logical = items.clone();
            if descending {
                logical.reverse();
            }
            let plan = plan_position_run(
                &logical,
                &moved,
                Some(if descending { "left" } else { "right" }),
                descending,
            )
            .expect("one bulk run fits between its neighbors");
            assert!(
                plan.sibling_writes.is_empty(),
                "available rank space must not move neighbors"
            );
            let ranks = moved
                .iter()
                .map(|id| plan.moved_rank_keys[id].as_str())
                .collect::<Vec<_>>();
            assert_eq!(ranks.len(), 4096);
            assert!(
                ranks
                    .iter()
                    .all(|rank| *rank > "00000000000000000000000000001000"
                        && *rank < "00000000000000000000000000003000")
            );
            assert!(ranks.windows(2).all(|pair| if descending {
                pair[0] > pair[1]
            } else {
                pair[0] < pair[1]
            }));
        }
    }
}
