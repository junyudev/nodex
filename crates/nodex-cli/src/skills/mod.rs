pub mod bundle;
pub(crate) mod install;
mod prompt;
mod target;

use serde_json::to_value;

use crate::cli::{SkillMutationArgs, SkillsArgs, SkillsCommand};
use crate::error::{CliError, CliErrorCode};
use crate::runtime::CommandOutput;

pub use target::{InstallerEnvironment, SkillAgent};

pub fn execute_setup(
    arguments: SkillMutationArgs,
    non_interactive: bool,
) -> Result<CommandOutput, CliError> {
    let environment = InstallerEnvironment::current()?;
    execute_setup_with_environment(arguments, non_interactive, &environment)
}

#[doc(hidden)]
pub fn execute_setup_with_environment(
    mut arguments: SkillMutationArgs,
    non_interactive: bool,
    environment: &InstallerEnvironment,
) -> Result<CommandOutput, CliError> {
    let selected_interactively = arguments.targets.agents.is_empty()
        && !arguments.yes
        && !arguments.dry_run
        && !non_interactive;
    if selected_interactively {
        arguments.targets.agents = prompt::select_agents()?;
        if arguments.targets.agents.is_empty() {
            return Ok(CommandOutput::Text(
                "Agent Skill setup cancelled; no files were changed.".to_owned(),
            ));
        }
    }
    require_selected_agents(&arguments)?;
    require_confirmation(&arguments, non_interactive, selected_interactively, false)?;
    let bundle = verified_bundle(environment)?;
    let result = install::install(
        &bundle,
        environment,
        &arguments.targets.agents,
        arguments.dry_run,
    )?;
    to_value(result).map(CommandOutput::Json).map_err(internal)
}

pub fn execute_skills(
    arguments: SkillsArgs,
    non_interactive: bool,
) -> Result<CommandOutput, CliError> {
    let environment = InstallerEnvironment::current()?;
    execute_skills_with_environment(arguments, non_interactive, &environment)
}

#[doc(hidden)]
pub fn execute_skills_with_environment(
    arguments: SkillsArgs,
    non_interactive: bool,
    environment: &InstallerEnvironment,
) -> Result<CommandOutput, CliError> {
    let bundle = verified_bundle(environment)?;
    let result = match arguments.command {
        SkillsCommand::Status(arguments) => install::inspect(
            install::SkillOperation::Status,
            &bundle,
            environment,
            &arguments.agents,
        )?,
        SkillsCommand::Doctor(arguments) => install::inspect(
            install::SkillOperation::Doctor,
            &bundle,
            environment,
            &arguments.agents,
        )?,
        SkillsCommand::Install(arguments) => {
            require_selected_agents(&arguments)?;
            require_confirmation(&arguments, non_interactive, false, false)?;
            install::install(
                &bundle,
                environment,
                &arguments.targets.agents,
                arguments.dry_run,
            )?
        }
        SkillsCommand::Remove(arguments) => {
            require_selected_agents(&arguments)?;
            require_confirmation(&arguments, non_interactive, false, true)?;
            install::remove(
                &bundle,
                environment,
                &arguments.targets.agents,
                arguments.dry_run,
            )?
        }
    };
    to_value(result).map(CommandOutput::Json).map_err(internal)
}

fn verified_bundle(
    environment: &InstallerEnvironment,
) -> Result<bundle::VerifiedSkillBundle, CliError> {
    let bundle = if environment.require_stable_bundle {
        bundle::verify_stable_for_executable(&environment.executable, &environment.home)?
    } else {
        bundle::verify_for_executable(&environment.executable)?.ok_or_else(|| {
            bundle::unavailable("test executable does not have an adjacent Agent Skill bundle")
        })?
    };
    Ok(bundle)
}

fn require_selected_agents(arguments: &SkillMutationArgs) -> Result<(), CliError> {
    if !arguments.targets.agents.is_empty() {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        "select at least one --agent codex or --agent claude-code",
    ))
}

fn require_confirmation(
    arguments: &SkillMutationArgs,
    non_interactive: bool,
    selected_interactively: bool,
    removing: bool,
) -> Result<(), CliError> {
    if arguments.dry_run || arguments.yes || selected_interactively {
        return Ok(());
    }
    if non_interactive {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Non-interactive Skill mutations require --yes; use --dry-run for read-only planning",
        ));
    }
    let confirmed = if removing {
        prompt::confirm_remove(&arguments.targets.agents)?
    } else {
        prompt::confirm_install(&arguments.targets.agents)?
    };
    if confirmed {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        "Agent Skill mutation was not confirmed; no files were changed",
    ))
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}
