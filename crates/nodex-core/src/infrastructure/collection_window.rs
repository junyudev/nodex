use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
    DEFAULT_COLLECTION_WINDOW_ITEMS, MAX_COLLECTION_CURSOR_BYTES, MAX_COLLECTION_WINDOW_ITEMS,
    MAX_COLLECTION_WINDOW_JSON_BYTES,
};
use serde::Serialize;

use super::cursor::KeysetCoordinate;
use super::sqlite::{StoreError, StoreErrorCode};

#[derive(Debug)]
pub struct NormalizedWindowRequest<'a> {
    pub after: Option<&'a str>,
    pub first: usize,
}

pub struct WindowCandidate<T> {
    pub item: T,
    pub coordinate: KeysetCoordinate,
}

pub fn normalize_request(
    request: &CollectionWindowRequest,
) -> Result<NormalizedWindowRequest<'_>, StoreError> {
    let first = request.first.unwrap_or(DEFAULT_COLLECTION_WINDOW_ITEMS);
    if !(1..=MAX_COLLECTION_WINDOW_ITEMS).contains(&first) {
        return Err(invalid("Collection window size is out of range"));
    }
    if request
        .after
        .as_ref()
        .is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_COLLECTION_CURSOR_BYTES)
    {
        return Err(invalid("Collection cursor is malformed"));
    }
    Ok(NormalizedWindowRequest {
        after: request.after.as_deref(),
        first: usize::try_from(first).map_err(|_| invalid("Collection window size is invalid"))?,
    })
}

/// Assembles a response from an already keyset-bounded source iterator.
///
/// The iterator must yield rows in canonical order and should be backed by a
/// query with `LIMIT first + 1`. This helper stops after the first overflow
/// candidate, but it intentionally does not turn an unbounded in-memory query
/// into acceptable pagination.
pub fn assemble<T, I, Mint>(
    candidates: I,
    first: usize,
    authority: CollectionWindowAuthority,
    mint_cursor: Mint,
) -> Result<CollectionWindow<T>, StoreError>
where
    T: Serialize,
    I: IntoIterator<Item = WindowCandidate<T>>,
    Mint: FnOnce(&KeysetCoordinate) -> Result<String, StoreError>,
{
    assemble_with_budget(
        candidates,
        first,
        authority,
        MAX_COLLECTION_WINDOW_JSON_BYTES,
        mint_cursor,
    )
}

pub(crate) fn assemble_with_budget<T, I, Mint>(
    candidates: I,
    first: usize,
    authority: CollectionWindowAuthority,
    maximum_json_bytes: usize,
    mint_cursor: Mint,
) -> Result<CollectionWindow<T>, StoreError>
where
    T: Serialize,
    I: IntoIterator<Item = WindowCandidate<T>>,
    Mint: FnOnce(&KeysetCoordinate) -> Result<String, StoreError>,
{
    if !(1..=usize::try_from(MAX_COLLECTION_WINDOW_ITEMS).expect("window limit fits usize"))
        .contains(&first)
    {
        return Err(invalid("Collection window size is out of range"));
    }
    let reserved_envelope_bytes = serde_json::to_vec(&serde_json::json!({
        "items": [],
        "next_cursor": "x".repeat(MAX_COLLECTION_CURSOR_BYTES),
        "authority": authority,
    }))
    .map_err(|_| internal("Collection window envelope cannot be encoded"))?
    .len();
    if reserved_envelope_bytes >= maximum_json_bytes {
        return Err(resource_exhausted(
            "Collection response budget cannot hold its envelope",
        ));
    }
    let maximum_items_bytes = maximum_json_bytes - reserved_envelope_bytes;
    let mut items = Vec::new();
    let mut encoded_items_bytes = 0_usize;
    let mut last_coordinate = None;
    let mut has_more = false;

    for candidate in candidates {
        if items.len() == first {
            has_more = true;
            break;
        }
        let encoded_item_bytes = serde_json::to_vec(&candidate.item)
            .map_err(|_| internal("Collection item cannot be encoded"))?
            .len();
        let separator_bytes = usize::from(!items.is_empty());
        let next_items_bytes = encoded_items_bytes
            .checked_add(separator_bytes)
            .and_then(|size| size.checked_add(encoded_item_bytes))
            .ok_or_else(|| resource_exhausted("Collection item budget overflowed"))?;
        if next_items_bytes > maximum_items_bytes {
            if items.is_empty() {
                return Err(resource_exhausted(
                    "A collection item exceeds the response budget",
                ));
            }
            has_more = true;
            break;
        }
        encoded_items_bytes = next_items_bytes;
        last_coordinate = Some(candidate.coordinate);
        items.push(candidate.item);
    }

    let next_cursor = if has_more {
        let coordinate = last_coordinate
            .as_ref()
            .ok_or_else(|| internal("Collection continuation has no coordinate"))?;
        Some(mint_cursor(coordinate)?)
    } else {
        None
    };
    let window = CollectionWindow {
        items,
        next_cursor,
        authority,
    };
    let encoded_bytes = serde_json::to_vec(&window)
        .map_err(|_| internal("Collection window cannot be encoded"))?
        .len();
    if encoded_bytes > maximum_json_bytes {
        return Err(internal("Collection window exceeded its assembled budget"));
    }
    Ok(window)
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn resource_exhausted(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use super::super::cursor::KeysetValue;
    use super::*;

    fn candidate(id: &str, value: String) -> WindowCandidate<String> {
        WindowCandidate {
            item: value,
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Text {
                    value: id.to_owned(),
                }],
                stable_id: id.to_owned(),
            },
        }
    }

    #[test]
    fn request_normalization_enforces_count_and_cursor_bounds() {
        assert_eq!(
            normalize_request(&CollectionWindowRequest::default())
                .expect("default window")
                .first,
            50
        );
        assert_eq!(
            normalize_request(&CollectionWindowRequest {
                after: None,
                first: Some(0),
            })
            .expect_err("zero window must fail")
            .code,
            StoreErrorCode::InvalidInput
        );
        assert_eq!(
            normalize_request(&CollectionWindowRequest {
                after: Some("x".repeat(MAX_COLLECTION_CURSOR_BYTES + 1)),
                first: Some(1),
            })
            .expect_err("oversized cursor must fail")
            .code,
            StoreErrorCode::InvalidInput
        );
        assert_eq!(
            normalize_request(&CollectionWindowRequest {
                after: None,
                first: Some(MAX_COLLECTION_WINDOW_ITEMS + 1),
            })
            .expect_err("window above the maximum must fail")
            .code,
            StoreErrorCode::InvalidInput
        );
    }

    #[test]
    fn count_budget_returns_a_cursor_for_the_last_included_coordinate() {
        let window = assemble_with_budget(
            [
                candidate("task-1", "one".to_owned()),
                candidate("task-2", "two".to_owned()),
                candidate("task-3", "three".to_owned()),
            ],
            2,
            CollectionWindowAuthority {
                projection_revision: 7,
            },
            8 * 1024,
            |coordinate| Ok(format!("after:{}", coordinate.stable_id)),
        )
        .expect("bounded window");

        assert_eq!(window.items, ["one", "two"]);
        assert_eq!(window.next_cursor.as_deref(), Some("after:task-2"));
    }

    #[test]
    fn byte_budget_counts_encoded_unicode_and_stops_before_overflow() {
        let wide = "界".repeat(1_200);
        let window = assemble_with_budget(
            [candidate("task-1", wide.clone()), candidate("task-2", wide)],
            2,
            CollectionWindowAuthority {
                projection_revision: 7,
            },
            8 * 1024,
            |coordinate| Ok(format!("after:{}", coordinate.stable_id)),
        )
        .expect("byte-bounded window");

        assert_eq!(window.items.len(), 1);
        assert_eq!(window.next_cursor.as_deref(), Some("after:task-1"));
        assert!(serde_json::to_vec(&window).expect("window JSON").len() <= 8 * 1024);
    }

    #[test]
    fn one_item_larger_than_the_budget_is_a_typed_error() {
        let error = assemble_with_budget(
            [candidate("task-1", "界".repeat(3_000))],
            1,
            CollectionWindowAuthority {
                projection_revision: 7,
            },
            8 * 1024,
            |_| Ok("unused".to_owned()),
        )
        .expect_err("oversized item must fail");

        assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
    }
}
