use std::any::TypeId;
use std::path::PathBuf;

use clap::{CommandFactory, builder::ArgAction};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArgumentHelp {
    pub id: String,
    pub long: Option<String>,
    pub short: Option<char>,
    pub position: Option<usize>,
    pub description: Option<String>,
    pub value_type: &'static str,
    pub required: bool,
    pub global: bool,
    pub minimum_values: usize,
    pub maximum_values: Option<usize>,
    pub defaults: Vec<String>,
    pub possible_values: Vec<String>,
    pub conflicts_with: Vec<String>,
    pub input_sources: Vec<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArgumentGroupHelp {
    pub id: String,
    pub arguments: Vec<String>,
    pub required: bool,
    pub multiple: bool,
}

pub(super) fn describe(path: &[&str]) -> (Vec<ArgumentHelp>, Vec<ArgumentGroupHelp>, String) {
    let mut root = crate::cli::Cli::command();
    root.build();
    let command = path.iter().fold(&root, |command, segment| {
        command
            .find_subcommand(segment)
            .expect("registered Clap command")
    });
    let arguments = command
        .get_arguments()
        .filter(|arg| !arg.is_hide_set())
        .map(|arg| {
            let count = arg.get_num_args().unwrap_or_default();
            let parser_type = arg.get_value_parser().type_id();
            let value_type = if matches!(arg.get_action(), ArgAction::SetTrue | ArgAction::SetFalse)
            {
                "boolean"
            } else if [
                TypeId::of::<u32>(),
                TypeId::of::<u64>(),
                TypeId::of::<usize>(),
                TypeId::of::<i64>(),
            ]
            .iter()
            .any(|kind| parser_type == *kind)
            {
                "integer"
            } else if parser_type == TypeId::of::<f64>() {
                "number"
            } else {
                "string"
            };
            let input_sources = if parser_type == TypeId::of::<PathBuf>() {
                match arg.get_id().as_str() {
                    "file" | "input" | "block_json" | "patch_json" | "from" | "source" => {
                        vec!["file", "stdin (-)"]
                    }
                    _ => vec!["path"],
                }
            } else {
                vec!["argument"]
            };
            ArgumentHelp {
                id: arg.get_id().to_string(),
                long: arg.get_long().map(str::to_owned),
                short: arg.get_short(),
                position: arg.get_index(),
                description: arg.get_help().map(ToString::to_string),
                value_type,
                required: arg.is_required_set(),
                global: arg.is_global_set(),
                minimum_values: count.min_values(),
                maximum_values: (count.max_values() != usize::MAX).then_some(count.max_values()),
                defaults: arg
                    .get_default_values()
                    .iter()
                    .map(|v| v.to_string_lossy().into_owned())
                    .collect(),
                possible_values: arg
                    .get_possible_values()
                    .iter()
                    .map(|v| v.get_name().to_owned())
                    .collect(),
                conflicts_with: command
                    .get_arg_conflicts_with(arg)
                    .iter()
                    .map(|a| a.get_id().to_string())
                    .collect(),
                input_sources,
            }
        })
        .collect();
    let groups = command
        .get_groups()
        .map(|group| {
            let mut group = group.clone();
            ArgumentGroupHelp {
                id: group.get_id().to_string(),
                arguments: group.get_args().map(ToString::to_string).collect(),
                required: group.is_required_set(),
                multiple: group.is_multiple(),
            }
        })
        .collect();
    (
        arguments,
        groups,
        command.clone().render_usage().to_string(),
    )
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentInputHelp {
    pub argument: &'static str,
    pub syntax: &'static str,
    pub stdin_when: &'static str,
    pub maximum_bytes: usize,
}

pub(super) fn content_input(path: &[&str]) -> Option<ContentInputHelp> {
    let (argument, syntax, stdin_when, maximum_bytes) = match path {
        ["patch"] => (
            "--file",
            "Nodex exact patch",
            "--file omitted or -",
            crate::patch::MAX_PATCH_BYTES,
        ),
        ["page", "create"] => (
            "--file",
            "Nested Markdown",
            "--file omitted without --empty, or --file -",
            crate::page_mutation::MAX_BODY_INPUT_BYTES,
        ),
        ["page", "insert" | "replace"] => (
            "--file",
            "Nested Markdown",
            "--file omitted or -",
            crate::page_mutation::MAX_BODY_INPUT_BYTES,
        ),
        ["page", "rename"] => (
            "--file",
            "single-line title Markdown",
            "--file -; mutually exclusive with positional title",
            crate::page_mutation::MAX_TITLE_INPUT_BYTES,
        ),
        ["block", "insert"] => (
            "--block-json",
            "JSON",
            "--block-json -",
            crate::page_mutation::MAX_BLOCK_JSON_BYTES,
        ),
        ["block", "update"] => (
            "--patch-json",
            "JSON",
            "--patch-json -",
            crate::page_mutation::MAX_BLOCK_JSON_BYTES,
        ),
        ["data-source", "query"] | ["page", "create-batch"] | ["page", "properties", "apply"] => (
            "--input",
            "JSON",
            "--input omitted or -",
            crate::input::MAX_JSON_BYTES,
        ),
        ["file", "import" | "replace"] | ["page", "file", "put" | "replace-entry"] => {
            ("--from", "bytes", "--from -", crate::files::MAX_FILE_BYTES)
        }
        _ => return None,
    };
    Some(ContentInputHelp {
        argument,
        syntax,
        stdin_when,
        maximum_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn help_exposes_the_same_required_alternatives_that_clap_enforces() {
        for (path, group_id, prefix, alternatives) in [
            (
                &["page", "rename"][..],
                "title_input",
                vec!["nodex", "page", "rename", "@page", "--if-match", "etag"],
                vec![vec!["Title"], vec!["--file", "-"]],
            ),
            (
                &["page", "file", "read"][..],
                "file_selector",
                vec!["nodex", "page", "file", "read", "@page"],
                vec![vec!["--file-id", "@file"], vec!["--path", "document.pdf"]],
            ),
        ] {
            let (_, groups, _) = describe(path);
            let group = groups
                .iter()
                .find(|group| group.id == group_id)
                .expect("public required group");
            assert!(group.required);
            assert!(!group.multiple);
            assert_eq!(group.arguments.len(), 2);
            assert!(crate::cli::Cli::try_parse_from(&prefix).is_err());
            for alternative in &alternatives {
                assert!(
                    crate::cli::Cli::try_parse_from(prefix.iter().chain(alternative.iter()))
                        .is_ok()
                );
            }
            assert!(
                crate::cli::Cli::try_parse_from(prefix.iter().chain(alternatives.iter().flatten()))
                    .is_err()
            );
        }
    }

    #[test]
    fn machine_defaults_and_stdin_paths_match_parsed_calls() {
        let (arguments, _, _) = describe(&["page", "insert"]);
        let anchor = arguments
            .iter()
            .find(|arg| arg.id == "at")
            .expect("anchor option");
        assert_eq!(anchor.defaults, ["end"]);
        let parsed = crate::cli::Cli::try_parse_from(["nodex", "page", "insert", "@page"])
            .expect("default append");
        let crate::cli::Command::Page(crate::cli::PageArgs {
            command: crate::cli::PageCommand::Insert(insert),
        }) = parsed.command
        else {
            panic!("Page insert")
        };
        assert_eq!(insert.at, anchor.defaults[0]);
        let (arguments, _, _) = describe(&["block", "update"]);
        let input = arguments
            .iter()
            .find(|arg| arg.id == "patch_json")
            .expect("JSON input");
        assert_eq!(input.input_sources, ["file", "stdin (-)"]);
        assert!(
            crate::cli::Cli::try_parse_from([
                "nodex",
                "block",
                "update",
                "@page",
                "--block",
                "@block",
                "--if-match",
                "etag",
                "--patch-json",
                "-"
            ])
            .is_ok()
        );
    }
}
