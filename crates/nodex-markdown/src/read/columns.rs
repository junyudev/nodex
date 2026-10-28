//! Source columns of inline nodes. Comrak reads a table cell after unescaping its `\|`, so a
//! position it reports inside a cell falls one column short for every `\|` before it there.

use comrak::nodes::{AstNode, LineColumn, NodeValue};
use std::collections::HashMap;

pub(super) struct Columns {
    /// Per line, each `\|` by its byte offset and by its offset once earlier ones are unescaped.
    pipe_escapes: HashMap<usize, Vec<(usize, usize)>>,
}

impl Columns {
    pub fn new<'s>(lines: impl IntoIterator<Item = &'s str>) -> Self {
        let mut pipe_escapes = HashMap::new();
        for (line, source) in lines.into_iter().enumerate() {
            let positions: Vec<_> = source
                .match_indices("\\|")
                .enumerate()
                .map(|(removed, (raw, _))| (raw, raw - removed))
                .collect();
            if !positions.is_empty() {
                pipe_escapes.insert(line, positions);
            }
        }
        Self { pipe_escapes }
    }

    /// The byte offset, within its line, of a position comrak reports for `node`.
    pub fn offset<'a>(&self, node: &'a AstNode<'a>, position: LineColumn) -> usize {
        let index = position.column.saturating_sub(1);
        let Some(escapes) = self.pipe_escapes.get(&position.line.saturating_sub(1)) else {
            return index;
        };
        let Some(cell) = node
            .ancestors()
            .find(|n| matches!(n.data.borrow().value, NodeValue::TableCell))
        else {
            return index;
        };
        let start = cell.data.borrow().sourcepos.start.column.saturating_sub(1);
        let target = index.saturating_sub(start);
        let before = escapes.partition_point(|(raw, _)| *raw < start);
        let logical_end = start.saturating_sub(before) + target;
        let through = escapes.partition_point(|(_, logical)| *logical < logical_end);
        start + target + through.saturating_sub(before)
    }
}
