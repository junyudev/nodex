//! Promotion retirement preserves membership and manual-position identities.
//! Inactive memberships do not participate in a View's canonical row order.

use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum PromotionPlacement {
    Library {
        rank_key: String,
        previous_sibling_id: Option<String>,
        next_sibling_id: Option<String>,
    },
    DataSource {
        database_id: String,
        data_source_id: String,
        membership_id: String,
        view_ids: Vec<String>,
    },
}

impl PromotionPlacement {
    pub(super) fn capture(
        connection: &Connection,
        library_id: &str,
        page_id: &str,
    ) -> Result<Self, StoreError> {
        let (kind, parent): (String, String) = connection.query_row(
            "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
            [page_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if kind == "library" {
            let (previous_sibling_id, next_sibling_id) =
                library_sibling_anchors(connection, library_id, page_id)?;
            let rank_key = connection.query_row(
                "SELECT rank_key FROM library_block_placements WHERE block_id = ?1",
                [page_id],
                |row| row.get(0),
            )?;
            return Ok(Self::Library {
                rank_key,
                previous_sibling_id,
                next_sibling_id,
            });
        }
        if kind != "data_source" {
            return Err(corrupt("Promotion has an unsupported parent"));
        }
        let (database_id, membership_id) = connection.query_row("SELECT source.home_database_block_id, membership.id FROM data_source_page_memberships membership JOIN data_sources source ON source.id = membership.data_source_id WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 AND membership.removed_at IS NULL", params![parent, page_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let view_ids = crate::database::retained_position_witnesses(connection, page_id)?
            .into_iter()
            .map(|position| position.view_id)
            .collect();
        Ok(Self::DataSource {
            database_id,
            data_source_id: parent,
            membership_id,
            view_ids,
        })
    }

    pub(super) fn rank_key(&self) -> &str {
        match self {
            Self::Library { rank_key, .. } => rank_key,
            Self::DataSource { .. } => "",
        }
    }

    pub(super) fn parent<'a>(&'a self, library_id: &'a str) -> (&'static str, &'a str) {
        match self {
            Self::Library { .. } => ("library", library_id),
            Self::DataSource { data_source_id, .. } => ("data_source", data_source_id),
        }
    }

    pub(super) fn authorize(
        &self,
        connection: &Connection,
        recipe: &BlockTransferUndoRecipeV4,
    ) -> Result<(), StoreError> {
        let Self::DataSource { data_source_id, .. } = self else {
            return Ok(());
        };
        validate_page_transfer_data_source_source(
            connection,
            &recipe.library_id,
            &recipe.project_id,
            data_source_id,
        )
    }

    pub(super) fn retire(
        &self,
        connection: &Connection,
        page_id: &str,
        now: &str,
    ) -> Result<(), StoreError> {
        let Self::DataSource {
            data_source_id,
            membership_id,
            ..
        } = self
        else {
            return Ok(());
        };
        let changed = connection.execute("UPDATE data_source_page_memberships SET removed_at = ?1, revision = revision + 1 WHERE id = ?2 AND data_source_id = ?3 AND page_block_id = ?4 AND removed_at IS NULL", params![now, membership_id, data_source_id, page_id])?;
        if changed != 1 {
            return Err(conflict("Promotion membership changed before Undo"));
        }
        crate::database::refresh_copied_page_projection(connection, page_id, None, None, now)
    }

    pub(super) fn restore(
        &self,
        connection: &Connection,
        library_id: &str,
        page_id: &str,
        now: &str,
    ) -> Result<(), StoreError> {
        match self {
            Self::Library {
                previous_sibling_id,
                next_sibling_id,
                ..
            } => {
                let before = resolve_library_page_relocation_anchor(
                    connection,
                    library_id,
                    previous_sibling_id.as_deref(),
                    next_sibling_id.as_deref(),
                )?;
                let anchor = before
                    .as_deref()
                    .map(|id| read_library_anchor(connection, library_id, id))
                    .transpose()?;
                insert_library_placement(connection, library_id, page_id, anchor.as_ref(), now)?;
            }
            Self::DataSource {
                data_source_id,
                membership_id,
                ..
            } => {
                let changed = connection.execute("UPDATE data_source_page_memberships SET removed_at = NULL, revision = revision + 1 WHERE id = ?1 AND data_source_id = ?2 AND page_block_id = ?3 AND removed_at IS NOT NULL", params![membership_id, data_source_id, page_id])?;
                if changed != 1 {
                    return Err(conflict("Promotion membership changed before Redo"));
                }
            }
        }
        Ok(())
    }

    pub(super) fn refresh(
        &self,
        connection: &Connection,
        page_id: &str,
        now: &str,
    ) -> Result<(), StoreError> {
        let Self::DataSource {
            data_source_id,
            membership_id,
            ..
        } = self
        else {
            return refresh_lifecycle_projection(connection, page_id, now);
        };
        crate::database::refresh_copied_page_projection(
            connection,
            page_id,
            Some(membership_id),
            Some(data_source_id),
            now,
        )
    }

    pub(super) fn data_source_id(&self) -> Option<&str> {
        match self {
            Self::Library { .. } => None,
            Self::DataSource { data_source_id, .. } => Some(data_source_id),
        }
    }

    pub(super) fn database_id(&self) -> Option<&str> {
        match self {
            Self::Library { .. } => None,
            Self::DataSource { database_id, .. } => Some(database_id),
        }
    }

    pub(super) fn view_ids(&self) -> &[String] {
        match self {
            Self::Library { .. } => &[],
            Self::DataSource { view_ids, .. } => view_ids,
        }
    }

    pub(super) fn revisions(
        &self,
        connection: &Connection,
    ) -> Result<BTreeMap<String, i64>, StoreError> {
        let Self::DataSource {
            data_source_id,
            membership_id,
            ..
        } = self
        else {
            return Ok(BTreeMap::new());
        };
        let revision = connection.query_row(
            "SELECT revision FROM data_source_page_memberships WHERE id = ?1",
            [membership_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(BTreeMap::from([(
            format!("membership:{data_source_id}:{membership_id}"),
            revision,
        )]))
    }
}

pub(super) fn normalize_batch_anchors(pages: &mut [PromotionPage]) {
    let mut order = (0..pages.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| {
        (pages[*a].placement.rank_key(), &pages[*a].page_id)
            .cmp(&(pages[*b].placement.rank_key(), &pages[*b].page_id))
    });
    let mut successors: BTreeMap<String, Option<String>> = BTreeMap::new();
    for index in order.into_iter().rev() {
        let page = &mut pages[index];
        let PromotionPlacement::Library {
            next_sibling_id, ..
        } = &mut page.placement
        else {
            continue;
        };
        if let Some(next) = next_sibling_id.as_ref().and_then(|id| successors.get(id)) {
            *next_sibling_id = next.clone();
        }
        successors.insert(page.page_id.clone(), next_sibling_id.clone());
    }
}
