use super::{
    index::{Capacity, Index, MatchType, Refresh},
    ranking::{Ranking, Result, Search},
};

const ROOM: Capacity = Capacity {
    entries: 1000,
    path_units: 100_000,
};

fn index(paths: &str) -> Index {
    let mut index = Index::new(false);
    assert!(index.add_batch(paths, ROOM));
    index.finish_building();
    index
}

fn attach(search: &mut Search, index: &Index, query: &str) -> Ranking {
    search.reparse(query.to_owned());
    let mut ranking = search.start();
    ranking.add_root(0, index);
    ranking
}

fn find(index: &Index, query: &str) -> Vec<Result> {
    let mut ranking = attach(&mut Search::default(), index, query);
    assert!(ranking.advance(0, u32::MAX));
    ranking.results()
}

#[test]
fn exact_names_and_one_exact_folder_survive_the_path_result_limit() {
    let mut index = index("viewmodel/build.gradle.kts\0feature/src/ChatViewModel.kt");
    for i in 0..80 {
        assert!(index.add_batch(&format!("parent-{i}/viewmodel/contents"), ROOM));
    }
    let results = find(&index, "ViewModel");
    assert_eq!(results.len(), 50);
    assert_eq!(results[0].match_type, MatchType::Directory);
    assert_eq!(results[0].path, "viewmodel");
    assert_eq!(results[1].path, "feature/src/ChatViewModel.kt");
    assert_eq!(results[1].indices, (16..25).collect::<Vec<_>>());
    assert!(results[2..].iter().all(|entry| entry.score < 65_536));
    assert_eq!(find(&index, "VM")[0].path, "feature/src/ChatViewModel.kt");

    assert!(index.add_batch("src/source.rs\0feature/src/src", ROOM));
    let results = find(&index, "src");
    assert_eq!(results[0].path, "feature/src/src");
    assert_eq!(results[1].path, "src");
    let paths = find(&index, "viewmodel/");
    assert!(
        paths
            .iter()
            .any(|entry| entry.path == "viewmodel/build.gradle.kts")
    );
    assert!(paths.iter().all(|entry| entry.score < 65_536));
}

#[test]
fn matching_atoms_share_sorted_unique_grapheme_indices() {
    let index = index("🧑‍💻/Cafe\u{301}.md\0src/file-index-module.ts\0src/file-index-module.test.ts");
    let cafe = &find(&index, "cafe afe")[0];
    assert_eq!(cafe.file_name, "Cafe\u{301}.md");
    assert_eq!(cafe.indices, [2, 3, 4, 5]);
    assert_eq!(
        find(&index, "^src 'module !test")[0].path,
        "src/file-index-module.ts"
    );
    assert!(
        find(&index, "fileindxmod")
            .iter()
            .any(|entry| entry.path == "src/file-index-module.ts")
    );
    assert!(find(&index, "unrelated").is_empty());
}

#[test]
fn results_keep_separate_root_slots_and_sort_score_ties_by_path() {
    let left = index("b/target.txt\0a/target.txt");
    let right = index("a/target.txt");
    let mut search = Search::default();
    let mut ranking = attach(&mut search, &left, "target");
    ranking.add_root(1, &right);
    assert!(ranking.advance(0, u32::MAX));
    assert!(ranking.advance(1, u32::MAX));
    let results = ranking.results();
    let paths: Vec<_> = results
        .iter()
        .map(|result| (result.path.as_str(), result.root_slot))
        .collect();
    assert_eq!(
        paths,
        [
            ("a/target.txt", 0),
            ("a/target.txt", 1),
            ("b/target.txt", 0)
        ]
    );
    assert!(
        results
            .iter()
            .all(|result| result.score == results[0].score)
    );
}

#[test]
fn a_ranker_can_follow_appends_and_keep_its_snapshot_across_edits() {
    let mut index = Index::new(false);
    assert!(index.add_batch("old/a.ts", ROOM));
    let mut search = Search::default();
    let mut ranking = attach(&mut search, &index, "a");
    assert!(ranking.dirty());
    assert!(!ranking.has_matches());
    assert!(ranking.advance(0, u32::MAX));
    assert!(index.add_batch("new/alpha.ts", ROOM));
    assert!(ranking.advance(0, u32::MAX));
    assert_eq!(ranking.results().len(), 2);

    index.finish_building();
    assert!(index.remove("old/a.ts"));
    assert!(index.add_batch("new/ab.ts", ROOM));
    assert!(ranking.advance(0, u32::MAX));
    assert!(
        ranking
            .results()
            .iter()
            .any(|entry| entry.path == "old/a.ts")
    );
    assert!(!ranking.dirty());
    drop(ranking);

    let mut changed = attach(&mut search, &index, "ab");
    assert!(changed.advance(0, u32::MAX));
    assert_eq!(changed.results()[0].path, "new/ab.ts");
}

#[test]
fn appended_queries_rescore_prior_matches_and_unscanned_names() {
    let mut index = Index::new(false);
    assert!(index.add_batch("alpha\0beta\0gamma\0alphabet", ROOM));
    let mut search = Search::default();
    let mut first = attach(&mut search, &index, "al");
    assert!(!first.advance(0, 3));
    drop(first);
    let mut next = attach(&mut search, &index, "alp");
    assert!(next.advance(0, u32::MAX));
    assert_eq!(next.scored, 2);
    assert_eq!(next.results().len(), 2);
    drop(next);

    let mut negative = attach(&mut search, &index, "!a");
    assert!(negative.advance(0, u32::MAX));
    assert!(negative.results().is_empty());
    drop(negative);
    let mut rescored = attach(&mut search, &index, "!al");
    assert!(rescored.advance(0, u32::MAX));
    assert_eq!(rescored.scored, 4);
    assert_eq!(rescored.results().len(), 2);
    drop(rescored);

    search.clear();
    let mut cleared = attach(&mut search, &index, "!alp");
    assert!(cleared.advance(0, u32::MAX));
    assert_eq!(cleared.scored, 4);
}

#[test]
fn updates_before_the_next_scan_keep_a_pending_rescore() {
    let index = index("alpha\0beta\0gamma");
    let mut search = Search::default();
    let mut initial = attach(&mut search, &index, "al");
    assert!(initial.advance(0, u32::MAX));
    drop(initial);

    search.reparse("be".to_owned());
    search.reparse("bet".to_owned());
    let mut rank = search.start();
    rank.add_root(0, &index);
    assert!(rank.advance(0, u32::MAX));
    assert_eq!(rank.scored, index.size());
    assert_eq!(rank.results()[0].path, "beta");
}

#[test]
fn reconciliation_only_replaces_the_requested_depth_and_prunes_empty_folders() {
    let mut index = index("foo/root.ts\0foo/bar/keep.ts\0foo/gone/one.ts\0other/untouched.ts");
    let mut refresh = Refresh::default();
    assert!(refresh.collect(&index, "foo/new/added.ts\0foo/new/added.ts", ROOM));
    assert!(!refresh.apply(&mut index, "foo", false, ROOM));
    assert!(!index.has_file("foo/root.ts"));
    assert!(index.has_file("foo/bar/keep.ts"));
    assert!(index.has_file("foo/new/added.ts"));
    assert_eq!(index.indexed_ancestor("foo/new/missing/child"), "foo/new");
    assert_eq!(index.subdirectories("foo").len(), 3);

    index.remove_tree("foo/gone");
    assert!(!index.has_directory("foo/gone"));
    let mut refresh = Refresh::default();
    assert!(refresh.collect(&index, "foo/bar/keep.ts", ROOM));
    assert!(!refresh.apply(&mut index, "foo", true, ROOM));
    assert!(!index.has_directory("foo/new"));
    assert!(index.has_file("foo/bar/keep.ts"));
    assert!(index.has_file("other/untouched.ts"));
    assert_eq!(index.size(), 5);
    assert_eq!(index.units, 48);
}

#[test]
fn capacity_counts_inferred_folders_and_utf16_path_units() {
    let mut index = Index::new(true);
    assert!(!index.add_batch(
        "😀\\a\0😀\\b",
        Capacity {
            entries: 2,
            path_units: 99
        }
    ));
    assert_eq!(index.size(), 2);
    assert_eq!(index.units, 6);
    assert!(index.has_file("😀/a"));
    assert!(index.add_batch(
        "😀\\a\0invalid\u{fffd}",
        Capacity {
            entries: 2,
            path_units: 6
        }
    ));
    assert!(!index.add_batch(
        "c",
        Capacity {
            entries: 3,
            path_units: 6
        }
    ));
    index.finish_building();
    index.remove_tree("😀");
    assert_eq!(index.size(), 0);
    assert_eq!(index.units, 0);
}
