use std::fs;
use std::io;
use std::os::unix::fs::symlink;

use serde::Serialize;

use super::bundle::VerifiedSkillBundle;
use super::target::{
    ClassifiedSkillTarget, InstallerEnvironment, LegacySkillTarget, SkillAgent, SkillTargetState,
    classify_target, ensure_parent, inspect_parent, legacy_codex_target, resolve_targets,
    target_conflict, target_raced,
};
use crate::error::{CliError, CliErrorCode};

const SKILL_RESULT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SkillOperation {
    Status,
    Install,
    Remove,
    Doctor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SkillTargetOutcome {
    Installed,
    AlreadyInstalled,
    AvailableExternal,
    Removed,
    AlreadyRemoved,
    WouldInstall,
    WouldRemove,
    Inspected,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundleResult {
    pub release_version: String,
    pub tree_sha256: String,
    pub source: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetResult {
    pub agent: SkillAgent,
    pub path: String,
    pub detected: bool,
    pub state: SkillTargetState,
    pub outcome: SkillTargetOutcome,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillOperationResult {
    pub schema_version: u32,
    pub operation: SkillOperation,
    pub dry_run: bool,
    pub changed: bool,
    pub bundle: SkillBundleResult,
    pub targets: Vec<SkillTargetResult>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub legacy_targets: Vec<LegacySkillTarget>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub fn inspect(
    operation: SkillOperation,
    bundle: &VerifiedSkillBundle,
    environment: &InstallerEnvironment,
    selected: &[SkillAgent],
) -> Result<SkillOperationResult, CliError> {
    let classified = classify_selected(bundle, environment, selected)?;
    let codex_state = classified
        .iter()
        .find(|target| target.target.agent == SkillAgent::Codex)
        .map_or(SkillTargetState::Missing, |target| target.state);
    let legacy = legacy_codex_target(environment, codex_state);
    let warnings = if operation == SkillOperation::Doctor && legacy.duplicate_discovery_risk {
        vec![format!(
            "{} may cause duplicate Codex Skill discovery; Nodex will not modify this legacy target",
            legacy.path
        )]
    } else {
        Vec::new()
    };
    let targets = classified
        .into_iter()
        .map(|classified| SkillTargetResult {
            agent: classified.target.agent,
            path: classified.target.path.display().to_string(),
            detected: classified.target.detected,
            state: classified.state,
            outcome: SkillTargetOutcome::Inspected,
            changed: false,
            detail: classified.detail,
        })
        .collect();
    Ok(result(
        operation,
        false,
        false,
        bundle,
        targets,
        (operation == SkillOperation::Doctor && legacy.state != SkillTargetState::Missing)
            .then_some(legacy)
            .into_iter()
            .collect(),
        warnings,
    ))
}

pub fn install(
    bundle: &VerifiedSkillBundle,
    environment: &InstallerEnvironment,
    selected: &[SkillAgent],
    dry_run: bool,
) -> Result<SkillOperationResult, CliError> {
    let classified = classify_selected(bundle, environment, selected)?;
    preflight(&classified, SkillOperation::Install)?;

    let mut results = Vec::with_capacity(classified.len());
    let mut mutations = 0_usize;
    for target in classified {
        let result = match target.state {
            SkillTargetState::ManagedCurrent => target_result(
                target,
                SkillTargetState::ManagedCurrent,
                SkillTargetOutcome::AlreadyInstalled,
                false,
            ),
            SkillTargetState::CompatibleExternal => target_result(
                target,
                SkillTargetState::CompatibleExternal,
                SkillTargetOutcome::AvailableExternal,
                false,
            ),
            SkillTargetState::Missing if dry_run => target_result(
                target,
                SkillTargetState::Missing,
                SkillTargetOutcome::WouldInstall,
                false,
            ),
            SkillTargetState::Missing => {
                ensure_parent(&target.target)?;
                match symlink(&bundle.skill_source, &target.target.path) {
                    Ok(()) => {
                        mutations += 1;
                        maybe_inject_failure(environment, mutations)?;
                        target_result(
                            target,
                            SkillTargetState::ManagedCurrent,
                            SkillTargetOutcome::Installed,
                            true,
                        )
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        let raced = classify_target(target.target.clone(), bundle);
                        if raced.state != SkillTargetState::ManagedCurrent {
                            return Err(target_raced(
                                &raced.target.path,
                                "target appeared after preflight and is not the current managed symlink",
                            ));
                        }
                        target_result(
                            raced,
                            SkillTargetState::ManagedCurrent,
                            SkillTargetOutcome::AlreadyInstalled,
                            false,
                        )
                    }
                    Err(error) => {
                        return Err(target_raced(
                            &target.target.path,
                            format!("could not create managed Skill symlink: {error}"),
                        ));
                    }
                }
            }
            SkillTargetState::LegacyExternal | SkillTargetState::Conflict => {
                unreachable!("install conflicts are rejected during preflight")
            }
        };
        results.push(result);
    }
    let changed = results.iter().any(|target| target.changed);
    Ok(result(
        SkillOperation::Install,
        dry_run,
        changed,
        bundle,
        results,
        Vec::new(),
        Vec::new(),
    ))
}

pub fn remove(
    bundle: &VerifiedSkillBundle,
    environment: &InstallerEnvironment,
    selected: &[SkillAgent],
    dry_run: bool,
) -> Result<SkillOperationResult, CliError> {
    let classified = classify_selected(bundle, environment, selected)?;
    preflight(&classified, SkillOperation::Remove)?;

    let mut results = Vec::with_capacity(classified.len());
    let mut mutations = 0_usize;
    for target in classified {
        let result = match target.state {
            SkillTargetState::Missing => target_result(
                target,
                SkillTargetState::Missing,
                SkillTargetOutcome::AlreadyRemoved,
                false,
            ),
            SkillTargetState::ManagedCurrent if dry_run => target_result(
                target,
                SkillTargetState::ManagedCurrent,
                SkillTargetOutcome::WouldRemove,
                false,
            ),
            SkillTargetState::ManagedCurrent => {
                let current = classify_target(target.target.clone(), bundle);
                if current.state != SkillTargetState::ManagedCurrent {
                    return Err(target_raced(
                        &current.target.path,
                        "target changed after remove preflight",
                    ));
                }
                match fs::remove_file(&current.target.path) {
                    Ok(()) => {
                        mutations += 1;
                        maybe_inject_failure(environment, mutations)?;
                        target_result(
                            current,
                            SkillTargetState::Missing,
                            SkillTargetOutcome::Removed,
                            true,
                        )
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => target_result(
                        current,
                        SkillTargetState::Missing,
                        SkillTargetOutcome::AlreadyRemoved,
                        false,
                    ),
                    Err(error) => {
                        return Err(target_raced(
                            &current.target.path,
                            format!("could not remove managed Skill symlink: {error}"),
                        ));
                    }
                }
            }
            SkillTargetState::CompatibleExternal
            | SkillTargetState::LegacyExternal
            | SkillTargetState::Conflict => {
                unreachable!("remove conflicts are rejected during preflight")
            }
        };
        results.push(result);
    }
    let changed = results.iter().any(|target| target.changed);
    Ok(result(
        SkillOperation::Remove,
        dry_run,
        changed,
        bundle,
        results,
        Vec::new(),
        Vec::new(),
    ))
}

fn classify_selected(
    bundle: &VerifiedSkillBundle,
    environment: &InstallerEnvironment,
    selected: &[SkillAgent],
) -> Result<Vec<ClassifiedSkillTarget>, CliError> {
    let targets = resolve_targets(environment, selected)?;
    let classified = targets
        .into_iter()
        .map(|target| classify_target(target, bundle))
        .collect::<Vec<_>>();
    for target in &classified {
        inspect_parent(&target.target)?;
    }
    Ok(classified)
}

fn preflight(targets: &[ClassifiedSkillTarget], operation: SkillOperation) -> Result<(), CliError> {
    for target in targets {
        let allowed = match operation {
            SkillOperation::Install => matches!(
                target.state,
                SkillTargetState::Missing
                    | SkillTargetState::ManagedCurrent
                    | SkillTargetState::CompatibleExternal
            ),
            SkillOperation::Remove => matches!(
                target.state,
                SkillTargetState::Missing | SkillTargetState::ManagedCurrent
            ),
            SkillOperation::Status | SkillOperation::Doctor => true,
        };
        if !allowed {
            return Err(target_conflict(
                &target.target.path,
                target.detail.clone().unwrap_or_else(|| {
                    format!(
                        "{} target is {:?} and cannot be {}",
                        target.target.path.display(),
                        target.state,
                        match operation {
                            SkillOperation::Install => "installed",
                            SkillOperation::Remove => "removed",
                            SkillOperation::Status | SkillOperation::Doctor => "mutated",
                        }
                    )
                }),
            ));
        }
    }
    Ok(())
}

fn target_result(
    classified: ClassifiedSkillTarget,
    state: SkillTargetState,
    outcome: SkillTargetOutcome,
    changed: bool,
) -> SkillTargetResult {
    SkillTargetResult {
        agent: classified.target.agent,
        path: classified.target.path.display().to_string(),
        detected: classified.target.detected,
        state,
        outcome,
        changed,
        detail: classified.detail,
    }
}

fn result(
    operation: SkillOperation,
    dry_run: bool,
    changed: bool,
    bundle: &VerifiedSkillBundle,
    targets: Vec<SkillTargetResult>,
    legacy_targets: Vec<LegacySkillTarget>,
    warnings: Vec<String>,
) -> SkillOperationResult {
    SkillOperationResult {
        schema_version: SKILL_RESULT_SCHEMA_VERSION,
        operation,
        dry_run,
        changed,
        bundle: SkillBundleResult {
            release_version: bundle.release_version.clone(),
            tree_sha256: bundle.tree_sha256.clone(),
            source: bundle.skill_source.display().to_string(),
        },
        targets,
        legacy_targets,
        warnings,
    }
}

fn maybe_inject_failure(
    environment: &InstallerEnvironment,
    mutations: usize,
) -> Result<(), CliError> {
    if environment
        .fail_after_target_mutations
        .is_some_and(|limit| mutations >= limit)
    {
        return Err(CliError::new(
            CliErrorCode::Internal,
            "injected Skill installer I/O failure",
        ));
    }
    Ok(())
}
