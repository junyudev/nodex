//! Claude forks share delegated transcripts through contained file aliases.
use std::collections::BTreeMap;
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

fn collect(
    root: &Path,
    directory: &Path,
    output: &mut BTreeMap<PathBuf, HistoryFile>,
    depth: usize,
) -> Result<()> {
    if depth > 32 || output.len() >= 100_000 {
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
            collect(root, &path, output, depth + 1)?;
            continue;
        }
        output.insert(
            files::relative_path(root, &path)?,
            history_file(root, &path)?,
        );
        if output.len() > 100_000 {
            return Err(invalid("Claude history has too many files"));
        }
    }
    Ok(())
}

/// Records resolved source identities so capture can materialize aliases and verify them again.
pub(crate) fn inventory(root: &Path) -> Result<BTreeMap<PathBuf, HistoryFile>> {
    let mut output = BTreeMap::new();
    for name in ["projects", "file-history"] {
        let directory = root.join(name);
        if files::exists(&directory)? {
            collect(root, &directory, &mut output, 0)?;
        }
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
            assert!(inventory(&home).is_err(), "{target_kind}");
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
        let before = inventory(home.path()).unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&targets[1], &link).unwrap();
        assert_ne!(before, inventory(home.path()).unwrap());
    }
}
