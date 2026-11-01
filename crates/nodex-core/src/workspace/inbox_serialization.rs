//! Serializer migration of canonical Inbox snapshots and their content fences.
//! Delivered handoffs and command receipts are immutable observations, not projections.
use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use serde_json::Value;

use super::inbox::corrupt;
use super::inbox_content::{
    agent_markdown, content_from_markdown, predecessor_agent_markdown_matches,
};
use super::inbox_read::{FrozenSuggestionInput, image_numbers};
use crate::infrastructure::sqlite::StoreError;

type Fingerprints = BTreeMap<(String, String), String>;

fn canonicalize(markdown: &str) -> Result<String, StoreError> {
    let blocks = nodex_markdown::read(markdown, nodex_markdown::ReadOptions::EXACT)
        .map_err(|_| corrupt("Stored Inbox Markdown is unreadable"))?;
    Ok(nodex_markdown::write(&blocks))
}

fn saved_inputs(connection: &Connection) -> Result<Vec<(String, String)>, StoreError> {
    Ok(connection
        .prepare(
            "SELECT request_id,inputs_json FROM inbox_suggestion_requests ORDER BY request_id",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

fn decode_inputs(json: &str) -> Result<Vec<FrozenSuggestionInput>, StoreError> {
    serde_json::from_str(json).map_err(|_| corrupt("Stored Inbox inputs are invalid"))
}

/// Frozen content is authoritative: never reread a Page or resolve newer image
/// bytes to rebuild its Agent body. The original fingerprint authenticates it.
pub(crate) fn validate_inbox_markdown_serialization(
    connection: &Connection,
    predecessor: bool,
) -> Result<(), StoreError> {
    for (_, json) in saved_inputs(connection)? {
        let mut offset = 0;
        for frozen in decode_inputs(&json)? {
            let mut canonical = frozen.content.clone();
            canonical.markdown = canonicalize(&canonical.markdown)?;
            let numbers = image_numbers(&canonical, offset);
            offset += canonical.images.len();
            let body_matches = if predecessor {
                predecessor_agent_markdown_matches(&canonical, &numbers, &frozen.input.body)?
            } else {
                frozen.input.body == agent_markdown(&canonical, &numbers, usize::MAX)?
                    && frozen.content.markdown == canonical.markdown
            };
            if frozen.input.page_id != frozen.input.basis.page_id
                || frozen.content.fingerprint() != frozen.input.basis.content_hash
                || frozen.input.images != frozen.content.images
                || !body_matches
            {
                return Err(corrupt(
                    "Stored Inbox input does not match its canonical content",
                ));
            }
        }
    }
    Ok(())
}

/// Rewrites known content fences only. Unknown historical fingerprints remain
/// stale; a serializer migration must never make an edited message look current.
fn rewrite_basis(value: &mut Value, fingerprints: &Fingerprints) -> bool {
    if let Some(members) = value.as_array_mut() {
        // Visit every member; a short-circuiting `any` would leave later fences stale.
        return members
            .iter_mut()
            .map(|member| usize::from(rewrite_basis(member, fingerprints)))
            .sum::<usize>()
            > 0;
    }
    let Some(page) = value.get("page_id").and_then(Value::as_str) else {
        return false;
    };
    let Some(old) = value.get("content_hash").and_then(Value::as_str) else {
        return false;
    };
    let Some(new) = fingerprints.get(&(page.to_owned(), old.to_owned())) else {
        return false;
    };
    if old == new {
        return false;
    }
    value["content_hash"] = Value::String(new.clone());
    true
}

pub(crate) fn rebuild_inbox_markdown_serialization(
    connection: &Connection,
) -> Result<usize, StoreError> {
    let mut fingerprints = Fingerprints::new();
    let pages = connection
        .prepare(
            "SELECT page.block_id,body.markdown FROM inbox_entries entry \
         JOIN pages page ON page.block_id=entry.page_id \
         JOIN document_materializations body ON body.document_id=page.document_id",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (page, markdown) in pages {
        let mut content = content_from_markdown(connection, markdown)?;
        let old = content.fingerprint();
        content.markdown = canonicalize(&content.markdown)?;
        fingerprints.insert((page, old), content.fingerprint());
    }
    let mut rebuilt = 0;
    for (request, json) in saved_inputs(connection)? {
        let mut inputs = decode_inputs(&json)?;
        let mut offset = 0;
        for frozen in &mut inputs {
            let old = frozen.content.fingerprint();
            frozen.content.markdown = canonicalize(&frozen.content.markdown)?;
            let new = frozen.content.fingerprint();
            fingerprints.insert((frozen.input.page_id.clone(), old), new.clone());
            frozen.input.basis.content_hash = new;
            frozen.input.body = agent_markdown(
                &frozen.content,
                &image_numbers(&frozen.content, offset),
                usize::MAX,
            )?;
            offset += frozen.content.images.len();
            rebuilt += 1;
        }
        if inputs.is_empty() {
            continue;
        }
        let inputs_json = serde_json::to_string(&inputs)
            .map_err(|_| corrupt("Stored Inbox inputs cannot be encoded"))?;
        connection.execute(
            "UPDATE inbox_suggestion_requests SET inputs_json=?2 WHERE request_id=?1",
            params![request, inputs_json],
        )?;
    }
    for (table, key, column) in [
        ("inbox_proposals", "proposal_id", "basis_json"),
        ("inbox_suggestion_requests", "request_id", "basis_json"),
        ("core_automation_firings", "dispatch_id", "hold_basis_json"),
    ] {
        let rows = connection
            .prepare(&format!("SELECT {key},{column} FROM {table}"))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, json) in rows {
            let mut basis: Value = serde_json::from_str(&json)
                .map_err(|_| corrupt("Stored Inbox content basis is invalid"))?;
            if !rewrite_basis(&mut basis, &fingerprints) {
                continue;
            }
            connection.execute(
                &format!("UPDATE {table} SET {column}=?2 WHERE {key}=?1"),
                params![id, basis.to_string()],
            )?;
        }
    }
    validate_inbox_markdown_serialization(connection, false)?;
    Ok(rebuilt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rewrites_every_known_content_fence_without_reviving_unknown_history() {
        let fingerprints = Fingerprints::from([
            (("page:a".into(), "old-a".into()), "new-a".into()),
            (("page:b".into(), "old-b".into()), "new-b".into()),
        ]);
        let mut basis = json!([
            {"page_id":"page:a", "content_hash":"old-a"},
            {"page_id":"page:b", "content_hash":"old-b"},
            {"page_id":"page:a", "content_hash":"unknown"},
        ]);
        assert!(rewrite_basis(&mut basis, &fingerprints));
        assert_eq!(
            basis,
            json!([
                {"page_id":"page:a", "content_hash":"new-a"},
                {"page_id":"page:b", "content_hash":"new-b"},
                {"page_id":"page:a", "content_hash":"unknown"},
            ])
        );
        assert!(!rewrite_basis(&mut basis, &fingerprints));
    }
}
