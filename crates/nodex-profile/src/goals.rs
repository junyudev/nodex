//! Relocates current Nodex-managed goal references in an unpublished native snapshot.
//! Formats are owned by `src/main/thread-goal-attachments.ts`; rollouts are never rewritten.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::files::{self, invalid};

const OBJECTIVE_PREFIX: &str = "Read the Codex goal objective file at ";
const OBJECTIVE_SUFFIX: &str = " before continuing.";
const OBJECTIVE_FILE: &str = "goal-objective.md";
const REGISTRY_FILE: &str = "pasted-text-attachments.json";
const PASTED_PREFIX: &str = "- pasted text file: ";
const PASTED_SUFFIX: &str = ". Read this file before continuing.";
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 16 * 1024;

struct Budget {
    entries: usize,
    bytes: usize,
}

impl Budget {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        if self.entries == 0 || bytes > self.bytes {
            return Err(invalid(
                "Managed goal references exceed their entry or byte budget",
            ));
        }
        self.entries -= 1;
        self.bytes -= bytes;
        Ok(())
    }
}

struct Relocation<'a> {
    source: PathBuf,
    staging: &'a Path,
    target: PathBuf,
}

/// Call with resolved Agent homes after native database/file copies, before the receipt digest.
/// Reads only the staging home. On failure the caller must discard its unpublished staging tree.
pub(crate) fn relocate_managed_references(
    source_agent: &Path,
    staging_agent: &Path,
    target_agent: &Path,
) -> Result<()> {
    if !source_agent.is_absolute() || !staging_agent.is_absolute() || !target_agent.is_absolute() {
        return Err(invalid(
            "Managed reference relocation requires absolute Agent homes",
        ));
    }
    if staging_agent.starts_with(source_agent)
        || source_agent.starts_with(staging_agent)
        || target_agent.starts_with(source_agent)
        || source_agent.starts_with(target_agent)
    {
        return Err(invalid(
            "Managed reference staging must be isolated from its source",
        ));
    }
    files::require_directory(staging_agent)?;
    let relocation = Relocation {
        source: source_agent.join("attachments"),
        staging: staging_agent,
        target: target_agent.join("attachments"),
    };
    let mut budget = Budget {
        entries: 100_000,
        bytes: 64 * 1024 * 1024,
    };
    relocation.relocate_goals(&mut budget)?;
    relocation.relocate_registry(&mut budget)
}

impl Relocation<'_> {
    /// Only UUID-owned immediate children are managed; arbitrary paths remain untouched.
    fn managed_path(&self, raw: &str, v4_only: bool) -> Result<Option<(PathBuf, String)>> {
        if raw.len() > MAX_PATH_BYTES {
            return Err(invalid(
                "Managed attachment reference exceeds its path byte limit",
            ));
        }
        let path = Path::new(raw);
        if !path.starts_with(&self.source) {
            return Ok(None);
        }
        let relative = files::relative_path(&self.source, path)?;
        let mut parts = relative.iter();
        let (Some(directory), Some(filename), None) = (parts.next(), parts.next(), parts.next())
        else {
            return Ok(None);
        };
        let Some(directory) = directory.to_str() else {
            return Ok(None);
        };
        if !is_uuid(directory, v4_only) {
            return Ok(None);
        }
        let staging_root = self.staging.join("attachments");
        files::require_directory(&staging_root)?;
        files::require_directory(&staging_root.join(directory))?;
        let copied = staging_root.join(directory).join(filename);
        files::fingerprint(&copied)?;
        let relocated = self
            .target
            .join(relative)
            .into_os_string()
            .into_string()
            .map_err(|_| invalid("Managed attachment destination is not UTF-8"))?;
        if relocated.len() > MAX_PATH_BYTES {
            return Err(invalid(
                "Managed attachment destination exceeds its path byte limit",
            ));
        }
        Ok(Some((copied, relocated)))
    }

    fn relocate_goals(&self, budget: &mut Budget) -> Result<()> {
        let path = self.staging.join("goals_1.sqlite");
        if !files::exists(&path)? {
            return Ok(());
        }
        files::fingerprint(&path)?;
        let mut connection = Connection::open_with_flags(
            std::fs::canonicalize(path)?,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let transaction = connection.transaction()?;
        let mut after = None;
        while let Some((thread, objective)) = next_goal(&transaction, after.as_deref(), budget)? {
            let updated = self.relocate_objective(&objective, budget)?;
            if updated != objective {
                transaction.execute(
                    "UPDATE thread_goals SET objective = ?1 WHERE thread_id = ?2",
                    (&updated, &thread),
                )?;
            }
            after = Some(thread);
        }
        transaction.commit()?;
        Ok(())
    }

    fn relocate_objective(&self, objective: &str, budget: &mut Budget) -> Result<String> {
        let pointer = objective
            .strip_prefix(OBJECTIVE_PREFIX)
            .and_then(|text| text.strip_suffix(OBJECTIVE_SUFFIX));
        let Some(raw) = pointer else {
            let updated = self.relocate_sections(objective)?;
            if updated != objective {
                require_inline_objective_size(&updated)?;
            }
            return Ok(updated);
        };
        if Path::new(raw)
            .file_name()
            .is_none_or(|name| name != OBJECTIVE_FILE)
        {
            return Ok(objective.to_owned());
        }
        let Some((copied, relocated)) = self.managed_path(raw, false)? else {
            return Ok(objective.to_owned());
        };
        let text = read_text(&copied, budget)?;
        let updated = self.relocate_sections(&text)?;
        if updated != text {
            write_text(&copied, &updated)?;
        }
        let pointer = format!("{OBJECTIVE_PREFIX}{relocated}{OBJECTIVE_SUFFIX}");
        require_inline_objective_size(&pointer)?;
        Ok(pointer)
    }

    /// The materializer appends at most three sections, in this order. Match whole suffix
    /// sections and exact generated line/file shapes, never paths embedded in arbitrary prose.
    fn relocate_sections(&self, text: &str) -> Result<String> {
        let mut result = text.to_owned();
        let mut end = text.len();
        let mut previous = 4;
        while end > 0 {
            let start = text[..end].rfind("\n\n").map_or(0, |index| index + 2);
            let Some((heading, lines)) = text[start..end].split_once('\n') else {
                break;
            };
            let rank = match heading {
                "Referenced pasted text files:" => 1,
                "Referenced image files:" => 2,
                "Referenced image URLs:" => 3,
                _ => break,
            };
            if rank >= previous {
                break;
            }
            let Some(updated) = self.relocate_section(lines, rank)? else {
                break;
            };
            let content_start = start + heading.len() + 1;
            if result.len() - (end - content_start) + updated.len() > MAX_TEXT_BYTES {
                return Err(invalid("Relocated goal exceeds its text byte limit"));
            }
            result.replace_range(content_start..end, &updated);
            previous = rank;
            end = start.saturating_sub(2);
        }
        Ok(result)
    }

    fn relocate_section(&self, lines: &str, rank: u8) -> Result<Option<String>> {
        // Validate the entire section before interpreting any of it as generated metadata.
        if !lines
            .split('\n')
            .all(|line| reference_parts(line, rank).is_some())
        {
            return Ok(None);
        }
        let mut updated = String::new();
        for line in lines.split('\n') {
            let (prefix, raw, suffix) = reference_parts(line, rank).expect("validated section");
            let replacement = if rank == 3 {
                None
            } else {
                self.managed_path(raw, true)?
            };
            let relocated = replacement.as_ref().map_or(raw, |(_, relocated)| relocated);
            if updated.len() + prefix.len() + relocated.len() + suffix.len() + 1 > MAX_TEXT_BYTES {
                return Err(invalid(
                    "Relocated goal section exceeds its text byte limit",
                ));
            }
            if !updated.is_empty() {
                updated.push('\n');
            }
            updated.push_str(prefix);
            updated.push_str(relocated);
            updated.push_str(suffix);
        }
        Ok(Some(updated))
    }

    fn relocate_registry(&self, budget: &mut Budget) -> Result<()> {
        let root = self.staging.join("attachments");
        if !files::exists(&root)? {
            return Ok(());
        }
        files::require_directory(&root)?;
        let path = root.join(REGISTRY_FILE);
        if !files::exists(&path)? {
            return Ok(());
        }
        let text = read_text(&path, budget)?;
        let mut registry: Registry = serde_json::from_str(&text)?;
        let mut relocated = BTreeMap::new();
        for raw in &mut registry.attachment_paths {
            budget.charge(raw.len())?;
            let Some((_, target)) = self.managed_path(raw, true)? else {
                continue;
            };
            budget.charge(target.len())?;
            relocated.insert(raw.clone(), target.clone());
            *raw = target;
        }
        for raw in &mut registry.pending_removal_paths {
            budget.charge(raw.len())?;
            if let Some(target) = relocated.get(raw) {
                budget.charge(target.len())?;
                *raw = target.clone();
            }
        }
        let mut excerpts = BTreeMap::new();
        for (raw, excerpt) in registry.text_excerpts_by_path {
            budget.charge(raw.len().saturating_add(excerpt.len()))?;
            let key = relocated.get(&raw).cloned().unwrap_or(raw);
            budget.charge(key.len())?;
            excerpts.insert(key, excerpt);
        }
        if relocated.is_empty() {
            return Ok(());
        }
        registry.text_excerpts_by_path = excerpts;
        write_text(&path, &serde_json::to_string(&registry)?)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    attachment_paths: Vec<String>,
    pending_removal_paths: Vec<String>,
    #[serde(default)]
    text_excerpts_by_path: BTreeMap<String, String>,
}

fn next_goal(
    connection: &Connection,
    after: Option<&str>,
    budget: &mut Budget,
) -> Result<Option<(String, String)>> {
    let sql = if after.is_some() {
        "SELECT thread_id, objective FROM thread_goals WHERE thread_id > ?1 ORDER BY thread_id LIMIT 1"
    } else {
        "SELECT thread_id, objective FROM thread_goals ORDER BY thread_id LIMIT 1"
    };
    let mut statement = connection.prepare_cached(sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(after))?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let id = row
        .get_ref(0)?
        .as_str()
        .map_err(|_| invalid("Goal Thread ID must be UTF-8 text"))?;
    let objective = row
        .get_ref(1)?
        .as_str()
        .map_err(|_| invalid("Goal objective must be UTF-8 text"))?;
    if id.len() > MAX_PATH_BYTES || objective.len() > MAX_TEXT_BYTES {
        return Err(invalid("Current goal exceeds its text byte limit"));
    }
    budget.charge(id.len().saturating_add(objective.len()))?;
    Ok(Some((id.to_owned(), objective.to_owned())))
}

fn read_text(path: &Path, budget: &mut Budget) -> Result<String> {
    let file = files::read_file(path)?;
    let size = usize::try_from(file.metadata()?.len())
        .map_err(|_| invalid("Managed reference file is too large"))?;
    if size > MAX_TEXT_BYTES {
        return Err(invalid(
            "Managed reference file exceeds its text byte limit",
        ));
    }
    budget.charge(size)?;
    let mut text = String::new();
    file.take(size as u64 + 1).read_to_string(&mut text)?;
    if text.len() != size {
        return Err(invalid("Managed reference file changed while reading"));
    }
    Ok(text)
}

fn write_text(path: &Path, text: &str) -> Result<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(invalid("Relocated references exceed their text byte limit"));
    }
    files::fingerprint(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?;
    file.write_all(text.as_bytes())?;
    file.flush()?;
    Ok(())
}

fn is_uuid(value: &str, v4_only: bool) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => {
                if v4_only {
                    *byte == b'4'
                } else {
                    (b'1'..=b'8').contains(byte)
                }
            }
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}

fn positive_index(value: &str) -> bool {
    value.len() <= 10
        && value.starts_with(|c: char| matches!(c, '1'..='9'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn require_inline_objective_size(objective: &str) -> Result<()> {
    if objective.chars().take(4001).count() > 4000 {
        return Err(invalid("Relocated goal objective exceeds 4000 code points"));
    }
    Ok(())
}

fn reference_parts(line: &str, rank: u8) -> Option<(&str, &str, &str)> {
    if rank == 1 {
        let raw = line
            .strip_prefix(PASTED_PREFIX)?
            .strip_suffix(PASTED_SUFFIX)?;
        let name = Path::new(raw).file_name()?.to_str()?;
        if !positive_index(name.strip_prefix("pasted-text-")?.strip_suffix(".txt")?) {
            return None;
        }
        return Some((PASTED_PREFIX, raw, PASTED_SUFFIX));
    }
    let (label, raw) = line.split_once("]: ")?;
    let index = label.strip_prefix("- [Image #")?;
    if !positive_index(index) {
        return None;
    }
    if rank == 3 {
        if !raw.starts_with("https://") && !raw.starts_with("http://") {
            return None;
        }
        return Some((&line[..label.len() + 3], raw, ""));
    }
    let name = Path::new(raw).file_name()?.to_str()?;
    let (number, extension) = name.strip_prefix("image-")?.split_once('.')?;
    if number != index
        || extension.is_empty()
        || extension.len() > 8
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }
    Some((&line[..label.len() + 3], raw, ""))
}

#[cfg(test)]
mod tests;
