use std::collections::BTreeMap;

use nodex_core_contracts::library::{LibraryHeadingLevel, LibraryStructuralTurnIntoTarget};
use serde_json::Value;

use super::block_materialization::MaterializedBlockNode;

pub fn canonical_ordinary_block_shape(
    target: &LibraryStructuralTurnIntoTarget,
) -> (&'static str, BTreeMap<String, Value>) {
    match target {
        LibraryStructuralTurnIntoTarget::Paragraph => ("paragraph", default_props()),
        LibraryStructuralTurnIntoTarget::Heading { level, toggleable } => {
            let mut props = default_props();
            props.insert(
                "level".to_owned(),
                Value::Number(heading_level(*level).into()),
            );
            props.insert("isToggleable".to_owned(), Value::Bool(*toggleable));
            ("heading", props)
        }
        LibraryStructuralTurnIntoTarget::BulletedList => ("bulletListItem", default_props()),
        LibraryStructuralTurnIntoTarget::NumberedList => ("numberedListItem", default_props()),
        LibraryStructuralTurnIntoTarget::TodoList => {
            let mut props = default_props();
            props.insert("checked".to_owned(), Value::Bool(false));
            ("checkListItem", props)
        }
        LibraryStructuralTurnIntoTarget::ToggleList => ("toggleListItem", default_props()),
        LibraryStructuralTurnIntoTarget::Quote => ("quote", quote_props()),
        LibraryStructuralTurnIntoTarget::Callout => {
            let mut props = default_props();
            props.insert("icon".to_owned(), Value::String("💡".to_owned()));
            ("callout", props)
        }
        LibraryStructuralTurnIntoTarget::Code => {
            let mut props = default_props();
            props.insert("language".to_owned(), Value::String("text".to_owned()));
            ("codeBlock", props)
        }
        LibraryStructuralTurnIntoTarget::Equation => ("mathBlock", BTreeMap::new()),
    }
}

/// Equation stores one canonical unstyled source atom, never rich inline nodes.
pub fn canonical_equation_block_content(
    target: &LibraryStructuralTurnIntoTarget,
    content: Option<&Value>,
) -> Option<Value> {
    if !matches!(target, LibraryStructuralTurnIntoTarget::Equation) {
        return None;
    }

    let mut source = String::new();
    append_plain_source(content.unwrap_or(&Value::Null), &mut source);
    Some(if source.is_empty() {
        Value::Array(Vec::new())
    } else {
        serde_json::json!([{ "type": "text", "text": source, "styles": {} }])
    })
}

fn append_plain_source(value: &Value, output: &mut String) {
    match value {
        Value::Array(items) => {
            for item in items {
                append_plain_source(item, output);
            }
        }
        Value::Object(item) => match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    output.push_str(text);
                }
            }
            Some("math") => {
                if let Some(source) = item.get("content").and_then(Value::as_str) {
                    output.push_str(source);
                }
            }
            Some("link") => {
                append_plain_source(item.get("content").unwrap_or(&Value::Null), output)
            }
            _ => {}
        },
        _ => {}
    }
}

/// Omitted ordinary properties have the same meaning as explicit default values.
pub fn semantic_empty_document_root(
    blocks: &[MaterializedBlockNode],
) -> Option<&MaterializedBlockNode> {
    let [block] = blocks else { return None };
    (block.block_type == "paragraph"
        && block.children.is_empty()
        && block
            .content
            .as_ref()
            .is_some_and(|content| content.as_array().is_some_and(Vec::is_empty))
        && block.props.iter().all(|(key, value)| {
            matches!(
                (key.as_str(), value.as_str()),
                ("textColor" | "backgroundColor", Some("default"))
                    | ("textAlignment", Some("left"))
            )
        }))
    .then_some(block)
}

pub fn default_props() -> BTreeMap<String, Value> {
    BTreeMap::from([
        (
            "backgroundColor".to_owned(),
            Value::String("default".to_owned()),
        ),
        ("textColor".to_owned(), Value::String("default".to_owned())),
        ("textAlignment".to_owned(), Value::String("left".to_owned())),
    ])
}

pub fn quote_props() -> BTreeMap<String, Value> {
    BTreeMap::from([
        (
            "backgroundColor".to_owned(),
            Value::String("default".to_owned()),
        ),
        ("textColor".to_owned(), Value::String("default".to_owned())),
    ])
}

fn heading_level(level: LibraryHeadingLevel) -> u8 {
    match level {
        LibraryHeadingLevel::One => 1,
        LibraryHeadingLevel::Two => 2,
        LibraryHeadingLevel::Three => 3,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn equation_flattens_text_links_and_inline_equations() {
        let content = json!([
            { "type": "text", "text": "Energy ", "styles": { "bold": true } },
            { "type": "math", "props": {}, "content": "E = mc^2" },
            { "type": "link", "href": "https://example.com", "content": [
                { "type": "text", "text": " reference", "styles": {} }
            ] }
        ]);
        let expected = json!([{
            "type": "text",
            "text": "Energy E = mc^2 reference",
            "styles": {},
        }]);

        assert_eq!(
            canonical_equation_block_content(
                &LibraryStructuralTurnIntoTarget::Equation,
                Some(&content)
            ),
            Some(expected)
        );
        assert_eq!(
            canonical_equation_block_content(
                &LibraryStructuralTurnIntoTarget::Code,
                Some(&content)
            ),
            None
        );
        assert_eq!(
            canonical_equation_block_content(
                &LibraryStructuralTurnIntoTarget::Paragraph,
                Some(&content)
            ),
            None
        );
    }
}
