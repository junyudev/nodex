# Landing Site

This document is the source of truth for the public Nodex landing site and its GitHub Pages deployment path.

## Overview

The landing site lives in `packages/landing`. Astro generates its static pages, with React islands for interactive content and Tailwind v4 for styling. It stays separate from the Electron renderer and its design-token stack.

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
vp run --filter @nodex/landing test
```

Astro owns the development server, production build, and preview server. The root
commands delegate to the landing package through Vite+. Its Vite plugins use the
workspace's Vite+ alias. The focused tests run an isolated production build and
check the generated pages and public assets. They run from the repository root
because the shared Vitest setup resolves generated Markdown assets from that directory.

### Demo media capture

Start the landing server separately, then record its capture pages:

```bash
vp run capture:landing --demo all --theme both
vp run capture:landing --og
```

The recorder uses Playwright Chromium and ffmpeg. Install the browser with
`vp exec playwright install chromium` if needed. ffmpeg needs H.264, VP9, and
WebP encoding; `brew install ffmpeg-full` supplies these on macOS. If ffmpeg
lacks WebP encoding, the recorder also supports an installed `img2webp`
(`brew install webp`). Nothing is installed automatically.

`--base-url` defaults to `http://127.0.0.1:4330`. `--out` defaults to
`notes.local/artifacts/landing-captures` in the checkout, which git ignores. `--demo`, `--theme`, `--fps` (30), and `--scale` (2) select the
capture. `--og` renders only a dark hero still at 70% as `og.png` (1200×630).
Run `vp run capture:landing --help` for all options. Named outputs are replaced
on subsequent runs; temporary full-resolution frames are removed after each capture.

`CAPTURE_DEMOS` in `src/demos/capture-demos.ts` owns the available demo IDs and
designed sizes. Each `/capture/<id>/?capture` page must expose a stable
`[data-capture-root]` at the page origin and set `window.__nodexCapture` with
`durationMs` and a `done` promise. The recorder measures the root, including its
padding, warms fonts, then navigates to a fresh one-shot playback. It observes
the handle's assignment and completion without changing any animation clocks.

CDP screencast JPEGs at quality 95 are sampled on their real presentation timestamps into a
constant-rate sequence. Missing frames are held, surplus frames dropped, and
the static tail is retained until `done`. The encoded duration follows real
elapsed time, rounded up by at most one output frame; heavy system load can
extend it because the demo bounds long animation deltas. Each capture writes
a timing JSON report, full-resolution first/last review PNGs, a 70% poster,
1260px H.264/VP9 videos, and a looping WebP at up to 20fps and its captured pixel
width capped to 1200px. MP4 is capped at 4 MB, WebP quality is reduced as needed
to stay within 8 MB, and the 960px,
15fps palette GIF is kept only if it fits within 10 MB. The summary prints the
dimensions, duration, and decimal MB size of each media file. Review the first,
poster, and last frames before publishing; interpolation cannot restore motion
that Chromium never delivered.

## Package Layout

`packages/landing` contains:

- `astro.config.ts` for static output, React islands, and the Tailwind Vite plugin
- `src/layouts/BaseLayout.astro` for metadata, font preloads, and system theme detection
- `src/pages/index.astro` for the homepage
- `src/pages/changelog/index.astro` for the generated changelog page
- `src/pages/privacy/index.astro` and `src/pages/terms/index.astro` for the legal pages
- `src/components/` for shared site navigation and footer
- `src/sections/` for the homepage sections, each an Astro component that places one demo island
- `src/demos/` for the interactive product demos, hydrated with Astro client directives and animated with `motion/react`; `lumen.ts` holds the fictional workspace and the current agent and model names every demo shares
- `src/replica/` for presentational copies of the desktop UI (window shell, Inbox, chat, Board) that the demos compose
- `src/pages/capture/` for the unlisted pages the media recorder captures, including the `og` social preview
- `src/styles/global.css` for landing-only Tailwind, Geist fonts, and the system-driven dark variant
- `src/styles/theme.css` for site colors and the app colors the replicas use in each theme
- `src/lib/site.ts` for typed release and install constants
- `src/changelog.ts` for build-time `CHANGELOG.md` parsing and the entry helpers the changelog page uses
- `src/download-cta.ts` for copying the Homebrew install command
- `public/` for copied brand assets, the committed OG image, and `.nojekyll`
- `scripts/capture-demos.ts` for recording demos into README and social media
- `dist/` for generated static output

The site is a static multi-page build. It does not use React Router or any client-side routing fallback.
The homepage links directly to the stable Apple silicon GitHub Release alias without JavaScript or browser architecture detection.
The homepage release stamp is build-time data: the typed `VERSION_LABEL` constant imports the root app version from the repository `package.json`, so the published site shows the same semver that release automation cuts.
The changelog page at `/changelog/` is also build-time data: it reads the root `CHANGELOG.md`, shows `Unreleased` first as in development and then each dated release in source order, marks the newest as Latest, and lists every release in a rail that follows the reader. Kinds of change always read Added, Changed, Deprecated, Removed, Fixed, Security. The release in development and the latest release show all their additions and changes; every other list shows its first entries and opens the rest on request. Each entry leads with its first sentence, so write that sentence to stand on its own.

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

The homepage tells one story in order. The hero headline's three lines are also the hero demo's
chapters and jump to them: **One inbox.** captures a burst of messages and plans each one, the
reader moves one plan's lead from GPT-6.1 Sol to Claude Opus before starting it, and the
cleared Inbox shows how it plans; **Every agent.** opens that chat, where the reader points at
its Claude lead and then at one of its GPT subagents; **All local.** opens a chat with its Page
in the side tab group, where the agent attaches its report and the reader opens it. Icons beside the last two lines show what they cover, and a line's short caption appears
only while its chapter plays. The sentence beside the headline is the README's tagline; change
both together.
Sections then cover cross-provider delegation, every provider's models and plans in one menu,
work landing in Pages on a Board, and one plain request that has an agent file a whole backlog,
followed by a feature grid and a final download call.

Product demos are scripted re-enactments built from replicas of the interface, not recordings:

- Demos show each flow as it is best designed, not only as today's interface draws it. Where a
  surface or flow would read better another way, the demo leads with that design and becomes
  its design reference for the app; keep what is already right in the app (its shell, labels,
  icons and colors) faithful so the replica still reads as Nodex.
- Every capability a demo shows must ship with the release the site is published with. Plan
  the release and the site together when a demo leads the app.
- Split tab groups follow the app: each group's tabs sit in the titlebar above its own pane,
  and a chat's Page opens in the side group. A file opened from a Page's Files opens as a new
  tab in that Page's group: HTML in a browser tab that renders it, any other file in a file tab.
- The cleared Inbox summarizes how it plans, with the app's own labels: the model it is
  Suggested by, Nodex's Model guide beside what is left of each plan's weekly budget, and the
  reader's Routing preferences. Pointing at a chat's model button shows the model that leads it,
  and a subagent's card marks its provider, so a Claude lead with Codex subagents reads at a
  glance.
- Every demo shares the fictional Lumen workspace in `src/demos/lumen.ts`; never show real
  user data, account names, or paths.
- Replicas read the app's own artwork where it has some: subagent avatars are loaded from
  `src/renderer/assets/subagent-avatars/` at build time (and a change there redeploys the site),
  so redrawn icons appear without copying files.
- A demo's script is a list of named cues on one clock (`src/demos/timeline.ts`). It plays while
  on screen, shows its final frame under reduced motion, and plays once from the start under
  `?capture` for the recorder.

The README embeds media recorded from the same demos under `.github/assets/readme/`. Record
again with `vp run capture:landing` after changing a demo the README shows.

Release CTA contract:

- default CTA target: `https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg`
- Nodex requires Apple silicon and macOS 15 or later; the CTA does not select an architecture.

Keep landing work inside `packages/landing` rather than pulling renderer code into the package.
