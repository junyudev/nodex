use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use yrs::sync::{Awareness, AwarenessUpdate};
use yrs::types::Attrs;
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Any, GetString, Out, ReadTxn, Text, Transact, Update, Xml, XmlFragment, XmlOut};

use nodex_core::document::{
    BlockDocumentSchema, DocumentBlockOperation, ExactMarkdownPatch, PortableSubtreeDocumentHead,
    PortableSubtreeTransferKind, PortableSubtreeTransferRequest, create_compatible_document,
    decode_block_document, encode_block_document, has_pending_dependencies,
    materialize_decoded_document, prepare_document_operation_update,
    prepare_exact_markdown_patch_update, prepare_portable_subtree_transfer_updates,
};
use nodex_core::domain::rich_text::RichTextItem;
use nodex_core::domain::subtree::BlockSubtreeInsertionTarget;

#[derive(Serialize)]
struct DocumentSummary {
    title: String,
    body_xml: String,
    body_semantic: Vec<XmlSemantic>,
    state_vector: Vec<u8>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum XmlSemantic {
    Element {
        name: String,
        attributes: BTreeMap<String, serde_json::Value>,
        children: Vec<XmlSemantic>,
    },
    Text {
        delta: Vec<TextDeltaSemantic>,
    },
}

#[derive(Serialize)]
struct TextDeltaSemantic {
    insert: serde_json::Value,
    attributes: BTreeMap<String, serde_json::Value>,
}

fn any_json(value: Any) -> serde_json::Value {
    match value {
        Any::Null => serde_json::Value::Null,
        Any::Undefined => serde_json::json!({ "$yrs": "undefined" }),
        Any::Bool(value) => serde_json::Value::Bool(value),
        Any::Number(value) => serde_json::json!(value),
        Any::BigInt(value) => serde_json::json!({ "$yrs": "bigint", "value": value.to_string() }),
        Any::String(value) => serde_json::Value::String(value.to_string()),
        Any::Buffer(value) => serde_json::json!({ "$yrs": "bytes", "value": value }),
        Any::Array(values) => {
            serde_json::Value::Array(values.iter().cloned().map(any_json).collect())
        }
        Any::Map(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), any_json(value.clone())))
                .collect(),
        ),
    }
}

fn out_json<T: ReadTxn>(value: Out, transaction: &T) -> serde_json::Value {
    match value {
        Out::Any(any) => any_json(any),
        other => serde_json::Value::String(other.to_string(transaction)),
    }
}

fn semantic_node<T: ReadTxn>(node: XmlOut, transaction: &T) -> XmlSemantic {
    match node {
        XmlOut::Element(element) => XmlSemantic::Element {
            name: element.tag().to_string(),
            attributes: element
                .attributes(transaction)
                .map(|(key, value)| (key.to_owned(), out_json(value, transaction)))
                .collect(),
            children: element
                .children(transaction)
                .map(|child| semantic_node(child, transaction))
                .collect(),
        },
        XmlOut::Text(text) => XmlSemantic::Text {
            delta: text
                .diff(transaction, YChange::identity)
                .into_iter()
                .map(|chunk| TextDeltaSemantic {
                    insert: out_json(chunk.insert, transaction),
                    attributes: chunk
                        .attributes
                        .map(|attributes| {
                            attributes
                                .into_iter()
                                .map(|(key, value)| (key.to_string(), any_json(value)))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect(),
        },
        XmlOut::Fragment(fragment) => XmlSemantic::Element {
            name: "#fragment".to_owned(),
            attributes: BTreeMap::new(),
            children: fragment
                .children(transaction)
                .map(|child| semantic_node(child, transaction))
                .collect(),
        },
    }
}

fn read_update(path: &Path) -> Result<Update, Box<dyn std::error::Error>> {
    let bytes = fs::read(path)?;
    Ok(Update::decode_v1(bytes.as_slice())?)
}

fn apply_update(document: &yrs::Doc, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let update = read_update(path)?;
    let mut transaction = document.transact_mut();
    transaction.apply_update(update)?;
    if has_pending_dependencies(&transaction) {
        return Err(format!("{} left unresolved dependencies", path.display()).into());
    }
    Ok(())
}

fn fixture_path(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn summarize(document: &yrs::Doc) -> DocumentSummary {
    let title = document.get_or_insert_text("title");
    let body = document.get_or_insert_xml_fragment("body");
    let transaction = document.transact();
    DocumentSummary {
        title: title.get_string(&transaction),
        body_xml: body.get_string(&transaction),
        body_semantic: body
            .children(&transaction)
            .map(|node| semantic_node(node, &transaction))
            .collect(),
        state_vector: transaction.state_vector().encode_v1(),
    }
}

fn load_fixture(root: &Path) -> Result<yrs::Doc, Box<dyn std::error::Error>> {
    let document = create_compatible_document("nodex-yjs-yrs-conformance");
    for name in ["base.bin", "first.bin", "second.bin"] {
        apply_update(&document, &fixture_path(root, name))?;
    }
    Ok(document)
}

fn load_matrix_fixture(root: &Path) -> Result<yrs::Doc, Box<dyn std::error::Error>> {
    let document = create_compatible_document("nodex-yjs-yrs-schema-matrix");
    apply_update(&document, &fixture_path(root, "matrix-base.bin"))?;
    Ok(document)
}

fn generate_for_document(
    document: yrs::Doc,
    output_update: &Path,
) -> Result<DocumentSummary, Box<dyn std::error::Error>> {
    let before = document.transact().state_vector();
    let title = document.get_or_insert_text("title");
    let body = document.get_or_insert_xml_fragment("body");
    let read_transaction = document.transact();
    let first_xml_text = body
        .successors(&read_transaction)
        .find_map(|node| match node {
            XmlOut::Text(text) => Some(text),
            _ => None,
        })
        .ok_or("fixture has no XML text node")?;
    drop(read_transaction);
    let mut transaction = document.transact_mut();
    let end = title.len(&transaction);
    title.insert(&mut transaction, end, " · Rust");
    let xml_end = first_xml_text.len(&transaction);
    first_xml_text.insert(&mut transaction, xml_end, " · Rust XML");
    drop(transaction);
    let update = document.transact().encode_state_as_update_v1(&before);
    fs::write(output_update, update)?;
    Ok(summarize(&document))
}

fn generate(
    fixture_root: &Path,
    output_update: &Path,
) -> Result<DocumentSummary, Box<dyn std::error::Error>> {
    generate_for_document(load_fixture(fixture_root)?, output_update)
}

fn inspect(
    fixture_root: &Path,
    rust_update: &Path,
    third_update: &Path,
) -> Result<DocumentSummary, Box<dyn std::error::Error>> {
    let document = load_fixture(fixture_root)?;
    apply_update(&document, rust_update)?;
    apply_update(&document, third_update)?;
    Ok(summarize(&document))
}

fn generate_matrix(
    fixture_root: &Path,
    output_update: &Path,
) -> Result<DocumentSummary, Box<dyn std::error::Error>> {
    generate_for_document(load_matrix_fixture(fixture_root)?, output_update)
}

fn inspect_matrix(
    fixture_root: &Path,
    rust_update: &Path,
    third_update: &Path,
) -> Result<DocumentSummary, Box<dyn std::error::Error>> {
    let document = load_matrix_fixture(fixture_root)?;
    apply_update(&document, rust_update)?;
    apply_update(&document, third_update)?;
    Ok(summarize(&document))
}

fn roundtrip_matrix_block_tree(
    fixture_root: &Path,
    output_update: &Path,
) -> Result<DocumentSummary, Box<dyn std::error::Error>> {
    let source = load_matrix_fixture(fixture_root)?;
    let decoded = decode_block_document(&source, BlockDocumentSchema::PageV4)?;
    let target = encode_block_document(
        "nodex-yjs-yrs-matrix-block-tree-roundtrip",
        decoded.schema,
        decoded.title.as_deref(),
        &decoded.block_tree,
    )?;
    let update = target
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    fs::write(output_update, update)?;
    Ok(summarize(&target))
}

#[derive(Serialize)]
struct AwarenessSummary {
    client_id: u64,
    state: serde_json::Value,
}

fn generate_awareness(
    input_update: &Path,
    output_update: &Path,
) -> Result<AwarenessSummary, Box<dyn std::error::Error>> {
    let update = AwarenessUpdate::decode_v1(fs::read(input_update)?.as_slice())?;
    let mut awareness = Awareness::new(create_compatible_document("nodex-awareness-rust"));
    awareness.apply_update(update)?;
    let state = serde_json::json!({
        "user": { "id": "rust-core", "name": "Rust Core 😀" },
        "cursor": { "anchor": 8, "head": 8 },
    });
    awareness.set_local_state(&state)?;
    fs::write(output_update, awareness.update()?.encode_v1())?;
    Ok(AwarenessSummary {
        client_id: awareness.client_id().get(),
        state,
    })
}

#[derive(Debug, Deserialize)]
struct RandomizedCorpus {
    cases: Vec<RandomizedCase>,
}

#[derive(Debug, Deserialize)]
struct RandomizedCase {
    seed: u64,
    operations: Vec<RandomizedEdit>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RandomizedTarget {
    Title,
    Body,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RandomizedEdit {
    Insert {
        target: RandomizedTarget,
        index: u32,
        text: String,
    },
    Delete {
        target: RandomizedTarget,
        index: u32,
        length: u32,
    },
    Format {
        target: RandomizedTarget,
        index: u32,
        length: u32,
        mark: String,
        enabled: bool,
    },
}

#[derive(Serialize)]
struct RandomizedProductSummary {
    body_semantic: Vec<XmlSemantic>,
    materialization: serde_json::Value,
}

#[derive(Serialize)]
struct RandomizedCaseSummary {
    seed: u64,
    rust_local: RandomizedProductSummary,
    yjs_update: RandomizedProductSummary,
}

fn load_randomized_fixture(root: &Path) -> Result<yrs::Doc, Box<dyn std::error::Error>> {
    let document = create_compatible_document("nodex-yjs-yrs-randomized");
    apply_update(&document, &fixture_path(root, "base.bin"))?;
    Ok(document)
}

fn apply_randomized_edits(
    document: &yrs::Doc,
    edits: &[RandomizedEdit],
) -> Result<(), Box<dyn std::error::Error>> {
    let title = document.get_or_insert_text("title");
    let body = document.get_or_insert_xml_fragment("body");
    let read = document.transact();
    let body_text = body
        .successors(&read)
        .find_map(|node| match node {
            XmlOut::Text(text) => Some(text),
            _ => None,
        })
        .ok_or("randomized fixture has no body XML text")?;
    drop(read);

    for edit in edits {
        let mut transaction = document.transact_mut();
        let target = match edit {
            RandomizedEdit::Insert { target, .. }
            | RandomizedEdit::Delete { target, .. }
            | RandomizedEdit::Format { target, .. } => target,
        };
        match target {
            RandomizedTarget::Title => apply_randomized_edit(&title, &mut transaction, edit),
            RandomizedTarget::Body => apply_randomized_edit(&body_text, &mut transaction, edit),
        }
    }
    Ok(())
}

fn apply_randomized_edit<T: Text>(
    text: &T,
    transaction: &mut yrs::TransactionMut<'_>,
    edit: &RandomizedEdit,
) {
    match edit {
        RandomizedEdit::Insert {
            index, text: value, ..
        } => text.insert(transaction, *index, value),
        RandomizedEdit::Delete { index, length, .. } => {
            text.remove_range(transaction, *index, *length);
        }
        RandomizedEdit::Format {
            index,
            length,
            mark,
            enabled,
            ..
        } => {
            let value = if *enabled { Any::Bool(true) } else { Any::Null };
            text.format(
                transaction,
                *index,
                *length,
                Attrs::from([(mark.clone().into(), value)]),
            );
        }
    }
}

fn randomized_product_summary(
    document: &yrs::Doc,
) -> Result<RandomizedProductSummary, Box<dyn std::error::Error>> {
    let decoded = decode_block_document(document, BlockDocumentSchema::PageV4)?;
    let materialization = serde_json::to_value(materialize_decoded_document(&decoded)?)?;
    let materialization = project_materialization(&materialization);
    let body = document.get_or_insert_xml_fragment("body");
    let transaction = document.transact();
    Ok(RandomizedProductSummary {
        body_semantic: body
            .children(&transaction)
            .map(|node| semantic_node(node, &transaction))
            .collect(),
        materialization,
    })
}

fn run_randomized_corpus(
    fixture_root: &Path,
    corpus_path: &Path,
    yjs_update_root: &Path,
    rust_update_root: &Path,
) -> Result<Vec<RandomizedCaseSummary>, Box<dyn std::error::Error>> {
    let corpus: RandomizedCorpus = serde_json::from_slice(&fs::read(corpus_path)?)?;
    let mut summaries = Vec::with_capacity(corpus.cases.len());
    for case in corpus.cases {
        let rust_document = load_randomized_fixture(fixture_root)?;
        let base_vector = rust_document.transact().state_vector();
        apply_randomized_edits(&rust_document, &case.operations)?;
        let rust_update = rust_document
            .transact()
            .encode_state_as_update_v1(&base_vector);
        fs::write(
            rust_update_root.join(format!("{}.bin", case.seed)),
            rust_update,
        )?;

        let yjs_document = load_randomized_fixture(fixture_root)?;
        apply_update(
            &yjs_document,
            &yjs_update_root.join(format!("{}.bin", case.seed)),
        )?;
        summaries.push(RandomizedCaseSummary {
            seed: case.seed,
            rust_local: randomized_product_summary(&rust_document)?,
            yjs_update: randomized_product_summary(&yjs_document)?,
        });
    }
    Ok(summaries)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SemanticOperationCorpus {
    operations: Vec<DocumentBlockOperation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticOperationSummary {
    materialization: serde_json::Value,
    state_vector_v1: Vec<u8>,
    write_fence_block_ids: Vec<String>,
    title_write_fence_required: bool,
}

fn run_semantic_operations(
    fixture_root: &Path,
    corpus_path: &Path,
    output_update: &Path,
) -> Result<SemanticOperationSummary, Box<dyn std::error::Error>> {
    let document = load_matrix_fixture(fixture_root)?;
    let transaction = document.transact();
    let full_state = transaction.encode_state_as_update_v1(&yrs::StateVector::default());
    let state_vector = transaction.state_vector().encode_v1();
    drop(transaction);
    let corpus: SemanticOperationCorpus = serde_json::from_slice(&fs::read(corpus_path)?)?;
    let prepared = prepare_document_operation_update(
        "nodex-yjs-yrs-schema-matrix",
        BlockDocumentSchema::PageV4,
        &full_state,
        &state_vector,
        &corpus.operations,
        false,
    )?;
    fs::write(output_update, &prepared.update_v1)?;
    let materialization = serde_json::to_value(prepared.materialization)?;
    Ok(SemanticOperationSummary {
        materialization: project_materialization(&materialization),
        state_vector_v1: prepared.state_vector_v1,
        write_fence_block_ids: prepared.write_fence_block_ids,
        title_write_fence_required: prepared.title_write_fence_required,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkdownPatchCorpus {
    patches: Vec<ExactMarkdownPatch>,
    #[serde(default)]
    rich_title: Option<Vec<RichTextItem>>,
}

fn run_markdown_patch(
    fixture_root: &Path,
    corpus_path: &Path,
    output_update: &Path,
) -> Result<SemanticOperationSummary, Box<dyn std::error::Error>> {
    let document = load_matrix_fixture(fixture_root)?;
    let transaction = document.transact();
    let full_state = transaction.encode_state_as_update_v1(&yrs::StateVector::default());
    let state_vector = transaction.state_vector().encode_v1();
    drop(transaction);
    let corpus: MarkdownPatchCorpus = serde_json::from_slice(&fs::read(corpus_path)?)?;
    let mut next_id = 0usize;
    let prepared = prepare_exact_markdown_patch_update(
        "nodex-yjs-yrs-schema-matrix",
        BlockDocumentSchema::PageV4,
        &full_state,
        &state_vector,
        &corpus.patches,
        corpus.rich_title.as_deref(),
        &mut || {
            next_id += 1;
            format!("bridge-markdown-{next_id}")
        },
    )?;
    fs::write(output_update, &prepared.update_v1)?;
    let materialization = serde_json::to_value(prepared.materialization)?;
    Ok(SemanticOperationSummary {
        materialization: project_materialization(&materialization),
        state_vector_v1: prepared.state_vector_v1,
        write_fence_block_ids: prepared.write_fence_block_ids,
        title_write_fence_required: prepared.title_write_fence_required,
    })
}

fn run_subtree_copy(
    fixture_root: &Path,
    output_update: &Path,
) -> Result<SemanticOperationSummary, Box<dyn std::error::Error>> {
    let document = load_matrix_fixture(fixture_root)?;
    let transaction = document.transact();
    let full_state = transaction.encode_state_as_update_v1(&yrs::StateVector::default());
    let state_vector = transaction.state_vector().encode_v1();
    drop(transaction);
    let head = PortableSubtreeDocumentHead {
        document_id: "nodex-yjs-yrs-schema-matrix".to_owned(),
        schema: BlockDocumentSchema::PageV4,
        full_state_v1: full_state,
        expected_state_vector_v1: state_vector,
    };
    let prepared = prepare_portable_subtree_transfer_updates(
        &PortableSubtreeTransferRequest {
            kind: PortableSubtreeTransferKind::Copy,
            source: head.clone(),
            target: head,
            root_block_ids: vec!["matrix-toggle".to_owned()],
            insertion: BlockSubtreeInsertionTarget {
                parent_block_id: None,
                before_block_id: Some("matrix-heading".to_owned()),
            },
        },
        &mut |source| format!("bridge-copy-{source}"),
    )?;
    fs::write(output_update, &prepared.target.update_v1)?;
    let materialization = serde_json::to_value(prepared.target.materialization)?;
    Ok(SemanticOperationSummary {
        materialization: project_materialization(&materialization),
        state_vector_v1: prepared.target.state_vector_v1,
        write_fence_block_ids: prepared.target.write_fence_block_ids,
        title_write_fence_required: prepared.target.title_write_fence_required,
    })
}

fn project_materialization(materialization: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": materialization["schemaVersion"],
        "title": materialization["title"],
        "richTitle": materialization["richTitle"],
        "blockTree": materialization["blockTree"],
        "markdown": materialization["markdown"],
        "plainText": materialization["plainText"],
        "preview": materialization["preview"],
        "references": materialization["references"],
        "assetRefs": materialization["assetRefs"],
        "searchUnits": materialization["searchUnits"],
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if let [_, mode, input_update, output_update] = args.as_slice()
        && mode == "awareness"
    {
        let summary = generate_awareness(Path::new(input_update), Path::new(output_update))?;
        println!("{}", serde_json::to_string(&summary)?);
        return Ok(());
    }

    let summary = match args.as_slice() {
        [_, mode, fixture_root, corpus, yjs_updates, rust_updates] if mode == "randomized" => {
            let summaries = run_randomized_corpus(
                Path::new(fixture_root),
                Path::new(corpus),
                Path::new(yjs_updates),
                Path::new(rust_updates),
            )?;
            println!("{}", serde_json::to_string(&summaries)?);
            return Ok(());
        }
        [_, mode, fixture_root, corpus, output_update] if mode == "semantic-operations" => {
            let summary = run_semantic_operations(
                Path::new(fixture_root),
                Path::new(corpus),
                Path::new(output_update),
            )?;
            println!("{}", serde_json::to_string(&summary)?);
            return Ok(());
        }
        [_, mode, fixture_root, corpus, output_update] if mode == "markdown-patch" => {
            let summary = run_markdown_patch(
                Path::new(fixture_root),
                Path::new(corpus),
                Path::new(output_update),
            )?;
            println!("{}", serde_json::to_string(&summary)?);
            return Ok(());
        }
        [_, mode, fixture_root, output_update] if mode == "subtree-copy" => {
            let summary = run_subtree_copy(Path::new(fixture_root), Path::new(output_update))?;
            println!("{}", serde_json::to_string(&summary)?);
            return Ok(());
        }
        [_, mode, fixture_root, output_update] if mode == "generate" => {
            generate(Path::new(fixture_root), Path::new(output_update))?
        }
        [_, mode, fixture_root, output_update] if mode == "matrix-generate" => {
            generate_matrix(Path::new(fixture_root), Path::new(output_update))?
        }
        [_, mode, fixture_root, output_update] if mode == "matrix-block-tree-roundtrip" => {
            roundtrip_matrix_block_tree(Path::new(fixture_root), Path::new(output_update))?
        }
        [_, mode, fixture_root, rust_update, third_update] if mode == "inspect" => inspect(
            Path::new(fixture_root),
            Path::new(rust_update),
            Path::new(third_update),
        )?,
        [_, mode, fixture_root, rust_update, third_update] if mode == "matrix-inspect" => {
            inspect_matrix(
                Path::new(fixture_root),
                Path::new(rust_update),
                Path::new(third_update),
            )?
        }
        _ => {
            return Err(
                "usage: yjs_yrs_bridge generate|matrix-generate|matrix-block-tree-roundtrip|subtree-copy <fixture-root> <output-update> | inspect|matrix-inspect <fixture-root> <rust-update> <third-update> | awareness <input-update> <output-update> | randomized <fixture-root> <corpus-json> <yjs-update-root> <rust-update-root> | semantic-operations|markdown-patch <fixture-root> <corpus-json> <output-update>"
                    .into(),
            );
        }
    };

    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}
