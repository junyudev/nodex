use nodex_core_contracts::library::LibraryStructuralTurnIntoTarget;
use thiserror::Error;

use super::block_children::accepts_block_children;
use super::block_materialization::{MaterializedBlockNode, dematerialize_block_tree};
use super::materialized_inline::{MaterializedInlineError, materialized_inline_from_rich_text};
use super::ordinary_block::{
    canonical_equation_block_content, canonical_ordinary_block_shape, semantic_empty_document_root,
};
use super::rich_text::RichTextItem;

#[derive(Clone, Debug, PartialEq)]
pub struct PageToBlockTransformation {
    pub block: MaterializedBlockNode,
    pub trailing_siblings: Vec<MaterializedBlockNode>,
    pub retained_empty_placeholder_id: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PageToBlockError {
    #[error(transparent)]
    InvalidTitle(#[from] MaterializedInlineError),
    #[error("Page body contains an invalid Block tree: {0}")]
    InvalidBody(String),
    #[error("Turn into produced an invalid Block tree: {0}")]
    InvalidResult(String),
}

pub fn plan_page_to_block_transformation(
    page_id: &str,
    rich_title: &[RichTextItem],
    body_roots: &[MaterializedBlockNode],
    target: &LibraryStructuralTurnIntoTarget,
) -> Result<PageToBlockTransformation, PageToBlockError> {
    dematerialize_block_tree(body_roots)
        .map_err(|error| PageToBlockError::InvalidBody(error.to_string()))?;
    let retained_empty_placeholder_id =
        semantic_empty_document_root(body_roots).map(|root| root.id.clone());
    let (block_type, props) = canonical_ordinary_block_shape(target);
    let mut block = MaterializedBlockNode {
        id: page_id.to_owned(),
        block_type: block_type.to_owned(),
        props,
        content: Some(materialized_inline_from_rich_text(rich_title)?),
        children: Vec::new(),
    };
    if let Some(content) = canonical_equation_block_content(target, block.content.as_ref()) {
        block.content = Some(content);
    }
    let target_tree = dematerialize_block_tree(std::slice::from_ref(&block))
        .map_err(|error| PageToBlockError::InvalidResult(error.to_string()))?;
    let body = if retained_empty_placeholder_id.is_none() {
        body_roots.to_vec()
    } else {
        Vec::new()
    };
    let trailing_siblings = if accepts_block_children(&target_tree.blocks[0]) {
        block.children = body;
        Vec::new()
    } else {
        body
    };
    let mut result = vec![block.clone()];
    result.extend(trailing_siblings.clone());
    dematerialize_block_tree(&result)
        .map_err(|error| PageToBlockError::InvalidResult(error.to_string()))?;
    Ok(PageToBlockTransformation {
        block,
        trailing_siblings,
        retained_empty_placeholder_id,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nodex_core_contracts::library::{LibraryHeadingLevel, LibraryStructuralTurnIntoTarget};
    use serde_json::{Value, json};

    use super::*;
    use crate::domain::ordinary_block::default_props;
    use crate::domain::rich_text::RichTextStyles;

    fn paragraph(id: &str, text: &str) -> MaterializedBlockNode {
        MaterializedBlockNode {
            id: id.to_owned(),
            block_type: "paragraph".to_owned(),
            props: default_props(),
            content: Some(json!([{ "type": "text", "text": text, "styles": {} }])),
            children: Vec::new(),
        }
    }

    fn all_targets() -> Vec<(LibraryStructuralTurnIntoTarget, &'static str)> {
        let headings = [
            LibraryHeadingLevel::One,
            LibraryHeadingLevel::Two,
            LibraryHeadingLevel::Three,
        ]
        .into_iter()
        .flat_map(|level| {
            [false, true].map(move |toggleable| {
                (
                    LibraryStructuralTurnIntoTarget::Heading { level, toggleable },
                    "heading",
                )
            })
        });
        std::iter::once((LibraryStructuralTurnIntoTarget::Paragraph, "paragraph"))
            .chain(headings)
            .chain([
                (
                    LibraryStructuralTurnIntoTarget::BulletedList,
                    "bulletListItem",
                ),
                (
                    LibraryStructuralTurnIntoTarget::NumberedList,
                    "numberedListItem",
                ),
                (LibraryStructuralTurnIntoTarget::TodoList, "checkListItem"),
                (
                    LibraryStructuralTurnIntoTarget::ToggleList,
                    "toggleListItem",
                ),
                (LibraryStructuralTurnIntoTarget::Quote, "quote"),
                (LibraryStructuralTurnIntoTarget::Callout, "callout"),
                (LibraryStructuralTurnIntoTarget::Code, "codeBlock"),
                (LibraryStructuralTurnIntoTarget::Equation, "mathBlock"),
            ])
            .collect()
    }

    #[test]
    fn every_target_keeps_identity_title_and_body_reading_order() {
        let body = vec![MaterializedBlockNode {
            children: vec![paragraph("grandchild", "nested")],
            ..paragraph("child", "body")
        }];
        let title = vec![
            RichTextItem::Text {
                text: "Title ".to_owned(),
                styles: RichTextStyles {
                    bold: true,
                    ..RichTextStyles::default()
                },
            },
            RichTextItem::PageMention {
                target_page_id: "mentioned-page".to_owned(),
            },
        ];
        let targets = all_targets();
        assert_eq!(targets.len(), 15);
        for (target, expected_type) in targets {
            let plan = plan_page_to_block_transformation("page-a", &title, &body, &target)
                .expect("valid transformation");
            assert_eq!(plan.block.id, "page-a");
            assert_eq!(plan.block.block_type, expected_type);
            let accepts_children = !matches!(
                target,
                LibraryStructuralTurnIntoTarget::Code
                    | LibraryStructuralTurnIntoTarget::Equation
                    | LibraryStructuralTurnIntoTarget::Heading {
                        toggleable: false,
                        ..
                    }
            );
            if accepts_children {
                assert_eq!(plan.block.children, body);
                assert!(plan.trailing_siblings.is_empty());
            } else {
                assert!(plan.block.children.is_empty());
                assert_eq!(plan.trailing_siblings, body);
            }
            assert_eq!(plan.retained_empty_placeholder_id, None);
            if matches!(target, LibraryStructuralTurnIntoTarget::Equation) {
                assert_eq!(
                    plan.block.content,
                    Some(json!([{
                        "type": "text",
                        "text": "Title ",
                        "styles": {},
                    }]))
                );
            } else {
                assert_eq!(
                    crate::domain::materialized_inline::rich_text_from_materialized_inline(
                        plan.block.content.as_ref().expect("content")
                    )
                    .expect("decoded")
                    .rich_text,
                    title
                );
            }
        }
    }

    #[test]
    fn omitted_and_explicit_default_empty_bodies_stay_in_the_dormant_document() {
        let empty = MaterializedBlockNode {
            id: "empty".to_owned(),
            block_type: "paragraph".to_owned(),
            props: default_props(),
            content: Some(Value::Array(Vec::new())),
            children: Vec::new(),
        };
        for props in [default_props(), BTreeMap::new()] {
            let empty = MaterializedBlockNode {
                props,
                ..empty.clone()
            };
            let plan = plan_page_to_block_transformation(
                "page-a",
                &[],
                std::slice::from_ref(&empty),
                &LibraryStructuralTurnIntoTarget::Paragraph,
            )
            .expect("valid transformation");
            assert!(plan.block.children.is_empty());
            assert!(plan.trailing_siblings.is_empty());
            assert_eq!(plan.retained_empty_placeholder_id.as_deref(), Some("empty"));
        }

        let styled = MaterializedBlockNode {
            props: BTreeMap::from([("textColor".to_owned(), json!("red"))]),
            ..empty
        };
        let plan = plan_page_to_block_transformation(
            "page-a",
            &[],
            std::slice::from_ref(&styled),
            &LibraryStructuralTurnIntoTarget::Paragraph,
        )
        .expect("valid transformation");
        assert_eq!(plan.block.children, vec![styled]);
        assert!(plan.trailing_siblings.is_empty());
        assert_eq!(plan.retained_empty_placeholder_id, None);
    }
}
