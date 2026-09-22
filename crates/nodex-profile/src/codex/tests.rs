use super::*;
use serde_json::json;
use std::io::Write;
use std::os::unix::fs::symlink;

const ROOT: &str = "11111111-1111-7111-8111-111111111111";
const CHILD: &str = "22222222-2222-7222-8222-222222222222";
const REVERT: &str = "33333333-3333-7333-8333-333333333333";

fn thread(id: &str) -> ProfileCloneThread {
    ProfileCloneThread {
        thread_id: id.into(),
        backend_kind: "codex".into(),
        execution_host_id: "local".into(),
    }
}

fn write_rollout(
    home: &Path,
    thread: &str,
    rollout: &str,
    base: Value,
    archived: bool,
    compressed: bool,
) -> (PathBuf, u64) {
    let directory = if archived {
        "archived_sessions"
    } else {
        "sessions/2026/09/22"
    };
    let relative = PathBuf::from(format!(
        "{directory}/rollout-2026-09-22T00-00-00-{thread}_{rollout}.jsonl{}",
        if compressed { ".zst" } else { "" }
    ));
    let bytes = format!(
        "{}\n",
        json!({"timestamp":"2026-09-22T00:00:00Z", "ordinal":0,
        "type":"session_meta", "payload":{"id":thread,"history_base":base}})
    )
    .into_bytes();
    let mut file = files::create_file(&home.join(&relative)).unwrap();
    if compressed {
        file.write_all(&zstd::stream::encode_all(bytes.as_slice(), 0).unwrap())
            .unwrap();
    } else {
        file.write_all(&bytes).unwrap();
    }
    (relative, bytes.len() as u64)
}

fn state(home: &Path, selections: &[(&str, &Path)]) {
    files::private_directory(home).unwrap();
    let db = Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT); CREATE TABLE agent_jobs(id TEXT PRIMARY KEY); INSERT INTO agent_jobs VALUES('pending');").unwrap();
    for (id, relative) in selections {
        db.execute(
            "INSERT INTO threads VALUES(?1,?2,'Retained title')",
            (id, home.join(relative).to_string_lossy().as_ref()),
        )
        .unwrap();
    }
}

#[test]
fn accepts_absent_and_known_history_modes_but_rejects_malformed_present_values() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let agent = source.join("agent");
    let (relative, _) = write_rollout(&agent, ROOT, ROOT, Value::Null, false, false);
    let original: Value =
        serde_json::from_slice(&fs::read(agent.join(&relative)).unwrap()).unwrap();
    assert!(!read_rollout(&agent, &relative).unwrap().paginated);
    for (mode, paginated) in [("legacy", false), ("paginated", true)] {
        let mut meta = original.clone();
        meta["payload"]["history_mode"] = json!(mode);
        fs::write(agent.join(&relative), format!("{meta}\n")).unwrap();
        assert_eq!(
            read_rollout(&agent, &relative).unwrap().paginated,
            paginated
        );
    }
    for (index, mode) in [
        Value::Null,
        json!(17),
        json!(true),
        json!({}),
        json!([]),
        json!("future"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut meta = original.clone();
        meta["payload"]["history_mode"] = mode;
        fs::write(agent.join(&relative), format!("{meta}\n")).unwrap();
        let target = root.path().join(format!("invalid-{index}"));
        let error = capture(&source, &target, &target, &[thread(ROOT)]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Unsupported native rollout history mode")
        );
    }
}

#[test]
fn bounds_projection_rows_and_bytes_including_oversized_thread_cells() {
    let root = tempfile::tempdir().unwrap();
    let connection = Connection::open(root.path().join("thread_history_1.sqlite")).unwrap();
    connection.execute_batch(
        "CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
         INSERT INTO thread_history_projection_state VALUES('a', 10, 1), ('é', 20, 2)",
    ).unwrap();
    let bytes = 3 + 4 * size_of::<u64>();
    let result = read_projections(root.path(), MetadataBudget { rows: 2, bytes }).unwrap();
    assert_eq!(
        result,
        BTreeMap::from([("a".into(), (10, 1)), ("é".into(), (20, 2))])
    );
    for budget in [
        MetadataBudget { rows: 1, bytes },
        MetadataBudget {
            rows: 2,
            bytes: bytes - 1,
        },
    ] {
        assert!(
            read_projections(root.path(), budget)
                .unwrap_err()
                .to_string()
                .contains("metadata row or byte budget")
        );
    }
    connection
        .execute("DELETE FROM thread_history_projection_state", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO thread_history_projection_state VALUES(?1, 0, 0)",
            ["é".repeat(8)],
        )
        .unwrap();
    assert!(
        read_projections(root.path(), MetadataBudget { rows: 1, bytes: 8 })
            .unwrap_err()
            .to_string()
            .contains("metadata row or byte budget")
    );
}

#[test]
fn bounds_rollout_metadata_before_retaining_the_index() {
    let root = tempfile::tempdir().unwrap();
    let (relative, _) = write_rollout(root.path(), ROOT, ROOT, Value::Null, false, false);
    let paths = [relative];
    let bytes = 2 * ROOT.len() + paths[0].as_os_str().len();
    assert_eq!(
        read_rollouts(root.path(), paths.iter(), MetadataBudget { rows: 1, bytes })
            .unwrap()
            .len(),
        1
    );
    for budget in [
        MetadataBudget { rows: 0, bytes },
        MetadataBudget {
            rows: 1,
            bytes: bytes - 1,
        },
    ] {
        assert!(
            read_rollouts(root.path(), paths.iter(), budget)
                .unwrap_err()
                .to_string()
                .contains("metadata row or byte budget")
        );
    }
}

#[test]
fn bounds_selected_paths_and_rolls_back_relocation_when_a_later_row_exceeds_budget() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    let selections = [
        (
            ROOT,
            PathBuf::from(format!("sessions/rollout-{ROOT}.jsonl")),
        ),
        (
            CHILD,
            PathBuf::from(format!("archived_sessions/rollout-{CHILD}.jsonl")),
        ),
    ];
    state(
        &source,
        &[(ROOT, &selections[0].1), (CHILD, &selections[1].1)],
    );
    let original = selections
        .iter()
        .map(|(id, path)| {
            (
                id.to_string(),
                source.join(path).to_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    let bytes = original
        .iter()
        .map(|(id, path)| id.len() + path.len())
        .sum::<usize>();
    let connection = Connection::open(source.join("state_5.sqlite")).unwrap();
    for budget in [
        MetadataBudget { rows: 1, bytes },
        MetadataBudget {
            rows: 2,
            bytes: bytes - 1,
        },
    ] {
        assert!(
            relocate_state(&source, &source, &target, &BTreeMap::new(), budget)
                .unwrap_err()
                .to_string()
                .contains("metadata row or byte budget")
        );
        for (id, path) in &original {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT rollout_path FROM threads WHERE id = ?1",
                        [id],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                *path
            );
        }
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM agent_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    let selected = relocate_state(
        &source,
        &source,
        &target,
        &BTreeMap::new(),
        MetadataBudget { rows: 2, bytes },
    )
    .unwrap();
    assert_eq!(
        selected,
        BTreeMap::from([(ROOT.into(), ROOT.into()), (CHILD.into(), CHILD.into())])
    );
    for (id, path) in selections {
        assert_eq!(
            connection
                .query_row(
                    "SELECT rollout_path FROM threads WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            target.join(path).to_str().unwrap()
        );
    }
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM agent_jobs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn rejects_oversized_native_selection_cells_before_relocation() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)")
        .unwrap();
    for column in 0..2 {
        connection.execute("DELETE FROM threads", []).unwrap();
        let mut values = ["a".to_owned(), "b".to_owned()];
        values[column] = "é".repeat(8);
        connection
            .execute(
                "INSERT INTO threads VALUES(?1, ?2)",
                rusqlite::params_from_iter(&values),
            )
            .unwrap();
        assert!(
            next_selection(&connection, None, &mut MetadataBudget { rows: 1, bytes: 8 })
                .unwrap_err()
                .to_string()
                .contains("metadata row or byte budget")
        );
        assert_eq!(
            next_selection(
                &connection,
                None,
                &mut MetadataBudget { rows: 1, bytes: 17 }
            )
            .unwrap(),
            Some((values[0].clone(), values[1].clone()))
        );
    }
}

#[test]
fn resolves_plain_compression_siblings_but_rejects_unrelated_duplicate_identities() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    let agent = source.join("agent");
    let (plain, _) = write_rollout(&agent, ROOT, ROOT, Value::Null, false, false);
    let (compressed, _) = write_rollout(
        &agent,
        ROOT,
        ROOT,
        json!({"thread_id":CHILD,"end_byte_offset":0,"end_ordinal_exclusive":0}),
        false,
        true,
    );
    // The stale compressed sibling is missing an ancestor, while plain history is readable.
    state(&agent, &[(ROOT, &compressed)]);
    let result = capture(&source, &target, &target, &[thread(ROOT)]).unwrap();
    assert_eq!(result.captured_thread_count, 1);
    assert_eq!(result.rollout_count, 1);
    for relative in [plain, compressed] {
        assert_eq!(
            fs::read(target.join("agent").join(&relative)).unwrap(),
            fs::read(agent.join(&relative)).unwrap()
        );
    }

    write_rollout(&agent, ROOT, ROOT, Value::Null, true, false);
    let duplicate = root.path().join("duplicate");
    let error = capture(&source, &duplicate, &duplicate, &[thread(ROOT)]).unwrap_err();
    assert!(error.to_string().contains("ambiguous duplicate rollout"));
}

#[test]
fn keeps_selected_revert_archives_inherited_bytes_and_metadata_in_an_independent_home() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    let agent = source.join("agent");
    let (parent, parent_bytes) = write_rollout(&agent, ROOT, ROOT, Value::Null, true, true);
    let (child, _) = write_rollout(
        &agent,
        CHILD,
        CHILD,
        json!({"thread_id":ROOT,"end_byte_offset":parent_bytes,"end_ordinal_exclusive":1}),
        false,
        false,
    );
    let (reverted, _) = write_rollout(
        &agent,
        CHILD,
        REVERT,
        json!({"thread_id":ROOT,"end_byte_offset":parent_bytes,"end_ordinal_exclusive":1}),
        false,
        false,
    );
    state(&agent, &[(ROOT, &parent), (CHILD, &reverted)]);
    for name in [
        "auth.json",
        "config.toml",
        "queue_1.sqlite",
        "logs_2.sqlite",
    ] {
        fs::write(
            agent.join(name),
            if name == "config.toml" {
                ""
            } else {
                "private-or-rebuildable"
            },
        )
        .unwrap();
    }
    let before = fs::read(agent.join(&child)).unwrap();
    let result = capture(&source, &target, &target, &[thread(ROOT), thread(CHILD)]).unwrap();
    assert_eq!(result.captured_thread_count, 2);
    assert!(result.missing_thread_ids.is_empty());
    assert_eq!(result.rollout_count, 3);
    fs::rename(&source, root.path().join("source-unavailable")).unwrap();
    let db = Connection::open(target.join("agent/state_5.sqlite")).unwrap();
    let (selected, title): (String, String) = db
        .query_row(
            "SELECT rollout_path,title FROM threads WHERE id=?1",
            [CHILD],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        PathBuf::from(selected),
        target.join("agent").join(&reverted)
    );
    assert_eq!(title, "Retained title");
    assert_eq!(fs::read(target.join("agent").join(child)).unwrap(), before);
    assert_eq!(
        db.query_row("SELECT count(*) FROM agent_jobs", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for name in [
        "auth.json",
        "config.toml",
        "queue_1.sqlite",
        "logs_2.sqlite",
        "thread-writer-locks",
    ] {
        assert!(!target.join("agent").join(name).exists());
    }
}

#[test]
fn rejects_unfinished_rollouts_even_without_required_threads() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    let agent = source.join("agent");
    let (relative, _) = write_rollout(&agent, ROOT, ROOT, Value::Null, false, false);
    let path = agent.join(relative);
    let mut bytes = fs::read(&path).unwrap();
    bytes.pop();
    fs::write(&path, bytes).unwrap();
    let error = capture(&source, &target, &target, &[]).unwrap_err();
    assert!(error.to_string().contains("unfinished record"));
}

#[test]
fn distinguishes_missing_native_history_from_remote_and_other_backend_threads() {
    let root = tempfile::tempdir().unwrap();
    let threads = [
        thread(ROOT),
        ProfileCloneThread {
            execution_host_id: "remote".into(),
            ..thread(CHILD)
        },
        ProfileCloneThread {
            backend_kind: "acp".into(),
            ..thread(REVERT)
        },
    ];
    let result = capture(
        &root.path().join("source"),
        &root.path().join("target"),
        &root.path().join("target"),
        &threads,
    )
    .unwrap();
    assert_eq!(result.missing_thread_ids, [ROOT]);
    assert_eq!(result.external_thread_count, 2);
    assert_eq!(result.required_thread_count, 1);
}

#[test]
fn paginated_history_requires_its_matching_native_projection() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let agent = source.join("agent");
    let (relative, _) = write_rollout(&agent, ROOT, ROOT, Value::Null, false, false);
    let mut meta: Value =
        serde_json::from_slice(&fs::read(agent.join(&relative)).unwrap()).unwrap();
    meta["payload"]["history_mode"] = json!("paginated");
    let bytes = format!("{meta}\n");
    fs::write(agent.join(&relative), &bytes).unwrap();
    let clone = |name: &str| {
        capture(
            &source,
            &root.path().join(name),
            &root.path().join(name),
            &[thread(ROOT)],
        )
        .unwrap()
    };
    assert_eq!(clone("missing-index").missing_thread_ids, [ROOT]);
    let index = Connection::open(agent.join("thread_history_1.sqlite")).unwrap();
    index.execute_batch("CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER)").unwrap();
    index
        .execute(
            "INSERT INTO thread_history_projection_state VALUES(?1,?2,1)",
            (ROOT, bytes.len() as i64 - 1),
        )
        .unwrap();
    assert_eq!(clone("stale-index").missing_thread_ids, [ROOT]);
    index
        .execute(
            "UPDATE thread_history_projection_state SET next_rollout_byte_offset=?1",
            [bytes.len() as i64],
        )
        .unwrap();
    assert_eq!(clone("complete-index").captured_thread_count, 1);
    let copied = Connection::open(
        root.path()
            .join("complete-index/agent/thread_history_1.sqlite"),
    )
    .unwrap();
    assert_eq!(
        copied
            .query_row(
                "SELECT next_rollout_byte_offset FROM thread_history_projection_state",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        bytes.len() as i64
    );
}

#[test]
fn missing_or_cyclic_ancestry_cannot_be_published_as_recoverable() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let agent = source.join("agent");
    write_rollout(
        &agent,
        CHILD,
        CHILD,
        json!({"thread_id":ROOT,"end_byte_offset":0,"end_ordinal_exclusive":0}),
        false,
        false,
    );
    let missing = capture(
        &source,
        &root.path().join("missing"),
        &root.path().join("missing"),
        &[thread(CHILD)],
    )
    .unwrap();
    assert_eq!(missing.missing_thread_ids, [CHILD]);
    write_rollout(
        &agent,
        ROOT,
        ROOT,
        json!({"thread_id":CHILD,"end_byte_offset":0,"end_ordinal_exclusive":0}),
        false,
        false,
    );
    let cyclic = capture(
        &source,
        &root.path().join("cyclic"),
        &root.path().join("cyclic"),
        &[thread(CHILD)],
    )
    .unwrap();
    assert_eq!(cyclic.missing_thread_ids, [CHILD]);
}

#[test]
fn native_metadata_is_required_to_select_a_reverted_history() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    write_rollout(&source.join("agent"), ROOT, ROOT, Value::Null, false, false);
    write_rollout(
        &source.join("agent"),
        ROOT,
        REVERT,
        Value::Null,
        false,
        false,
    );
    let result = capture(
        &source,
        &root.path().join("target"),
        &root.path().join("target"),
        &[thread(ROOT)],
    )
    .unwrap();
    assert_eq!(result.missing_thread_ids, [ROOT]);
}

#[test]
fn detects_missing_and_invalid_inherited_history_cutoffs() {
    for (position, ordinal) in [(1, 1), (999999, 1), (0, 99)] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        write_rollout(&source.join("agent"), ROOT, ROOT, Value::Null, false, false);
        write_rollout(
            &source.join("agent"),
            CHILD,
            CHILD,
            json!({"thread_id":ROOT,"end_byte_offset":position,"end_ordinal_exclusive":ordinal}),
            false,
            false,
        );
        let result = capture(
            &source,
            &root.path().join("target"),
            &root.path().join("target"),
            &[thread(CHILD)],
        )
        .unwrap();
        assert_eq!(result.missing_thread_ids, [CHILD]);
    }
}

#[test]
fn rejects_live_writers_and_releases_coordination_on_failure() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let agent = source.join("agent");
    write_rollout(&agent, ROOT, ROOT, Value::Null, false, false);
    let lock = files::create_file(
        &agent
            .join("thread-writer-locks")
            .join(format!("{ROOT}.lock")),
    )
    .unwrap();
    lock.lock().unwrap();
    let error = capture(
        &source,
        &root.path().join("busy"),
        &root.path().join("busy"),
        &[thread(ROOT)],
    )
    .unwrap_err();
    assert!(error.to_string().contains("conversation writer"));
    drop(lock);
    let result = capture(
        &source,
        &root.path().join("idle"),
        &root.path().join("idle"),
        &[thread(ROOT)],
    )
    .unwrap();
    assert_eq!(result.captured_thread_count, 1);
}

#[test]
fn captures_committed_wal_data_and_rejects_changes_during_capture() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state_5.sqlite");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE example(value TEXT); INSERT INTO example VALUES('from WAL');").unwrap();
    let source = DatabaseSource::open(path).unwrap();
    let target = root.path().join("copy.sqlite");
    source.snapshot(&target).unwrap();
    assert_eq!(
        Connection::open(target)
            .unwrap()
            .query_row("SELECT value FROM example", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "from WAL"
    );
    source.verify_unchanged().unwrap();
    writer
        .execute("INSERT INTO example VALUES('later')", [])
        .unwrap();
    assert!(
        source
            .verify_unchanged()
            .unwrap_err()
            .to_string()
            .contains("changed during capture")
    );
}

#[test]
fn rejects_symlinks_and_native_paths_into_another_home() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let agent = source.join("agent");
    let (relative, _) = write_rollout(&agent, ROOT, ROOT, Value::Null, false, false);
    state(&agent, &[(ROOT, &relative)]);
    let db = Connection::open(agent.join("state_5.sqlite")).unwrap();
    db.execute(
        "UPDATE threads SET rollout_path='/another/profile/sessions/rollout.jsonl'",
        [],
    )
    .unwrap();
    assert!(
        capture(
            &source,
            &root.path().join("external"),
            &root.path().join("external"),
            &[thread(ROOT)]
        )
        .unwrap_err()
        .to_string()
        .contains("outside its Profile")
    );
    fs::remove_file(agent.join("state_5.sqlite")).unwrap();
    let file = agent.join(&relative);
    let moved = agent.join("original");
    fs::rename(&file, &moved).unwrap();
    symlink(&moved, &file).unwrap();
    assert!(
        capture(
            &source,
            &root.path().join("symlink"),
            &root.path().join("symlink"),
            &[thread(ROOT)]
        )
        .unwrap_err()
        .to_string()
        .contains("regular file")
    );
}
