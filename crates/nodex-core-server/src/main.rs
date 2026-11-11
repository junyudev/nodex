#![forbid(unsafe_code)]

use std::{env, path::PathBuf};

use nodex_core_protocol::{CoreSelectionPolicy, LauncherKind};

/// Installer maintenance connects only to an existing, authenticated generation.
/// It must never launch a Core or stop another installation's selected authority.
fn shutdown_existing(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let [shutdown, home_flag, home, pid_flag, pid] = arguments else {
        return Err(
            "usage: nodex-core --shutdown --home <absolute-home> --expected-pid <pid>".into(),
        );
    };
    if shutdown != "--shutdown" || home_flag != "--home" || pid_flag != "--expected-pid" {
        return Err("invalid Core shutdown arguments".into());
    }
    let home = PathBuf::from(home);
    let pid = pid.parse::<u32>()?;
    if !home.is_absolute() || pid == 0 {
        return Err("Core shutdown requires an absolute home and nonzero PID".into());
    }
    let client = nodex_core_protocol::client::CoreClient::connect(&home, "installer-maintenance")?;
    if client.descriptor.pid != pid {
        return Err("Core generation no longer belongs to the expected process".into());
    }
    client.shutdown()?;
    Ok(())
}

fn parse_arguments() -> Result<(PathBuf, CoreSelectionPolicy, LauncherKind), String> {
    let (args, _) = transport_arguments()?;
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

fn transport_arguments() -> Result<
    (
        Vec<String>,
        Option<nodex_core_contracts::team::ListenRequest>,
    ),
    String,
> {
    let mut args = env::args();
    let mut local = vec![args.next().ok_or("Missing executable")?];
    let (mut address, mut cert, mut key) = (None, None, None);
    while let Some(arg) = args.next() {
        if matches!(arg.as_str(), "--listen" | "--cert" | "--key") {
            let value = args.next().ok_or("Missing remote listener argument")?;
            let target = match arg.as_str() {
                "--listen" => &mut address,
                "--cert" => &mut cert,
                _ => &mut key,
            };
            if target.replace(value).is_some() {
                return Err("Duplicate listener argument".into());
            }
            continue;
        }
        local.push(arg);
    }
    if address.is_none() && (cert.is_some() || key.is_some()) {
        return Err("Certificate options require --listen".into());
    }
    let listen = address.map(|address| nodex_core_contracts::team::ListenRequest {
        peer_policy: nodex_core_contracts::team::ListenerPeerPolicy::Operator,
        address,
        cert,
        key,
    });
    Ok((local, listen))
}

// Every launcher gets the same lifetime guarantee before any runtime threads start.
// Desktop may already have detached us; a native CLI normally has not.
fn isolate_process() -> Result<(), Box<dyn std::error::Error>> {
    nodex_platform::process::isolate_process()?;
    Ok(())
}

#[tokio::main]
async fn run(
    home: PathBuf,
    policy: CoreSelectionPolicy,
    launcher: LauncherKind,
) -> Result<(), Box<dyn std::error::Error>> {
    let (_, listen) = transport_arguments()?;
    nodex_core_server::run_with_options(home, policy, launcher, listen).await
}

fn main() {
    if env::args().nth(1).as_deref() == Some("--shutdown") {
        if let Err(error) = shutdown_existing(&env::args().skip(1).collect::<Vec<_>>()) {
            eprintln!("nodex-core shutdown failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(windows)]
    if env::args().nth(1).as_deref() == Some("--desktop-tools-repl") {
        let mut args = env::args().skip(2);
        let Some((executable, environment)) = args.next().zip(args.next()) else {
            std::process::exit(2);
        };
        let result = serde_json::from_str(&environment)
            .map_err(std::io::Error::other)
            .and_then(|environment| {
                nodex_platform::desktop_tools::run_repl_job(
                    &executable,
                    &args.collect::<Vec<_>>(),
                    environment,
                )
            });
        match result {
            Ok(code) => std::process::exit(code as i32),
            Err(error) => {
                eprintln!("Desktop Tools REPL launch failed: {error}");
                std::process::exit(1);
            }
        }
    }
    #[cfg(windows)]
    if env::args().nth(1).as_deref() == Some("--desktop-tools-native") {
        if env::args().count() != 2 {
            std::process::exit(2);
        }
        if let Err(error) = nodex_platform::desktop_tools::run_stdio() {
            eprintln!("Desktop Tools platform command failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if env::args().nth(1).as_deref() == Some("--private-filesystem") {
        if env::args().count() != 2 {
            eprintln!("usage: nodex-core --private-filesystem < bounded-request.json");
            std::process::exit(2);
        }
        if let Err(error) = nodex_core_server::private_filesystem::run(std::io::stdin().lock()) {
            eprintln!("nodex-core private filesystem failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    let (home, policy, launcher) = match parse_arguments() {
        Ok(arguments) => arguments,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    match nodex_platform::process::bootstrap_detached() {
        Ok(Some(code)) => std::process::exit(code),
        Ok(None) => {}
        Err(error) => {
            eprintln!("nodex-core isolation failed: {error}");
            std::process::exit(1);
        }
    }
    if let Err(error) = isolate_process().and_then(|()| run(home, policy, launcher)) {
        eprintln!("nodex-core startup failed: {error}");
        std::process::exit(1);
    }
}
