use clap::ValueEnum;

use crate::cli::{Command, DraftArgs, DraftCommand, FileCommand, PageCommand, PageFileCommand};

/// Presentation is resolved once, independently of mutation identity and authorization.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum OutputFormat {
    #[default]
    Auto,
    Json,
    Text,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputKind {
    Structured,
    Content,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Presentation {
    pub json_result: bool,
    pub json_diagnostics: bool,
    pub interactive: bool,
}

pub fn resolve(
    format: OutputFormat,
    kind: OutputKind,
    stdin_is_tty: bool,
    stdout_is_tty: bool,
) -> Presentation {
    let json_diagnostics = match format {
        OutputFormat::Auto => !stdout_is_tty,
        OutputFormat::Json => true,
        OutputFormat::Text => false,
    };
    Presentation {
        json_result: format == OutputFormat::Json
            || (format == OutputFormat::Auto && kind == OutputKind::Structured && !stdout_is_tty),
        json_diagnostics,
        interactive: stdin_is_tty && stdout_is_tty && format != OutputFormat::Json,
    }
}

pub fn output_kind(command: &Command) -> OutputKind {
    match command {
        Command::Read(_) | Command::Sed(_) | Command::Rg(_) | Command::Docs(_) => {
            OutputKind::Content
        }
        Command::Draft(DraftArgs {
            command: DraftCommand::Diff { .. },
        }) => OutputKind::Content,
        Command::File(arguments) => match &arguments.command {
            FileCommand::Read(arguments) if arguments.output.as_os_str() == "-" => {
                OutputKind::Content
            }
            _ => OutputKind::Structured,
        },
        Command::Page(arguments) => match &arguments.command {
            PageCommand::File(arguments) => match &arguments.command {
                PageFileCommand::Read(arguments) if arguments.output.as_os_str() == "-" => {
                    OutputKind::Content
                }
                _ => OutputKind::Structured,
            },
            _ => OutputKind::Structured,
        },
        _ => OutputKind::Structured,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipes_select_json_only_for_structured_results() {
        assert!(resolve(OutputFormat::Auto, OutputKind::Structured, true, false).json_result);
        let raw = resolve(OutputFormat::Auto, OutputKind::Content, true, false);
        assert!(!raw.json_result);
        assert!(raw.json_diagnostics);
        assert!(!raw.interactive);
    }

    #[test]
    fn stdin_does_not_select_output_but_always_limits_interaction() {
        let result = resolve(OutputFormat::Auto, OutputKind::Structured, false, true);
        assert!(!result.json_result);
        assert!(!result.interactive);
        assert!(resolve(OutputFormat::Auto, OutputKind::Structured, true, true).interactive);
    }

    #[test]
    fn explicit_formats_do_not_reenable_noninteractive_prompts() {
        for format in [OutputFormat::Json, OutputFormat::Text] {
            assert!(!resolve(format, OutputKind::Structured, false, false).interactive);
            assert_eq!(
                resolve(format, OutputKind::Content, true, true).json_result,
                format == OutputFormat::Json
            );
        }
    }
}
