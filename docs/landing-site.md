# Landing Site

This document is the source of truth for the public Nodex landing site, its
content and media contracts, and its GitHub Pages deployment path.

## Overview

The site lives in `packages/landing`. Astro builds ordinary static HTML for
`https://nodex.jyu.app`; the package stays separate from the Electron renderer
and does not inherit desktop-only CSS or runtime assumptions.

The homepage is one componentized marketing composition with a hero, a
four-state workflow demonstration, an Our Core Values section, and the shared
footer. Public wording is centralized in
`src/i18n/en/translation.json`. The checked-in third-party source license for
the landing implementation remains in `packages/landing/ZEN_LICENSE`.

## Local Commands

Run these from the repository root:

```bash
vp run dev:landing
vp run build:landing
vp run preview:landing
vp run test:landing
```

`build:landing` produces `packages/landing/dist/` with Astro. `test:landing`
builds first, then validates the generated routes, release links, Changelog
rendering, release metadata, and media-readiness contract.

For the Storybook review entry, run the landing preview and Storybook together:

```bash
vp run preview:landing
vp run dev:storybook
```

Then open `Landing/Page preview`. Set `VITE_LANDING_PREVIEW_URL` if the preview
is not available at `http://127.0.0.1:4321/`.

## Routes and Sources of Truth

Astro file routing emits these public routes:

- `/` — product landing
- `/download/` — explicit Apple silicon and Intel downloads plus Homebrew
- `/changelog/` — generated from the root `CHANGELOG.md`
- `/privacy/`
- `/terms/`

The displayed version comes from the root `package.json`. Canonical, Open Graph,
Twitter, sitemap, and structured metadata use `https://nodex.jyu.app` as the
site origin. Static assets, `CNAME`, `.nojekyll`, and `robots.txt` live in
`packages/landing/public/`.

## Content Contract

The homepage makes four claims:

1. A developer can shape a task as a Page and choose the context that matters.
2. A Project keeps that Page beside agent chat, files, terminal, browser, and
   Review.
3. The native CLI and official Skill let local agents search, read, create, and
   update Pages.
4. Library and Project state live in the local SQLite-backed core, and the
   desktop app and CLI are open source.

The site must not claim a Markdown-file source of truth, automatic return of
agent output to the originating Page, provenance that does not exist, or
multi-user cloud collaboration.

The site navigation stays intentionally narrow. The header exposes GitHub,
theme, and Download without a secondary navigation row or mobile drawer. The
hero has one Download call to action. The footer retains the large brand and
download call to action, then limits navigation to GitHub, Changelog, Privacy,
and Terms.

The final homepage section is Our Core Values: Open source, Tangible context,
and Local-first. It reuses the established product-principles composition and
must not be preceded by a second download, Homebrew, or source-link section.

## Product Media

The five product-media slots keep stable public paths:

- `hero-video`
- `workspaces` (Shape)
- `compact-mode` (Run)
- `glance` (Review)
- `split-views` (Shared Pages)

Each directory contains `poster.webp`, `video.webm`, and `video.mp4`. The exact
storyboard, privacy review, and byte budgets live in
`packages/landing/MEDIA.md`.

The current files are temporary. Keep `landingMediaStatus` in
`src/constants/media.ts` set to `pending` until the final captures have been
recorded and reviewed. Local builds intentionally remain available for copy and
layout review; the deployment workflow sets `NODEX_REQUIRE_LANDING_MEDIA=1` and
therefore refuses to publish while the status is pending.

## Release and Download Contracts

- Apple silicon: `https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg`
- Intel Mac: `https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-x64.dmg`
- Homebrew: `brew install --cask junyudev/tap/nodex`
- Supported desktop runtime: macOS 15 or later

The main CTA opens `/download/`, where both architectures are always explicit.
No user-agent inference is required, and the page remains complete without
JavaScript.

## Publishing Topology

Builds happen in this repository. Deployment publishes
`packages/landing/dist/` into the root of `NodexApp/NodexApp.github.io`.

- `.github/workflows/deploy-landing-site.yml` runs on protected `main` changes
  to landing source, release metadata, or the deployment workflows.
- `.github/workflows/_deploy-landing-site.yml` checks out one exact source SHA,
  requires reviewed media, builds the site, replaces the target artifact, and
  commits only when the generated output changed.
- Release promotion calls the same reusable workflow after release verification,
  so version and Changelog copy cannot precede their downloadable artifacts.

The `landing-production` environment binds the
`NODEXAPP_GITHUB_IO_TOKEN` secret. The token needs read/write contents access
only to `NodexApp/NodexApp.github.io`.

## GitHub Workflows

The repository-wide `.github/workflows/ci.yml` validates the landing build on
every PR and protected-main push as part of its always-run static contracts.
There is no separate landing-only validation workflow or second required check.

- `.github/workflows/deploy-landing-site.yml`
  - runs on `main` changes affecting the landing implementation and on manual dispatch
  - calls the shared exact-SHA deployment workflow
- `.github/workflows/_deploy-landing-site.yml`
  - builds the site from one protected-main commit
  - always clones the fixed `NodexApp/NodexApp.github.io` target; callers cannot
    override the destination
  - ordinary deploys replace the built site while preserving the target
    `updates/` tree
  - commits only when there is a diff
  - is also called by release promotion after the immutable app Release is
    verified; that mode projects the Release Bundle's exact signed arm64/x64
    appcast snapshots into `/updates/stable/<arch>/appcast.xml`, rejects feed
    rollback or same-version byte drift, and verifies the public bytes and
    immutable enclosures after push

## Required Secrets

The deploy workflow binds the `landing-production` environment, restricted to
protected `main`. Its callers explicitly map this repository Action secret to
the reusable deployment workflow:

- `NODEXAPP_GITHUB_IO_TOKEN`
  - fine-grained GitHub token
  - repository access: `NodexApp/NodexApp.github.io`
  - permission: `Contents: Read and write`

## Pages Configuration

In `NodexApp/NodexApp.github.io`, configure GitHub Pages to publish from the default branch root.

The stable application-update endpoints are:

- `https://nodex.jyu.app/updates/stable/arm64/appcast.xml`
- `https://nodex.jyu.app/updates/stable/x64/appcast.xml`

The Pages repository stores only the signed feed control plane. Full ZIPs and
deltas remain immutable assets of the corresponding `junyudev/nodex` GitHub
Release. Feed recovery replays a verified release snapshot; it does not
regenerate or re-sign an existing release.

No SPA fallback is needed. `packages/landing/public/CNAME` is part of the
production custom-domain contract and must remain in the generated Pages tree;
`nodexapp.github.io` is only the underlying Pages host.
