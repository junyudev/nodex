#![forbid(unsafe_code)]

use std::{env, fs::File, path::PathBuf};

use nodex_core_protocol::{CoreSelectionPolicy, LauncherKind};

fn parse_arguments() -> Result<(PathBuf, CoreSelectionPolicy, LauncherKind), String> {
    let args = env::args().collect::<Vec<_>>();
    match args.as_slice() {
        [_, home_flag, home] if home_flag == "--home" => Ok((
            PathBuf::from(home),
            CoreSelectionPolicy::Compatible,
            LauncherKind::NativeCli,
        )),
        [_, home_flag, home, policy_flag, policy, launcher_flag, launcher]
            if home_flag == "--home"
                && policy_flag == "--selection-policy"
                && launcher_flag == "--launcher" =>
        {
            let policy = match policy.as_str() {
                "compatible" => CoreSelectionPolicy::Compatible,
                "prefer-current-artifact" => CoreSelectionPolicy::PreferCurrentArtifact,
                _ => return Err("invalid Core selection policy".to_owned()),
            };
            let launcher = match launcher.as_str() {
                "electron-host" => LauncherKind::ElectronHost,
                "native-cli" => LauncherKind::NativeCli,
                "test" => LauncherKind::Test,
                _ => return Err("invalid Core launcher kind".to_owned()),
            };
            Ok((PathBuf::from(home), policy, launcher))
        }
        _ => Err(
            "usage: nodex-core --home <absolute-home> [--selection-policy <compatible|prefer-current-artifact> --launcher <electron-host|native-cli|test>]"
                .to_owned(),
        ),
    }
}

// Every launcher gets the same lifetime guarantee before any runtime threads start.
// Desktop may already have detached us; a native CLI normally has not.
fn isolate_process() -> Result<(), Box<dyn std::error::Error>> {
    if rustix::process::getsid(None)? != rustix::process::getpid() {
        rustix::process::setsid()?;
    }
    rustix::stdio::dup2_stdin(File::open("/dev/null")?)?;
    Ok(())
}

#[tokio::main]
async fn run(
    home: PathBuf,
    policy: CoreSelectionPolicy,
    launcher: LauncherKind,
) -> Result<(), Box<dyn std::error::Error>> {
    nodex_core_server::run_with_selection(home, policy, launcher).await
}

fn main() {
    let (home, policy, launcher) = match parse_arguments() {
        Ok(arguments) => arguments,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    if let Err(error) = isolate_process().and_then(|()| run(home, policy, launcher)) {
        eprintln!("nodex-core startup failed: {error}");
        std::process::exit(1);
    }
}
