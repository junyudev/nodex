//! Compile changes in the editable NFM projection against authoritative Blocks.
//! Source locations distinguish repeated text; parsing defaults never replace
//! fields or topology that the patch did not change.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use similar::{Algorithm, DiffTag, capture_diff_slices};

use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::nfm::{NfmBlock, NfmSourceBlock, materialize_nfm, serialize_nfm_located};
use crate::domain::nfm_parser::{
    LocatedNfm, materialize_nfm_blocks_with_ids, parse_nfm, parse_nfm_located,
};

use super::operations::{NfmPatchSpan, operation_error, resolve_exact_nfm_patches};
use super::{
    DocumentBlockOperation, DocumentBlockUpdatePatch, DocumentMaterialization,
    DocumentOperationError, DocumentOperationErrorCode, ExactNfmPatch,
};

// Bound alignment work independently of document size. Unchanged prefixes and
// suffixes are removed before this budget applies; large unrelated documents do
// not make a narrow patch expensive.
const MAX_ALIGNMENT_CELLS: usize = 1_000_000;

#[derive(Clone)]
struct FlatBlock {
    block: MaterializedBlockNode,
    parent: Option<usize>,
}

struct Projection {
    blocks: Vec<FlatBlock>,
    locations: Vec<NfmSourceBlock>,
}

struct TextChange {
    old: Range<usize>,
    new: Range<usize>,
    equal: bool,
}

struct DesiredBlock {
    block: MaterializedBlockNode,
    parent: Option<String>,
    order: (usize, usize),
}

pub(super) fn compile(
    source: &DocumentMaterialization,
    patches: &[ExactNfmPatch],
    allocate_block_id: &mut impl FnMut() -> String,
) -> Result<Vec<DocumentBlockOperation>, DocumentOperationError> {
    let (text, mut locations) = located_body(&source.block_tree)?;
    let spans = resolve_exact_nfm_patches(&text, patches)?;
    let (target_text, changes) = patch_with_provenance(&text, &spans)?;
    let mut old = project(parse_nfm_located(&text).map_err(invalid)?)?;
    let parsed_target = parse_nfm_located(&target_text).map_err(invalid)?;
    let expected_projection = parsed_target.blocks.clone();
    let new = project(parsed_target)?;
    let actual = flatten(&source.block_tree);
    if locations.len() != actual.len() {
        return Err(invalid("NFM cannot locate every authoritative Block"));
    }
    // The semantic empty root has no emitted text but remains the one editable
    // authority Block when a patch fills or clears the document.
    if source.nfm.is_empty() {
        locations[0].spans = std::iter::once(0..text.len()).collect();
        old.locations[0].spans = locations[0].spans.clone();
    }
    let source_edges = overlap_edges(
        &locations,
        &old.locations,
        &[TextChange {
            old: 0..text.len(),
            new: 0..text.len(),
            equal: true,
        }],
    );
    let projected_sources = invert_edges(&source_edges, old.blocks.len());
    let lineage = correlate(&old, &new, &changes);
    let desired = desired_blocks(
        &actual,
        &old,
        &new,
        &projected_sources,
        &lineage,
        allocate_block_id,
    )?;
    let tree = build_tree(&desired)?;
    let actual_projection = materialize_nfm(&tree).map_err(invalid)?;
    if parse_nfm(&actual_projection.nfm).map_err(invalid)? != expected_projection {
        return Err(invalid(
            "NFM patch cannot preserve the requested projection and Block identities; use explicit Block operations for this structural change",
        ));
    }
    compile_operations(&source.block_tree, &tree)
}

/// Use the same canonical byte locations for draft observations and semantic patches.
fn located_body(
    tree: &[MaterializedBlockNode],
) -> Result<(String, Vec<NfmSourceBlock>), DocumentOperationError> {
    let source_nfm = materialize_nfm(tree).map_err(invalid)?;
    let (mut text, mut locations) = serialize_nfm_located(&source_nfm.blocks);
    if source_nfm.nfm.is_empty() {
        text.clear();
        locations = vec![NfmSourceBlock {
            spans: std::iter::once(0..1).collect(),
        }];
    }
    if !text.ends_with('\n') {
        let end = text.len();
        text.push('\n');
        if let Some(span) = locations
            .iter_mut()
            .flat_map(|item| &mut item.spans)
            .find(|span| span.end == end)
        {
            span.end += 1;
        }
    }
    Ok((text, locations))
}

pub(crate) fn draft_body_blocks(
    tree: &[MaterializedBlockNode],
    expected_body: &str,
) -> Result<Vec<nodex_core_contracts::library::LibraryPageDraftBlock>, DocumentOperationError> {
    use nodex_core_contracts::library::{LibraryPageDraftBlock, LibraryPageDraftSpan};
    let (text, locations) = located_body(tree)?;
    let actual = flatten(tree);
    if text != expected_body || actual.len() != locations.len() {
        return Err(invalid(
            "Draft body and Block locations must share one exact materialization",
        ));
    }
    Ok(actual
        .iter()
        .zip(locations)
        .map(|(block, location)| LibraryPageDraftBlock {
            block_id: block.block.id.clone(),
            parent_block_id: block.parent.map(|index| actual[index].block.id.clone()),
            spans: location
                .spans
                .into_iter()
                .map(|span| LibraryPageDraftSpan {
                    start: span.start,
                    end: span.end,
                })
                .collect(),
        })
        .collect())
}

fn invalid(message: impl std::fmt::Display) -> DocumentOperationError {
    operation_error(
        DocumentOperationErrorCode::InvalidNfm,
        message.to_string(),
        None,
        None,
    )
}

fn flatten(blocks: &[MaterializedBlockNode]) -> Vec<FlatBlock> {
    fn visit(blocks: &[MaterializedBlockNode], parent: Option<usize>, output: &mut Vec<FlatBlock>) {
        for block in blocks {
            let index = output.len();
            let mut own = block.clone();
            own.children.clear();
            output.push(FlatBlock { block: own, parent });
            visit(&block.children, Some(index), output);
        }
    }
    let mut output = Vec::new();
    visit(blocks, None, &mut output);
    output
}

fn project(mut parsed: LocatedNfm) -> Result<Projection, DocumentOperationError> {
    if parsed.blocks.is_empty() {
        parsed.blocks.push(NfmBlock::EmptyBlock {
            children: Vec::new(),
        });
        parsed.locations.push(NfmSourceBlock::default());
    }
    let mut ordinal = 0;
    let blocks = materialize_nfm_blocks_with_ids(&parsed.blocks, &mut || {
        let id = format!("projection-{ordinal}");
        ordinal += 1;
        id
    })
    .map_err(invalid)?;
    let blocks = flatten(&blocks);
    if blocks.len() != parsed.locations.len() {
        return Err(invalid("Parsed NFM locations do not cover its Block tree"));
    }
    Ok(Projection {
        blocks,
        locations: parsed.locations,
    })
}

fn patch_with_provenance(
    source: &str,
    spans: &[NfmPatchSpan],
) -> Result<(String, Vec<TextChange>), DocumentOperationError> {
    let mut text = String::new();
    let mut changes = Vec::new();
    let mut cursor = 0;
    for span in spans {
        append_equal(source, cursor..span.start, &mut text, &mut changes);
        let target_start = text.len();
        text.push_str(&span.replacement);
        align_replacement(
            &source[span.start..span.end],
            &span.replacement,
            span.start,
            target_start,
            &mut changes,
        )?;
        cursor = span.end;
    }
    append_equal(source, cursor..source.len(), &mut text, &mut changes);
    Ok((text, changes))
}

fn append_equal(
    source: &str,
    range: Range<usize>,
    text: &mut String,
    changes: &mut Vec<TextChange>,
) {
    if range.is_empty() {
        return;
    }
    let start = text.len();
    text.push_str(&source[range.clone()]);
    changes.push(TextChange {
        old: range,
        new: start..text.len(),
        equal: true,
    });
}

fn line_offsets(lines: &[&str]) -> Vec<usize> {
    std::iter::once(0)
        .chain(lines.iter().scan(0, |offset, line| {
            *offset += line.len();
            Some(*offset)
        }))
        .collect()
}

fn align_replacement(
    old: &str,
    new: &str,
    old_start: usize,
    new_start: usize,
    output: &mut Vec<TextChange>,
) -> Result<(), DocumentOperationError> {
    let old_lines: Vec<_> = old.split_inclusive('\n').collect();
    let new_lines: Vec<_> = new.split_inclusive('\n').collect();
    let old_offsets = line_offsets(&old_lines);
    let new_offsets = line_offsets(&new_lines);
    let prefix = old_lines
        .iter()
        .zip(&new_lines)
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = old_lines[prefix..]
        .iter()
        .rev()
        .zip(new_lines[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_end = old_lines.len() - suffix;
    let new_end = new_lines.len() - suffix;
    if (old_end - prefix).saturating_mul(new_end - prefix) > MAX_ALIGNMENT_CELLS {
        return Err(invalid(
            "NFM patch edit region is too large to correlate safely; use smaller patches or an explicit body replacement",
        ));
    }
    output.push(TextChange {
        old: old_start..old_start + old_offsets[prefix],
        new: new_start..new_start + new_offsets[prefix],
        equal: true,
    });
    for op in capture_diff_slices(
        Algorithm::Myers,
        &old_lines[prefix..old_end],
        &new_lines[prefix..new_end],
    ) {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        let old_range = old_offsets[prefix + old_range.start]..old_offsets[prefix + old_range.end];
        let new_range = new_offsets[prefix + new_range.start]..new_offsets[prefix + new_range.end];
        if tag == DiffTag::Equal {
            output.push(TextChange {
                old: old_start + old_range.start..old_start + old_range.end,
                new: new_start + new_range.start..new_start + new_range.end,
                equal: true,
            });
            continue;
        }
        align_characters(
            &old[old_range.clone()],
            &new[new_range.clone()],
            old_start + old_range.start,
            new_start + new_range.start,
            output,
        )?;
    }
    output.push(TextChange {
        old: old_start + old_offsets[old_end]..old_start + old.len(),
        new: new_start + new_offsets[new_end]..new_start + new.len(),
        equal: true,
    });
    Ok(())
}

fn align_characters(
    old: &str,
    new: &str,
    old_start: usize,
    new_start: usize,
    output: &mut Vec<TextChange>,
) -> Result<(), DocumentOperationError> {
    let old_chars: Vec<_> = old.chars().collect();
    let new_chars: Vec<_> = new.chars().collect();
    let prefix = old_chars
        .iter()
        .zip(&new_chars)
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = old_chars[prefix..]
        .iter()
        .rev()
        .zip(new_chars[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_end = old_chars.len() - suffix;
    let new_end = new_chars.len() - suffix;
    if (old_end - prefix).saturating_mul(new_end - prefix) > MAX_ALIGNMENT_CELLS {
        return Err(invalid(
            "NFM patch edit region is too large to correlate safely; use smaller patches or an explicit body replacement",
        ));
    }
    let offsets = |chars: &[char]| {
        std::iter::once(0)
            .chain(chars.iter().scan(0, |offset, character| {
                *offset += character.len_utf8();
                Some(*offset)
            }))
            .collect::<Vec<_>>()
    };
    let old_offsets = offsets(&old_chars);
    let new_offsets = offsets(&new_chars);
    output.push(TextChange {
        old: old_start..old_start + old_offsets[prefix],
        new: new_start..new_start + new_offsets[prefix],
        equal: true,
    });
    for op in capture_diff_slices(
        Algorithm::Myers,
        &old_chars[prefix..old_end],
        &new_chars[prefix..new_end],
    ) {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        output.push(TextChange {
            old: old_start + old_offsets[prefix + old_range.start]
                ..old_start + old_offsets[prefix + old_range.end],
            new: new_start + new_offsets[prefix + new_range.start]
                ..new_start + new_offsets[prefix + new_range.end],
            equal: tag == DiffTag::Equal,
        });
    }
    output.push(TextChange {
        old: old_start + old_offsets[old_end]..old_start + old.len(),
        new: new_start + new_offsets[new_end]..new_start + new.len(),
        equal: true,
    });
    Ok(())
}

fn intersects(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}

fn indexed_spans(locations: &[NfmSourceBlock]) -> Vec<(Range<usize>, usize)> {
    let mut spans: Vec<_> = locations
        .iter()
        .enumerate()
        .flat_map(|(index, location)| location.spans.iter().map(move |span| (span.clone(), index)))
        .collect();
    spans.sort_by_key(|(span, _)| span.start);
    spans
}

/// Build correspondence from positions, not from a global search for equal text.
fn overlap_edges(
    old: &[NfmSourceBlock],
    new: &[NfmSourceBlock],
    changes: &[TextChange],
) -> Vec<BTreeSet<usize>> {
    let old_spans = indexed_spans(old);
    let new_spans = indexed_spans(new);
    let mut edges = vec![BTreeSet::new(); old.len()];
    for change in changes
        .iter()
        .filter(|change| change.equal && !change.old.is_empty())
    {
        let mut left = old_spans.partition_point(|(span, _)| span.end <= change.old.start);
        let mut right = new_spans.partition_point(|(span, _)| span.end <= change.new.start);
        while let (Some((a, ai)), Some((b, bi))) = (old_spans.get(left), new_spans.get(right)) {
            if a.start >= change.old.end || b.start >= change.new.end {
                break;
            }
            let translated = change.new.start + a.start.max(change.old.start) - change.old.start
                ..change.new.start + a.end.min(change.old.end) - change.old.start;
            if intersects(&translated, b) {
                edges[*ai].insert(*bi);
            }
            if translated.end <= b.end {
                left += 1;
            } else {
                right += 1;
            }
        }
    }
    edges
}

fn invert_edges(edges: &[BTreeSet<usize>], target_count: usize) -> Vec<Vec<usize>> {
    let mut reverse = vec![Vec::new(); target_count];
    for (source, targets) in edges.iter().enumerate() {
        for target in targets {
            reverse[*target].push(source);
        }
    }
    reverse
}

fn own_equal(a: &MaterializedBlockNode, b: &MaterializedBlockNode) -> bool {
    a.block_type == b.block_type && a.props == b.props && a.content == b.content
}

fn touched(locations: &[NfmSourceBlock], range: &Range<usize>) -> Vec<usize> {
    locations
        .iter()
        .enumerate()
        .filter_map(|(index, location)| {
            location
                .spans
                .iter()
                .any(|span| intersects(span, range))
                .then_some(index)
        })
        .collect()
}

/// Anchor unchanged projected Blocks, then retain one-to-one changed regions.
/// Splits/merges without a surviving anchor introduce new identities.
fn correlate(old: &Projection, new: &Projection, changes: &[TextChange]) -> Vec<Option<usize>> {
    let all_edges = overlap_edges(&old.locations, &new.locations, changes);
    let all_reverse = invert_edges(&all_edges, new.blocks.len());
    let mut edges = all_edges.clone();
    for (index, targets) in edges.iter_mut().enumerate() {
        targets.retain(|target| own_equal(&old.blocks[index].block, &new.blocks[*target].block));
    }
    let reverse = invert_edges(&edges, new.blocks.len());
    let mut lineage = vec![None; new.blocks.len()];
    let mut used = BTreeSet::new();
    for (index, candidates) in reverse.iter().enumerate() {
        let [old_index] = candidates.as_slice() else {
            continue;
        };
        if edges[*old_index].len() != 1
            || !own_equal(&old.blocks[*old_index].block, &new.blocks[index].block)
        {
            continue;
        }
        lineage[index] = Some(*old_index);
        used.insert(*old_index);
    }
    for change in changes.iter().filter(|change| !change.equal) {
        let mut old_touched = touched(&old.locations, &change.old);
        let mut new_touched = touched(&new.locations, &change.new);
        // A pure insertion/deletion inside an existing token has an empty span
        // on one side. Its surviving bytes identify the edited Block.
        if change.old.is_empty() {
            old_touched = new_touched
                .iter()
                .flat_map(|index| all_reverse[*index].iter().copied())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        }
        if change.new.is_empty() {
            new_touched = old_touched
                .iter()
                .flat_map(|index| all_edges[*index].iter().copied())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        }
        let old_candidates: Vec<_> = old_touched
            .into_iter()
            .filter(|id| !used.contains(id))
            .collect();
        let new_candidates: Vec<_> = new_touched
            .into_iter()
            .filter(|id| lineage[*id].is_none())
            .collect();
        let ([old_index], [new_index]) = (old_candidates.as_slice(), new_candidates.as_slice())
        else {
            continue;
        };
        lineage[*new_index] = Some(*old_index);
        used.insert(*old_index);
    }
    if old.blocks.len() == 1 && new.blocks.len() == 1 && lineage[0].is_none() {
        lineage[0] = Some(0);
    }
    lineage
}

fn overlay(
    original: &MaterializedBlockNode,
    old: &MaterializedBlockNode,
    new: &MaterializedBlockNode,
) -> MaterializedBlockNode {
    let mut result = original.clone();
    if old.block_type != new.block_type {
        result.block_type = new.block_type.clone();
    }
    if old.content != new.content {
        result.content = new.content.clone();
    }
    for key in old
        .props
        .keys()
        .chain(new.props.keys())
        .collect::<BTreeSet<_>>()
    {
        if old.props.get(key) == new.props.get(key) {
            continue;
        }
        if let Some(value) = new.props.get(key) {
            result.props.insert(key.clone(), value.clone());
        } else {
            result.props.remove(key);
        }
    }
    result
}

fn desired_blocks(
    actual: &[FlatBlock],
    old: &Projection,
    new: &Projection,
    projected_sources: &[Vec<usize>],
    lineage: &[Option<usize>],
    allocate: &mut impl FnMut() -> String,
) -> Result<Vec<DesiredBlock>, DocumentOperationError> {
    let sources: Vec<_> = lineage
        .iter()
        .map(|old| {
            old.map(|i| projected_sources[i].clone())
                .unwrap_or_default()
        })
        .collect();
    let retained: BTreeSet<_> = sources.iter().flatten().copied().collect();
    // A lossy projection can combine original Blocks (e.g. an empty callout's
    // first paragraph). Keep that opaque group intact unless explicitly changed.
    for (index, group) in projected_sources
        .iter()
        .enumerate()
        .filter(|(_, group)| group.len() != 1)
    {
        let Some(target) = lineage.iter().position(|origin| *origin == Some(index)) else {
            if group.is_empty() {
                continue;
            }
            return Err(invalid(
                "NFM patch would remove an ambiguous Block projection; use explicit Block operations",
            ));
        };
        if !own_equal(&old.blocks[index].block, &new.blocks[target].block) {
            return Err(invalid(
                "NFM patch would modify an ambiguous Block projection; use explicit Block operations",
            ));
        }
    }
    let mut ids = Vec::with_capacity(new.blocks.len());
    let mut reserved_ids: BTreeSet<_> = actual.iter().map(|item| item.block.id.clone()).collect();
    for group in &sources {
        if let Some(source) = group.first() {
            ids.push(actual[*source].block.id.clone());
            continue;
        }
        let id = allocate();
        if !reserved_ids.insert(id.clone()) {
            return Err(invalid("NFM patch allocator reused a Block identity"));
        }
        ids.push(id);
    }
    let mut desired = Vec::new();
    for (index, projected) in new.blocks.iter().enumerate() {
        let target_parent = projected.parent.map(|parent| ids[parent].clone());
        let Some(old_index) = lineage[index] else {
            let mut block = projected.block.clone();
            block.id = ids[index].clone();
            desired.push(DesiredBlock {
                block,
                parent: target_parent,
                order: (index, 0),
            });
            continue;
        };
        let same_parent = match (old.blocks[old_index].parent, projected.parent) {
            (None, None) => true,
            (Some(old_parent), Some(new_parent)) => lineage[new_parent] == Some(old_parent),
            _ => false,
        };
        if sources[index].len() > 1 && !same_parent {
            return Err(invalid(
                "NFM patch cannot move an ambiguous Block projection",
            ));
        }
        for (rank, source_index) in sources[index].iter().enumerate() {
            let original = &actual[*source_index];
            let parent = if same_parent
                && original
                    .parent
                    .is_none_or(|parent| retained.contains(&parent))
            {
                original
                    .parent
                    .map(|parent| actual[parent].block.id.clone())
            } else {
                target_parent.clone()
            };
            let block = if sources[index].len() == 1 {
                overlay(
                    &original.block,
                    &old.blocks[old_index].block,
                    &projected.block,
                )
            } else {
                original.block.clone()
            };
            desired.push(DesiredBlock {
                block,
                parent,
                order: (index, rank),
            });
        }
    }
    if desired.len()
        != desired
            .iter()
            .map(|item| &item.block.id)
            .collect::<BTreeSet<_>>()
            .len()
    {
        return Err(invalid("NFM patch produced duplicate Block identities"));
    }
    Ok(desired)
}

fn build_tree(
    desired: &[DesiredBlock],
) -> Result<Vec<MaterializedBlockNode>, DocumentOperationError> {
    let ids: BTreeSet<_> = desired.iter().map(|item| item.block.id.as_str()).collect();
    if desired.iter().any(|item| {
        item.parent
            .as_deref()
            .is_some_and(|parent| !ids.contains(parent))
    }) {
        return Err(invalid("NFM patch contains a missing parent"));
    }
    let mut children = BTreeMap::<Option<&str>, Vec<&DesiredBlock>>::new();
    for item in desired {
        children
            .entry(item.parent.as_deref())
            .or_default()
            .push(item);
    }
    for siblings in children.values_mut() {
        siblings.sort_by_key(|item| item.order);
    }
    fn visit(
        parent: Option<&str>,
        children: &BTreeMap<Option<&str>, Vec<&DesiredBlock>>,
        seen: &mut BTreeSet<String>,
    ) -> Result<Vec<MaterializedBlockNode>, DocumentOperationError> {
        let mut result = Vec::new();
        for item in children.get(&parent).into_iter().flatten() {
            if !seen.insert(item.block.id.clone()) {
                return Err(invalid("NFM patch creates a Block cycle"));
            }
            let mut block = item.block.clone();
            block.children = visit(Some(&block.id), children, seen)?;
            result.push(block);
        }
        Ok(result)
    }
    let mut seen = BTreeSet::new();
    let result = visit(None, &children, &mut seen)?;
    if seen.len() != desired.len() {
        return Err(invalid("NFM patch creates a Block cycle"));
    }
    Ok(result)
}

struct WorkingTree {
    nodes: BTreeMap<String, MaterializedBlockNode>,
    parents: BTreeMap<String, Option<String>>,
    children: BTreeMap<Option<String>, Vec<String>>,
}

impl WorkingTree {
    fn from_blocks(blocks: &[MaterializedBlockNode]) -> Self {
        let flat = flatten(blocks);
        let mut tree = Self {
            nodes: BTreeMap::new(),
            parents: BTreeMap::new(),
            children: BTreeMap::new(),
        };
        for item in &flat {
            let parent = item.parent.map(|parent| flat[parent].block.id.clone());
            tree.attach(item.block.id.clone(), parent);
            tree.nodes.insert(item.block.id.clone(), item.block.clone());
        }
        tree
    }

    fn attach(&mut self, id: String, parent: Option<String>) {
        if let Some(previous) = self.parents.insert(id.clone(), parent.clone()) {
            self.children
                .entry(previous)
                .or_default()
                .retain(|child| child != &id);
        }
        self.children.entry(parent).or_default().push(id);
    }

    fn delete(&mut self, id: &str) {
        for child in self
            .children
            .remove(&Some(id.to_owned()))
            .unwrap_or_default()
        {
            self.delete(&child);
        }
        if let Some(parent) = self.parents.remove(id) {
            self.children
                .entry(parent)
                .or_default()
                .retain(|child| child != id);
        }
        self.nodes.remove(id);
    }
}

fn compile_operations(
    source: &[MaterializedBlockNode],
    target: &[MaterializedBlockNode],
) -> Result<Vec<DocumentBlockOperation>, DocumentOperationError> {
    let mut current = WorkingTree::from_blocks(source);
    let original_parents = current.parents.clone();
    let desired = WorkingTree::from_blocks(target);
    let mut operations = Vec::new();
    // Target preorder establishes a surviving parent before each child. It also
    // evacuates retained descendants before any old ancestor is deleted.
    for item in flatten(target) {
        let id = item.block.id.clone();
        let parent = desired.parents[&id].clone();
        match current.nodes.get(&id) {
            None => {
                operations.push(DocumentBlockOperation::InsertBlock {
                    block: item.block.clone(),
                    parent_block_id: parent.clone(),
                    before_block_id: None,
                });
                current.attach(id.clone(), parent.clone());
            }
            Some(before) if !own_equal(before, &item.block) => {
                operations.push(DocumentBlockOperation::UpdateBlock {
                    block_id: id.clone(),
                    patch: DocumentBlockUpdatePatch {
                        block_type: Some(item.block.block_type.clone()),
                        props: Some(item.block.props.clone()),
                        content: item.block.content.clone(),
                        unset_content: item.block.content.is_none(),
                    },
                })
            }
            Some(_) => {}
        }
        current.nodes.insert(id.clone(), item.block);
        if current.parents[&id] != parent {
            operations.push(DocumentBlockOperation::MoveBlock {
                block_id: id.clone(),
                parent_block_id: parent.clone(),
                before_block_id: None,
            });
            current.attach(id.clone(), parent);
        }
    }
    let removed_roots: Vec<_> = current
        .parents
        .iter()
        .filter(|(id, parent)| {
            !desired.nodes.contains_key(*id)
                && parent
                    .as_ref()
                    .is_none_or(|parent| desired.nodes.contains_key(parent))
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in removed_roots {
        operations.push(DocumentBlockOperation::DeleteBlock {
            block_id: id.clone(),
        });
        current.delete(&id);
    }
    for (parent, children) in &desired.children {
        // Newly inserted or reparented Blocks are placed around surviving
        // siblings, never used as anchors that force untouched Yrs nodes to move.
        let existing: Vec<_> = current
            .children
            .get(parent)
            .into_iter()
            .flatten()
            .filter(|id| original_parents.get(*id) == Some(parent))
            .cloned()
            .collect();
        let retained_order = longest_retained_order(&existing, children);
        let mut before = None;
        for id in children.iter().rev() {
            if !retained_order.contains(id) {
                operations.push(DocumentBlockOperation::MoveBlock {
                    block_id: id.clone(),
                    parent_block_id: parent.clone(),
                    before_block_id: before.clone(),
                });
            }
            before = Some(id.clone());
        }
    }
    Ok(operations)
}

/// Retain a longest common sibling subsequence in O(n log n), so inserting or
/// reordering a small region never moves all the unaffected sibling subtrees.
fn longest_retained_order(current: &[String], desired: &[String]) -> BTreeSet<String> {
    let positions: BTreeMap<_, _> = current
        .iter()
        .enumerate()
        .map(|(index, id)| (id, index))
        .collect();
    let sequence: Vec<_> = desired
        .iter()
        .filter_map(|id| positions.get(id).map(|position| (id, *position)))
        .collect();
    let mut tails = Vec::<usize>::new();
    let mut previous = vec![None; sequence.len()];
    for (index, (_, position)) in sequence.iter().enumerate() {
        let slot = tails.partition_point(|tail| sequence[*tail].1 < *position);
        previous[index] = slot.checked_sub(1).map(|slot| tails[slot]);
        if slot == tails.len() {
            tails.push(index);
        } else {
            tails[slot] = index;
        }
    }
    let mut result = BTreeSet::new();
    let mut cursor = tails.last().copied();
    while let Some(index) = cursor {
        result.insert(sequence[index].0.clone());
        cursor = previous[index];
    }
    result
}
