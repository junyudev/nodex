use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap, HashSet},
    hash::{BuildHasher, RandomState},
    rc::Rc,
};

use hashbrown::HashTable;
use nucleo_matcher::{Utf32Str, Utf32String};
use serde::Serialize;

const CHUNK_SIZE: usize = 1024;
const ROOT: u32 = u32::MAX;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum MatchType {
    File,
    Directory,
}

// ASCII paths are already valid matcher columns. Unicode columns keep one scalar per
// grapheme, so only those entries need to store the original path separately.
#[derive(Clone)]
pub(super) enum IndexedEntry {
    Ascii { path: Box<str>, kind: MatchType },
    Unicode(Box<UnicodeEntry>),
    Vacant,
}

#[derive(Clone)]
pub(super) struct UnicodeEntry {
    path: Box<str>,
    column: Box<[char]>,
    kind: MatchType,
}

impl IndexedEntry {
    fn new(path: &str, kind: MatchType) -> Self {
        match Utf32String::from(path) {
            Utf32String::Ascii(path) => Self::Ascii { path, kind },
            Utf32String::Unicode(column) => Self::Unicode(Box::new(UnicodeEntry {
                path: path.into(),
                column,
                kind,
            })),
        }
    }

    pub(super) fn path(&self) -> &str {
        match self {
            Self::Ascii { path, .. } => path,
            Self::Unicode(entry) => &entry.path,
            Self::Vacant => unreachable!("vacant file index slot"),
        }
    }

    pub(super) fn kind(&self) -> MatchType {
        match self {
            Self::Ascii { kind, .. } => *kind,
            Self::Unicode(entry) => entry.kind,
            Self::Vacant => unreachable!("vacant file index slot"),
        }
    }

    pub(super) fn column(&self) -> Utf32Str<'_> {
        match self {
            Self::Ascii { path, .. } => Utf32Str::Ascii(path.as_bytes()),
            Self::Unicode(entry) => Utf32Str::Unicode(&entry.column),
            Self::Vacant => unreachable!("vacant file index slot"),
        }
    }

    pub(super) fn units(&self) -> u32 {
        match self {
            Self::Ascii { path, .. } => path.len() as u32,
            Self::Unicode(entry) => path_units(&entry.path),
            Self::Vacant => 0,
        }
    }
}

pub(super) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn path_units(path: &str) -> u32 {
    if path.is_ascii() {
        path.len() as u32
    } else {
        path.encode_utf16().count() as u32
    }
}

#[derive(Clone, Default)]
pub(super) struct Entries {
    chunks: Vec<Rc<Vec<IndexedEntry>>>,
    pub(super) len: u32,
}

impl Entries {
    fn set(&mut self, slot: u32, entry: IndexedEntry) {
        let slot = slot as usize;
        let chunk = slot / CHUNK_SIZE;
        let offset = slot % CHUNK_SIZE;
        if chunk == self.chunks.len() {
            self.chunks.push(Rc::new(Vec::with_capacity(CHUNK_SIZE)));
        }
        let entries = Rc::make_mut(&mut self.chunks[chunk]);
        if offset == entries.len() {
            entries.push(entry);
            self.len += 1;
        } else {
            entries[offset] = entry;
        }
    }

    fn at(&self, slot: u32) -> &IndexedEntry {
        &self.chunks[slot as usize / CHUNK_SIZE][slot as usize % CHUNK_SIZE]
    }

    pub(super) fn get(&self, slot: u32) -> Option<&IndexedEntry> {
        let entry = self.at(slot);
        (!matches!(entry, IndexedEntry::Vacant)).then_some(entry)
    }
}

#[derive(Clone)]
pub(super) struct Snapshot {
    pub(super) entries: Rc<RefCell<Entries>>,
    pub(super) root: Rc<()>,
    pub(super) revision: u64,
}

#[derive(Clone, Copy)]
pub(super) struct Capacity {
    pub(super) entries: u32,
    pub(super) path_units: u32,
}

#[derive(PartialEq, Eq)]
enum Add {
    Added,
    Present,
    Full,
}

pub(super) struct Index {
    snapshot: Snapshot,
    // The lookup table stores only slots; path bytes live in the matching column.
    paths: HashTable<u32>,
    hasher: RandomState,
    children: HashMap<u32, HashSet<u32>>,
    vacant: Vec<u32>,
    building: bool,
    pub(super) units: u32,
    windows_paths: bool,
}

impl Index {
    pub(super) fn new(windows_paths: bool) -> Self {
        Self {
            snapshot: Snapshot {
                entries: Rc::default(),
                root: Rc::new(()),
                revision: 0,
            },
            paths: HashTable::new(),
            hasher: RandomState::new(),
            children: HashMap::new(),
            vacant: Vec::new(),
            building: true,
            units: 0,
            windows_paths,
        }
    }

    pub(super) fn snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }

    pub(super) fn size(&self) -> u32 {
        self.paths.len() as u32
    }

    pub(super) fn finish_building(&mut self) {
        self.building = false;
    }

    fn batch<'a>(
        &self,
        records: &'a str,
    ) -> impl Iterator<Item = std::borrow::Cow<'a, str>> + use<'a> {
        let windows_paths = self.windows_paths;
        records
            .split('\0')
            .filter(|path| !path.is_empty() && !path.contains('\u{fffd}'))
            .map(move |path| {
                if windows_paths && path.contains('\\') {
                    path.replace('\\', "/").into()
                } else {
                    path.into()
                }
            })
    }

    pub(super) fn add_batch(&mut self, records: &str, capacity: Capacity) -> bool {
        for path in self.batch(records) {
            if self.add(&path, capacity) == Add::Full {
                return false;
            }
        }
        true
    }

    fn find(&self, path: &str) -> Option<u32> {
        let entries = self.snapshot.entries.borrow();
        self.paths
            .find(self.hasher.hash_one(path), |&slot| {
                entries.at(slot).path() == path
            })
            .copied()
    }

    fn directory(&self, path: &str) -> Option<u32> {
        if path.is_empty() {
            return Some(ROOT);
        }
        self.find(path)
            .filter(|slot| self.children.contains_key(slot))
    }

    pub(super) fn has_directory(&self, path: &str) -> bool {
        self.directory(path).is_some()
    }

    pub(super) fn has_file(&self, path: &str) -> bool {
        self.find(path)
            .is_some_and(|slot| !self.children.contains_key(&slot))
    }

    pub(super) fn indexed_ancestor<'a>(&self, path: &'a str) -> &'a str {
        let directory = parent(path);
        if self.has_directory(directory) {
            return directory;
        }
        self.indexed_ancestor(directory)
    }

    pub(super) fn subdirectories(&self, directory: &str) -> Vec<String> {
        let Some(slot) = self.directory(directory) else {
            return Vec::new();
        };
        let entries = self.snapshot.entries.borrow();
        self.children
            .get(&slot)
            .into_iter()
            .flatten()
            .filter(|child| self.children.contains_key(child))
            .map(|&child| entries.at(child).path().to_owned())
            .collect()
    }

    fn add(&mut self, path: &str, capacity: Capacity) -> Add {
        if self.find(path).is_some() {
            return Add::Present;
        }

        let mut missing = Vec::new();
        let mut total_units = path_units(path);
        let mut directory = parent(path);
        let mut parent = loop {
            if directory.is_empty() {
                break ROOT;
            }
            if let Some(slot) = self.find(directory) {
                // A concurrent filesystem edit can replace a file with a directory.
                // The watch refresh will remove the old name and list the new tree.
                if !self.children.contains_key(&slot) {
                    return Add::Present;
                }
                break slot;
            }
            missing.push(directory);
            total_units += path_units(directory);
            directory = self::parent(directory);
        };
        if self.size() + 1 + missing.len() as u32 > capacity.entries
            || self.units + total_units > capacity.path_units
        {
            return Add::Full;
        }

        for directory in missing.into_iter().rev() {
            parent = self.insert(directory, MatchType::Directory, parent);
        }
        self.insert(path, MatchType::File, parent);
        self.units += total_units;
        Add::Added
    }

    fn set_entry(&mut self, slot: u32, entry: IndexedEntry) {
        if !self.building {
            // A ranker holds only the old snapshot and edited chunks are copied on demand.
            Rc::make_mut(&mut self.snapshot.entries);
            self.snapshot.revision += 1;
        }
        self.snapshot.entries.borrow_mut().set(slot, entry);
    }

    fn insert(&mut self, path: &str, kind: MatchType, parent: u32) -> u32 {
        let slot = self
            .vacant
            .pop()
            .unwrap_or_else(|| self.snapshot.entries.borrow().len);
        self.set_entry(slot, IndexedEntry::new(path, kind));
        let entries = self.snapshot.entries.borrow();
        self.paths
            .insert_unique(self.hasher.hash_one(path), slot, |&key| {
                self.hasher.hash_one(entries.at(key).path())
            });
        self.children.entry(parent).or_default().insert(slot);
        if kind == MatchType::Directory {
            self.children.insert(slot, HashSet::new());
        }
        slot
    }

    fn delete(&mut self, slot: u32) -> u32 {
        let parent = {
            let entries = self.snapshot.entries.borrow();
            let entry = entries.at(slot);
            let parent = self.directory(self::parent(entry.path())).unwrap_or(ROOT);
            if let Ok(found) = self
                .paths
                .find_entry(self.hasher.hash_one(entry.path()), |&key| key == slot)
            {
                found.remove();
            }
            self.units -= entry.units();
            parent
        };
        self.set_entry(slot, IndexedEntry::Vacant);
        self.vacant.push(slot);
        self.children.remove(&slot);
        if let Some(children) = self.children.get_mut(&parent) {
            children.remove(&slot);
        }
        parent
    }

    fn remove_file(&mut self, slot: u32) {
        let mut directory = self.delete(slot);
        while directory != ROOT && self.children.get(&directory).is_some_and(HashSet::is_empty) {
            directory = self.delete(directory);
        }
    }

    pub(super) fn remove(&mut self, path: &str) -> bool {
        let Some(slot) = self
            .find(path)
            .filter(|slot| !self.children.contains_key(slot))
        else {
            return false;
        };
        self.remove_file(slot);
        true
    }

    fn files(&self, directory: &str, tree: bool) -> Vec<u32> {
        let Some(slot) = self.directory(directory) else {
            return Vec::new();
        };
        let mut pending = vec![slot];
        let mut files = Vec::new();
        while let Some(directory) = pending.pop() {
            for &child in self.children.get(&directory).into_iter().flatten() {
                if self.children.contains_key(&child) {
                    if tree {
                        pending.push(child);
                    }
                } else {
                    files.push(child);
                }
            }
        }
        files
    }

    pub(super) fn remove_tree(&mut self, directory: &str) {
        if directory.is_empty() && self.size() > 0 {
            self.snapshot.entries = Rc::default();
            self.snapshot.revision += 1;
            self.paths = HashTable::new();
            self.children = HashMap::new();
            self.vacant = Vec::new();
            self.units = 0;
            return;
        }
        for slot in self.files(directory, true) {
            self.remove_file(slot);
        }
    }
}

#[derive(Default)]
pub(super) struct Refresh {
    seen: Vec<bool>,
    additions: BTreeSet<Box<str>>,
    listed: u32,
    new_path_units: u32,
}

impl Refresh {
    // A routine relist only needs a mark per existing name. Retain strings for new names
    // so listing failures can leave the original index intact.
    pub(super) fn collect(&mut self, index: &Index, records: &str, capacity: Capacity) -> bool {
        self.seen
            .resize(index.snapshot.entries.borrow().len as usize, false);
        for path in index.batch(records) {
            if let Some(slot) = index
                .find(&path)
                .filter(|slot| !index.children.contains_key(slot))
            {
                if std::mem::replace(&mut self.seen[slot as usize], true) {
                    continue;
                }
            } else {
                if self.additions.contains(path.as_ref()) {
                    continue;
                }
                self.new_path_units += path_units(&path);
                if self.new_path_units > capacity.path_units {
                    return false;
                }
                self.additions.insert(path.into_owned().into_boxed_str());
            }
            self.listed += 1;
            if self.listed > capacity.entries {
                return false;
            }
        }
        true
    }

    pub(super) fn apply(
        &mut self,
        index: &mut Index,
        directory: &str,
        tree: bool,
        capacity: Capacity,
    ) -> bool {
        for slot in index.files(directory, tree) {
            if !self.seen.get(slot as usize).copied().unwrap_or(false) {
                index.remove_file(slot);
            }
        }
        let mut full = false;
        for path in std::mem::take(&mut self.additions) {
            full |= index.add(&path, capacity) == Add::Full;
        }
        full
    }
}
