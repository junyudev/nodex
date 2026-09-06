use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use clap::ValueEnum;
use serde::Serialize;

use super::bundle::{VerifiedSkillBundle, digest_skill_tree};
use crate::error::{CliError, CliErrorCode};

#[derive(
    Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, ValueEnum, utoipa::ToSchema,
)]
#[serde(rename_all = "kebab-case")]
#[value(rename_all = "kebab-case")]
pub enum SkillAgent {
    Codex,
    ClaudeCode,
}

impl SkillAgent {
    pub const ALL: [Self; 2] = [Self::Codex, Self::ClaudeCode];

    pub const fn executable_name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SkillTargetState {
    Missing,
    ManagedCurrent,
    CompatibleExternal,
    LegacyExternal,
    Conflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillTarget {
    pub agent: SkillAgent,
    pub config_root: PathBuf,
    pub skills_root: PathBuf,
    pub path: PathBuf,
    pub detected: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassifiedSkillTarget {
    pub target: SkillTarget,
    pub state: SkillTargetState,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LegacySkillTarget {
    pub path: String,
    pub state: SkillTargetState,
    pub duplicate_discovery_risk: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallerEnvironment {
    pub home: PathBuf,
    pub claude_config_dir: Option<PathBuf>,
    pub executable: PathBuf,
    pub path: Option<OsString>,
    pub require_stable_bundle: bool,
    pub fail_after_target_mutations: Option<usize>,
}

impl InstallerEnvironment {
    pub fn current() -> Result<Self, CliError> {
        let home = env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| unsupported("HOME is required for global Agent Skill setup"))?;
        if !home.is_absolute() {
            return Err(unsupported("HOME must be an absolute path"));
        }
        let claude_config_dir = env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        if claude_config_dir
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err(unsupported(
                "CLAUDE_CONFIG_DIR must be an absolute path for Agent Skill setup",
            ));
        }
        let executable = env::current_exe().map_err(|error| {
            unsupported(format!(
                "Nodex could not resolve the current executable: {error}"
            ))
        })?;
        Ok(Self {
            home,
            claude_config_dir,
            executable,
            path: env::var_os("PATH"),
            require_stable_bundle: true,
            fail_after_target_mutations: None,
        })
    }

    #[doc(hidden)]
    pub fn for_tests(home: PathBuf, executable: PathBuf) -> Self {
        Self {
            home,
            claude_config_dir: None,
            executable,
            path: None,
            require_stable_bundle: false,
            fail_after_target_mutations: None,
        }
    }
}

pub fn resolve_targets(
    environment: &InstallerEnvironment,
    selected: &[SkillAgent],
) -> Result<Vec<SkillTarget>, CliError> {
    let agents = if selected.is_empty() {
        SkillAgent::ALL.to_vec()
    } else {
        SkillAgent::ALL
            .into_iter()
            .filter(|agent| selected.contains(agent))
            .collect()
    };
    agents
        .into_iter()
        .map(|agent| resolve_target(environment, agent))
        .collect()
}

fn resolve_target(
    environment: &InstallerEnvironment,
    agent: SkillAgent,
) -> Result<SkillTarget, CliError> {
    let config_root = match agent {
        SkillAgent::Codex => environment.home.join(".agents"),
        SkillAgent::ClaudeCode => environment
            .claude_config_dir
            .clone()
            .unwrap_or_else(|| environment.home.join(".claude")),
    };
    if !config_root.is_absolute() {
        return Err(unsupported(format!(
            "{} config root is not absolute",
            agent.executable_name()
        )));
    }
    let skills_root = config_root.join("skills");
    let path = skills_root.join("nodex");
    let detected = command_on_path(environment.path.as_deref(), agent.executable_name())
        || config_root_exists(&config_root)
        || fs::symlink_metadata(&path).is_ok();
    Ok(SkillTarget {
        agent,
        config_root,
        skills_root,
        path,
        detected,
    })
}

fn command_on_path(path: Option<&std::ffi::OsStr>, command: &str) -> bool {
    path.into_iter()
        .flat_map(env::split_paths)
        .any(|directory| fs::symlink_metadata(directory.join(command)).is_ok())
}

fn config_root_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn classify_target(target: SkillTarget, bundle: &VerifiedSkillBundle) -> ClassifiedSkillTarget {
    let metadata = match fs::symlink_metadata(&target.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return ClassifiedSkillTarget {
                target,
                state: SkillTargetState::Missing,
                detail: None,
            };
        }
        Err(error) => {
            return ClassifiedSkillTarget {
                detail: Some(format!(
                    "could not inspect {}: {error}",
                    target.path.display()
                )),
                target,
                state: SkillTargetState::Conflict,
            };
        }
    };

    if metadata.file_type().is_symlink() {
        return match fs::read_link(&target.path) {
            Ok(raw) if raw.is_absolute() && raw.as_path() == bundle.skill_source.as_path() => {
                ClassifiedSkillTarget {
                    target,
                    state: SkillTargetState::ManagedCurrent,
                    detail: None,
                }
            }
            Ok(raw) => ClassifiedSkillTarget {
                detail: Some(format!(
                    "symlink points to {} instead of the current verified bundle",
                    raw.display()
                )),
                target,
                state: SkillTargetState::Conflict,
            },
            Err(error) => ClassifiedSkillTarget {
                detail: Some(format!("could not read symlink: {error}")),
                target,
                state: SkillTargetState::Conflict,
            },
        };
    }

    if metadata.file_type().is_dir() {
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            return ClassifiedSkillTarget {
                detail: Some("directory is not owned by the current user".to_owned()),
                target,
                state: SkillTargetState::Conflict,
            };
        }
        let compatible = digest_skill_tree(&target.path).is_ok_and(|digest| {
            digest.tree_sha256 == bundle.tree_sha256
                && digest.file_count == bundle.file_count
                && digest.total_bytes == bundle.total_bytes
        });
        return ClassifiedSkillTarget {
            detail: (!compatible)
                .then(|| "directory contents differ from the official Skill".to_owned()),
            target,
            state: if compatible {
                SkillTargetState::CompatibleExternal
            } else {
                SkillTargetState::Conflict
            },
        };
    }

    ClassifiedSkillTarget {
        detail: Some("target is neither a managed symlink nor a compatible directory".to_owned()),
        target,
        state: SkillTargetState::Conflict,
    }
}

pub fn inspect_parent(target: &SkillTarget) -> Result<(), CliError> {
    inspect_config_root(&target.config_root)?;
    match fs::symlink_metadata(&target.skills_root) {
        Ok(metadata) => require_owned_real_directory(&target.skills_root, &metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(target_conflict(
            &target.skills_root,
            format!("could not inspect target parent: {error}"),
        )),
    }
}

pub fn ensure_parent(target: &SkillTarget) -> Result<(), CliError> {
    match fs::symlink_metadata(&target.config_root) {
        Ok(_) => {
            inspect_config_root(&target.config_root)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_directory_without_clobber(&target.config_root)?;
            inspect_config_root(&target.config_root)?;
        }
        Err(error) => {
            return Err(target_conflict(
                &target.config_root,
                format!("could not inspect config root: {error}"),
            ));
        }
    }

    match fs::symlink_metadata(&target.skills_root) {
        Ok(metadata) => require_owned_real_directory(&target.skills_root, &metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_directory_without_clobber(&target.skills_root)?;
            let metadata = fs::symlink_metadata(&target.skills_root).map_err(|error| {
                target_raced(
                    &target.skills_root,
                    format!("could not re-inspect created skills directory: {error}"),
                )
            })?;
            require_owned_real_directory(&target.skills_root, &metadata)
        }
        Err(error) => Err(target_conflict(
            &target.skills_root,
            format!("could not inspect target parent: {error}"),
        )),
    }
}

fn inspect_config_root(path: &Path) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let canonical = path.canonicalize().map_err(|error| {
                target_conflict(
                    path,
                    format!("config root symlink cannot be resolved: {error}"),
                )
            })?;
            let canonical_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
                target_conflict(
                    path,
                    format!("config root target cannot be inspected: {error}"),
                )
            })?;
            require_owned_real_directory(&canonical, &canonical_metadata)
        }
        Ok(metadata) => require_owned_real_directory(path, &metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| target_conflict(path, "config root has no parent directory"))?;
            let parent_metadata = fs::symlink_metadata(parent).map_err(|parent_error| {
                target_conflict(
                    path,
                    format!(
                        "config root parent {} is unavailable: {parent_error}",
                        parent.display()
                    ),
                )
            })?;
            require_owned_real_directory(parent, &parent_metadata)
        }
        Err(error) => Err(target_conflict(
            path,
            format!("could not inspect config root: {error}"),
        )),
    }
}

fn require_owned_real_directory(path: &Path, metadata: &fs::Metadata) -> Result<(), CliError> {
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(target_conflict(path, "path is not a real directory"));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(target_conflict(
            path,
            "directory is not owned by the current user",
        ));
    }
    Ok(())
}

fn create_directory_without_clobber(path: &Path) -> Result<(), CliError> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(target_raced(
            path,
            format!("could not create target parent: {error}"),
        )),
    }
}

pub fn legacy_codex_target(
    environment: &InstallerEnvironment,
    codex_state: SkillTargetState,
) -> LegacySkillTarget {
    let path = environment.home.join(".codex/skills/nodex");
    let exists = fs::symlink_metadata(&path).is_ok();
    LegacySkillTarget {
        path: path.display().to_string(),
        state: if exists {
            SkillTargetState::LegacyExternal
        } else {
            SkillTargetState::Missing
        },
        duplicate_discovery_risk: exists && codex_state != SkillTargetState::Missing,
    }
}

fn unsupported(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::SkillAgentUnsupported, message)
}

pub fn target_conflict(path: &Path, message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::SkillTargetConflict, message).at_path(path.display().to_string())
}

pub fn target_raced(path: &Path, message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::SkillTargetRaced, message).at_path(path.display().to_string())
}
