//! Claude forks share delegated transcripts through contained file aliases.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::Result;
use crate::files::{self, invalid};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct HistoryFile {
    pub path: PathBuf,
    pub fingerprint: files::Fingerprint,
}

fn is_subagent_transcript(relative: &Path) -> bool {
    let parts: Vec<_> = relative.components().collect();
    parts.len() == 5
        && parts[0].as_os_str() == "projects"
        && parts[3].as_os_str() == "subagents"
        && relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
}

fn history_file(root: &Path, path: &Path) -> Result<HistoryFile> {
    if !fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Ok(HistoryFile {
            path: path.to_owned(),
            fingerprint: files::fingerprint(path)?,
        });
    }
    let relative = files::relative_path(root, path)?;
    if !is_subagent_transcript(&relative) {
        return Err(invalid(
            "Claude history alias is not a delegated transcript",
        ));
    }
    let physical_root = fs::canonicalize(root)?;
    let target = fs::canonicalize(path)?;
    let target_relative = files::relative_path(&physical_root, &target)?;
    if !is_subagent_transcript(&target_relative) || target.file_name() != path.file_name() {
        return Err(invalid(
            "Claude history alias does not select its delegated transcript",
        ));
    }
    Ok(HistoryFile {
        fingerprint: files::fingerprint(&target)?,
        path: target,
    })
}

fn insert(
    root: &Path,
    path: &Path,
    output: &mut BTreeMap<PathBuf, HistoryFile>,
    max_files: usize,
) -> Result<()> {
    if output.len() >= max_files {
        return Err(invalid("Claude history has too many files"));
    }
    output.insert(files::relative_path(root, path)?, history_file(root, path)?);
    Ok(())
}

fn collect(
    root: &Path,
    directory: &Path,
    output: &mut BTreeMap<PathBuf, HistoryFile>,
    max_files: usize,
    depth: usize,
) -> Result<()> {
    if depth > 32 {
        return Err(invalid("Claude history exceeds its filesystem bounds"));
    }
    files::require_directory(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name() == ".DS_Store" {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect(root, &path, output, max_files, depth + 1)?;
            continue;
        }
        insert(root, &path, output, max_files)?;
    }
    Ok(())
}

fn collect_project(
    root: &Path,
    directory: &Path,
    required: &BTreeSet<String>,
    output: &mut BTreeMap<PathBuf, HistoryFile>,
    max_files: usize,
) -> Result<()> {
    files::require_directory(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if required.contains(name) {
            collect(root, &entry.path(), output, max_files, 0)?;
            continue;
        }
        if name
            .strip_suffix(".jsonl")
            .is_some_and(|id| required.contains(id))
        {
            insert(root, &entry.path(), output, max_files)?;
        }
    }
    Ok(())
}

fn session_component(id: &str) -> Result<()> {
    let mut parts = Path::new(id).components();
    if id.len() > 512
        || !matches!(parts.next(), Some(std::path::Component::Normal(_)))
        || parts.next().is_some()
    {
        return Err(invalid(
            "Claude native Session identity is not a path component",
        ));
    }
    Ok(())
}

/// Captures only this Profile's native Sessions and their delegated/file-history trees.
/// Fork transcripts already contain their inherited messages. Delegated aliases retain
/// their resolved source identity without pulling in the parent's unrelated history.
pub(crate) fn inventory(
    root: &Path,
    required: &BTreeSet<String>,
) -> Result<BTreeMap<PathBuf, HistoryFile>> {
    inventory_with_file_limit(root, required, 100_000)
}

fn inventory_with_file_limit(
    root: &Path,
    required: &BTreeSet<String>,
    max_files: usize,
) -> Result<BTreeMap<PathBuf, HistoryFile>> {
    let mut output = BTreeMap::new();
    for id in required {
        session_component(id)?;
        let directory = root.join("file-history").join(id);
        if files::exists(&directory)? {
            files::require_directory(&root.join("file-history"))?;
            collect(root, &directory, &mut output, max_files, 0)?;
        }
    }
    let projects = root.join("projects");
    if required.is_empty() || !files::exists(&projects)? {
        return Ok(output);
    }
    files::require_directory(&projects)?;
    for (index, project) in fs::read_dir(&projects)?.enumerate() {
        if index >= 100_000 {
            return Err(invalid("Claude history has too many projects"));
        }
        let project = project?;
        if !project.file_type()?.is_dir() {
            continue;
        }
        collect_project(root, &project.path(), required, &mut output, max_files)?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn rejects_aliases_outside_the_home_or_transcript_tree() {
        for target_kind in ["outside", "credentials", "directory"] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("claude");
            let link = home.join("projects/project/fork/subagents/agent-child.jsonl");
            files::private_directory(link.parent().unwrap()).unwrap();
            let target = match target_kind {
                "outside" => root
                    .path()
                    .join("other/projects/project/parent/subagents/agent-child.jsonl"),
                "credentials" => home.join(".credentials.json"),
                "directory" => home.join("projects/project/parent/subagents/agent-child.jsonl"),
                _ => unreachable!(),
            };
            if target_kind == "directory" {
                files::private_directory(&target).unwrap();
            } else {
                files::create_file(&target).unwrap();
            }
            symlink(&target, &link).unwrap();
            assert!(
                inventory(&home, &BTreeSet::from(["fork".into()])).is_err(),
                "{target_kind}"
            );
        }
    }

    #[test]
    fn detects_a_fork_alias_changing_its_physical_transcript() {
        let home = tempfile::tempdir().unwrap();
        let targets = ["first", "second"].map(|session| {
            home.path().join(format!(
                "projects/project/{session}/subagents/agent-child.jsonl"
            ))
        });
        for target in &targets {
            files::create_file(target).unwrap();
        }
        let link = home
            .path()
            .join("projects/project/fork/subagents/agent-child.jsonl");
        files::private_directory(link.parent().unwrap()).unwrap();
        symlink(&targets[0], &link).unwrap();
        let before = inventory(home.path(), &BTreeSet::from(["fork".into()])).unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&targets[1], &link).unwrap();
        assert_ne!(
            before,
            inventory(home.path(), &BTreeSet::from(["fork".into()])).unwrap()
        );
    }

    #[test]
    fn includes_session_file_history_but_ignores_unrelated_session_writes() {
        let home = tempfile::tempdir().unwrap();
        let selected = home.path().join("projects/project/fork.jsonl");
        let backup = home.path().join("file-history/fork/abc@v1");
        let unrelated = home.path().join("projects/project/parent.jsonl");
        for path in [&selected, &backup, &unrelated] {
            files::create_file(path).unwrap();
        }
        let required = BTreeSet::from(["fork".into()]);
        let before = inventory(home.path(), &required).unwrap();
        assert_eq!(before.len(), 2);
        fs::write(&unrelated, b"another session is running").unwrap();
        assert_eq!(before, inventory(home.path(), &required).unwrap());
        fs::write(&backup, b"changed checkpoint").unwrap();
        assert_ne!(before, inventory(home.path(), &required).unwrap());
        let before = inventory(home.path(), &required).unwrap();
        fs::write(&selected, b"selected session changed").unwrap();
        assert_ne!(before, inventory(home.path(), &required).unwrap());
    }

    #[test]
    fn rejects_session_id_path_traversal() {
        let home = tempfile::tempdir().unwrap();
        for id in ["", ".", "..", "../other", "/outside", "first/second"] {
            assert!(inventory(home.path(), &BTreeSet::from([id.into()])).is_err());
        }
    }

    #[test]
    fn bounds_top_level_transcripts_across_projects() {
        let home = tempfile::tempdir().unwrap();
        for project in ["first", "second", "third"] {
            files::create_file(
                &home
                    .path()
                    .join(format!("projects/{project}/selected.jsonl")),
            )
            .unwrap();
        }
        let required = BTreeSet::from(["selected".into()]);
        assert_eq!(
            inventory_with_file_limit(home.path(), &required, 3)
                .unwrap()
                .len(),
            3
        );
        assert!(inventory_with_file_limit(home.path(), &required, 2).is_err());
    }

    #[test]
    fn shares_one_file_bound_across_transcripts_delegated_history_and_checkpoints() {
        let home = tempfile::tempdir().unwrap();
        for relative in [
            "projects/project/selected.jsonl",
            "projects/project/selected/subagents/agent-child.jsonl",
            "file-history/selected/abc@v1",
            "projects/project/unrelated.jsonl",
            "projects/project/unrelated/subagents/agent-other.jsonl",
            "file-history/unrelated/abc@v1",
        ] {
            files::create_file(&home.path().join(relative)).unwrap();
        }
        files::private_directory(&home.path().join("projects/project/selected/empty")).unwrap();
        let required = BTreeSet::from(["selected".into()]);
        assert_eq!(
            inventory_with_file_limit(home.path(), &required, 3)
                .unwrap()
                .len(),
            3
        );
        assert!(inventory_with_file_limit(home.path(), &required, 2).is_err());
    }
}
