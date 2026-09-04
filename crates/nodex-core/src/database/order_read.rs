//! Complete ordering and nullable position metadata without a UNION spool.

pub(crate) const POSITION_RANK: &str = "CASE WHEN position.default_epoch = position_state.default_epoch THEN NULL ELSE coalesce(position.rank_key, position_import.rank_key) END";
pub(crate) const POSITION_REVISION: &str = "CASE WHEN position.default_epoch = position_state.default_epoch THEN NULL WHEN position.page_block_id IS NOT NULL THEN max(position.revision, 1) ELSE position_import.revision END";

/// Before publication, reproduce initialization's explicit (rank, Page ID)
/// prefix and implicit Page ID suffix. Hex encoding preserves binary order;
/// the terminator sorts below every hex digit, preserving prefix comparisons.
/// Epoch changes affect optional metadata only, never this complete order.
pub(crate) fn order_rank(page: &str) -> String {
    format!(
        "CASE WHEN position_state.active_generation IS NOT NULL THEN position.rank_key
         WHEN position_import.page_block_id IS NOT NULL
           THEN '0' || hex(position_import.rank_key) || '!' || hex({page})
         ELSE '1' || hex({page}) END"
    )
}

/// Coordinates are trusted SQL expressions from the query builder, never input
/// values. Keep both table probes keyed by View and Page; a LEFT JOIN to the
/// UNION projection would materialize every position in the View.
pub(crate) fn position_joins(view: &str, page: &str) -> String {
    format!(
        "LEFT JOIN database_view_order_state position_state ON position_state.view_id = {view}
         LEFT JOIN database_view_order_rows position
           ON position.view_id = {view} AND position.generation = position_state.active_generation
           AND position.page_block_id = {page}
         LEFT JOIN database_view_order_import_positions position_import
           ON position_import.view_id = {view} AND position_import.page_block_id = {page}
           AND position_state.active_generation IS NULL
           AND (position_state.view_id IS NULL OR position_state.import_enabled = 1)"
    )
}

/// This ordinal is a presentation read, not the bounded positioning planner.
/// Separate range counts preserve import visibility without a UNION spool.
pub(crate) fn preceding_positions(view: &str, page: &str) -> String {
    format!(
        "(SELECT count(*) FROM database_view_order_rows peer
          WHERE peer.view_id = {view} AND peer.generation = position_state.active_generation
            AND (peer.default_epoch IS NULL OR peer.default_epoch <> position_state.default_epoch)
            AND (peer.rank_key, peer.page_block_id) < ({POSITION_RANK}, {page}))
         + (SELECT count(*) FROM database_view_order_import_positions peer
          WHERE position_state.active_generation IS NULL AND peer.view_id = {view}
            AND (position_state.view_id IS NULL OR position_state.import_enabled = 1)
            AND (peer.rank_key, peer.page_block_id) < ({POSITION_RANK}, {page}))"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::manual_order::keyset_identity;
    use rusqlite::Connection;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE database_view_order_state(view_id TEXT PRIMARY KEY, active_generation INTEGER, default_epoch INTEGER, import_enabled INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE database_view_order_rows(view_id TEXT, generation INTEGER, page_block_id TEXT, rank_key TEXT,
               default_epoch INTEGER, revision INTEGER, PRIMARY KEY(view_id, generation, page_block_id)) WITHOUT ROWID;
             CREATE TABLE database_view_order_import_positions(view_id TEXT, page_block_id TEXT, rank_key TEXT,
               revision INTEGER, PRIMARY KEY(view_id, page_block_id)) WITHOUT ROWID;
             CREATE TABLE membership(page_block_id TEXT PRIMARY KEY);
             INSERT INTO membership VALUES ('page');
             INSERT INTO database_view_order_import_positions VALUES ('view', 'page', 'legacy-rank', 3);"
        ).unwrap();
        connection
    }

    fn point_sql() -> String {
        format!(
            "SELECT {POSITION_RANK}, {POSITION_REVISION}, ({ordinal})
                 FROM membership {joins} WHERE membership.page_block_id = ?2",
            joins = position_joins("?1", "membership.page_block_id"),
            ordinal = preceding_positions("?1", "membership.page_block_id")
        )
    }

    fn read(connection: &Connection) -> (Option<String>, Option<i64>, i64) {
        connection
            .query_row(&point_sql(), ["view", "page"], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
    }

    #[test]
    fn nullable_position_follows_publication_freezing_and_generation_changes() {
        let connection = fixture();
        assert_eq!(read(&connection), (Some("legacy-rank".into()), Some(3), 0));
        assert_eq!(keyset_identity(&connection, "view").unwrap(), None);
        connection
            .execute_batch(
            "INSERT INTO database_view_order_state(view_id, active_generation, default_epoch) VALUES ('view', NULL, 1);
             INSERT INTO database_view_order_rows VALUES ('view', 1, 'page', 'new-rank', 1, 0);",
            )
            .unwrap();
        assert_eq!(read(&connection).0.as_deref(), Some("legacy-rank"));
        connection
            .execute(
                "UPDATE database_view_order_state SET active_generation = 1",
                [],
            )
            .unwrap();
        assert_eq!(read(&connection), (None, None, 0));
        assert_eq!(
            keyset_identity(&connection, "view").unwrap(),
            Some((Some(1), 1))
        );
        connection
            .execute("UPDATE database_view_order_state SET default_epoch = 2", [])
            .unwrap();
        assert_eq!(read(&connection), (Some("new-rank".into()), Some(1), 0));
        connection.execute_batch(
            "INSERT INTO database_view_order_rows VALUES ('view', 2, 'page', 'rebalanced-rank', 1, 0);
             UPDATE database_view_order_state SET active_generation = 2;"
        ).unwrap();
        assert_eq!(
            read(&connection),
            (Some("rebalanced-rank".into()), Some(1), 0)
        );
        assert_eq!(
            keyset_identity(&connection, "view").unwrap(),
            Some((Some(2), 2))
        );
    }

    #[test]
    fn complete_order_preserves_import_prefixes_and_default_order_across_publication() {
        let connection = fixture();
        connection
            .execute_batch(
                "INSERT INTO membership VALUES ('id-a'), ('id-z'), ('id-b'), ('id-default');
             INSERT INTO database_view_order_import_positions VALUES
               ('view', 'id-a', 'a', 1), ('view', 'id-z', 'a', 1), ('view', 'id-b', 'aa', 1);",
            )
            .unwrap();
        let ordered = |descending: bool| {
            let sql = format!(
                "SELECT membership.page_block_id FROM membership {} ORDER BY {} {}",
                position_joins("'view'", "membership.page_block_id"),
                order_rank("membership.page_block_id"),
                if descending { "DESC" } else { "ASC" }
            );
            connection
                .prepare(&sql)
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let expected = ["id-a", "id-z", "id-b", "page", "id-default"];
        assert_eq!(ordered(false), expected);
        assert_eq!(
            ordered(true),
            expected.into_iter().rev().collect::<Vec<_>>()
        );
        connection
            .execute(
                "INSERT INTO database_view_order_state VALUES ('view', NULL, 1, 1)",
                [],
            )
            .unwrap();
        for (ordinal, page) in expected.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO database_view_order_rows VALUES ('view', 1, ?1, ?2, ?3, 1)",
                    rusqlite::params![
                        page,
                        format!("{:032x}", ordinal + 1),
                        (*page == "id-default").then_some(1)
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "UPDATE database_view_order_state SET active_generation = 1",
                [],
            )
            .unwrap();
        for epoch in [1, 2] {
            connection
                .execute(
                    "UPDATE database_view_order_state SET default_epoch = ?1",
                    [epoch],
                )
                .unwrap();
            assert_eq!(ordered(false), expected);
            assert_eq!(
                ordered(true),
                expected.into_iter().rev().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn reset_hides_import_positions_before_publication() {
        let connection = fixture();
        connection.execute_batch(
            "INSERT INTO database_view_order_import_positions VALUES ('view', 'before', 'a', 2);
             INSERT INTO database_view_order_state VALUES ('view', NULL, 1, 0);"
        ).unwrap();
        assert_eq!(read(&connection), (None, None, 0));
        connection.execute_batch(
            "INSERT INTO database_view_order_rows VALUES ('view', 2, 'page', 'reset-rank', NULL, 1);
             UPDATE database_view_order_state SET active_generation = 2;"
        ).unwrap();
        assert_eq!(read(&connection), (Some("reset-rank".into()), Some(1), 0));
    }

    #[test]
    fn point_join_does_not_materialize_other_positions() {
        let mut baseline = None;
        for size in [1_000, 10_000, 100_000] {
            let connection = fixture();
            connection.execute_batch(&format!(
                "INSERT INTO database_view_order_state(view_id, active_generation, default_epoch) VALUES ('view', 1, 1);
                 WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<{size})
                 INSERT INTO database_view_order_rows SELECT 'view', 1, printf('other-%06d', n), printf('%032x', n), NULL, 1 FROM ids;"
            )).unwrap();
            let sql = format!(
                "SELECT {POSITION_RANK}, {POSITION_REVISION} FROM membership {} WHERE membership.page_block_id = ?2",
                position_joins("?1", "membership.page_block_id")
            );
            let steps = Arc::new(AtomicUsize::new(0));
            let observed = steps.clone();
            connection
                .progress_handler(
                    1,
                    Some(move || {
                        observed.fetch_add(1, Ordering::Relaxed);
                        false
                    }),
                )
                .unwrap();
            let result = connection
                .query_row(&sql, ["view", "page"], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                    ))
                })
                .unwrap();
            connection
                .progress_handler(0, None::<fn() -> bool>)
                .unwrap();
            assert_eq!(
                result,
                (None, None),
                "published generations must never fall back to import rows"
            );
            let count = steps.load(Ordering::Relaxed);
            let small = *baseline.get_or_insert(count);
            assert!(
                count > 0 && count <= small * 4,
                "point join work grew with View size: {count}"
            );
        }
    }
}
