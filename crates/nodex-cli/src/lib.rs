#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::io::IsTerminal;

use clap::Parser;

pub mod agent_interface;
mod browse;
pub mod cli;
mod config;
mod data_source;
pub mod deeplink;
mod draft;
pub mod error;
mod files;
mod input;
pub mod meta_yaml;
mod open;
mod page_batch;
mod page_files;
mod page_lifecycle;
mod page_mutation;
mod page_properties;
pub mod patch;
pub mod presentation;
mod ripgrep;
pub mod runtime;
mod search;
pub mod sed;
mod service;
pub mod skills;
mod view;

use cli::Cli;
use error::{CliError, CliErrorCode};

pub const EXIT_SUCCESS: i32 = 0;
pub const EXIT_NO_MATCHES: i32 = 1;
pub const EXIT_REJECTED: i32 = 2;
pub const EXIT_INTERRUPTED: i32 = 130;

pub fn run(arguments: impl IntoIterator<Item = OsString>) -> i32 {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let stdout_is_tty = std::io::stdout().is_terminal();
    let stdin_is_tty = std::io::stdin().is_terminal();
    let requested = requested_output_before_parse(&arguments);
    let help_requested = arguments
        .iter()
        .take_while(|value| *value != "--")
        .any(|argument| argument == "--help" || argument == "-h");
    if requested == presentation::OutputFormat::Json && help_requested {
        return print_machine_help(&arguments);
    }
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => {
            let exit_status = error.exit_code();
            if exit_status == EXIT_SUCCESS {
                let _ = error.print();
                return exit_status;
            }
            let format = presentation::resolve(
                requested,
                presentation::OutputKind::Structured,
                stdin_is_tty,
                stdout_is_tty,
            );
            render_error(
                &CliError::new(CliErrorCode::InvalidInput, error.to_string()),
                format.json_diagnostics,
            );
            return EXIT_REJECTED;
        }
    };
    let format = presentation::resolve(
        cli.requested_output(),
        presentation::output_kind(&cli.command),
        stdin_is_tty,
        stdout_is_tty,
    );
    match runtime::execute_with_presentation(cli, format) {
        Ok(output) => {
            let exit_status = output.exit_status();
            match output.write(format.json_result) {
                Ok(()) => exit_status,
                Err(error) => {
                    render_error(&error, format.json_diagnostics);
                    EXIT_REJECTED
                }
            }
        }
        Err(error) => {
            render_error(&error, format.json_diagnostics);
            EXIT_REJECTED
        }
    }
}

// Parse errors must honor output selection even when Clap cannot construct Cli.
fn requested_output_before_parse(arguments: &[OsString]) -> presentation::OutputFormat {
    use presentation::OutputFormat;
    let mut values = arguments.iter().skip(1).take_while(|value| *value != "--");
    let mut format = OutputFormat::Auto;
    while let Some(argument) = values.next() {
        if argument == "--json" {
            return OutputFormat::Json;
        }
        let value = if argument == "--output-format" {
            values.next().and_then(|value| value.to_str())
        } else {
            argument
                .to_str()
                .and_then(|value| value.strip_prefix("--output-format="))
        };
        format = match value {
            Some("json") => OutputFormat::Json,
            Some("text") => OutputFormat::Text,
            Some("auto") => OutputFormat::Auto,
            _ => format,
        };
    }
    format
}

fn print_machine_help(arguments: &[OsString]) -> i32 {
    let document = match agent_interface::machine_help(arguments) {
        Ok(document) => document,
        Err(error) => {
            render_error(&error, true);
            return EXIT_REJECTED;
        }
    };
    match serde_json::to_string_pretty(&document) {
        Ok(json) => {
            println!("{json}");
            EXIT_SUCCESS
        }
        Err(error) => {
            render_error(
                &CliError::new(
                    CliErrorCode::Internal,
                    format!("machine-readable help could not be encoded: {error}"),
                ),
                true,
            );
            EXIT_REJECTED
        }
    }
}

pub fn render_error(error: &CliError, json: bool) {
    if json {
        let envelope = error::ErrorEnvelope::new(error);
        match serde_json::to_string(&envelope) {
            Ok(encoded) => eprintln!("{encoded}"),
            Err(_) => eprintln!("CLI_INTERNAL: failed to encode error"),
        }
        return;
    }

    eprintln!("{}: {}", error.code.as_str(), error.message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_exit_statuses_match_the_shell_contract() {
        assert_eq!(EXIT_SUCCESS, 0);
        assert_eq!(EXIT_NO_MATCHES, 1);
        assert_eq!(EXIT_REJECTED, 2);
        assert_eq!(EXIT_INTERRUPTED, 130);
    }

    #[test]
    fn clap_help_and_version_are_successful_control_flow() {
        assert_eq!(run(["nodex", "--help"].map(OsString::from)), EXIT_SUCCESS);
        assert_eq!(
            run(["nodex", "--version"].map(OsString::from)),
            EXIT_SUCCESS
        );
        assert_eq!(
            run(["nodex", "not-a-command"].map(OsString::from)),
            EXIT_REJECTED
        );
    }
}
