# macOS Release CI

This document is the source of truth for Nodex macOS release automation, notarization, and Homebrew tap publication.

## Overview

Nodex ships notarized macOS builds for both Apple Silicon and Intel:
- `Nodex-<version>-arm64.dmg`
- `Nodex-<version>-arm64.zip`
- `Nodex-<version>-x64.dmg`
- `Nodex-<version>-x64.zip`

The release pipeline is split across two GitHub Actions workflows:
- `.github/workflows/prepare-release.yml`
- `.github/workflows/release.yml`

`Prepare Release` is the normal entrypoint. It validates the repo, bumps the version, rolls `CHANGELOG.md` forward, creates the release commit, creates the `v<version>` tag, pushes both, then calls `release.yml`.

`Release` is the packaging workflow. It signs, notarizes, verifies, publishes the GitHub Release, and updates the first-party Homebrew tap.

For local Linux-path debugging, Nodex also ships a committed `act` harness for the `prepare` job. That harness intentionally stops after validation and never performs the mutating release steps locally.

## One-Time Setup

### GitHub

Create a GitHub Actions environment named `release` in the `Asphocarp/nodex` repository. The macOS build jobs, release publication job, and Homebrew tap update job all run under that environment.

Add these environment secrets:
- `CSC_LINK`: base64 of the exported `Developer ID Application` `.p12`
- `CSC_KEY_PASSWORD`: password used when exporting the `.p12`
- `APPLE_API_KEY_B64`: base64 of the App Store Connect API key `.p8`
- `APPLE_API_KEY_ID`: App Store Connect API key id
- `APPLE_API_ISSUER`: App Store Connect issuer id
- `HOMEBREW_TAP_GITHUB_TOKEN`: fine-grained token with `Contents: Read and write` on `Asphocarp/homebrew-nodex`

Recommended environment protection:
- required reviewers for first releases
- secrets restricted to the `release` environment only

### Apple

Nodex uses:
- bundle id `app.jyu.nodex`
- `Developer ID Application` certificate for outside-App-Store distribution
- App Store Connect API key authentication for notarization

The certificate exported into `CSC_LINK` must contain the `Developer ID Application` identity and its private key.

## Triggering a Release

### Preferred path

Run `Prepare Release` from GitHub Actions UI or from the CLI.

For a patch bump:

```bash
gh workflow run "Prepare Release" \
  --repo Asphocarp/nodex \
  -f release_type=patch
```

For an explicit version:

```bash
gh workflow run "Prepare Release" \
  --repo Asphocarp/nodex \
  -f release_type=custom \
  -f custom_version=0.1.3
```

Before triggering it:
1. Make sure `CHANGELOG.md` has the intended release notes under `## [Unreleased]`.
2. Make sure the `release` environment secrets are populated.
3. Make sure the default branch is green.

### Manual fallback

If the workflow cannot be used, cut the version locally:

```bash
bun run release:cut -- 0.1.3
git push origin HEAD
git push origin v0.1.3
```

This bypasses the `Prepare Release` workflow, so use it only when necessary.

### Local `act` reproduction for `prepare`

Use this when `Prepare Release` fails in the Ubuntu validation path and you need a local reproduction that stays aligned with the real workflow:

```bash
brew install act
bun run release:prepare:act:list
bun run release:prepare:act -- --release-type patch
```

For an explicit version:

```bash
bun run release:prepare:act -- --release-type custom --custom-version 0.1.3
```

Supporting files:
- `.actrc`
- `.github/act/prepare-release.event.json`
- `.github/act/prepare-release.secrets.example`
- `scripts/run-prepare-release-act.sh`

Behavior:
- runs only the `prepare` job from `.github/workflows/prepare-release.yml`
- keeps checkout, Bun setup, install, typecheck, lint, and test aligned with GitHub Actions
- skips version bump, changelog generation, commit/tag/push, and the reusable `publish` workflow when `github.event.act` is true

Current known target:
- the cloud failure on March 16, 2026 is in the Ubuntu `bun test` step and currently surfaces as `ThreadItemRenderer > renders file-change inline toggle with filename`

Limitations:
- no macOS runner emulation
- no notarization validation
- no environment-scoped GitHub Actions secret parity
- requires a working Docker-compatible runtime such as Docker Desktop or OrbStack

## Workflow Details

### `Prepare Release`

Workflow file: `.github/workflows/prepare-release.yml`

Trigger:
- `workflow_dispatch`

Inputs:
- `release_type`: `patch`, `minor`, `major`, or `custom`
- `custom_version`: required only when `release_type=custom`

Steps:
1. Check out the repository with full history.
2. Install the Bun version pinned in `package.json#packageManager`, then install dependencies with `bun install --frozen-lockfile`.
3. Run `bun run typecheck`.
4. Run `bun run lint`.
5. Run `bun test`.
6. When `github.event.act` is true, stop after validation and skip all mutating release steps plus the downstream `publish` job.
7. Resolve the target version:
   - for `patch`/`minor`/`major`, use Bun semver bumping
   - for `custom`, use the explicit version string
8. Run `bun pm version ... --no-git-tag-version`.
9. Run `bun run release:prepare` to:
   - roll `CHANGELOG.md` forward
   - generate release notes
   - generate the release commit message
10. Create the release commit.
11. Create annotated tag `v<version>`.
12. Push the commit and tag.
13. Call `.github/workflows/release.yml` through `workflow_call`, passing the newly created git ref.

Output contract:
- `git_ref`: for example `v0.1.3`
- `version`: for example `0.1.3`

### `Release`

Workflow file: `.github/workflows/release.yml`

Triggers:
- `push` on tags matching `v*`
- `workflow_call` from `Prepare Release`

Environment:
- all jobs use the `release` environment

Release jobs:
- `build-macos-arm64`
- `build-macos-x64`
- `publish-release`
- `update-homebrew-tap`

#### `build-macos-arm64`

Runner:
- `macos-latest`

Responsibilities:
1. Check out the release tag or passed git ref.
2. Install the Bun version pinned in `package.json#packageManager`, then install dependencies.
3. Resolve the release tag and semver version.
4. Materialize `APPLE_API_KEY_B64` into `${RUNNER_TEMP}/AuthKey_<id>.p8`.
5. Export `APPLE_API_KEY=<temp-path>` into the job environment.
6. Run `bun run package:mac:arm64`.
7. Assert these files exist:
   - `dist/Nodex-<version>-arm64.dmg`
   - `dist/Nodex-<version>-arm64.zip`
   - built `Nodex.app`
8. Verify signing and notarization:
   - `codesign --verify --deep --strict --verbose=2`
   - `spctl --assess --type open --context context:primary-signature --verbose=4`
   - `xcrun stapler staple`
   - `xcrun stapler validate`
9. Upload the DMG and ZIP as the `macos-arm64-release` artifact.

Secrets consumed:
- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY_B64`

#### `build-macos-x64`

Runner:
- `macos-15-intel`

Responsibilities are the same as the arm64 job, except it runs `bun run package:mac:x64`, expects `x64` artifacts, and uploads them as `macos-x64-release`.

#### `publish-release`

Runner:
- `ubuntu-latest`

Dependencies:
- `build-macos-arm64`
- `build-macos-x64`

Responsibilities:
1. Check out the same release ref.
2. Install the Bun version pinned in `package.json#packageManager`, then install dependencies.
3. Download the `macos-arm64-release` artifact.
4. Download the `macos-x64-release` artifact.
5. Extract release notes for the resolved version from `CHANGELOG.md` with `bun run release:notes`.
6. Publish a non-draft GitHub Release using `softprops/action-gh-release`.
7. Attach all four release assets:
   - arm64 DMG
   - arm64 ZIP
   - x64 DMG
   - x64 ZIP

This job does not build binaries. It only publishes artifacts produced and verified by the two macOS jobs.

#### `update-homebrew-tap`

Runner:
- `ubuntu-latest`

Dependencies:
- `build-macos-arm64`
- `build-macos-x64`
- `publish-release`

Responsibilities:
1. Check out the same release ref.
2. Install the Bun version pinned in `package.json#packageManager`, then install dependencies.
3. Download the arm64 and x64 release artifacts.
4. Locate the released DMGs for both architectures.
5. Compute `sha256` for both DMGs with `shasum -a 256`.
6. Clone `Asphocarp/homebrew-nodex` using `HOMEBREW_TAP_GITHUB_TOKEN`.
7. Run `bun run release:cask` to generate `Casks/nodex.rb`.
8. Commit the cask update:
   - `chore: update nodex cask to v<version>`
9. Push the tap update if the generated file changed.

If the tap repo already matches the generated cask, the job exits successfully without a new commit.

## Artifact and Cask Contract

The release job assumes these filenames:
- `dist/Nodex-<version>-arm64.dmg`
- `dist/Nodex-<version>-arm64.zip`
- `dist/Nodex-<version>-x64.dmg`
- `dist/Nodex-<version>-x64.zip`

The Homebrew cask generator assumes:
- the GitHub release tag is `v<version>`
- the app name is `Nodex`
- `app.jyu.nodex` is the canonical macOS bundle id for zap paths
- the cask lives at `Asphocarp/homebrew-nodex/Casks/nodex.rb`

Homebrew install path:

```bash
brew tap Asphocarp/nodex
brew install --cask nodex
```

## Observability and Recovery

### Watching the workflows

List recent runs:

```bash
gh run list --repo Asphocarp/nodex --workflow "Prepare Release"
gh run list --repo Asphocarp/nodex --workflow "Release"
```

Watch a run:

```bash
gh run watch --repo Asphocarp/nodex
```

Inspect logs:

```bash
gh run view --repo Asphocarp/nodex --log
```

### Common failure points

`Prepare Release` failure:
- cause: typecheck, lint, or test regression
- action: reproduce locally with `bun run release:prepare:act -- --release-type patch`, fix the repo state on the default branch, then rerun `Prepare Release`

`build-macos-*` failure before notarization:
- cause: missing signing secrets, malformed `.p12`, wrong certificate, missing `APPLE_API_ISSUER`, or packaging regression
- action: fix the secret or packaging issue, then rerun the failed job or rerun the entire workflow

`build-macos-*` failure during notarization or stapling:
- cause: Apple auth issue, notarization rejection, missing hardened runtime entitlement, or transient Apple service failure
- action: inspect the notarization logs, correct the signing config if needed, and rerun the job

`publish-release` failure:
- cause: missing release notes extraction, missing artifacts, or GitHub release API issue
- action: rerun the job after confirming both build jobs uploaded artifacts

`update-homebrew-tap` failure:
- cause: invalid tap token, missing tap repo access, or push conflict in `Asphocarp/homebrew-nodex`
- action: fix the token or repo state, then rerun only the tap update job

### Recovery guidance

If `publish-release` succeeds but `update-homebrew-tap` fails:
- do not rebuild macOS artifacts
- rerun only `update-homebrew-tap` after fixing the token or repo issue

If `Prepare Release` is failing before the version bump:
- use the local `act` harness first
- do not try to debug the macOS packaging jobs until the Ubuntu `prepare` path is green again

If the version tag was created but the release workflow is unusable:
- fix the blocking issue
- rerun the existing workflow for that tag
- do not create a second tag for the same version

If a bad release commit was created by `Prepare Release` but not yet published:
- revert or fix forward on the default branch
- cut a new version
- do not move the existing tag silently

## Local Validation Before Enabling Secrets

Before trusting CI with signing secrets, do one local dry run on a Mac that has the certificate and API key available:

```bash
bun run package:mac:arm64
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Nodex.app"
spctl --assess --type open --context context:primary-signature --verbose=4 "dist/Nodex-<version>-arm64.dmg"
xcrun stapler validate "dist/Nodex-<version>-arm64.dmg"
```

Repeat the same flow for `bun run package:mac:x64` if Intel packaging is being validated locally.
