//! Where each Block's own text lies in an exact text.
//!
//! Exact patches and drafts keep the identity of every Block they leave unchanged by mapping
//! edited text back to the Blocks that wrote it. A Block owns the lines it writes itself: its
//! markers and text, a container's opening and closing lines, a table's or code Block's lines.
//! Its children's lines belong to the children, and blank lines that only separate Blocks belong
//! to no Block.

use std::ops::Range;

/// The byte ranges of the lines one Block owns, each line with its line ending except the
/// text's last line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceBlock {
    pub spans: Vec<Range<usize>>,
}

/// Blocks read from a text, with where each one's own lines lie in it. `locations` follows the
/// Block tree in preorder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub blocks: Vec<crate::Block>,
    pub locations: Vec<SourceBlock>,
}
