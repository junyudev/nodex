use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use super::block_materialization::MaterializedBlockNode;
use super::materialized_inline::rich_text_from_materialized_inline;
use super::rich_text::{RichTextItem, RichTextMaterialization, RichTextStyles};

const PROMOTABLE_TYPES: &[&str] = &[
    "paragraph",
    "heading",
    "bulletListItem",
    "numberedListItem",
    "toggleListItem",
    "quote",
];
const WRAPPED_TYPES: &[&str] = &[
    "checkListItem",
    "codeBlock",
    "mathBlock",
    "table",
    "divider",
    "image",
    "callout",
    "database",
    "pageRef",
    "databaseViewRef",
    "syncedBlockRef",
    "templateRef",
];
const PRESENTATION_PROPERTIES: &[&str] = &[
    "backgroundColor",
    "textColor",
    "textAlignment",
    "level",
    "isToggleable",
    "start",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PageWrapperReason {
    TypeRequiresWrapper,
    UnsupportedPrimaryContent,
    UnmappedTypeState,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BlockToPageTransformation {
    Promote {
        page_id: String,
        rich_title: Vec<RichTextItem>,
        body_roots: Vec<MaterializedBlockNode>,
        consumed_type: String,
        consumed_props: BTreeMap<String, Value>,
        placeholder_block_id: Option<String>,
    },
    Wrap {
        page_id: String,
        wrapped_root: MaterializedBlockNode,
        rich_title: Vec<RichTextItem>,
        reason: PageWrapperReason,
    },
    AlreadyPage {
        page_id: String,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BlockToPageError {
    #[error("Block type {0} has no Page transformation capability")]
    UnknownBlockType(String),
    #[error("Block primary content is not title-safe")]
    UnsupportedPrimaryContent,
}

pub fn plan_block_to_page_transformation(
    root: &MaterializedBlockNode,
    result_root_id: &str,
    wrapper_page_id: &str,
    empty_body_block_id: &str,
) -> Result<BlockToPageTransformation, BlockToPageError> {
    if root.block_type == "page" {
        return Ok(BlockToPageTransformation::AlreadyPage {
            page_id: result_root_id.to_owned(),
        });
    }
    if WRAPPED_TYPES.contains(&root.block_type.as_str()) {
        return Ok(wrap(
            root,
            wrapper_page_id,
            PageWrapperReason::TypeRequiresWrapper,
        ));
    }
    if !PROMOTABLE_TYPES.contains(&root.block_type.as_str()) {
        return Err(BlockToPageError::UnknownBlockType(root.block_type.clone()));
    }
    if root
        .props
        .keys()
        .any(|key| !PRESENTATION_PROPERTIES.contains(&key.as_str()))
    {
        return Ok(wrap(
            root,
            wrapper_page_id,
            PageWrapperReason::UnmappedTypeState,
        ));
    }
    let rich_title = match primary_rich_text(root) {
        Ok(value) => value.rich_text,
        Err(BlockToPageError::UnsupportedPrimaryContent) => {
            return Ok(wrap(
                root,
                wrapper_page_id,
                PageWrapperReason::UnsupportedPrimaryContent,
            ));
        }
        Err(error) => return Err(error),
    };
    let (body_roots, placeholder_block_id) = if root.children.is_empty() {
        (
            vec![empty_paragraph(empty_body_block_id)],
            Some(empty_body_block_id.to_owned()),
        )
    } else {
        (root.children.clone(), None)
    };
    Ok(BlockToPageTransformation::Promote {
        page_id: result_root_id.to_owned(),
        rich_title,
        body_roots,
        consumed_type: root.block_type.clone(),
        consumed_props: root.props.clone(),
        placeholder_block_id,
    })
}

fn wrap(
    root: &MaterializedBlockNode,
    wrapper_page_id: &str,
    reason: PageWrapperReason,
) -> BlockToPageTransformation {
    let fallback = vec![RichTextItem::Text {
        text: root.block_type.clone(),
        styles: RichTextStyles::default(),
    }];
    let rich_title = primary_rich_text(root)
        .ok()
        .filter(|value| !value.plain_text.trim().is_empty())
        .map_or(fallback, |value| value.rich_text);
    BlockToPageTransformation::Wrap {
        page_id: wrapper_page_id.to_owned(),
        wrapped_root: root.clone(),
        rich_title,
        reason,
    }
}

fn primary_rich_text(
    root: &MaterializedBlockNode,
) -> Result<RichTextMaterialization, BlockToPageError> {
    root.content
        .as_ref()
        .ok_or(BlockToPageError::UnsupportedPrimaryContent)
        .and_then(|content| {
            rich_text_from_materialized_inline(content)
                .map_err(|_| BlockToPageError::UnsupportedPrimaryContent)
        })
}

fn empty_paragraph(block_id: &str) -> MaterializedBlockNode {
    MaterializedBlockNode {
        id: block_id.to_owned(),
        block_type: "paragraph".to_owned(),
        props: BTreeMap::from([
            (
                "backgroundColor".to_owned(),
                Value::String("default".to_owned()),
            ),
            ("textColor".to_owned(), Value::String("default".to_owned())),
            ("textAlignment".to_owned(), Value::String("left".to_owned())),
        ]),
        content: Some(Value::Array(Vec::new())),
        children: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::domain::rich_text::RichTextStyles;

    fn paragraph(
        id: &str,
        content: Value,
        children: Vec<MaterializedBlockNode>,
    ) -> MaterializedBlockNode {
        MaterializedBlockNode {
            id: id.to_owned(),
            block_type: "paragraph".to_owned(),
            props: BTreeMap::from([
                ("backgroundColor".to_owned(), json!("default")),
                ("textColor".to_owned(), json!("default")),
                ("textAlignment".to_owned(), json!("left")),
            ]),
            content: Some(content),
            children,
        }
    }

    #[test]
    fn promotes_rich_primary_content_and_lifts_only_children() {
        let child = paragraph(
            "child-a",
            json!([{ "type": "text", "text": "Child", "styles": {} }]),
            Vec::new(),
        );
        let root = paragraph(
            "root-a",
            json!([
                { "type": "text", "text": "Rich ", "styles": { "bold": true } },
                { "type": "link", "href": "https://nodex.local", "content": [
                    { "type": "text", "text": "title", "styles": { "italic": true } }
                ] },
                { "type": "threadMention", "props": { "uuid": "thread-a" } },
                { "type": "pageMention", "props": { "targetPageId": "page-a" } }
            ]),
            vec![child.clone()],
        );
        let plan =
            plan_block_to_page_transformation(&root, "root-a", "wrapper-unused", "empty-unused")
                .expect("promotion");
        let BlockToPageTransformation::Promote {
            page_id,
            rich_title,
            body_roots,
            placeholder_block_id,
            ..
        } = plan
        else {
            panic!("promotion");
        };
        assert_eq!(page_id, "root-a");
        assert_eq!(body_roots, vec![child]);
        assert_eq!(placeholder_block_id, None);
        assert_eq!(
            rich_title,
            vec![
                RichTextItem::Text {
                    text: "Rich ".to_owned(),
                    styles: RichTextStyles {
                        bold: true,
                        ..RichTextStyles::default()
                    },
                },
                RichTextItem::Link {
                    text: "title".to_owned(),
                    href: "https://nodex.local".to_owned(),
                    styles: RichTextStyles {
                        italic: true,
                        ..RichTextStyles::default()
                    },
                },
                RichTextItem::ThreadMention {
                    uuid: "thread-a".to_owned(),
                },
                RichTextItem::PageMention {
                    target_page_id: "page-a".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn allocates_one_canonical_empty_body_for_a_promoted_leaf() {
        let root = paragraph(
            "leaf",
            json!([{ "type": "text", "text": "Leaf", "styles": {} }]),
            Vec::new(),
        );
        let BlockToPageTransformation::Promote {
            body_roots,
            placeholder_block_id,
            ..
        } = plan_block_to_page_transformation(&root, "leaf", "unused", "empty-body")
            .expect("promotion")
        else {
            panic!("promotion");
        };
        assert_eq!(placeholder_block_id.as_deref(), Some("empty-body"));
        assert_eq!(body_roots, vec![empty_paragraph("empty-body")]);
    }

    #[test]
    fn wraps_unsupported_atoms_and_stateful_types_without_loss() {
        let attachment = paragraph(
            "attachment-root",
            json!([{ "type": "attachment", "props": {
                "kind": "file", "mode": "materialized", "source": "nodex://assets/demo.txt", "name": "demo.txt"
            } }]),
            Vec::new(),
        );
        let plan = plan_block_to_page_transformation(
            &attachment,
            "attachment-root",
            "wrapper-attachment",
            "unused",
        )
        .expect("wrapper");
        assert!(matches!(
            plan,
            BlockToPageTransformation::Wrap {
                page_id,
                wrapped_root,
                reason: PageWrapperReason::UnsupportedPrimaryContent,
                ..
            } if page_id == "wrapper-attachment" && wrapped_root == attachment
        ));

        let mut checklist = paragraph(
            "check",
            json!([{ "type": "text", "text": "Done", "styles": {} }]),
            Vec::new(),
        );
        checklist.block_type = "checkListItem".to_owned();
        checklist.props = BTreeMap::from([("checked".to_owned(), json!(true))]);
        let BlockToPageTransformation::Wrap {
            rich_title, reason, ..
        } = plan_block_to_page_transformation(&checklist, "check", "wrapper-check", "unused")
            .expect("wrapper")
        else {
            panic!("wrapper");
        };
        assert_eq!(reason, PageWrapperReason::TypeRequiresWrapper);
        assert_eq!(
            rich_title,
            vec![RichTextItem::Text {
                text: "Done".to_owned(),
                styles: RichTextStyles::default(),
            }]
        );
    }
}
