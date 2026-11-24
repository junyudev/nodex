// Ranking follows Codex's Apache-2.0 file-search snapshot logic. Nucleo's
// path-score/length/insertion order selects candidates. The app-server then orders the
// selected results by their final score and path.
use std::{cell::RefCell, cmp::Reverse, collections::BinaryHeap, rc::Rc};

use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{Atom, AtomKind, CaseMatching, Normalization, Pattern},
};
use serde::Serialize;

use super::index::{Index, IndexedEntry, MatchType, Snapshot};

const MATCH_LIMIT: usize = 50;
const NAME_BONUS: u32 = u16::MAX as u32 + 1;

#[derive(Debug, Eq, PartialEq, Serialize)]
pub(super) struct Result {
    pub(super) root_slot: u32,
    pub(super) path: String,
    pub(super) match_type: MatchType,
    pub(super) file_name: String,
    pub(super) score: u32,
    pub(super) indices: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Candidate {
    score: Reverse<u32>,
    path_score: Reverse<u32>,
    path_len: usize,
    root: u32,
    slot: u32,
}

impl Candidate {
    fn with_score(self, score: u32) -> Self {
        Self {
            score: Reverse(score),
            ..self
        }
    }
}

#[derive(Default)]
struct CandidatePrefix {
    end: u32,
    matches: Vec<u32>,
}

impl CandidatePrefix {
    fn record_match(&mut self, slot: u32) {
        let word = (slot / u32::BITS) as usize;
        self.matches.resize(self.matches.len().max(word + 1), 0);
        self.matches[word] |= 1 << (slot % u32::BITS);
    }

    /// Slots beyond the prefix have not been tested, so they remain candidates.
    fn next(&self, mut slot: u32, end: u32) -> u32 {
        let prefix_end = end.min(self.end);
        if slot >= prefix_end {
            return slot;
        }
        while slot < prefix_end {
            let word = (slot / u32::BITS) as usize;
            let Some(bits) = self.matches.get(word) else {
                return prefix_end;
            };
            let remaining = bits & (u32::MAX << (slot % u32::BITS));
            if remaining != 0 {
                return (word as u32 * u32::BITS + remaining.trailing_zeros()).min(prefix_end);
            }
            slot = (word as u32 + 1) * u32::BITS;
        }
        prefix_end
    }
}

struct PriorRoot {
    identity: Rc<()>,
    revision: u64,
    candidates: CandidatePrefix,
}

struct RootScan {
    snapshot: Snapshot,
    old: CandidatePrefix,
    current: CandidatePrefix,
}

#[derive(Default, PartialEq, Eq)]
enum Status {
    #[default]
    Unchanged,
    Update,
    Rescore,
}

type Candidates = Vec<Option<PriorRoot>>;

#[derive(Default)]
pub(super) struct Search {
    query: String,
    pattern: Pattern,
    status: Status,
    previous: Rc<RefCell<Candidates>>,
}

impl Search {
    pub(super) fn reparse(&mut self, query: String) {
        // Nucleo's MultiPattern::reparse carries a pending rescore across updates until
        // the next matcher tick. Negative final atoms can admit prior nonmatches.
        self.status = if query.starts_with(&self.query)
            && self.status != Status::Rescore
            && self.pattern.atoms.last().is_none_or(|atom| !atom.negative)
        {
            Status::Update
        } else {
            Status::Rescore
        };
        self.pattern
            .reparse(&query, CaseMatching::Ignore, Normalization::Smart);
        self.query = query;
    }

    pub(super) fn start(&mut self) -> Ranking {
        let status = std::mem::take(&mut self.status);
        let previous = std::mem::take(&mut self.previous);
        // As in Nucleo, an empty pattern resets the candidate set.
        let old = if status != Status::Rescore && !self.pattern.atoms.is_empty() {
            std::mem::take(&mut *previous.borrow_mut())
        } else {
            Vec::new()
        };
        let rank_names = matches!(self.pattern.atoms.as_slice(), [atom] if atom.kind == AtomKind::Fuzzy && !atom.negative)
            && !self.query.contains(['/', '\\']);

        Ranking {
            previous: Rc::clone(&self.previous),
            pattern: self.pattern.clone(),
            rank_names,
            matcher: Matcher::new(Config::DEFAULT.match_paths()),
            old,
            scans: Vec::new(),
            top: TopMatches {
                dirty: true,
                ..TopMatches::default()
            },
            #[cfg(test)]
            scored: 0,
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }
}

pub(super) struct Ranking {
    previous: Rc<RefCell<Candidates>>,
    pattern: Pattern,
    rank_names: bool,
    matcher: Matcher,
    old: Vec<Option<PriorRoot>>,
    scans: Vec<Option<RootScan>>,
    top: TopMatches,
    #[cfg(test)]
    pub(super) scored: u32,
}

impl Ranking {
    pub(super) fn add_root(&mut self, root: u32, index: &Index) {
        let snapshot = index.snapshot();
        let old = self.old.get_mut(root as usize).and_then(Option::take);
        let reusable = old.filter(|old| {
            old.revision == snapshot.revision && Rc::ptr_eq(&old.identity, &snapshot.root)
        });
        self.scans
            .resize_with(self.scans.len().max(root as usize + 1), || None);
        self.scans[root as usize] = Some(RootScan {
            snapshot,
            old: reusable.map_or_else(CandidatePrefix::default, |old| old.candidates),
            current: CandidatePrefix::default(),
        });
    }

    /// Returns true when caught up with all the entries currently available in this root.
    pub(super) fn advance(&mut self, root: u32, batch: u32) -> bool {
        let scan = self.scans[root as usize]
            .as_mut()
            .expect("attached ranking root");
        let entries = Rc::clone(&scan.snapshot.entries);
        let entries = entries.borrow();
        let end = entries.len.min(scan.current.end.saturating_add(batch));
        let mut slot = scan.current.end;
        let name = self.rank_names.then(|| &self.pattern.atoms[0]);
        while slot < end {
            slot = scan.old.next(slot, end);
            if slot == end {
                break;
            }
            let current = slot;
            slot += 1;
            let Some(entry) = entries.get(current) else {
                continue;
            };
            #[cfg(test)]
            {
                self.scored += 1;
            }
            let Some(score) = self.pattern.score(entry.column(), &mut self.matcher) else {
                continue;
            };
            scan.current.record_match(current);
            let candidate = Candidate {
                score: Reverse(score),
                path_score: Reverse(score),
                path_len: entry.column().len(),
                root,
                slot: current,
            };
            self.top.consider(entry, candidate, name, &mut self.matcher);
        }
        scan.current.end = end;
        end == entries.len
    }

    pub(super) fn dirty(&self) -> bool {
        self.top.dirty
    }

    pub(super) fn has_matches(&self) -> bool {
        !self.top.best.is_empty()
    }

    pub(super) fn results(&mut self) -> Vec<Result> {
        let mut results = Vec::new();
        for candidate in self.top.selected() {
            let scan = self.scans[candidate.root as usize]
                .as_ref()
                .expect("attached ranking root");
            let entries = scan.snapshot.entries.borrow();
            let entry = entries.get(candidate.slot).expect("ranked entry");
            let path = entry.column();
            let haystack = if self.rank_names && candidate.score.0 >= NAME_BONUS {
                basename(path)
            } else {
                path
            };
            let mut indices = Vec::new();
            let _ = self
                .pattern
                .indices(haystack, &mut self.matcher, &mut indices);
            for index in &mut indices {
                *index += (path.len() - haystack.len()) as u32;
            }
            indices.sort_unstable();
            indices.dedup();
            let file_name = entry.path().rsplit('/').next().unwrap_or_default();
            results.push(Result {
                root_slot: candidate.root,
                path: entry.path().to_owned(),
                match_type: entry.kind(),
                file_name: file_name.to_owned(),
                score: candidate.score.0,
                indices,
            });
        }
        results.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
        results
    }
}

#[derive(Default)]
struct TopMatches {
    best: BinaryHeap<Candidate>,
    exact_folder: Option<Candidate>,
    dirty: bool,
}

impl TopMatches {
    fn consider(
        &mut self,
        entry: &IndexedEntry,
        mut candidate: Candidate,
        name: Option<&Atom>,
        matcher: &mut Matcher,
    ) {
        if let Some(name) = name {
            let basename = basename(entry.column());
            let exact_length = basename.len() == name.needle_text().len();
            match entry.kind() {
                MatchType::File => {
                    if let Some(score) = name.score(basename, matcher) {
                        let bonus = if exact_length {
                            3 * NAME_BONUS
                        } else {
                            NAME_BONUS
                        };
                        candidate = candidate.with_score(bonus + u32::from(score));
                    }
                }
                // Keep the first exact folder in Nucleo's path order. Tracking it separately
                // lets a stronger folder displace it without losing the old folder's path score.
                MatchType::Directory
                    if exact_length
                        && self.exact_folder.is_none_or(|folder| candidate < folder)
                        && name.score(basename, matcher).is_some() =>
                {
                    self.exact_folder = Some(candidate);
                    self.dirty = true;
                }
                MatchType::Directory => {}
            }
        }
        if self.best.len() < MATCH_LIMIT {
            self.best.push(candidate);
            self.dirty = true;
        } else if let Some(mut worst) = self.best.peek_mut()
            && candidate < *worst
        {
            *worst = candidate;
            self.dirty = true;
        }
    }

    fn selected(&mut self) -> impl Iterator<Item = Candidate> {
        let mut selected = self.best.clone().into_sorted_vec();
        if let Some(folder) = self.exact_folder {
            selected.retain(|candidate| *candidate != folder);
            selected.push(folder.with_score(2 * NAME_BONUS + folder.score.0));
            selected.sort_unstable();
        }
        self.dirty = false;
        selected.into_iter().take(MATCH_LIMIT)
    }
}

impl Drop for Ranking {
    fn drop(&mut self) {
        *self.previous.borrow_mut() = std::mem::take(&mut self.scans)
            .into_iter()
            .map(|scan| {
                scan.map(|scan| PriorRoot {
                    identity: scan.snapshot.root,
                    revision: scan.snapshot.revision,
                    candidates: scan.current,
                })
            })
            .collect();
    }
}

fn basename(path: Utf32Str<'_>) -> Utf32Str<'_> {
    let len = path.chars().rev().take_while(|&c| c != '/').count();
    path.slice(path.len() - len..)
}
