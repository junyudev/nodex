use std::collections::BTreeSet;

use nodex_core_contracts::database::{DatabaseRelationTargetItem, DatabaseRelationValuePreview};
use nodex_core_contracts::events::{LocalProjectionPatch, ResourceKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::sqlite::{StoreError, StoreErrorCode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProjectionRequirements {
    pub subject: ResourceKey,
    pub required_resources: Vec<ResourceKey>,
    pub patch_hash: String,
}

pub(crate) fn extract(patch: &LocalProjectionPatch) -> Result<ProjectionRequirements, StoreError> {
    let (subject, required_resources) = match patch {
        LocalProjectionPatch::DatabaseRowUpsert {
            project_id,
            database_id,
            data_source_id,
            view_id,
            row,
            ..
        } => {
            let subject = ResourceKey::View {
                view_id: view_id.clone(),
            };
            let mut required_resources = BTreeSet::from([
                ResourceKey::Project {
                    project_id: project_id.clone(),
                },
                ResourceKey::Page {
                    page_id: row.page_id.clone(),
                },
                ResourceKey::Document {
                    document_id: row.document_id.clone(),
                },
                ResourceKey::Database {
                    database_id: database_id.clone(),
                },
                ResourceKey::DataSource {
                    data_source_id: data_source_id.clone(),
                },
                subject.clone(),
            ]);
            for value in row
                .database_values
                .values()
                .chain(row.intrinsic_properties.values())
            {
                collect_relation_targets(value, &mut required_resources)?;
            }
            (subject, required_resources)
        }
        LocalProjectionPatch::DatabaseRowRemove {
            project_id,
            database_id,
            data_source_id,
            view_id,
            ..
        } => {
            let subject = ResourceKey::View {
                view_id: view_id.clone(),
            };
            (
                subject.clone(),
                BTreeSet::from([
                    ResourceKey::Project {
                        project_id: project_id.clone(),
                    },
                    ResourceKey::Database {
                        database_id: database_id.clone(),
                    },
                    ResourceKey::DataSource {
                        data_source_id: data_source_id.clone(),
                    },
                    subject,
                ]),
            )
        }
        LocalProjectionPatch::PageChanged {
            project_id,
            page_id,
        } => {
            let subject = ResourceKey::Page {
                page_id: page_id.clone(),
            };
            (
                subject.clone(),
                BTreeSet::from([
                    ResourceKey::Project {
                        project_id: project_id.clone(),
                    },
                    subject,
                ]),
            )
        }
    };
    let encoded = serde_json::to_vec(patch)
        .map_err(|_| corrupt("Projection patch cannot be canonically encoded"))?;
    Ok(ProjectionRequirements {
        subject,
        required_resources: required_resources.into_iter().collect(),
        patch_hash: hex::encode(Sha256::digest(encoded)),
    })
}

fn collect_relation_targets(
    value: &Value,
    required_resources: &mut BTreeSet<ResourceKey>,
) -> Result<(), StoreError> {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_relation_targets(value, required_resources)?;
            }
        }
        Value::Object(record) => {
            if record.get("kind").and_then(Value::as_str) == Some("relation") {
                let preview = record
                    .get("value")
                    .cloned()
                    .ok_or_else(|| corrupt("Relation projection preview is missing"))?;
                let preview = serde_json::from_value::<DatabaseRelationValuePreview>(preview)
                    .map_err(|_| corrupt("Relation projection preview is invalid"))?;
                required_resources.extend(preview.targets.into_iter().filter_map(|target| {
                    let DatabaseRelationTargetItem::Visible { page_id, .. } = target else {
                        return None;
                    };
                    Some(ResourceKey::Page { page_id })
                }));
                return Ok(());
            }
            for value in record.values() {
                collect_relation_targets(value, required_resources)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nodex_core_contracts::database::DatabaseRowSummary;
    use nodex_core_contracts::events::{LocalProjectionPatch, ResourceKey};
    use serde_json::json;

    #[test]
    fn relation_preview_targets_are_exact_projection_requirements() {
        let patch = LocalProjectionPatch::DatabaseRowUpsert {
            project_id: "project:reader".to_owned(),
            database_id: "database:board".to_owned(),
            data_source_id: "source:board".to_owned(),
            view_id: "view:board".to_owned(),
            row: Box::new(DatabaseRowSummary {
                page_id: "page:row".to_owned(),
                page_key: None,
                lifecycle: "active".to_owned(),
                title: "Row".to_owned(),
                rich_title: json!([]),
                description_preview: String::new(),
                description_length: 0,
                has_description: false,
                database_values: BTreeMap::from([(
                    "p_relation".to_owned(),
                    json!({
                        "kind": "relation",
                        "value": {
                            "value_revision": 3,
                            "total_count": 2,
                            "targets": [
                                {
                                    "kind": "visible",
                                    "edge_id": "edge:visible",
                                    "page_id": "page:target",
                                    "title": "Target",
                                    "lifecycle": "active",
                                    "membership_state": "active"
                                },
                                {
                                    "kind": "unavailable",
                                    "edge_id": "edge:unavailable"
                                }
                            ],
                            "unavailable_count": 1,
                            "has_more": false
                        }
                    }),
                )]),
                intrinsic_properties: BTreeMap::new(),
                database_value_revisions: BTreeMap::new(),
                task_parent_page_id: None,
                task_sibling_rank: None,
                task_parent_value_revision: 1,
                metadata_revision: 1,
                parent_revision: 1,
                document_id: "document:row".to_owned(),
                document_generation: 1,
                document_head_seq: 1,
                membership_id: "membership:row".to_owned(),
                membership_revision: 1,
                membership_created_at: "2026-08-09T00:00:00Z".to_owned(),
                created_at: "2026-08-09T00:00:00Z".to_owned(),
                updated_at: "2026-08-09T00:00:00Z".to_owned(),
                effective_group_key: None,
                effective_subgroup_key: None,
                rank_key: None,
                position_revision: None,
                position_order: None,
            }),
            total_rows: 1,
            group_total: None,
        };

        let extracted = super::extract(&patch).expect("extract requirements");

        assert_eq!(
            extracted.subject,
            ResourceKey::View {
                view_id: "view:board".to_owned(),
            }
        );
        assert_eq!(
            extracted.required_resources,
            vec![
                ResourceKey::Project {
                    project_id: "project:reader".to_owned(),
                },
                ResourceKey::Page {
                    page_id: "page:row".to_owned(),
                },
                ResourceKey::Page {
                    page_id: "page:target".to_owned(),
                },
                ResourceKey::Document {
                    document_id: "document:row".to_owned(),
                },
                ResourceKey::Database {
                    database_id: "database:board".to_owned(),
                },
                ResourceKey::DataSource {
                    data_source_id: "source:board".to_owned(),
                },
                ResourceKey::View {
                    view_id: "view:board".to_owned(),
                },
            ]
        );
        assert_eq!(extracted.patch_hash.len(), 64);
    }
}
