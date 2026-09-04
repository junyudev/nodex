use std::collections::BTreeMap;

pub const MAX_REBALANCE_ITEMS: usize = 100_000;
const RANK_WIDTH: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RankedItem {
    pub id: String,
    pub rank_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FractionalRankPlan {
    pub rank_key: String,
    pub rebalanced_rank_keys: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FractionalRankErrorCode {
    AnchorNotFound,
    RebalanceLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FractionalRankError {
    pub code: FractionalRankErrorCode,
    pub message: String,
}

pub fn is_fractional_rank_key(value: &str) -> bool {
    value.len() == RANK_WIDTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn evenly_spaced_rank(index: usize, total: usize) -> String {
    let divisor = (total + 1) as u128;
    let ordinal = (index + 1) as u128;
    let value = (u128::MAX / divisor) * ordinal + ((u128::MAX % divisor) * ordinal) / divisor;
    format!("{value:032x}")
}

pub fn materialize_order(ids: &[String]) -> Result<BTreeMap<String, String>, FractionalRankError> {
    make_rebalanced_ranks(ids)
}

/// Allocate a whole run inside an open interval without consuming its gap by
/// repeated halving. `None` asks the caller for wider, bounded neighbor evidence.
pub fn rank_run_between(
    left: Option<&str>,
    right: Option<&str>,
    count: usize,
) -> Option<Vec<String>> {
    if count == 0 || count > MAX_REBALANCE_ITEMS {
        return None;
    }
    let parse = |rank: &str| {
        is_fractional_rank_key(rank)
            .then(|| u128::from_str_radix(rank, 16).ok())
            .flatten()
    };
    let left = left.map(parse).unwrap_or(Some(0))?;
    let right = right.map(parse).unwrap_or(Some(u128::MAX))?;
    let distance = right.checked_sub(left)?;
    let divisor = count as u128 + 1;
    if distance < divisor {
        return None;
    }
    Some(
        (1..=count)
            .map(|ordinal| {
                let ordinal = ordinal as u128;
                let offset =
                    (distance / divisor) * ordinal + ((distance % divisor) * ordinal) / divisor;
                format!("{:032x}", left + offset)
            })
            .collect(),
    )
}

pub fn plan(
    items: &[RankedItem],
    target_id: &str,
    before_id: Option<&str>,
) -> Result<FractionalRankPlan, FractionalRankError> {
    let items = items
        .iter()
        .filter(|item| item.id != target_id)
        .cloned()
        .collect::<Vec<_>>();
    let anchor_index = if let Some(before_id) = before_id {
        items
            .iter()
            .position(|item| item.id == before_id)
            .ok_or_else(|| FractionalRankError {
                code: FractionalRankErrorCode::AnchorNotFound,
                message: format!("Fractional order anchor does not exist: {before_id}"),
            })?
    } else {
        items.len()
    };

    let mut rebalanced_rank_keys = BTreeMap::new();
    let mut effective_items = items.clone();
    if requires_rebalance(&items) {
        rebalanced_rank_keys =
            make_rebalanced_ranks(&items.iter().map(|item| item.id.clone()).collect::<Vec<_>>())?;
        effective_items = apply_rebalanced_ranks(&items, &rebalanced_rank_keys);
    }
    if let Some(rank_key) = rank_between(
        read_rank(&effective_items, anchor_index.wrapping_sub(1)),
        read_rank(&effective_items, anchor_index),
    ) {
        return Ok(FractionalRankPlan {
            rank_key,
            rebalanced_rank_keys,
        });
    }

    rebalanced_rank_keys =
        make_rebalanced_ranks(&items.iter().map(|item| item.id.clone()).collect::<Vec<_>>())?;
    effective_items = apply_rebalanced_ranks(&items, &rebalanced_rank_keys);
    let rank_key = rank_between(
        read_rank(&effective_items, anchor_index.wrapping_sub(1)),
        read_rank(&effective_items, anchor_index),
    )
    .ok_or_else(|| FractionalRankError {
        code: FractionalRankErrorCode::RebalanceLimit,
        message: "Fractional rank space remained exhausted after a bounded rebalance".to_owned(),
    })?;
    Ok(FractionalRankPlan {
        rank_key,
        rebalanced_rank_keys,
    })
}

fn rank_between(left: Option<&str>, right: Option<&str>) -> Option<String> {
    let left = left
        .map(|rank| u128::from_str_radix(rank, 16).ok())
        .unwrap_or(Some(0))?;
    let right = right
        .map(|rank| u128::from_str_radix(rank, 16).ok())
        .unwrap_or(Some(u128::MAX))?;
    let distance = right.checked_sub(left)?;
    if distance <= 1 {
        return None;
    }
    Some(format!("{:032x}", left + distance / 2))
}

fn read_rank(items: &[RankedItem], index: usize) -> Option<&str> {
    items.get(index).map(|item| item.rank_key.as_str())
}

fn requires_rebalance(items: &[RankedItem]) -> bool {
    let mut previous: Option<&str> = None;
    for item in items {
        if !is_fractional_rank_key(&item.rank_key)
            || previous.is_some_and(|previous| item.rank_key.as_str() <= previous)
        {
            return true;
        }
        previous = Some(&item.rank_key);
    }
    false
}

fn make_rebalanced_ranks(ids: &[String]) -> Result<BTreeMap<String, String>, FractionalRankError> {
    if ids.len() > MAX_REBALANCE_ITEMS {
        return Err(FractionalRankError {
            code: FractionalRankErrorCode::RebalanceLimit,
            message: format!(
                "Fractional order contains {} items; the bounded rebalance limit is {MAX_REBALANCE_ITEMS}",
                ids.len()
            ),
        });
    }
    Ok(ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), evenly_spaced_rank(index, ids.len())))
        .collect())
}

fn apply_rebalanced_ranks(
    items: &[RankedItem],
    ranks: &BTreeMap<String, String>,
) -> Vec<RankedItem> {
    items
        .iter()
        .map(|item| RankedItem {
            id: item.id.clone(),
            rank_key: ranks
                .get(&item.id)
                .cloned()
                .unwrap_or_else(|| item.rank_key.clone()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_run_uses_open_interval_and_reports_insufficient_space() {
        let left = "0000000000000000000000000000000a";
        let right = "0000000000000000000000000000000d";
        assert_eq!(
            rank_run_between(Some(left), Some(right), 2),
            Some(vec![
                "0000000000000000000000000000000b".to_owned(),
                "0000000000000000000000000000000c".to_owned(),
            ])
        );
        for (lower, upper, count) in [
            (Some(left), Some(right), 3),
            (Some(left), Some(left), 1),
            (Some(right), Some(left), 1),
            (Some("bad-rank"), Some(right), 1),
            (None, None, 0),
            (None, None, MAX_REBALANCE_ITEMS + 1),
        ] {
            assert_eq!(rank_run_between(lower, upper, count), None);
        }
        let all = rank_run_between(None, None, MAX_REBALANCE_ITEMS).expect("full rank interval");
        assert_eq!(all.len(), MAX_REBALANCE_ITEMS);
        assert!(all.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(all.first().unwrap().as_str() > "00000000000000000000000000000000");
        assert!(all.last().unwrap().as_str() < "ffffffffffffffffffffffffffffffff");
    }

    #[test]
    fn matches_the_typescript_append_and_rebalance_vectors() {
        let items = (0..8)
            .map(|index| RankedItem {
                id: format!("item-{index}"),
                rank_key: evenly_spaced_rank(index, 8),
            })
            .collect::<Vec<_>>();
        let appended = plan(&items, "new", None).expect("append rank");
        assert_eq!(appended.rank_key, "f1c71c71c71c71c71c71c71c71c71c70");
        assert!(appended.rebalanced_rank_keys.is_empty());

        let exhausted = vec![
            RankedItem {
                id: "left".to_owned(),
                rank_key: "00000000000000000000000000000001".to_owned(),
            },
            RankedItem {
                id: "right".to_owned(),
                rank_key: "00000000000000000000000000000002".to_owned(),
            },
        ];
        let inserted = plan(&exhausted, "new", Some("right")).expect("rebalanced rank");
        assert_eq!(inserted.rank_key, "7fffffffffffffffffffffffffffffff");
        assert_eq!(
            inserted.rebalanced_rank_keys["left"],
            "55555555555555555555555555555555"
        );
        assert_eq!(
            inserted.rebalanced_rank_keys["right"],
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }
}
