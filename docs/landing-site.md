# Landing Site

This document is the source of truth for the public Nodex landing site and its GitHub Pages deployment path.

## Overview

The landing site lives in `packages/landing`. It is a small Vite-built static site that intentionally stays separate from the Electron renderer and its design-token stack.

Why it is separate:
- the site is published to `https://nodexapp.github.io`
- it should stay fast and low-risk
- it should not inherit desktop-app-only code, CSS, or runtime assumptions

The source of truth stays in this repository. Published static output is pushed to the separate org-site repository `NodexApp/NodexApp.github.io`.

## Local Commands

Run these from the repo root:

```bash
bun run dev:landing
bun run build:landing
bun run preview:landing
```

## Package Layout

`packages/landing` contains:
- `index.html` for the homepage
- `privacy/index.html`
- `terms/index.html`
- `src/styles.css` for landing-only Tailwind and token styling
- `src/download-cta.ts` for the direct-download CTA upgrade logic
- `public/` for copied brand assets, the committed OG image, and `.nojekyll`

The site is a static multi-page build. It does not use React Router or any client-side routing fallback.
The homepage keeps the primary macOS CTA no-JS-safe by pointing at the stable arm64 GitHub Release alias first, then downgrades to the x64 alias only when browser signals positively identify Intel.

## Publishing Topology

Builds happen in this repository. Deployment publishes the generated `packages/landing/dist/` output into the root of `NodexApp/NodexApp.github.io`.

Repository roles:
- `Asphocarp/nodex`: source code, build logic, CI, and documentation
- `NodexApp/NodexApp.github.io`: published static artifact only

This split matters because the root org site URL `https://nodexapp.github.io` must be served by a repository named `NodexApp.github.io`.

## GitHub Workflows

Two workflows manage the site:

- `.github/workflows/landing-site.yml`
  - validates the landing package on pull requests and relevant pushes
  - installs dependencies and runs `bun run build:landing`

- `.github/workflows/deploy-landing-site.yml`
  - runs on `main` changes affecting the landing site and on manual dispatch
  - builds the site in this repo
  - clones `NodexApp/NodexApp.github.io`
  - replaces its root contents with the built artifact
  - commits only when there is a diff

## Required Secrets

The deploy workflow expects this secret in `Asphocarp/nodex`:

- `NODEXAPP_GITHUB_IO_TOKEN`
  - fine-grained GitHub token
  - repository access: `NodexApp/NodexApp.github.io`
  - permission: `Contents: Read and write`

## Pages Configuration

In `NodexApp/NodexApp.github.io`, configure GitHub Pages to publish from the default branch root.

No SPA fallback is needed.
No CNAME file is needed for the default `nodexapp.github.io` hostname.

## Content Notes

The v1 site is intentionally narrow:
- a single-screen homepage
- a primary release CTA
- a secondary Homebrew install affordance
- minimal privacy and terms pages

Release CTA contract:
- default CTA target: `https://github.com/Asphocarp/nodex/releases/latest/download/Nodex-latest-arm64.dmg`
- x64 CTA target: `https://github.com/Asphocarp/nodex/releases/latest/download/Nodex-latest-x64.dmg`
- browser-side detection is conservative; ambiguous clients stay on arm64 and only explicit Intel evidence switches to x64

If the site later expands into screenshots, FAQ, or longer-form product copy, keep that work inside `packages/landing` rather than pulling renderer code into the package.
