use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::{
    Actor,
    discussions::{DiscussionCommandResult, RunRevertConflict},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::{Operation, decode, encode, invalid, page_document};
use crate::document::{DocumentBlockOperation, DocumentBlockUpdatePatch, discussion_marks};
use crate::domain::{block_materialization::MaterializedBlockNode, markdown::materialize_markdown};
use crate::infrastructure::sqlite::StoreError;

#[derive(Clone, Serialize, Deserialize)]
struct State {
    block: MaterializedBlockNode,
    markdown: String,
    parent: Option<String>,
}

impl State {
    fn equivalent(&self, other: &Self) -> bool {
        self.markdown == other.markdown
    }
}

fn equivalent(a: Option<&State>, b: Option<&State>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.equivalent(b),
        (None, None) => true,
        _ => false,
    }
}

struct Location<'a> {
    block: &'a MaterializedBlockNode,
    parent: Option<&'a str>,
}

fn index(blocks: &[MaterializedBlockNode]) -> BTreeMap<&str, Location<'_>> {
    fn visit<'a>(
        blocks: &'a [MaterializedBlockNode],
        parent: Option<&'a str>,
        out: &mut BTreeMap<&'a str, Location<'a>>,
    ) {
        for block in blocks {
            if matches!(block.block_type.as_str(), "page" | "database" | "canvas") {
                continue;
            }
            out.insert(&block.id, Location { block, parent });
            visit(&block.children, Some(&block.id), out);
        }
    }
    let mut out = BTreeMap::new();
    visit(blocks, None, &mut out);
    out
}

fn snapshot(location: &Location<'_>) -> Result<State, StoreError> {
    let mut block = location.block.clone();
    block.children.clear();
    let markdown = materialize_markdown(std::slice::from_ref(&block))
        .map_err(|e| invalid(e.to_string()))?
        .markdown;
    Ok(State {
        block,
        markdown,
        parent: location.parent.map(str::to_owned),
    })
}

pub(crate) fn record(
    connection: &Connection,
    page: &str,
    actor: &Actor,
    before: &[MaterializedBlockNode],
    after: &[MaterializedBlockNode],
) -> Result<(), StoreError> {
    let Actor::Agent {
        session_id,
        run_id: Some(run_id),
        ..
    } = actor
    else {
        return Ok(());
    };
    if before == after {
        return Ok(());
    }

    let old = index(before);
    let new = index(after);
    let mut lookup = connection.prepare_cached(
        "SELECT after_json,interleaved FROM page_run_block_changes WHERE page_id=?1 AND session_id=?2 AND run_id=?3 AND block_id=?4",
    )?;
    let mut update = connection.prepare_cached(
        "INSERT INTO page_run_block_changes(page_id,session_id,run_id,block_id,before_json,after_json,interleaved)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(page_id,run_id,session_id,block_id) DO UPDATE
           SET after_json=excluded.after_json,interleaved=excluded.interleaved",
    )?;
    for id in old
        .keys()
        .chain(new.keys())
        .copied()
        .collect::<BTreeSet<_>>()
    {
        let a = old.get(id);
        let b = new.get(id);
        if let (Some(a), Some(b)) = (a, b)
            && a.block.block_type == b.block.block_type
            && a.block.props == b.block.props
            && a.block.content == b.block.content
            && a.parent == b.parent
            && a.block.children.iter().map(|child| &child.id).eq(b
                .block
                .children
                .iter()
                .map(|child| &child.id))
        {
            continue;
        }
        let before = a.map(snapshot).transpose()?;
        let after = b.map(snapshot).transpose()?;
        if equivalent(before.as_ref(), after.as_ref()) {
            continue;
        }
        let remembered = lookup.query_row(params![page, session_id, run_id, id], |r| {
            Ok((decode::<Option<State>>(r, 0)?, r.get::<_, bool>(1)?))
        });
        let interleaved = match remembered {
            Ok((previous, changed)) => changed || !equivalent(previous.as_ref(), before.as_ref()),
            Err(rusqlite::Error::QueryReturnedNoRows) => false,
            Err(error) => return Err(error.into()),
        };
        update.execute(params![
            page,
            session_id,
            run_id,
            id,
            encode(&before)?,
            encode(&after)?,
            interleaved
        ])?;
    }
    Ok(())
}

pub(super) fn revert(
    operation: &mut Operation<'_>,
    page: &str,
    run_id: &str,
) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
    if run_id.is_empty() || run_id.len() > 512 {
        return Err(invalid("Run identity is invalid"));
    }
    let connection = operation.connection;
    let document = page_document(connection, page)?;
    let current = index(&document.base_materialization.block_tree);
    let mut statement = connection.prepare(
        "SELECT block_id,before_json,after_json,interleaved
         FROM page_run_block_changes WHERE page_id=?1 AND run_id=?2 ORDER BY block_id,session_id",
    )?;
    let tracked = statement
        .query_map(params![page, run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                decode::<Option<State>>(r, 1)?,
                decode::<Option<State>>(r, 2)?,
                r.get::<_, bool>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut conflicted = BTreeMap::<String, &str>::new();
    let mut seen = BTreeSet::new();
    let mut restores = BTreeMap::new();
    let mut deletes = BTreeSet::new();
    for (block_id, before, after, interleaved) in tracked {
        if !seen.insert(block_id.clone()) {
            conflicted.insert(block_id.clone(), "run_identity_ambiguous");
            restores.remove(&block_id);
            deletes.remove(&block_id);
            continue;
        }
        if equivalent(before.as_ref(), after.as_ref()) {
            continue;
        }
        let now = current.get(block_id.as_str()).map(snapshot).transpose()?;
        // Undo removes the Ask's output. A consumed Pending block stays consumed.
        if after.is_none()
            && before
                .as_ref()
                .is_some_and(|before| before.block.block_type == "pending")
        {
            continue;
        }
        let reason = if interleaved || !equivalent(now.as_ref(), after.as_ref()) {
            Some("changed_since_run")
        } else if after.is_none() {
            Some("deleted_by_run")
        } else if before.is_none()
            && now
                .as_ref()
                .zip(after.as_ref())
                .is_some_and(|(current, written)| current.parent != written.parent)
        {
            Some("moved_since_run")
        } else {
            None
        };
        if let Some(reason) = reason {
            conflicted.insert(block_id, reason);
        } else if let Some(before) = before {
            restores.insert(block_id, before.block);
        } else {
            deletes.insert(block_id);
        }
    }
    fn removable(block: &MaterializedBlockNode, deletes: &BTreeSet<String>) -> bool {
        block
            .children
            .iter()
            .all(|child| deletes.contains(&child.id) && removable(child, deletes))
    }
    for id in deletes.clone() {
        if !removable(current[id.as_str()].block, &deletes) {
            conflicted.insert(id, "has_retained_children");
        }
    }
    deletes.retain(|id| !conflicted.contains_key(id));
    let mut operations = Vec::new();
    let mut reverted = Vec::new();
    for (block_id, mut before) in restores {
        if let (Some(content), Some(restored)) = (
            &current[block_id.as_str()].block.content,
            &mut before.content,
        ) {
            discussion_marks::preserve(content, restored);
        }
        operations.push(DocumentBlockOperation::UpdateBlock {
            block_id: block_id.clone(),
            patch: DocumentBlockUpdatePatch {
                block_type: Some(before.block_type),
                props: Some(before.props),
                unset_content: before.content.is_none(),
                content: before.content,
            },
        });
        reverted.push(block_id);
    }
    for block_id in &deletes {
        if !current[block_id.as_str()]
            .parent
            .is_some_and(|parent| deletes.contains(parent))
        {
            operations.push(DocumentBlockOperation::DeleteBlock {
                block_id: block_id.clone(),
            });
        }
        reverted.push(block_id.clone());
    }
    if !operations.is_empty()
        && document
            .base_materialization
            .block_tree
            .iter()
            .all(|block| deletes.contains(&block.id))
    {
        operations.push(DocumentBlockOperation::InsertBlock {
            block: MaterializedBlockNode {
                id: super::id_for(operation.write.operation_id, "empty-revert-root"),
                block_type: "paragraph".to_owned(),
                props: BTreeMap::new(),
                content: Some(serde_json::json!([])),
                children: Vec::new(),
            },
            parent_block_id: None,
            before_block_id: None,
        });
    }
    operation.write_document(&document, &operations)?;
    let changed = !reverted.is_empty();
    let conflicts = conflicted
        .into_iter()
        .map(|(block_id, reason)| RunRevertConflict {
            block_id,
            reason: reason.to_owned(),
        })
        .collect();
    Ok((
        page.to_owned(),
        DiscussionCommandResult::RunRevert {
            reverted,
            conflicts,
        },
        changed,
    ))
}
