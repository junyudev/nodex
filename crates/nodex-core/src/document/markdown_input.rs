use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::markdown::{MarkdownMaterializationError, materialize_markdown_blocks_with_ids};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub(crate) enum DocumentMarkdownInputError {
    #[error(transparent)]
    Parse(#[from] nodex_markdown::ReadError),
    #[error(transparent)]
    Materialization(#[from] MarkdownMaterializationError),
    #[error(
        "Markdown insertion must contain at least one Block; use <br> to insert an intentional empty Block"
    )]
    EmptyFragment,
}

pub(crate) fn materialize_document_markdown(
    input: &str,
    allocate: &mut impl FnMut() -> String,
) -> Result<Vec<MaterializedBlockNode>, DocumentMarkdownInputError> {
    let parsed = nodex_markdown::read_located(input, nodex_markdown::ReadOptions::EXACT)?;
    Ok(materialize_markdown_blocks_with_ids(
        &parsed.blocks,
        allocate,
    )?)
}

pub(crate) fn materialize_markdown_fragment(
    input: &str,
    allocate: &mut impl FnMut() -> String,
) -> Result<Vec<MaterializedBlockNode>, DocumentMarkdownInputError> {
    if input.trim().is_empty() {
        return Err(DocumentMarkdownInputError::EmptyFragment);
    }
    materialize_document_markdown(input, allocate)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_document_and_explicit_empty_insertion_have_distinct_boundaries() {
        let blocks = materialize_document_markdown("", &mut || "seed".into()).unwrap();
        assert_eq!(blocks[0].id, "seed");
        assert_eq!(blocks[0].content, Some(serde_json::json!([])));
        assert!(matches!(
            materialize_markdown_fragment(" \n", &mut || panic!("must not allocate")),
            Err(DocumentMarkdownInputError::EmptyFragment)
        ));
        assert_eq!(
            materialize_markdown_fragment("<br>", &mut || "empty".into())
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn malformed_exact_input_keeps_the_language_error() {
        let input = ":::toggle[Truncated]";
        let expected =
            nodex_markdown::read_located(input, nodex_markdown::ReadOptions::EXACT).unwrap_err();
        assert_eq!(
            materialize_document_markdown(input, &mut || panic!("must not allocate"))
                .unwrap_err()
                .to_string(),
            expected.to_string()
        );
    }
}
