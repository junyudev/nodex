use super::*;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::symlink;
use tempfile::{TempDir, tempdir};

const DIRECTORY: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_DIRECTORY: &str = "22222222-2222-4222-8222-222222222222";

struct Fixture {
    _root: TempDir,
    source: PathBuf,
    staging: PathBuf,
    target: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempdir().unwrap();
        let resolved = root.path().canonicalize().unwrap();
        let fixture = Self {
            _root: root,
            source: resolved.join("source-agent"),
            staging: resolved.join("staging-agent"),
            target: resolved.join("target-agent"),
        };
        files::private_directory(&fixture.source).unwrap();
        files::private_directory(&fixture.staging).unwrap();
        fixture
    }

    fn attachment(&self, name: &str, text: &str) -> String {
        let path = self.source.join("attachments").join(DIRECTORY).join(name);
        files::create_file(&path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        path.to_str().unwrap().to_owned()
    }

    fn goals(&self, rows: &[(&str, &str)]) {
        let connection = Connection::open(self.source.join("goals_1.sqlite")).unwrap();
        connection.execute_batch("CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT DEFAULT 'paused', tokens_used INTEGER DEFAULT 17)").unwrap();
        for (id, objective) in rows {
            connection
                .execute(
                    "INSERT INTO thread_goals(thread_id, objective) VALUES (?1, ?2)",
                    (id, objective),
                )
                .unwrap();
        }
    }

    fn registry(&self, value: Value) {
        let path = self.source.join("attachments").join(REGISTRY_FILE);
        files::create_file(&path)
            .unwrap()
            .write_all(value.to_string().as_bytes())
            .unwrap();
    }

    fn copy(&self) {
        let inventory = files::inventory(
            &self.source,
            &["attachments", "sessions"],
            &["goals_1.sqlite"],
        )
        .unwrap();
        for relative in inventory.keys() {
            files::copy_file(&self.source.join(relative), &self.staging.join(relative)).unwrap();
        }
    }

    fn run(&self) -> Result<()> {
        relocate_managed_references(&self.source, &self.staging, &self.target)
    }

    fn target_path(&self, source: &str) -> String {
        self.target
            .join(Path::new(source).strip_prefix(&self.source).unwrap())
            .to_str()
            .unwrap()
            .to_owned()
    }

    fn copied_path(&self, source: &str) -> PathBuf {
        self.staging
            .join(Path::new(source).strip_prefix(&self.source).unwrap())
    }

    fn objective(&self, id: &str) -> String {
        Connection::open(self.staging.join("goals_1.sqlite"))
            .unwrap()
            .query_row(
                "SELECT objective FROM thread_goals WHERE thread_id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
    }
}

fn pointer(path: &str) -> String {
    format!("{OBJECTIVE_PREFIX}{path}{OBJECTIVE_SUFFIX}")
}

#[test]
fn relocates_current_pointer_and_generated_suffixes_without_touching_prose_or_history() {
    let fixture = Fixture::new();
    let pasted = fixture.attachment("pasted-text-1.txt", "pasted input");
    let image = fixture.attachment("image-2.png", "image bytes");
    let prose = format!(
        "{}\nKeep this historical reference verbatim: {pasted}",
        "x".repeat(4001)
    );
    let sections = format!(
        "\n\nReferenced pasted text files:\n- pasted text file: {pasted}. Read this file before continuing.\n\nReferenced image files:\n- [Image #2]: {image}\n\nReferenced image URLs:\n- [Image #3]: https://example.invalid/image.png"
    );
    let document = fixture.attachment(OBJECTIVE_FILE, &format!("{prose}{sections}"));
    fixture.attachment("unused.md", &pointer(&document));
    let short = format!("Short goal{sections}");
    fixture.goals(&[
        ("long", &pointer(&document)),
        ("short", &short),
        ("external", &pointer("/workspace/goal-objective.md")),
    ]);
    let history = fixture.source.join("sessions/rollout.jsonl");
    files::create_file(&history)
        .unwrap()
        .write_all(pointer(&document).as_bytes())
        .unwrap();
    fixture.copy();
    let before = files::digest_tree(&fixture.source).unwrap();

    fixture.run().unwrap();

    assert_eq!(
        fixture.objective("long"),
        pointer(&fixture.target_path(&document))
    );
    let updated_sections = format!(
        "\n\nReferenced pasted text files:\n- pasted text file: {}. Read this file before continuing.\n\nReferenced image files:\n- [Image #2]: {}\n\nReferenced image URLs:\n- [Image #3]: https://example.invalid/image.png",
        fixture.target_path(&pasted),
        fixture.target_path(&image)
    );
    assert_eq!(
        fs::read_to_string(fixture.copied_path(&document)).unwrap(),
        format!("{prose}{updated_sections}")
    );
    assert_eq!(
        fixture.objective("short"),
        format!("Short goal{updated_sections}")
    );
    assert_eq!(
        fixture.objective("external"),
        pointer("/workspace/goal-objective.md")
    );
    assert_eq!(
        fs::read(fixture.staging.join("sessions/rollout.jsonl")).unwrap(),
        fs::read(history).unwrap()
    );
    assert_eq!(
        fs::read_to_string(
            fixture
                .staging
                .join("attachments")
                .join(DIRECTORY)
                .join("unused.md")
        )
        .unwrap(),
        pointer(&document)
    );
    assert_eq!(files::digest_tree(&fixture.source).unwrap(), before);
    let connection = Connection::open(fixture.staging.join("goals_1.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT status, tokens_used FROM thread_goals WHERE thread_id='long'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            )
            .unwrap(),
        ("paused".into(), 17)
    );
}

#[test]
fn registry_relocates_only_registered_ownership_and_preserves_excerpt_text() {
    let fixture = Fixture::new();
    let pasted = fixture.attachment("pasted-text.txt", "source text");
    let external = "/workspace/another-file.txt";
    let unregistered = fixture
        .source
        .join("attachments")
        .join(OTHER_DIRECTORY)
        .join("pasted-text.txt")
        .to_str()
        .unwrap()
        .to_owned();
    fixture.registry(json!({
        "attachmentPaths": [&pasted, external],
        "pendingRemovalPaths": [&pasted, &unregistered],
        "textExcerptsByPath": {&pasted: format!("Prose mentions {pasted}"), external: "keep", &unregistered: "unowned"}
    }));
    fixture.copy();
    let before = files::digest_tree(&fixture.source).unwrap();
    fixture.run().unwrap();
    let actual: Value = serde_json::from_slice(
        &fs::read(fixture.staging.join("attachments").join(REGISTRY_FILE)).unwrap(),
    )
    .unwrap();
    let relocated = fixture.target_path(&pasted);
    assert_eq!(
        actual,
        json!({
            "attachmentPaths": [&relocated, external],
            "pendingRemovalPaths": [&relocated, &unregistered],
            "textExcerptsByPath": {&relocated: format!("Prose mentions {pasted}"), external: "keep", &unregistered: "unowned"}
        })
    );
    assert_eq!(
        fs::read_to_string(fixture.copied_path(&pasted)).unwrap(),
        "source text"
    );
    assert_eq!(files::digest_tree(&fixture.source).unwrap(), before);
}

#[test]
fn missing_owned_dependencies_reject_goal_pointer_nested_reference_and_registry() {
    for kind in ["pointer", "nested", "registry"] {
        let fixture = Fixture::new();
        let missing = fixture
            .source
            .join("attachments")
            .join(DIRECTORY)
            .join(if kind == "pointer" {
                OBJECTIVE_FILE
            } else {
                "pasted-text-1.txt"
            })
            .to_str()
            .unwrap()
            .to_owned();
        match kind {
            "pointer" => fixture.goals(&[("goal", &pointer(&missing))]),
            "nested" => {
                let document = fixture.attachment(OBJECTIVE_FILE, &format!("Goal\n\nReferenced pasted text files:\n- pasted text file: {missing}. Read this file before continuing."));
                fixture.goals(&[("goal", &pointer(&document))]);
            }
            _ => fixture.registry(json!({"attachmentPaths": [missing], "pendingRemovalPaths": []})),
        }
        fixture.copy();
        let before = files::digest_tree(&fixture.source).unwrap();
        assert!(fixture.run().is_err(), "{kind}");
        assert_eq!(files::digest_tree(&fixture.source).unwrap(), before);
    }
}

#[test]
fn source_may_be_unavailable_and_external_or_non_generated_references_are_untouched() {
    let fixture = Fixture::new();
    let document = fixture.attachment(OBJECTIVE_FILE, "the original objective");
    let generated = "Referenced pasted text files:\n- pasted text file: /workspace/pasted-text-1.txt. Read this file before continuing.".to_owned();
    let prose = format!(
        "Examples\n\nReferenced pasted text files:\n- pasted text file: {}. Read this file before continuing.\n\nThis is ordinary prose after the example.",
        fixture
            .source
            .join("attachments")
            .join(DIRECTORY)
            .join("pasted-text-1.txt")
            .display()
    );
    fixture.goals(&[
        ("owned", &pointer(&document)),
        ("external", &generated),
        ("prose", &prose),
    ]);
    fixture.copy();
    fs::rename(&fixture.source, fixture.source.with_file_name("hidden")).unwrap();
    fixture.run().unwrap();
    assert_eq!(
        fixture.objective("owned"),
        pointer(&fixture.target_path(&document))
    );
    assert_eq!(fixture.objective("external"), generated);
    assert_eq!(fixture.objective("prose"), prose);
}

#[test]
fn rejects_owned_symlinks_and_traversal_without_following_them() {
    for kind in ["file", "directory", "traversal"] {
        let fixture = Fixture::new();
        let document = fixture.attachment(OBJECTIVE_FILE, "untouched");
        let raw = if kind == "traversal" {
            format!(
                "{}/attachments/{DIRECTORY}/../{DIRECTORY}/{OBJECTIVE_FILE}",
                fixture.source.display()
            )
        } else {
            document.clone()
        };
        fixture.goals(&[("goal", &pointer(&raw))]);
        fixture.copy();
        if kind == "file" {
            fs::remove_file(fixture.copied_path(&document)).unwrap();
            symlink(&document, fixture.copied_path(&document)).unwrap();
        }
        if kind == "directory" {
            let directory = fixture.copied_path(&document).parent().unwrap().to_owned();
            fs::remove_dir_all(&directory).unwrap();
            symlink(Path::new(&document).parent().unwrap(), directory).unwrap();
        }
        let before = files::digest_tree(&fixture.source).unwrap();
        assert!(fixture.run().is_err(), "{kind}");
        assert_eq!(files::digest_tree(&fixture.source).unwrap(), before);
    }
}

#[test]
fn bounds_rows_strings_and_file_reads_before_retaining_them() {
    let fixture = Fixture::new();
    fixture.goals(&[("a", "1234"), ("b", "5678")]);
    let connection = Connection::open(fixture.source.join("goals_1.sqlite")).unwrap();
    let mut rows = Budget {
        entries: 1,
        bytes: 100,
    };
    assert!(next_goal(&connection, None, &mut rows).unwrap().is_some());
    assert!(next_goal(&connection, Some("a"), &mut rows).is_err());
    assert!(
        next_goal(
            &connection,
            None,
            &mut Budget {
                entries: 10,
                bytes: 4
            }
        )
        .is_err()
    );
    let path = fixture.source.join("oversized");
    files::create_file(&path)
        .unwrap()
        .set_len(MAX_TEXT_BYTES as u64 + 1)
        .unwrap();
    assert!(
        read_text(
            &path,
            &mut Budget {
                entries: 10,
                bytes: usize::MAX
            }
        )
        .is_err()
    );
    fs::write(&path, "12345").unwrap();
    assert!(
        read_text(
            &path,
            &mut Budget {
                entries: 10,
                bytes: 4
            }
        )
        .is_err()
    );
}

#[test]
fn rejects_malformed_registry_and_source_as_staging() {
    let fixture = Fixture::new();
    fixture.registry(json!({"attachmentPaths": [5], "pendingRemovalPaths": []}));
    fixture.copy();
    assert!(fixture.run().is_err());
    let before = files::digest_tree(&fixture.source).unwrap();
    assert!(
        relocate_managed_references(&fixture.source, &fixture.source, &fixture.target).is_err()
    );
    assert_eq!(files::digest_tree(&fixture.source).unwrap(), before);
}

#[test]
fn bounds_registry_entries_and_relocated_goal_pointer() {
    let fixture = Fixture::new();
    let pasted = fixture.attachment("pasted-text.txt", "text");
    fixture.registry(json!({"attachmentPaths": [pasted], "pendingRemovalPaths": []}));
    let document = fixture.attachment(OBJECTIVE_FILE, "goal");
    fixture.goals(&[("goal", &pointer(&document))]);
    fixture.copy();
    let relocation = Relocation {
        source: fixture.source.join("attachments"),
        staging: &fixture.staging,
        target: fixture.target.join("attachments"),
    };
    assert!(
        relocation
            .relocate_registry(&mut Budget {
                entries: 1,
                bytes: MAX_TEXT_BYTES
            })
            .is_err()
    );
    let long_target = fixture.target.join("x".repeat(4000));
    assert!(relocate_managed_references(&fixture.source, &fixture.staging, &long_target).is_err());
    assert_eq!(fixture.objective("goal"), pointer(&document));
}

#[test]
fn absent_native_goals_and_registry_need_no_relocation() {
    let fixture = Fixture::new();
    fixture.run().unwrap();
    assert_eq!(fs::read_dir(&fixture.staging).unwrap().count(), 0);
}

#[test]
fn rejects_inline_expansion_past_native_limit_and_accepts_exactly_4000_code_points() {
    let fixture = Fixture::new();
    let pasted = fixture.attachment("pasted-text-1.txt", "text");
    let suffix = format!(
        "\n\nReferenced pasted text files:\n- pasted text file: {pasted}. Read this file before continuing."
    );
    let objective = format!("{}{suffix}", "界".repeat(4000 - suffix.chars().count()));
    fixture.goals(&[("goal", &objective)]);
    fixture.copy();
    let expanded_target = fixture.target.join("longer-home");
    let error = relocate_managed_references(&fixture.source, &fixture.staging, &expanded_target)
        .unwrap_err();
    assert!(error.to_string().contains("4000 code points"));
    assert_eq!(fixture.objective("goal"), objective);
    fixture.run().unwrap();
    let updated = fixture.objective("goal");
    assert_eq!(updated.chars().count(), 4000);
    assert!(updated.ends_with(&format!(
        "{}. Read this file before continuing.",
        fixture.target_path(&pasted)
    )));
}
