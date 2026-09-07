use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::agent_interface::{AGENT_API_MAX_REVISION, AGENT_API_MIN_REVISION};
use crate::error::{CliError, CliErrorCode};

const MAX_BUNDLE_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SKILL_FILE_BYTES: u64 = 128 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 512 * 1024;

pub const OFFICIAL_SKILL_FILES: [&str; 7] = [
    "SKILL.md",
    "agents/openai.yaml",
    "references/nested-markdown.md",
    "references/page-editor.md",
    "references/project-database-views.md",
    "references/queries-and-configuration.md",
    "references/troubleshooting.md",
];

const OFFICIAL_BUNDLE_FILES: [&str; 10] = [
    "LICENSE",
    "README.md",
    "release-manifest.json",
    "skills/nodex/SKILL.md",
    "skills/nodex/agents/openai.yaml",
    "skills/nodex/references/nested-markdown.md",
    "skills/nodex/references/page-editor.md",
    "skills/nodex/references/project-database-views.md",
    "skills/nodex/references/queries-and-configuration.md",
    "skills/nodex/references/troubleshooting.md",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedSkillBundle {
    pub bundle_root: PathBuf,
    pub skill_source: PathBuf,
    pub release_version: String,
    pub tree_sha256: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillTreeDigest {
    pub tree_sha256: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u32,
    distribution: String,
    product: ReleaseProduct,
    agent_interface: ReleaseAgentInterface,
    skills: Vec<ReleaseSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseProduct {
    name: String,
    release_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseAgentInterface {
    minimum_revision: u32,
    maximum_revision: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseSkill {
    name: String,
    path: String,
    tree_sha256: String,
    file_count: u64,
    total_bytes: u64,
}

pub fn discover_current() -> Result<Option<VerifiedSkillBundle>, CliError> {
    let Ok(executable) = std::env::current_exe() else {
        return Ok(None);
    };
    verify_for_executable(&executable)
}

pub fn verify_stable_for_executable(
    executable: &Path,
    home: &Path,
) -> Result<VerifiedSkillBundle, CliError> {
    let bundle = verify_for_executable(executable)?.ok_or_else(|| {
        unavailable(
            "the current Nodex CLI is not inside a packaged Nodex.app Skill bundle; install Nodex in /Applications or use npx skills@latest add NodexApp/skills",
        )
    })?;
    let canonical_executable = executable.canonicalize().map_err(|error| {
        unavailable(format!(
            "Nodex could not canonicalize {}: {error}",
            executable.display()
        ))
    })?;
    let app = packaged_app_from_executable(&canonical_executable).ok_or_else(|| {
        unavailable("the current Nodex CLI is not inside a canonical Nodex.app layout")
    })?;
    let canonical_home = home.canonicalize().map_err(|error| {
        unavailable(format!(
            "Nodex could not verify the user home {}: {error}",
            home.display()
        ))
    })?;
    let system_applications = Path::new("/Applications");
    let user_applications = canonical_home.join("Applications");
    let stable = app
        .parent()
        .is_some_and(|parent| parent == system_applications || parent == user_applications);
    if !stable {
        return Err(unavailable(format!(
            "{} is not a stable /Applications or ~/Applications install; move Nodex.app before installing managed Agent Skills, or use npx skills@latest add NodexApp/skills",
            app.display()
        )));
    }
    Ok(bundle)
}

pub fn verify_for_executable(executable: &Path) -> Result<Option<VerifiedSkillBundle>, CliError> {
    let Ok(canonical_executable) = executable.canonicalize() else {
        return Ok(None);
    };
    let Some(app) = packaged_app_from_executable(&canonical_executable) else {
        return Ok(None);
    };
    let resources = app.join("Contents/Resources");
    let bundle_root = resources.join("agent-skills");
    let manifest_path = bundle_root.join("release-manifest.json");
    let manifest_metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(invalid(format!(
                "could not inspect {}: {error}",
                manifest_path.display()
            )));
        }
    };
    require_regular_single_link(
        &manifest_path,
        &manifest_metadata,
        MAX_BUNDLE_MANIFEST_BYTES,
    )?;
    validate_exact_bundle_tree(&bundle_root)?;

    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        invalid(format!(
            "could not read {}: {error}",
            manifest_path.display()
        ))
    })?;
    if manifest_bytes.windows(2).any(|window| window == b"\r\n") {
        return Err(invalid("release-manifest.json uses CRLF line endings"));
    }
    let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes).map_err(|error| {
        invalid(format!(
            "{} is not a valid release manifest: {error}",
            manifest_path.display()
        ))
    })?;
    validate_release_manifest(&manifest)?;

    let skill_source = bundle_root.join("skills/nodex");
    let digest = digest_skill_tree(&skill_source)?;
    let skill = &manifest.skills[0];
    if digest.tree_sha256 != skill.tree_sha256
        || digest.file_count != skill.file_count
        || digest.total_bytes != skill.total_bytes
    {
        return Err(invalid(
            "the packaged Nodex Skill tree does not match release-manifest.json",
        ));
    }
    let canonical_source = skill_source.canonicalize().map_err(|error| {
        invalid(format!(
            "could not canonicalize {}: {error}",
            skill_source.display()
        ))
    })?;
    if canonical_source != skill_source {
        return Err(invalid(
            "the packaged Nodex Skill source escaped its canonical bundle path",
        ));
    }

    Ok(Some(VerifiedSkillBundle {
        bundle_root,
        skill_source: canonical_source,
        release_version: manifest.product.release_version.clone(),
        tree_sha256: digest.tree_sha256,
        file_count: digest.file_count,
        total_bytes: digest.total_bytes,
    }))
}

fn packaged_app_from_executable(executable: &Path) -> Option<PathBuf> {
    let bin = executable.parent()?;
    if bin.file_name()?.to_str()? != "bin" {
        return None;
    }
    let resources = bin.parent()?;
    if resources.file_name()?.to_str()? != "Resources" {
        return None;
    }
    let contents = resources.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let app = contents.parent()?;
    if app.extension()?.to_str()? != "app" {
        return None;
    }
    Some(app.to_path_buf())
}

fn validate_release_manifest(manifest: &ReleaseManifest) -> Result<(), CliError> {
    if manifest.schema_version != 1
        || manifest.distribution != "NodexApp/skills"
        || manifest.product.name != "Nodex"
        || manifest.product.release_version.trim().is_empty()
    {
        return Err(invalid(
            "release manifest has an unsupported product or schema",
        ));
    }
    if manifest.agent_interface.minimum_revision > AGENT_API_MIN_REVISION
        || manifest.agent_interface.maximum_revision < AGENT_API_MAX_REVISION
    {
        return Err(invalid(
            "release manifest is incompatible with this Agent API revision",
        ));
    }
    let [skill] = manifest.skills.as_slice() else {
        return Err(invalid(
            "release manifest must contain exactly one official Skill",
        ));
    };
    if skill.name != "nodex"
        || skill.path != "skills/nodex"
        || !valid_sha256(&skill.tree_sha256)
        || skill.file_count != OFFICIAL_SKILL_FILES.len() as u64
        || skill.total_bytes == 0
        || skill.total_bytes > MAX_SKILL_TOTAL_BYTES
    {
        return Err(invalid(
            "release manifest contains an invalid Nodex Skill descriptor",
        ));
    }
    Ok(())
}

fn validate_exact_bundle_tree(root: &Path) -> Result<(), CliError> {
    let allowed_files = OFFICIAL_BUNDLE_FILES.into_iter().collect::<BTreeSet<_>>();
    let allowed_directories = directory_allowlist(&allowed_files);
    validate_tree_entries(root, root, &allowed_files, &allowed_directories)?;
    for relative in &allowed_files {
        let path = root.join(relative);
        if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file()) {
            return Err(invalid(format!(
                "official Skill bundle is missing required file: {relative}"
            )));
        }
    }
    Ok(())
}

pub fn digest_skill_tree(root: &Path) -> Result<SkillTreeDigest, CliError> {
    let allowed_files = OFFICIAL_SKILL_FILES.into_iter().collect::<BTreeSet<_>>();
    let allowed_directories = directory_allowlist(&allowed_files);
    validate_tree_entries(root, root, &allowed_files, &allowed_directories)?;

    let mut files = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for relative in allowed_files {
        let path = root.join(relative);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| invalid(format!("could not inspect {}: {error}", path.display())))?;
        require_regular_single_link(&path, &metadata, MAX_SKILL_FILE_BYTES)?;
        let bytes = fs::read(&path)
            .map_err(|error| invalid(format!("could not read {}: {error}", path.display())))?;
        if bytes.windows(2).any(|window| window == b"\r\n") {
            return Err(invalid(format!(
                "{} uses CRLF line endings",
                path.display()
            )));
        }
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| invalid("official Skill byte count overflowed"))?;
        files.insert(relative.to_owned(), bytes);
    }
    if total_bytes > MAX_SKILL_TOTAL_BYTES {
        return Err(invalid(format!(
            "official Skill exceeds the {MAX_SKILL_TOTAL_BYTES} byte limit"
        )));
    }

    let mut hasher = Sha256::new();
    for (relative, bytes) in &files {
        hasher.update(relative.as_bytes());
        hasher.update(b"\0");
        hasher.update(bytes.len().to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(bytes);
        hasher.update(b"\0");
    }
    Ok(SkillTreeDigest {
        tree_sha256: hex::encode(hasher.finalize()),
        file_count: files.len() as u64,
        total_bytes,
    })
}

fn validate_tree_entries(
    root: &Path,
    directory: &Path,
    allowed_files: &BTreeSet<&str>,
    allowed_directories: &BTreeSet<String>,
) -> Result<(), CliError> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| invalid(format!("could not inspect {}: {error}", root.display())))?;
    if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
        return Err(invalid(format!(
            "{} must be a real directory",
            root.display()
        )));
    }

    let mut entries = fs::read_dir(directory)
        .map_err(|error| invalid(format!("could not read {}: {error}", directory.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| invalid(format!("could not read {}: {error}", directory.display())))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);

    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid("official Skill path escaped its root"))?;
        let relative = portable_relative_path(relative)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| invalid(format!("could not inspect {}: {error}", path.display())))?;
        if metadata.file_type().is_symlink() {
            return Err(invalid(format!(
                "official Skill tree contains a symlink: {relative}"
            )));
        }
        if metadata.file_type().is_dir() {
            if !allowed_directories.contains(&relative) {
                return Err(invalid(format!(
                    "official Skill tree contains an unknown directory: {relative}"
                )));
            }
            validate_tree_entries(root, &path, allowed_files, allowed_directories)?;
            continue;
        }
        if !metadata.file_type().is_file() {
            return Err(invalid(format!(
                "official Skill tree contains a special file: {relative}"
            )));
        }
        if !allowed_files.contains(relative.as_str()) {
            return Err(invalid(format!(
                "official Skill tree contains an unknown file: {relative}"
            )));
        }
        let max_bytes = if relative == "release-manifest.json" {
            MAX_BUNDLE_MANIFEST_BYTES
        } else {
            MAX_SKILL_FILE_BYTES
        };
        require_regular_single_link(&path, &metadata, max_bytes)?;
        let bytes = fs::read(&path)
            .map_err(|error| invalid(format!("could not read {}: {error}", path.display())))?;
        if bytes.windows(2).any(|window| window == b"\r\n") {
            return Err(invalid(format!(
                "{} uses CRLF line endings",
                path.display()
            )));
        }
    }
    Ok(())
}

fn portable_relative_path(path: &Path) -> Result<String, CliError> {
    let components = path
        .components()
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .ok_or_else(|| invalid("official Skill path is not valid UTF-8"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty()
        || components
            .iter()
            .any(|component| component.is_empty() || *component == "..")
    {
        return Err(invalid("official Skill contains an unsafe relative path"));
    }
    Ok(components.join("/"))
}

fn directory_allowlist(files: &BTreeSet<&str>) -> BTreeSet<String> {
    let mut directories = BTreeSet::new();
    for file in files {
        let components = file.split('/').collect::<Vec<_>>();
        for length in 1..components.len() {
            directories.insert(components[..length].join("/"));
        }
    }
    directories
}

fn require_regular_single_link(
    path: &Path,
    metadata: &fs::Metadata,
    max_bytes: u64,
) -> Result<(), CliError> {
    if !metadata.file_type().is_file() {
        return Err(invalid(format!("{} is not a regular file", path.display())));
    }
    if metadata.nlink() != 1 {
        return Err(invalid(format!(
            "{} must not be hard-linked",
            path.display()
        )));
    }
    if metadata.len() > max_bytes {
        return Err(invalid(format!(
            "{} exceeds the {max_bytes} byte limit",
            path.display()
        )));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn unavailable(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::SkillBundleUnavailable, message)
}

pub fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::SkillBundleInvalid, message)
}
