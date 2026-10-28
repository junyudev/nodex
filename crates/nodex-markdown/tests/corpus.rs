//! Nodex's own documentation is a corpus of real Markdown: every file reads as a document,
//! and its exact text reads back as the same Blocks and writes as the same text again.

use std::path::{Path, PathBuf};

use nodex_markdown::{ReadOptions, read, write};

fn markdown_files(directory: &Path, files: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.expect("directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            markdown_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "md") {
            files.push(path);
        }
    }
}

#[test]
fn documentation_round_trips_through_its_exact_text() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for directory in ["docs", "agent-skills"] {
        markdown_files(&root.join(directory), &mut files);
    }
    assert!(files.len() > 20, "the documentation corpus is missing");
    for path in files {
        let name = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .display()
            .to_string();
        let source = std::fs::read_to_string(&path).expect("readable Markdown");
        let blocks = read(&source, ReadOptions::DOCUMENT)
            .unwrap_or_else(|error| panic!("{name} does not read: {error:?}"));
        let exact = write(&blocks);
        let reread = read(&exact, ReadOptions::EXACT)
            .unwrap_or_else(|error| panic!("{name}'s exact text does not read: {error:?}"));
        if let Some(index) = (0..blocks.len().max(reread.len()))
            .find(|&index| blocks.get(index) != reread.get(index))
        {
            panic!(
                "{name}'s exact text reads differently at Block {index}:\n{:#?}\n{:#?}",
                blocks.get(index),
                reread.get(index)
            );
        }
        assert_eq!(write(&reread), exact, "{name}'s exact text is not stable");
    }
}
