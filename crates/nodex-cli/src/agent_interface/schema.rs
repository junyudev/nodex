//! Offline schemas reuse the exact Rust serialization types at each CLI boundary.
use std::collections::BTreeMap;

use nodex_core_contracts::{
    ModuleReadSnapshot, administration::*, database::*, document::*, library::*,
};
use serde_json::{Value, json};
use utoipa::ToSchema;

/// Return a self-contained JSON Schema. Recursive references remain local and resolvable.
pub(crate) fn document<T: ToSchema>() -> Value {
    let mut dependencies = Vec::new();
    T::schemas(&mut dependencies);
    let mut definitions = serde_json::Map::new();
    for (name, schema) in dependencies {
        definitions.insert(
            name,
            serde_json::to_value(schema).expect("schema serialization"),
        );
    }
    definitions.insert(
        T::name().into_owned(),
        serde_json::to_value(T::schema()).expect("schema serialization"),
    );
    let mut document = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": format!("#/$defs/{}", T::name()),
        "$defs": definitions,
    });
    localize_references(&mut document);
    document
}

fn combine<const N: usize>(mut root: Value, dependencies: [Value; N]) -> Value {
    for dependency in dependencies {
        root["$defs"]
            .as_object_mut()
            .expect("root definitions")
            .extend(
                dependency["$defs"]
                    .as_object()
                    .expect("dependency definitions")
                    .clone(),
            );
    }
    root
}

fn localize_references(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref") {
                *reference = reference.replace("#/components/schemas/", "#/$defs/");
            }
            for value in object.values_mut() {
                localize_references(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                localize_references(value);
            }
        }
        _ => {}
    }
}

pub(super) fn result(path: &[&str]) -> Value {
    let mut schema = match path {
        ["capabilities"] => document::<super::AgentCapabilitiesV1>(),
        ["setup"] | ["skills", _] => document::<crate::skills::install::SkillOperationResult>(),
        ["ls"] => document::<crate::browse::BrowseOutput>(),
        ["search"] => document::<crate::search::SearchOutput>(),
        ["data-source", "describe"] => document::<crate::data_source::DataSourceDescribeOutput>(),
        ["data-source", "list"] => database_snapshot("data_source_window"),
        ["data-source", "options"] => database_snapshot("option_window"),
        ["data-source", "query"] => database_snapshot("data_source_query"),
        ["page", "properties", "get"] => document::<crate::page_properties::PagePropertiesOutput>(),
        ["page", "properties", "apply" | "set"] => combine(
            document::<nodex_core_contracts::ApplyResponse<DatabaseCommitValue, DatabaseReceipt>>(),
            [
                document::<DatabaseCommitValue>(),
                document::<DatabaseReceipt>(),
            ],
        ),
        ["page", "create-batch"] => document::<crate::page_batch::PageBatchOutput>(),
        ["context"] => document::<crate::runtime::ContextOutput>(),
        ["tree"] => document::<crate::runtime::TreeRoot>(),
        ["read"] => document::<LibraryPageProjectionFile>(),
        ["sed"] => document::<crate::runtime::SedOutput>(),
        ["docs", "nested-markdown"] => document::<String>(),
        ["rg"] => document::<ProcessResult>(),
        ["view", "query"] => document::<crate::view::ViewQueryOutput>(),
        ["open", _] => document::<crate::open::OpenResult>(),
        ["patch"] | ["page", "insert" | "replace" | "rename"] | ["block", _] => {
            document::<crate::page_mutation::SemanticMutationResult>()
        }
        ["page", "create"] => document::<crate::page_lifecycle::PageCreationResult>(),
        ["page", "move"] => document::<crate::page_lifecycle::PageMoveResult>(),
        ["page", "duplicate"] => document::<crate::page_lifecycle::PageCopyResult>(),
        ["page", "delete"] => document::<crate::page_lifecycle::PageDeletionResult>(),
        ["file", "list"] => document::<LibraryFilePage>(),
        ["file", "info"] => document::<LibraryFile>(),
        ["file", "versions"] => document::<LibraryFileVersionPage>(),
        ["file", "usages"] => document::<LibraryFileUsagePage>(),
        ["page", "file", "list"] => document::<LibraryPageFileInventory>(),
        ["file", "read"] | ["page", "file", "read"] => {
            document::<crate::files::FileDownloadResult>()
        }
        ["file", _] | ["page", "file", _] => document::<crate::files::FileMutationResult>(),
        ["history"] => document::<LibraryPageHistoryPage>(),
        ["backup", "list"] => document::<crate::runtime::BackupListOutput>(),
        ["backup", "create"] => combine(
            document::<
                nodex_core_contracts::ApplyResponse<
                    StoreAdministrationCommitValue,
                    StoreAdministrationReceipt,
                >,
            >(),
            [
                document::<StoreAdministrationCommitValue>(),
                document::<StoreAdministrationReceipt>(),
            ],
        ),
        ["profile", "clone"] => document::<nodex_core::administration::ProfileCloneReceipt>(),
        ["doctor"] => document::<crate::runtime::DoctorOutput>(),
        ["draft", "create"] => document::<crate::draft::DraftWorkspaceResult>(),
        ["draft", "diff"] => document::<crate::draft::DraftDiffResult>(),
        ["draft", "discard"] => document::<crate::draft::DraftDiscardResult>(),
        ["draft", "apply"] => draft_apply_schema(),
        ["service", _] => document::<crate::service::ServiceReport>(),
        _ => panic!("missing typed result schema for {}", path.join(" ")),
    };
    prune_definitions(&mut schema);
    schema
}

fn database_snapshot(kind: &str) -> Value {
    let mut schema = combine(
        document::<ModuleReadSnapshot<DatabaseReadValue>>(),
        [document::<DatabaseReadValue>()],
    );
    let variants = schema["$defs"]["DatabaseReadValue"]["oneOf"]
        .as_array_mut()
        .expect("tagged Database read variants");
    variants.retain(|variant| variant["properties"]["kind"]["enum"] == json!([kind]));
    assert_eq!(variants.len(), 1, "registered Database read variant {kind}");
    schema
}

/// Keep only reachable definitions so one command's help never carries unrelated contracts.
fn prune_definitions(schema: &mut Value) {
    let mut pending = Vec::new();
    let mut reachable = std::collections::BTreeSet::new();
    let mut root = schema.clone();
    root.as_object_mut().expect("schema object").remove("$defs");
    collect_references(&root, &mut pending);
    while let Some(name) = pending.pop() {
        if !reachable.insert(name.clone()) {
            continue;
        }
        if let Some(definition) = schema["$defs"].get(&name) {
            collect_references(definition, &mut pending);
        }
    }
    schema["$defs"]
        .as_object_mut()
        .expect("definitions")
        .retain(|name, _| reachable.contains(name));
}

fn collect_references(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get("$ref")
                && let Some(name) = reference.strip_prefix("#/$defs/")
            {
                output.push(name.to_owned());
            }
            for child in object.values() {
                collect_references(child, output);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_references(child, output);
            }
        }
        _ => {}
    }
}

#[derive(serde::Serialize, ToSchema)]
pub(crate) struct ProcessResult {
    pub stdout: String,
    pub exit_status: i32,
}

fn draft_apply_schema() -> Value {
    let mut schema = combine(
        document::<crate::page_mutation::SemanticMutationResult>(),
        [
            document::<crate::draft::DraftApplicationIdentity>(),
            document::<crate::draft::DraftNoChangeResult>(),
        ],
    );
    schema.as_object_mut().expect("schema").remove("$ref");
    schema["anyOf"] = json!([
        { "allOf": [{ "$ref": "#/$defs/SemanticMutationResult" }, { "$ref": "#/$defs/DraftApplicationIdentity" }] },
        { "$ref": "#/$defs/DraftNoChangeResult" }
    ]);
    schema
}

pub(super) fn payloads(path: &[&str]) -> BTreeMap<String, Value> {
    match path {
        ["data-source", "query"] => {
            BTreeMap::from([("--input".into(), document::<DatabaseDataSourceQuery>())])
        }
        ["page", "properties", "apply"] => BTreeMap::from([(
            "--input".into(),
            document::<crate::page_properties::PropertyApplyInput>(),
        )]),
        ["page", "create-batch"] => BTreeMap::from([(
            "--input".into(),
            document::<crate::page_batch::PageBatchInput>(),
        )]),
        ["block", "insert"] => BTreeMap::from([(
            "--block-json".into(),
            document::<DocumentSemanticBlockDraft>(),
        )]),
        ["block", "update"] => BTreeMap::from([(
            "--patch-json".into(),
            document::<DocumentBlockUpdatePatch>(),
        )]),
        ["history"] => {
            BTreeMap::from([("--before".into(), document::<LibraryPageHistoryCursor>())])
        }
        _ => BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;

    #[test]
    fn every_published_schema_compiles_with_only_local_references() {
        for command in super::super::COMMANDS {
            let result = result(command.path);
            assert_local_references(&result, &result, &command.path.join(" "));
            jsonschema::validator_for(&result).unwrap_or_else(|error| {
                panic!("{} result schema: {error}", command.path.join(" "))
            });
            for (argument, payload) in payloads(command.path) {
                assert_local_references(&payload, &payload, &command.path.join(" "));
                jsonschema::validator_for(&payload).unwrap_or_else(|error| {
                    panic!(
                        "{} {argument} payload schema: {error}",
                        command.path.join(" ")
                    )
                });
            }
        }
    }

    fn assert_local_references(root: &Value, value: &Value, label: &str) {
        match value {
            Value::Object(object) => {
                if let Some(Value::String(reference)) = object.get("$ref") {
                    let pointer = reference
                        .strip_prefix('#')
                        .expect("offline local reference");
                    assert!(
                        root.pointer(pointer).is_some(),
                        "{label}: unresolved {reference}"
                    );
                }
                for value in object.values() {
                    assert_local_references(root, value, label);
                }
            }
            Value::Array(values) => {
                for value in values {
                    assert_local_references(root, value, label);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn payload_schemas_agree_with_the_real_decoders() {
        assert_decoder::<DocumentSemanticBlockDraft>(json!({
            "local_id": "note", "block_type": "paragraph", "props": {},
            "content": {"kind": "absent"}, "children": []
        }));
        assert_decoder::<DocumentBlockUpdatePatch>(
            json!({"content": {"kind": "absent"}, "unset_content": false}),
        );
        assert_decoder::<DatabaseDataSourceQuery>(json!({
            "filter": {"kind": "group", "operator": "and", "children": []}, "sort": []
        }));
        assert_decoder::<crate::page_properties::PropertyApplyInput>(json!({"edits": [{
            "address": {"page_id": "page", "data_source_id": "source", "property_id": "status"},
            "edit": {"kind": "replace", "expected_value_revision": 0, "value": {"kind": "select", "option_id": "done"}}
        }]}));
        assert_decoder::<crate::page_batch::PageBatchInput>(json!({
            "destination": {"kind": "page", "page_id": "parent"},
            "pages": [{"title_markdown": "Agenda", "nested_markdown": "Discussion"}]
        }));
    }

    fn assert_decoder<T: DeserializeOwned + ToSchema>(valid: Value) {
        let schema = document::<T>();
        let validator = jsonschema::validator_for(&schema).expect("compile payload schema");
        serde_json::from_value::<T>(valid.clone())
            .unwrap_or_else(|error| panic!("{}: {error}", T::name()));
        assert!(
            validator.is_valid(&valid),
            "{}: {:?}",
            T::name(),
            validator.iter_errors(&valid).collect::<Vec<_>>()
        );
        let mut unknown = valid;
        unknown["unexpected_input"] = json!(true);
        assert!(serde_json::from_value::<T>(unknown.clone()).is_err());
        assert!(
            !validator.is_valid(&unknown),
            "{} schema must reject unknown fields",
            T::name()
        );
        assert!(serde_json::from_value::<T>(Value::Null).is_err());
        assert!(!validator.is_valid(&Value::Null));
    }
}
