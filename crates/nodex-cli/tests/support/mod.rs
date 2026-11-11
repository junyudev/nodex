use std::process::Command;

pub fn cli_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nodex"));
    nodex_platform::process::clear_agent_shell_environment(&mut command);
    command
}
