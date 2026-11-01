use nodex_platform::private_fs::symlink;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;

use clap::Parser;
use nodex_cli::cli::{Cli, Command, SkillMutationArgs, SkillTargetArgs, SkillsArgs, SkillsCommand};
use nodex_cli::error::CliErrorCode;
use nodex_cli::runtime::CommandOutput;
use nodex_cli::skills::bundle::{
    OFFICIAL_SKILL_FILES, digest_skill_tree, verify_for_executable, verify_stable_for_executable,
};
use nodex_cli::skills::{InstallerEnvironment, SkillAgent, execute_skills_with_environment};
use nodex_platform::test_support::TempDir;
use serde_json::{Value, json};

struct Fixture {
    _temp: TempDir,
    home: PathBuf,
    executable: PathBuf,
    bundle_source: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let temp = nodex_platform::test_support::tempdir().expect("temp");
        let home = temp.path().join("home");
        nodex_platform::private_fs::create_dir(&home).expect("home");
        let executable = temp.path().join(if cfg!(windows) {
            format!("{name}/resources/bin/nodex.exe")
        } else {
            format!("{name}.app/Contents/Resources/bin/nodex")
        });
        nodex_platform::private_fs::create_dir_all(executable.parent().expect("bin"))
            .expect("app layout");
        nodex_platform::private_fs::write(&executable, b"test executable").expect("executable");
        let bundle_root = executable
            .parent()
            .expect("bin")
            .parent()
            .expect("Resources")
            .join("agent-skills");
        let bundle_source = bundle_root.join("skills/nodex");
        copy_official_skill(&bundle_source);
        nodex_platform::private_fs::write(
            bundle_root.join("README.md"),
            b"Official Nodex Skills\n",
        )
        .expect("README");
        nodex_platform::private_fs::write(
            bundle_root.join("LICENSE"),
            fs::read(repository_root().join("LICENSE")).expect("root license"),
        )
        .expect("license");
        let digest = digest_skill_tree(&bundle_source).expect("Skill digest");
        let manifest = json!({
            "schemaVersion": 1,
            "distribution": "NodexApp/skills",
            "product": {
                "name": "Nodex",
                "releaseVersion": "1.2.3"
            },
            "source": {
                "repository": "NodexApp/nodex",
                "ref": "v1.2.3"
            },
            "agentInterface": {
                "minimumRevision": 1,
                "maximumRevision": 1
            },
            "skills": [{
                "name": "nodex",
                "path": "skills/nodex",
                "treeSha256": digest.tree_sha256,
                "fileCount": digest.file_count,
                "totalBytes": digest.total_bytes
            }]
        });
        nodex_platform::private_fs::write(
            bundle_root.join("release-manifest.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).expect("manifest")
            ),
        )
        .expect("manifest");

        let bundle_source = bundle_source
            .canonicalize()
            .expect("canonical Skill source");
        Self {
            _temp: temp,
            home,
            executable,
            bundle_source,
        }
    }

    fn environment(&self) -> InstallerEnvironment {
        InstallerEnvironment::for_tests(self.home.clone(), self.executable.clone())
    }

    fn target(&self, agent: SkillAgent) -> PathBuf {
        match agent {
            SkillAgent::Codex => self.home.join(".agents").join("skills").join("nodex"),
            SkillAgent::ClaudeCode => self.home.join(".claude").join("skills").join("nodex"),
        }
    }
}

fn read_managed_link(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    let raw = fs::read_link(path)?;
    assert!(raw.is_absolute());
    fs::canonicalize(raw)
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates")
        .parent()
        .expect("repository")
        .to_path_buf()
}

fn copy_official_skill(destination: &Path) {
    let source = repository_root().join("agent-skills/nodex");
    for relative in OFFICIAL_SKILL_FILES {
        let target = destination.join(relative);
        nodex_platform::private_fs::create_dir_all(target.parent().expect("parent"))
            .expect("target parent");
        nodex_platform::private_fs::copy(source.join(relative), target).expect("copy Skill file");
    }
}

fn mutation(agents: Vec<SkillAgent>) -> SkillMutationArgs {
    SkillMutationArgs {
        targets: SkillTargetArgs { agents },
        dry_run: false,
        yes: true,
    }
}

fn install_args(agents: Vec<SkillAgent>) -> SkillsArgs {
    SkillsArgs {
        command: SkillsCommand::Install(mutation(agents)),
    }
}

fn remove_args(agents: Vec<SkillAgent>) -> SkillsArgs {
    SkillsArgs {
        command: SkillsCommand::Remove(mutation(agents)),
    }
}

fn status_args(agents: Vec<SkillAgent>) -> SkillsArgs {
    SkillsArgs {
        command: SkillsCommand::Status(SkillTargetArgs { agents }),
    }
}

fn json_output(output: CommandOutput) -> Value {
    let CommandOutput::Json(value) = output else {
        panic!("expected JSON output")
    };
    value
}

#[test]
fn installs_global_codex_and_claude_targets_as_exact_absolute_symlinks() {
    let fixture = Fixture::new("Nodex");
    let result = json_output(
        execute_skills_with_environment(
            install_args(SkillAgent::ALL.to_vec()),
            true,
            &fixture.environment(),
        )
        .expect("install"),
    );
    assert_eq!(result["changed"], true);
    assert_eq!(result["targets"][0]["outcome"], "installed");
    assert_eq!(result["targets"][1]["outcome"], "installed");
    for agent in SkillAgent::ALL {
        let raw = read_managed_link(fixture.target(agent)).expect("managed symlink");
        assert!(raw.is_absolute());
        assert_eq!(raw, fixture.bundle_source);
    }
    assert!(!fixture.home.join(".agents/.nodex").exists());

    let repeated = json_output(
        execute_skills_with_environment(
            install_args(SkillAgent::ALL.to_vec()),
            true,
            &fixture.environment(),
        )
        .expect("repeat"),
    );
    assert_eq!(repeated["changed"], false);
    assert!(
        repeated["targets"]
            .as_array()
            .expect("targets")
            .iter()
            .all(|target| target["outcome"] == "already-installed")
    );

    let removed = json_output(
        execute_skills_with_environment(
            remove_args(SkillAgent::ALL.to_vec()),
            true,
            &fixture.environment(),
        )
        .expect("remove"),
    );
    assert_eq!(removed["changed"], true);
    assert!(!fixture.target(SkillAgent::Codex).exists());
    assert!(!fixture.target(SkillAgent::ClaudeCode).exists());
}

#[test]
fn json_mutations_require_confirmation_and_dry_run_never_writes() {
    let fixture = Fixture::new("confirmation");
    let unconfirmed = SkillMutationArgs {
        targets: SkillTargetArgs {
            agents: vec![SkillAgent::Codex],
        },
        dry_run: false,
        yes: false,
    };
    let error = execute_skills_with_environment(
        SkillsArgs {
            command: SkillsCommand::Install(unconfirmed),
        },
        true,
        &fixture.environment(),
    )
    .expect_err("JSON confirmation");
    assert_eq!(error.code, CliErrorCode::InvalidInput);

    let dry_run = SkillMutationArgs {
        targets: SkillTargetArgs {
            agents: vec![SkillAgent::Codex],
        },
        dry_run: true,
        yes: false,
    };
    let result = json_output(
        execute_skills_with_environment(
            SkillsArgs {
                command: SkillsCommand::Install(dry_run),
            },
            true,
            &fixture.environment(),
        )
        .expect("dry run"),
    );
    assert_eq!(result["targets"][0]["outcome"], "would-install");
    assert_eq!(result["changed"], false);
    assert!(fs::symlink_metadata(fixture.target(SkillAgent::Codex)).is_err());
}

#[test]
fn honors_claude_config_dir_and_reports_compatible_external_directories() {
    let fixture = Fixture::new("Nodex");
    let custom_claude = fixture.home.join("custom-claude");
    nodex_platform::private_fs::create_dir(&custom_claude).expect("custom Claude root");
    let mut environment = fixture.environment();
    environment.claude_config_dir = Some(custom_claude.clone());
    execute_skills_with_environment(
        install_args(vec![SkillAgent::ClaudeCode]),
        true,
        &environment,
    )
    .expect("custom install");
    assert_eq!(
        read_managed_link(custom_claude.join("skills/nodex")).expect("Claude symlink"),
        fixture.bundle_source
    );

    let external = fixture.target(SkillAgent::Codex);
    copy_official_skill(&external);
    let status = json_output(
        execute_skills_with_environment(
            status_args(vec![SkillAgent::Codex]),
            true,
            &fixture.environment(),
        )
        .expect("status"),
    );
    assert_eq!(status["targets"][0]["state"], "compatible-external");
    let install = json_output(
        execute_skills_with_environment(
            install_args(vec![SkillAgent::Codex]),
            true,
            &fixture.environment(),
        )
        .expect("external install"),
    );
    assert_eq!(install["targets"][0]["outcome"], "available-external");
    assert_eq!(install["changed"], false);
    let remove_error = execute_skills_with_environment(
        remove_args(vec![SkillAgent::Codex]),
        true,
        &fixture.environment(),
    )
    .expect_err("external directory is not Nodex-owned");
    assert_eq!(remove_error.code, CliErrorCode::SkillTargetConflict);
    assert!(external.is_dir());
}

#[test]
fn conflicts_fail_closed_before_any_selected_target_is_written() {
    let fixture = Fixture::new("Nodex");
    let claude = fixture.target(SkillAgent::ClaudeCode);
    nodex_platform::private_fs::create_dir_all(claude.parent().expect("Claude skills"))
        .expect("parent");
    nodex_platform::private_fs::write(&claude, b"user file").expect("conflict");

    let error = execute_skills_with_environment(
        install_args(SkillAgent::ALL.to_vec()),
        true,
        &fixture.environment(),
    )
    .expect_err("preflight conflict");
    assert_eq!(error.code, CliErrorCode::SkillTargetConflict);
    assert_eq!(
        error.path.as_deref(),
        Some(claude.to_string_lossy().as_ref())
    );
    assert!(fs::symlink_metadata(fixture.target(SkillAgent::Codex)).is_err());
}

#[test]
fn different_external_directory_and_parent_symlink_traversal_are_conflicts() {
    let different = Fixture::new("different");
    let target = different.target(SkillAgent::Codex);
    nodex_platform::private_fs::create_dir_all(&target).expect("different directory");
    nodex_platform::private_fs::write(target.join("SKILL.md"), b"different\n")
        .expect("different Skill");
    let error = execute_skills_with_environment(
        install_args(vec![SkillAgent::Codex]),
        true,
        &different.environment(),
    )
    .expect_err("different directory");
    assert_eq!(error.code, CliErrorCode::SkillTargetConflict);

    let traversed = Fixture::new("traversed");
    let outside = traversed.home.join("outside-skills");
    nodex_platform::private_fs::create_dir(&outside).expect("outside");
    nodex_platform::private_fs::create_dir(traversed.home.join(".agents")).expect("Codex root");
    symlink(&outside, traversed.home.join(".agents/skills")).expect("parent symlink");
    let error = execute_skills_with_environment(
        install_args(vec![SkillAgent::Codex]),
        true,
        &traversed.environment(),
    )
    .expect_err("skills parent traversal");
    assert_eq!(error.code, CliErrorCode::SkillTargetConflict);
    assert!(fs::symlink_metadata(outside.join("nodex")).is_err());
}

#[test]
fn an_owned_config_root_symlink_is_allowed_but_its_skills_child_must_be_real() {
    let fixture = Fixture::new("config-root-link");
    let actual_root = fixture.home.join("codex-config");
    nodex_platform::private_fs::create_dir(&actual_root).expect("actual config root");
    symlink(&actual_root, fixture.home.join(".agents")).expect("config root symlink");
    execute_skills_with_environment(
        install_args(vec![SkillAgent::Codex]),
        true,
        &fixture.environment(),
    )
    .expect("install through owned config root");
    assert_eq!(
        read_managed_link(actual_root.join("skills/nodex")).expect("managed target"),
        fixture.bundle_source
    );
}

#[test]
fn foreign_relative_and_broken_symlinks_are_never_adopted() {
    for (name, raw_target) in [
        ("foreign", PathBuf::from("/tmp/another-skill")),
        ("relative", PathBuf::from("../../official")),
        ("broken", PathBuf::from("/definitely/missing/nodex-skill")),
    ] {
        let fixture = Fixture::new(name);
        let target = fixture.target(SkillAgent::Codex);
        nodex_platform::private_fs::create_dir_all(target.parent().expect("skills"))
            .expect("parent");
        symlink(raw_target, &target).expect("conflicting symlink");
        let error = execute_skills_with_environment(
            install_args(vec![SkillAgent::Codex]),
            true,
            &fixture.environment(),
        )
        .expect_err("symlink conflict");
        assert_eq!(error.code, CliErrorCode::SkillTargetConflict);
        assert!(
            fs::symlink_metadata(&target)
                .expect("preserved target")
                .file_type()
                .is_symlink()
        );
    }
}

#[test]
fn doctor_reports_but_never_changes_a_legacy_codex_target() {
    let fixture = Fixture::new("legacy");
    execute_skills_with_environment(
        install_args(vec![SkillAgent::Codex]),
        true,
        &fixture.environment(),
    )
    .expect("current install");
    let legacy = fixture.home.join(".codex/skills/nodex");
    nodex_platform::private_fs::create_dir_all(&legacy).expect("legacy directory");
    nodex_platform::private_fs::write(legacy.join("user.md"), b"user managed\n")
        .expect("legacy content");
    let doctor = json_output(
        execute_skills_with_environment(
            SkillsArgs {
                command: SkillsCommand::Doctor(SkillTargetArgs {
                    agents: vec![SkillAgent::Codex],
                }),
            },
            true,
            &fixture.environment(),
        )
        .expect("doctor"),
    );
    assert_eq!(doctor["legacyTargets"][0]["state"], "legacy-external");
    assert_eq!(doctor["legacyTargets"][0]["duplicateDiscoveryRisk"], true);
    assert!(legacy.join("user.md").is_file());
}

#[test]
fn interrupted_multi_target_install_converges_on_idempotent_retry() {
    let fixture = Fixture::new("Nodex");
    let mut interrupted = fixture.environment();
    interrupted.fail_after_target_mutations = Some(1);
    let error =
        execute_skills_with_environment(install_args(SkillAgent::ALL.to_vec()), true, &interrupted)
            .expect_err("injected failure");
    assert_eq!(error.code, CliErrorCode::Internal);
    assert_eq!(
        read_managed_link(fixture.target(SkillAgent::Codex)).expect("first target"),
        fixture.bundle_source
    );
    assert!(fs::symlink_metadata(fixture.target(SkillAgent::ClaudeCode)).is_err());

    let recovered = json_output(
        execute_skills_with_environment(
            install_args(SkillAgent::ALL.to_vec()),
            true,
            &fixture.environment(),
        )
        .expect("recovery"),
    );
    assert_eq!(recovered["targets"][0]["outcome"], "already-installed");
    assert_eq!(recovered["targets"][1]["outcome"], "installed");
    assert_eq!(recovered["changed"], true);
}

#[test]
fn concurrent_installers_converge_through_no_clobber_reclassification() {
    let fixture = Fixture::new("Nodex");
    let environment = fixture.environment();
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let environment = environment.clone();
            thread::spawn(move || {
                barrier.wait();
                execute_skills_with_environment(
                    install_args(vec![SkillAgent::Codex]),
                    true,
                    &environment,
                )
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().expect("thread").expect("converged install");
    }
    assert_eq!(
        read_managed_link(fixture.target(SkillAgent::Codex)).expect("managed target"),
        fixture.bundle_source
    );
}

#[test]
fn an_app_move_makes_the_old_link_a_report_only_conflict() {
    let first = Fixture::new("Nodex-old");
    execute_skills_with_environment(
        install_args(vec![SkillAgent::Codex]),
        true,
        &first.environment(),
    )
    .expect("initial install");
    let second = Fixture::new("Nodex-new");
    let mut moved_environment = second.environment();
    moved_environment.home = first.home.clone();

    let status = json_output(
        execute_skills_with_environment(
            status_args(vec![SkillAgent::Codex]),
            true,
            &moved_environment,
        )
        .expect("status"),
    );
    assert_eq!(status["targets"][0]["state"], "conflict");
    let remove_error = execute_skills_with_environment(
        remove_args(vec![SkillAgent::Codex]),
        true,
        &moved_environment,
    )
    .expect_err("new App cannot own old link");
    assert_eq!(remove_error.code, CliErrorCode::SkillTargetConflict);
    assert_eq!(
        read_managed_link(first.target(SkillAgent::Codex)).expect("old link preserved"),
        first.bundle_source
    );
}

#[test]
fn bundle_verifier_rejects_unknown_links_hardlinks_and_special_files() {
    let unknown = Fixture::new("unknown");
    nodex_platform::private_fs::write(
        unknown.bundle_source.join("references/not-allowlisted.md"),
        b"unknown",
    )
    .expect("unknown file");
    assert_eq!(
        verify_for_executable(&unknown.executable)
            .expect_err("unknown bundle file")
            .code,
        CliErrorCode::SkillBundleInvalid
    );

    let linked = Fixture::new("linked");
    let reference = linked.bundle_source.join("references/troubleshooting.md");
    fs::remove_file(&reference).expect("remove reference");
    symlink(
        linked.bundle_source.join("references/page-editor.md"),
        &reference,
    )
    .expect("bundle symlink");
    assert_eq!(
        verify_for_executable(&linked.executable)
            .expect_err("bundle symlink")
            .code,
        CliErrorCode::SkillBundleInvalid
    );

    let hardlinked = Fixture::new("hardlinked");
    let reference = hardlinked
        .bundle_source
        .join("references/troubleshooting.md");
    fs::remove_file(&reference).expect("remove reference");
    fs::hard_link(
        hardlinked.bundle_source.join("references/page-editor.md"),
        &reference,
    )
    .expect("bundle hardlink");
    assert_eq!(
        verify_for_executable(&hardlinked.executable)
            .expect_err("bundle hardlink")
            .code,
        CliErrorCode::SkillBundleInvalid
    );

    #[cfg(unix)]
    {
        let special = Fixture::new("special");
        let short_socket = special._temp.path().join("unexpected.socket");
        let _listener = std::os::unix::net::UnixListener::bind(&short_socket).expect("socket");
        nodex_platform::private_fs::atomic_replace(
            &short_socket,
            special.bundle_source.join("unexpected.socket"),
        )
        .expect("move socket into bundle");
        assert_eq!(
            verify_for_executable(&special.executable)
                .expect_err("bundle socket")
                .code,
            CliErrorCode::SkillBundleInvalid
        );
    }
}

#[test]
fn stable_setup_rejects_a_valid_bundle_outside_applications() {
    let fixture = Fixture::new("translocated");
    let error = verify_stable_for_executable(&fixture.executable, &fixture.home)
        .expect_err("temporary App path is unstable");
    assert_eq!(error.code, CliErrorCode::SkillBundleUnavailable);
}

#[test]
fn mutation_cli_has_no_scope_mode_or_path_escape_hatch() {
    for flag in ["--scope", "--project-root", "--mode", "--force", "--adopt"] {
        assert!(
            Cli::try_parse_from([
                "nodex", "skills", "install", "--agent", "codex", "--yes", flag, "value",
            ])
            .is_err(),
            "{flag} must not parse"
        );
    }

    let parsed = Cli::try_parse_from([
        "nodex",
        "--project",
        "not-allowed",
        "skills",
        "install",
        "--agent",
        "codex",
        "--yes",
    ])
    .expect("global parser");
    let Command::Skills(_) = &parsed.command else {
        panic!("Skills command")
    };
    let error = nodex_cli::runtime::execute(parsed).expect_err("scope rejected before bootstrap");
    assert_eq!(error.code, CliErrorCode::InvalidInput);
}
