# Nodex

Block-based Agent Orchestrator.

## System Requirements

- Desktop app: macOS 12 Monterey or later
- CPU: Apple silicon and Intel Macs are supported

Release packaging currently runs on macOS 26 CI runners because the Icon Composer build path requires Xcode 26 `actool`, but that is a build-time requirement, not a user runtime requirement.

## Features

[TODO]

## Getting Started

[TODO]

## Landing Site

The public landing site lives in [`packages/landing`](packages/landing/) and is intended to publish to [nodexapp.github.io](https://nodexapp.github.io).

Local commands:

```bash
bun run dev:landing
bun run build:landing
bun run preview:landing
```

Operational details for GitHub Pages publishing live in [`docs/landing-site.md`](docs/landing-site.md).

## Local GitHub Actions Debugging

To reproduce the Ubuntu `prepare` job from `Prepare Release` locally with [`act`](https://github.com/nektos/act):

```bash
brew install act
bun run release:prepare:act:list
bun run release:prepare:act -- --release-type patch
```

Notes:
- The local harness only runs the `prepare` job from `.github/workflows/prepare-release.yml`.
- Local `act` runs stop after validation (`bun install`, `typecheck`, `lint`, `test`) and skip the version bump, changelog rewrite, commit, tag, push, and downstream `publish` job.
- Copy `.github/act/prepare-release.secrets.example` to `.github/act/prepare-release.secrets.local` only if you need to provide explicit secrets; otherwise the wrapper tries to use `gh auth token` automatically.
- `act` does not emulate the macOS release jobs, notarization, or GitHub environment-scoped secret behavior. Use it to debug the Ubuntu validation path first.
