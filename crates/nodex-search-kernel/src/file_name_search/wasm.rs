use wasm_bindgen::prelude::*;

use super::{
    index::{Capacity, Index, Refresh},
    ranking::{Ranking, Search},
};

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export interface IndexedFileMatch {
    readonly root_slot: number;
    readonly path: string;
    readonly match_type: "file" | "directory";
    readonly file_name: string;
    readonly score: number;
    readonly indices: readonly number[];
}
"#;

#[wasm_bindgen]
pub struct FileNameIndex(Index);

#[wasm_bindgen]
impl FileNameIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(windows_paths: bool) -> Self {
        Self(Index::new(windows_paths))
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.0.size()
    }

    #[wasm_bindgen(getter, js_name = pathUnits)]
    pub fn path_units(&self) -> u32 {
        self.0.units
    }

    #[wasm_bindgen(js_name = addBatch)]
    pub fn add_batch(&mut self, paths: &str, entries: u32, path_units: u32) -> bool {
        self.0.add_batch(
            paths,
            Capacity {
                entries,
                path_units,
            },
        )
    }

    #[wasm_bindgen(js_name = finishBuilding)]
    pub fn finish_building(&mut self) {
        self.0.finish_building();
    }

    #[wasm_bindgen(js_name = hasDirectory)]
    pub fn has_directory(&self, path: &str) -> bool {
        self.0.has_directory(path)
    }

    #[wasm_bindgen(js_name = hasFile)]
    pub fn has_file(&self, path: &str) -> bool {
        self.0.has_file(path)
    }

    #[wasm_bindgen(js_name = indexedAncestor)]
    pub fn indexed_ancestor(&self, path: &str) -> String {
        self.0.indexed_ancestor(path).to_owned()
    }

    pub fn subdirectories(&self, path: &str) -> Vec<String> {
        self.0.subdirectories(path)
    }

    pub fn remove(&mut self, path: &str) -> bool {
        self.0.remove(path)
    }

    #[wasm_bindgen(js_name = removeTree)]
    pub fn remove_tree(&mut self, path: &str) {
        self.0.remove_tree(path);
    }
}

#[wasm_bindgen]
pub struct FileNameRefresh(Refresh);

#[wasm_bindgen]
impl FileNameRefresh {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self(Refresh::default())
    }

    pub fn collect(
        &mut self,
        index: &FileNameIndex,
        paths: &str,
        entries: u32,
        path_units: u32,
    ) -> bool {
        self.0.collect(
            &index.0,
            paths,
            Capacity {
                entries,
                path_units,
            },
        )
    }

    pub fn apply(
        &mut self,
        index: &mut FileNameIndex,
        directory: &str,
        tree: bool,
        entries: u32,
        path_units: u32,
    ) -> bool {
        self.0.apply(
            &mut index.0,
            directory,
            tree,
            Capacity {
                entries,
                path_units,
            },
        )
    }
}

#[wasm_bindgen]
pub struct FileNameSearch(Search);

#[wasm_bindgen]
impl FileNameSearch {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self(Search::default())
    }

    pub fn reparse(&mut self, query: String) {
        self.0.reparse(query);
    }

    pub fn start(&mut self) -> FileNameRanking {
        FileNameRanking(self.0.start())
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
}

#[wasm_bindgen]
pub struct FileNameRanking(Ranking);

#[wasm_bindgen]
impl FileNameRanking {
    #[wasm_bindgen(js_name = addRoot)]
    pub fn add_root(&mut self, root_slot: u32, index: &FileNameIndex) {
        self.0.add_root(root_slot, &index.0);
    }

    pub fn advance(&mut self, root_slot: u32, batch: u32) -> bool {
        self.0.advance(root_slot, batch)
    }

    #[wasm_bindgen(getter)]
    pub fn dirty(&self) -> bool {
        self.0.dirty()
    }

    #[wasm_bindgen(getter, js_name = hasMatches)]
    pub fn has_matches(&self) -> bool {
        self.0.has_matches()
    }

    #[wasm_bindgen(unchecked_return_type = "IndexedFileMatch[]")]
    pub fn results(&mut self) -> Result<JsValue, JsError> {
        Ok(serde_wasm_bindgen::to_value(&self.0.results())?)
    }
}
