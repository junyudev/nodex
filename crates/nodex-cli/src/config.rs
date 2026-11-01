use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{CliError, CliErrorCode};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Default, Deserialize)]
struct RootConfig {
    #[serde(default)]
    server: ServerConfig,
}

#[derive(Default, Deserialize)]
struct ServerConfig {
    home: Option<String>,
}

pub(crate) fn resolve_home(
    cwd: &Path,
    environment_home: Option<&OsStr>,
    user_home: Option<&OsStr>,
) -> Result<PathBuf, CliError> {
    if let Some(environment_home) = nonblank_os(environment_home) {
        return Ok(resolve_path(cwd, Path::new(environment_home)));
    }
    let user_home = nonblank_os(user_home).map(PathBuf::from).ok_or_else(|| {
        CliError::new(
            CliErrorCode::CoreUnavailable,
            "The OS user home is unavailable and NODEX_HOME is not set",
        )
    })?;
    let user_config = user_home.join(".nodex/config.toml");
    let project_config = find_project_config(cwd);
    let mut config_paths = vec![user_config.clone()];
    if let Some(project_config) = project_config.filter(|path| path != &user_config) {
        config_paths.push(project_config);
    }
    let mut configured_home = None;
    for path in config_paths {
        if !path.exists() {
            continue;
        }
        if let Some(home) = read_server_home(&path)? {
            configured_home = Some(home);
        }
    }
    let Some(configured_home) = configured_home else {
        return Ok(user_home.join(".nodex"));
    };
    let expanded = expand_user_home(&configured_home, &user_home);
    Ok(resolve_path(cwd, &expanded))
}

fn nonblank_os(value: Option<&OsStr>) -> Option<&OsStr> {
    let value = value.filter(|value| !value.is_empty())?;
    if value.to_str().is_some_and(|value| value.trim().is_empty()) {
        return None;
    }
    Some(value)
}

fn resolve_path(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_owned();
    }
    cwd.join(path)
}

fn expand_user_home(value: &str, user_home: &Path) -> PathBuf {
    if value == "~" {
        return user_home.to_owned();
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return user_home.join(relative);
    }
    PathBuf::from(value)
}

fn find_project_config(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .map(|directory| directory.join(".nodex/config.toml"))
        .find(|candidate| candidate.exists())
}

fn read_server_home(path: &Path) -> Result<Option<String>, CliError> {
    let metadata = fs::metadata(path).map_err(|error| config_error(path, error))?;
    if !metadata.is_file() {
        return Err(config_error(
            path,
            "configuration path is not a regular file",
        ));
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(config_error(
            path,
            format!("configuration exceeds the {MAX_CONFIG_BYTES}-byte limit"),
        ));
    }
    let source = fs::read_to_string(path).map_err(|error| config_error(path, error))?;
    let parsed = toml::from_str::<RootConfig>(&source)
        .map_err(|error| config_error(path, format!("invalid TOML: {error}")))?;
    Ok(parsed
        .server
        .home
        .map(|home| home.trim().to_owned())
        .filter(|home| !home.is_empty()))
}

fn config_error(path: &Path, error: impl std::fmt::Display) -> CliError {
    CliError::new(
        CliErrorCode::CoreUnavailable,
        format!("could not read Nodex configuration: {error}"),
    )
    .at_path(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_platform::test_support::tempdir;

    #[test]
    fn environment_home_has_priority_and_resolves_from_cwd() {
        let directory = tempdir().expect("cwd");
        let resolved = resolve_home(directory.path(), Some(OsStr::new("relative-profile")), None)
            .expect("environment home");
        assert_eq!(resolved, directory.path().join("relative-profile"));
    }

    #[test]
    fn nearest_project_config_overrides_user_config_and_expands_tilde() {
        let directory = tempdir().expect("root");
        let user_home = directory.path().join("user");
        let project = directory.path().join("workspace/project");
        let cwd = project.join("src/module");
        nodex_platform::private_fs::create_dir_all(user_home.join(".nodex"))
            .expect("user config directory");
        nodex_platform::private_fs::create_dir_all(project.join(".nodex"))
            .expect("project config directory");
        nodex_platform::private_fs::create_dir_all(&cwd).expect("cwd");
        nodex_platform::private_fs::write(
            user_home.join(".nodex/config.toml"),
            "[server]\nhome = \"~/user-profile\"\n",
        )
        .expect("user config");
        nodex_platform::private_fs::write(
            project.join(".nodex/config.toml"),
            "title = \"Nodex\"\n[server]\nhome = \"project-profile\"\n",
        )
        .expect("project config");

        let resolved =
            resolve_home(&cwd, None, Some(user_home.as_os_str())).expect("merged configuration");
        assert_eq!(resolved, cwd.join("project-profile"));

        fs::remove_file(project.join(".nodex/config.toml")).expect("remove override");
        let user_resolved =
            resolve_home(&cwd, None, Some(user_home.as_os_str())).expect("user configuration");
        assert_eq!(user_resolved, user_home.join("user-profile"));
    }

    #[test]
    fn malformed_configuration_fails_with_its_path() {
        let directory = tempdir().expect("root");
        let user_home = directory.path().join("user");
        nodex_platform::private_fs::create_dir_all(user_home.join(".nodex"))
            .expect("config directory");
        let path = user_home.join(".nodex/config.toml");
        nodex_platform::private_fs::write(&path, "[server\nhome = true").expect("invalid config");
        let error = resolve_home(directory.path(), None, Some(user_home.as_os_str()))
            .expect_err("malformed config must fail closed");
        assert_eq!(error.code, CliErrorCode::CoreUnavailable);
        assert_eq!(error.path.as_deref(), Some(path.to_string_lossy().as_ref()));
    }
}
