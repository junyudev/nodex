use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::discussions::{DiscussionAnchor, DiscussionTextRange};
use rusqlite::{Connection, params};
use serde_json::Value;

use super::{DISCUSSION_FIELDS, discussion, encode, invalid};
use crate::document::{
    DocumentBlockOperation, DocumentBlockUpdatePatch, DocumentMaterialization, discussion_marks,
};
use crate::domain::{block_materialization::MaterializedBlockNode, markdown::materialize_markdown};
use crate::infrastructure::sqlite::StoreError;

pub(super) struct BlockRange<'a> {
    pub blocks: &'a [MaterializedBlockNode],
    pub parent: Option<&'a str>,
    pub following: Option<&'a str>,
}

pub(super) fn range<'a>(
    blocks: &'a [MaterializedBlockNode],
    ids: &[String],
) -> Option<BlockRange<'a>> {
    fn find<'a>(
        blocks: &'a [MaterializedBlockNode],
        ids: &[String],
        parent: Option<&'a str>,
    ) -> Option<BlockRange<'a>> {
        if let Some(index) = blocks.iter().position(|block| block.id == ids[0])
            && let Some(selected) = blocks.get(index..index + ids.len())
            && selected.iter().map(|block| &block.id).eq(ids)
        {
            return Some(BlockRange {
                blocks: selected,
                parent,
                following: blocks.get(index + ids.len()).map(|block| block.id.as_str()),
            });
        }
        blocks
            .iter()
            .find_map(|block| find(&block.children, ids, Some(&block.id)))
    }
    if ids.is_empty() || ids.len() > 512 {
        return None;
    }
    find(blocks, ids, None)
}

fn find_block<'a>(
    blocks: &'a [MaterializedBlockNode],
    id: &str,
) -> Option<&'a MaterializedBlockNode> {
    blocks.iter().find_map(|block| {
        if block.id == id {
            Some(block)
        } else {
            find_block(&block.children, id)
        }
    })
}

pub(super) fn block_ids(anchor: &DiscussionAnchor) -> &[String] {
    match anchor {
        DiscussionAnchor::Page => &[],
        DiscussionAnchor::Blocks { block_ids } => block_ids,
        DiscussionAnchor::Text { block_id } | DiscussionAnchor::Datum { block_id, .. } => {
            std::slice::from_ref(block_id)
        }
    }
}

pub(super) struct PreparedAnchor {
    pub anchor: DiscussionAnchor,
    pub quote: String,
    pub operation: Option<DocumentBlockOperation>,
    pub indexed: Vec<String>,
}

pub(super) fn prepare(
    materialization: &DocumentMaterialization,
    id: &str,
    anchor: &DiscussionAnchor,
    text_range: Option<&DiscussionTextRange>,
    selected_quote: Option<&str>,
) -> Result<PreparedAnchor, StoreError> {
    if text_range.is_some() && !matches!(anchor, DiscussionAnchor::Text { .. }) {
        return Err(invalid("Only a text anchor uses a text range"));
    }
    let tree = &materialization.block_tree;
    let mut anchor = anchor.clone();
    let mut indexed = block_ids(&anchor).to_vec();
    let (quote, operation) = match &mut anchor {
        DiscussionAnchor::Page => (materialization.plain_text.clone(), None),
        DiscussionAnchor::Blocks { block_ids } => {
            let blocks = range(tree, block_ids)
                .ok_or_else(|| invalid("Select contiguous sibling Blocks in document order"))?;
            let text = match selected_quote {
                Some(quote) => quote.to_owned(),
                None => {
                    materialize_markdown(blocks.blocks)
                        .map_err(|error| invalid(error.to_string()))?
                        .plain_text
                }
            };
            (text, None)
        }
        DiscussionAnchor::Text { block_id } => {
            let body = Body::read(tree);
            if let Some(marked) = body.marks.get(id) {
                *block_id = marked[0].clone();
                indexed = marked.clone();
                let text = marked
                    .iter()
                    .filter_map(|id| body.blocks[id.as_str()].content.as_ref())
                    .map(|content| discussion_marks::quote(content, id))
                    .collect::<Vec<_>>()
                    .join(" ");
                (text, None)
            } else if let Some(range) = text_range {
                let block = find_block(tree, block_id)
                    .ok_or_else(|| invalid("The text anchor Block is unavailable"))?;
                let mut content = block
                    .content
                    .clone()
                    .ok_or_else(|| invalid("The anchor Block has no inline text"))?;
                let text = discussion_marks::mark_range(&mut content, id, range)?;
                (
                    text,
                    Some(DocumentBlockOperation::UpdateBlock {
                        block_id: block_id.clone(),
                        patch: DocumentBlockUpdatePatch {
                            content: Some(content),
                            ..Default::default()
                        },
                    }),
                )
            } else {
                // The editor's CRDT update may arrive before or after creation.
                indexed.clear();
                (selected_quote.unwrap_or_default().to_owned(), None)
            }
        }
        DiscussionAnchor::Datum {
            block_id,
            source,
            key,
            field,
        } => {
            let block = find_block(tree, block_id)
                .ok_or_else(|| invalid("The Visual anchor Block is unavailable"))?;
            if !is_visual(block)
                || source.trim().is_empty()
                || source.len() > 256
                || field
                    .as_ref()
                    .is_some_and(|field| field.trim().is_empty() || field.len() > 256)
                || encode(key)?.len() > 4096
            {
                return Err(invalid(
                    "A datum anchor requires a Visual, source, and row key",
                ));
            }
            let text = field.as_ref().map_or_else(
                || format!("{source}: {key}"),
                |field| format!("{source}: {key}, {field}"),
            );
            (text, None)
        }
    };
    Ok(PreparedAnchor {
        anchor,
        quote: quote.chars().take(500).collect(),
        operation,
        indexed,
    })
}

fn is_visual(block: &MaterializedBlockNode) -> bool {
    block.block_type == "codeBlock"
        && block
            .props
            .get("language")
            .is_some_and(|value| value == "visual")
}

pub(super) fn set_index(
    connection: &Connection,
    discussion: &str,
    blocks: &[String],
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM page_discussion_anchor_blocks WHERE discussion_id=?1",
        [discussion],
    )?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO page_discussion_anchor_blocks(discussion_id,block_id) VALUES(?1,?2)",
    )?;
    for id in blocks {
        insert.execute(params![discussion, id])?;
    }
    Ok(())
}

struct Body<'a> {
    blocks: BTreeMap<&'a str, &'a MaterializedBlockNode>,
    marks: BTreeMap<String, Vec<String>>,
    pending: BTreeMap<&'a str, &'a str>,
}

impl<'a> Body<'a> {
    fn read(blocks: &'a [MaterializedBlockNode]) -> Self {
        let mut body = Self {
            blocks: BTreeMap::new(),
            marks: BTreeMap::new(),
            pending: BTreeMap::new(),
        };
        body.index(blocks);
        body
    }

    fn index(&mut self, blocks: &'a [MaterializedBlockNode]) {
        for block in blocks {
            self.blocks.insert(&block.id, block);
            if let Some(content) = &block.content {
                for id in discussion_marks::ids(content) {
                    self.marks.entry(id).or_default().push(block.id.clone());
                }
            }
            if let Some(id) = pending_discussion(block) {
                self.pending.entry(id).or_insert(block.id.as_str());
            }
            self.index(&block.children);
        }
    }
}

fn pending_discussion(block: &MaterializedBlockNode) -> Option<&str> {
    if block.block_type != "pending" {
        return None;
    }
    block
        .props
        .get("discussion")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// Validate anchors from the accepted tree in the same transaction as its canonical commit.
pub(crate) fn reconcile(
    connection: &Connection,
    page: &str,
    before: &[MaterializedBlockNode],
    after: &[MaterializedBlockNode],
) -> Result<(), StoreError> {
    let any: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM page_discussions)", [], |r| {
            r.get(0)
        })?;
    if !any || before == after {
        return Ok(());
    }
    let current = Body::read(after);
    let previous = Body::read(before);
    let mut statement = connection.prepare(&format!(
        "SELECT {DISCUSSION_FIELDS} FROM page_discussions d WHERE d.page_id=?1"
    ))?;
    let home = statement
        .query_map([page], discussion)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let home_ids: BTreeSet<_> = home.iter().map(|value| value.id.as_str()).collect();
    let replacements = pending_replacements(before, after, &previous.blocks);
    for value in &home {
        let replacement = replacements.get(value.id.as_str());
        let anchor = if let Some(blocks) = replacement.filter(|blocks| !blocks.is_empty()) {
            DiscussionAnchor::Blocks {
                block_ids: blocks.clone(),
            }
        } else if let Some(block) = current
            .pending
            .get(value.id.as_str())
            .filter(|_| matches!(value.anchor, DiscussionAnchor::Page))
        {
            DiscussionAnchor::Blocks {
                block_ids: vec![(*block).to_owned()],
            }
        } else if matches!(value.anchor, DiscussionAnchor::Text { .. })
            && let Some(blocks) = current.marks.get(&value.id)
        {
            DiscussionAnchor::Text {
                block_id: blocks[0].clone(),
            }
        } else {
            value.anchor.clone()
        };
        let live = match &anchor {
            DiscussionAnchor::Page => true,
            DiscussionAnchor::Blocks { block_ids } => block_ids
                .iter()
                .all(|id| current.blocks.contains_key(id.as_str())),
            DiscussionAnchor::Text { .. } => current.marks.contains_key(&value.id),
            DiscussionAnchor::Datum { block_id, .. } => current
                .blocks
                .get(block_id.as_str())
                .is_some_and(|block| is_visual(block)),
        };
        let indexed = match &anchor {
            DiscussionAnchor::Text { .. } => current
                .marks
                .get(&value.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            _ => block_ids(&anchor),
        };
        let quote =
            if value.quote.is_empty() && matches!(anchor, DiscussionAnchor::Text { .. }) && live {
                indexed
                    .iter()
                    .filter_map(|id| current.blocks[id.as_str()].content.as_ref())
                    .map(|content| discussion_marks::quote(content, &value.id))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(500)
                    .collect()
            } else {
                value.quote.clone()
            };
        connection.execute(
            "UPDATE page_discussions SET anchor_json=?2,anchor_state=?3,quote=?4 WHERE id=?1 AND (anchor_json<>?2 OR anchor_state<>?3 OR quote<>?4)",
            params![value.id, encode(&anchor)?, if live { "live" } else { "orphaned" }, quote],
        )?;
        // Preserve the last known identities when a range disappears. Cross-Page
        // relocation stages the source deletion before persisting the destination.
        if live
            && (anchor != value.anchor
                || value.anchor_state
                    == nodex_core_contracts::discussions::DiscussionAnchorState::Orphaned
                || (matches!(anchor, DiscussionAnchor::Text { .. })
                    && current.marks.get(&value.id) != previous.marks.get(&value.id)))
        {
            set_index(connection, &value.id, indexed)?;
        }
    }

    for (id, blocks) in &current.marks {
        if home_ids.contains(id.as_str()) {
            continue;
        }
        let mut relocate = connection.prepare_cached(
            "UPDATE page_discussions SET page_id=?2,anchor_json=?3,anchor_state='live'
             WHERE id=?1 AND anchor_state='orphaned' AND json_extract(anchor_json,'$.kind')='text'
               AND EXISTS(SELECT 1 FROM page_discussion_anchor_blocks WHERE discussion_id=?1 AND block_id=?4)
               AND EXISTS (SELECT 1 FROM pages source JOIN pages target ON target.library_id=source.library_id
                 WHERE source.block_id=page_discussions.page_id AND target.block_id=?2)",
        )?;
        for block in blocks {
            let anchor = DiscussionAnchor::Text {
                block_id: blocks[0].clone(),
            };
            if relocate.execute(params![id, page, encode(&anchor)?, block])? != 0 {
                set_index(connection, id, blocks)?;
                break;
            }
        }
    }
    Ok(())
}

fn pending_replacements<'a>(
    before: &'a [MaterializedBlockNode],
    after: &'a [MaterializedBlockNode],
    previous: &BTreeMap<&str, &MaterializedBlockNode>,
) -> BTreeMap<&'a str, Vec<String>> {
    fn visit<'a>(
        before: &'a [MaterializedBlockNode],
        after: &[MaterializedBlockNode],
        previous: &BTreeMap<&str, &MaterializedBlockNode>,
        out: &mut BTreeMap<&'a str, Vec<String>>,
    ) {
        let positions: BTreeMap<_, _> = after
            .iter()
            .enumerate()
            .map(|(i, block)| (block.id.as_str(), i))
            .collect();
        for (i, block) in before.iter().enumerate() {
            let position = positions.get(block.id.as_str()).copied();
            if let Some(id) = pending_discussion(block) {
                if let Some(replaced) = position
                    .map(|pos| &after[pos])
                    .filter(|value| value.block_type != "pending")
                {
                    out.insert(id, vec![replaced.id.clone()]);
                } else if position.is_none() {
                    let start = before[..i]
                        .iter()
                        .rev()
                        .find_map(|b| positions.get(b.id.as_str()))
                        .map_or(0, |pos| pos + 1);
                    let end = before[i + 1..]
                        .iter()
                        .find_map(|b| positions.get(b.id.as_str()))
                        .copied()
                        .unwrap_or(after.len());
                    let inserted = after
                        .get(start..end)
                        .unwrap_or_default()
                        .iter()
                        .filter(|candidate| !previous.contains_key(candidate.id.as_str()))
                        .map(|candidate| candidate.id.clone())
                        .collect();
                    out.insert(id, inserted);
                }
            }
            if let Some(position) = position {
                visit(&block.children, &after[position].children, previous, out);
            }
        }
    }
    let mut replacements = BTreeMap::new();
    visit(before, after, previous, &mut replacements);
    replacements
}
