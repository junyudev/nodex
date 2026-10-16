# Landing Site

This document is the source of truth for the public Nodex landing site and its GitHub Pages deployment path.

## Overview

The landing site lives in `packages/landing`. It is a small Vite-built static site that intentionally stays separate from the Electron renderer and its design-token stack.

Why it is separate:

- the site is published to `https://nodex.jyu.app`
- it should stay fast and low-risk
- it should not inherit desktop-app-only code, CSS, or runtime assumptions

The source of truth stays in this repository. Published static output is pushed to the separate org-site repository `NodexApp/NodexApp.github.io`.

## Local Commands

Run these from the repo root:

```bash
vp run dev:landing
vp run build:landing
vp run preview:landing
```

## Package Layout

`packages/landing` contains:

- `index.html` for the homepage
- `changelog/index.html` for the generated changelog page
- `privacy/index.html`
- `terms/index.html`
- `src/styles.css` for landing-only Tailwind and token styling
- `src/changelog-renderer.ts` for build-time `CHANGELOG.md` parsing and rendering
- `src/download-cta.ts` for copying the Homebrew install command
- `public/` for copied brand assets, the committed OG image, and `.nojekyll`

The site is a static multi-page build. It does not use React Router or any client-side routing fallback.
The homepage links directly to the stable Apple silicon GitHub Release alias without JavaScript or browser architecture detection.
The homepage release stamp is also build-time data: it reads the root app version from the repository `package.json`, so the published site shows the same semver that release automation cuts.
The changelog page at `/changelog/` is also build-time data: it reads the root `CHANGELOG.md`, renders `Unreleased` first as an in-development entry, and then renders dated release entries in the same order as the source file.

## Publishing Topology

Builds happen in this repository. Deployment publishes the generated `packages/landing/dist/` output into the root of `NodexApp/NodexApp.github.io`.

Repository roles:

- `junyudev/nodex`: source code, build logic, CI, and documentation
- `NodexApp/NodexApp.github.io`: published static artifact only

This split matters because the root org site URL `https://nodexapp.github.io` must be served by a repository named `NodexApp.github.io`.

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
    verified; that mode projects the Release Bundle's exact signed arm64
    appcast snapshot into `/updates/stable/arm64/appcast.xml`, rejects feed
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

The Pages repository stores only the signed feed control plane. Full ZIPs and
deltas remain immutable assets of the corresponding `junyudev/nodex` GitHub
Release. Feed recovery replays a verified release snapshot; it does not
regenerate or re-sign an existing release.

No SPA fallback is needed. `packages/landing/public/CNAME` is part of the
production custom-domain contract and must remain in the generated Pages tree;
`nodexapp.github.io` is only the underlying Pages host.

## Content Notes

The v1 site is intentionally narrow:

- a single-screen homepage
- a generated changelog page at `/changelog/`
- a primary release CTA
- a secondary Homebrew install affordance
- minimal privacy and terms pages

Release CTA contract:

- default CTA target: `https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg`
- Nodex requires Apple silicon and macOS 15 or later; the CTA does not select an architecture.

If the site later expands into screenshots, FAQ, or longer-form product copy, keep that work inside `packages/landing` rather than pulling renderer code into the package.
