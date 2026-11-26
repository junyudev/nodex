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
The Astro configuration loads as native ESM, and Vite uses the landing package's
explicit TypeScript configuration. Builds must not discover unrelated ancestor
projects or depend on their installed frameworks, including in linked worktrees.

### Changelog data

The site takes published entry slugs and media references from each stable tag's
change files. Their grouped text and order must match `CHANGELOG.md`. Releases
through `v0.1.2` may be missing their tags from the public archive. These releases
and tags without change files have text-only entries when no source is available.

The deployment workflow shallow-fetches stable `vX.Y.Z` tags and sets
`NODEX_LANDING_DEPLOY=1`. A missing tag from `v0.1.3` onward or a missing or
invalid published media description fails that build. Other builds, including
shallow CI checkouts, warn and use the archived text or the available media.

`vp run dev:landing` resolves unreleased screenshots and clips from the same
local store as `media:add` (including `NODEX_MEDIA_STORE` overrides). It serves
the originals and uses `ffprobe` from FFmpeg for clip dimensions. Production
builds keep Unreleased text-only.

### Demo media capture

Start the landing server separately, then record its capture pages:

```bash
vp run capture:landing --demo all --theme both --locale both
vp run capture:landing --og
```

The recorder uses Playwright Chromium and ffmpeg. Install the browser with
`vp exec playwright install chromium` if needed. ffmpeg needs H.264 and VP9
encoding; `brew install ffmpeg-full` supplies these on macOS. The looping AVIF
needs `avifenc` (`brew install libavif`). Nothing is installed automatically.

Record media you will publish against a production preview: the development server can stretch a
long demo's timeline by a second or two.

`--base-url` defaults to `http://127.0.0.1:4330`. With several checkouts running, that
port may serve another checkout's site and the recording silently shows its demos; start
this checkout's server on a free port and pass it with `--base-url`. `--out` defaults to
`notes.local/artifacts/landing-captures` in the checkout, which git ignores. `--demo`, `--theme`, `--fps` (30), and `--scale` select the
capture. `--locale` accepts `en` (default), `zh-CN`, or `both`. Simplified Chinese
captures use the `<demo>-zh-<theme>` filename stem; `README.zh-CN.md` shows those loops from
`.github/assets/readme/` and `README.md` the English ones. Without `--scale`, each demo renders at the quarter-step device scale that puts it nearest
1800px wide, about twice the width GitHub shows a README image, so the published frames are the
browser's own pixels and not a resampled larger capture; `--og` defaults to 2. `--og` renders only the [social cards](#social-cards) and replaces their committed images in `public/`,
unless `--out` names another directory; it needs Chromium but not ffmpeg.
Run `vp run capture:landing --help` for all options. Named outputs are replaced
on subsequent runs; temporary full-resolution frames are removed after each capture.

`CAPTURE_DEMOS` in `src/demos/capture-demos.ts` owns the available demo IDs and
designed sizes. Each `/capture/<id>/?capture` or `/zh-cn/capture/<id>/?capture`
page must expose a stable
`[data-capture-root]` at the page origin and set `window.__nodexCapture` with
`durationMs` and a `done` promise. The recorder measures the root, including its
padding, warms fonts, then navigates to a fresh one-shot playback. It observes
the handle's assignment and completion without changing any animation clocks.

CDP screencast PNGs are sampled on their real presentation timestamps into a
constant-rate sequence. Missing frames are held, surplus frames dropped, and
the static tail is retained until `done`. The encoded duration follows real
elapsed time, rounded up by at most one output frame; heavy system load can
extend it because the demo bounds long animation deltas. Each capture writes
a timing JSON report, full-resolution first/last review PNGs, a 70% poster,
1260px H.264/VP9 videos, and a looping 4:4:4 AVIF at up to 20fps and its captured pixel
width capped to 1900px. MP4 is capped at 4 MB, AVIF quality is reduced as needed
to stay within 4 MB, and the 960px,
15fps palette GIF is kept only if it fits within 10 MB. The summary prints the
dimensions, duration, and decimal MB size of each media file. Review the first,
poster, and last frames before publishing; interpolation cannot restore motion
that Chromium never delivered.

The loop is AVIF because an interface is mostly still between frames, which AV1 predicts cheaply,
and full chroma keeps coloured text sharp. Keep it off animated WebP: its lossy encoder skips a
pixel that changed by less than a quality-dependent tolerance, so a slow fade leaves blocks of
stale colour on screen. Frames are PNG for the same reason: Chromium's JPEG halves chroma at
every quality.

## Package Layout

`packages/landing` contains:

- `astro.config.mjs` for static output, React islands, and the Tailwind Vite plugin
- `src/layouts/BaseLayout.astro` for metadata, font preloads, and system theme detection
- `src/pages/index.astro` and `src/pages/download/index.astro` for the English homepage and download page
- `src/pages/zh-cn/` for their Simplified Chinese routes, rendered by the same page components
- `src/pages/changelog/index.astro` for the generated changelog page
- `src/pages/privacy/index.astro` and `src/pages/terms/index.astro` for the legal pages
- `src/components/` for shared site navigation, footer, wordmark, and the social card frame
- `src/sections/` for the homepage sections, each an Astro component that places one demo island
- `src/demos/` for the interactive product demos, hydrated with Astro client directives and animated with `motion/react`; `lumen.ts` holds the fictional workspace and the current agent and model names every demo shares
- `src/replica/` for presentational copies of the desktop UI (window shell, Inbox, chat, Board) and of Nodex Mobile that the demos compose
- `src/pages/capture/` for the unlisted pages the media recorder captures, including each social card at `/capture/og/<card>/`
- `src/styles/global.css` for landing-only Tailwind, Geist fonts, and the system-driven dark variant
- `src/styles/theme.css` for site colors and the desktop and phone app colors the replicas use in each theme
- `src/lib/site.ts` for typed release and install constants
- `src/lib/social-cards.ts` for the social cards the site publishes
- `src/changelog.ts` for the changelog page's view of `CHANGELOG.md` and `changes/`, read through `src/shared/changelog.ts`, and the entry helpers the page uses
- `src/download-cta.ts` for copying the Homebrew install command
- `public/` for copied brand assets, the committed social cards, and `.nojekyll`
- `scripts/capture-demos.ts` for recording demos into README and social media
- `dist/` for generated static output

The site is a static multi-page build. It does not use React Router or any client-side routing fallback.
The homepage and downloads are available in English at `/` and `/download/`, and in Simplified
Chinese at `/zh-cn/` and `/zh-cn/download/`. The language switch links to the equivalent page,
with reciprocal `hreflang` links and a canonical URL for each language. Visiting `/` opens
Simplified Chinese when Chinese is the browser's preferred language. The switch saves the visitor's
explicit choice in their browser and takes precedence on later visits. Automatic navigation keeps
the original query and fragment, and analytics counts the destination page only, with the source
of the original visit. With JavaScript
disabled, the static language links work from the English default. Product demos follow the
homepage language, including the replica UI and the scripted workspace content. Social card
artwork, the changelog, and legal pages are in English.
Download links point at the stable alias assets every GitHub Release carries: `Nodex-latest-arm64.dmg` for macOS and `Nodex-latest-windows-x64.exe` for Windows. The homepage's download action follows the visitor's platform. An inline script in `BaseLayout.astro` marks Windows visitors with `data-os="windows"`, and the `windows` Tailwind variant switches the action to the Windows installer and its SmartScreen note before first paint. Without the script, or on any other platform, the page offers macOS. The nav's Download goes to `/download/`, which lists every build without relying on JavaScript.
The same page's `#mobile` card offers Nodex Mobile: the public TestFlight beta for iPhone and the `Nodex-latest-android.apk` alias every stable release carries, both in `DOWNLOADS` so their clicks count the same way. A Google Play button appears once `GOOGLE_PLAY_URL` names a listing. The homepage's mobile section and Link a device in Settings → Remote both point at this card rather than at a store.
Windows downloads appear only when the release the site describes carries Windows installers: `windowsDownloadsAvailable` in `src/lib/site.ts` compares the root app version with 0.5.0, the last stable release published without them. Once a later release is the oldest one the site can describe, that gate can be removed.
The homepage release stamp is build-time data: the typed `VERSION_LABEL` constant imports the root app version from the repository `package.json`, so the published site shows the same semver that release automation cuts.
The changelog page at `/changelog/` is also build-time data: it shows the changes not released yet from `changes/` first, as Unreleased and without a headline, then each published release from the root `CHANGELOG.md`, newest first, marks the newest as Latest, and lists every release in a rail that follows the reader. Kinds of change always read Added, Changed, Deprecated, Removed, Fixed, Security. The release in development and the latest release show all their additions and changes; every other list shows its first entries and opens the rest on request. Each entry leads with its first sentence, so write that sentence to stand on its own.

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
  - only moves the pages forward: `.landing-source` at the target root records the
    commit the pages were built from, and a deploy from an older commit, such as a
    release promoted while newer site changes reached `main`, keeps those pages and
    publishes only its update feed
  - commits only when there is a diff
  - is also called by release promotion after the immutable app Release is
    verified; that mode projects the Release Bundle's exact signed macOS arm64
    and Windows x64 appcast snapshots into their stable feed paths, rejects feed
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

Each channel has one macOS arm64 feed and one Windows x64 feed:

- `https://nodex.jyu.app/updates/stable/arm64/appcast.xml`
- `https://nodex.jyu.app/updates/stable/windows-x64/appcast.xml`
- `https://nodex.jyu.app/updates/nightly/arm64/appcast.xml`
- `https://nodex.jyu.app/updates/nightly/windows-x64/appcast.xml`

The Pages repository stores only the signed feed control plane. Full ZIPs,
Windows installers and deltas remain immutable assets of the corresponding `junyudev/nodex` GitHub
Release. Feed recovery replays a verified release snapshot; it does not
regenerate or re-sign an existing release. Projection preflights all feeds before
writing, refuses rollback and same-build byte drift, and verifies canonical public
feed bytes plus immutable enclosure availability after push. Nightly promotion
changes only `updates/nightly/`; ordinary landing deploys preserve all feeds.

No SPA fallback is needed. `packages/landing/public/CNAME` is part of the
production custom-domain contract and must remain in the generated Pages tree;
`nodexapp.github.io` is only the underlying Pages host.

## Content Notes

Claude Code, Codex and Antigravity, the built-in Agents, and DeepSeek, connected with the reader's
own API key, are the story's four peers: each has a mark beside the headline, a place in the
tagline and real work in the demos, as a lead or a subagent, a route from the Inbox and its own
usage meter. OpenCode's free models and the ACP Registry round them out. Keep that balance when a
demo changes, in the marks, the copy and who does what. A DeepSeek key runs on Nodex's Codex, so
its lines take Codex's color while its whale mark names it.

The homepage tells one story in order. The hero headline's three lines are also the hero demo's
chapters and jump to them: **One inbox.** captures a burst of messages and suggests a place for
each one, routes to Codex, Antigravity, DeepSeek, a running chat and Notes, the reader moves
one chat's model from GPT-6.2 Sol to Claude Opus before starting it, and the cleared Inbox shows
how it plans; **Every agent.** opens that chat, where the reader points at its Claude lead, opens
its Gemini subagent in the Subagents tab beside it, watches it finish in Antigravity, then steps
back to the chat's Subagents map as the last part comes home; **All local.** opens a Gemini chat
with its Page in the side tab group, where the agent writes its findings, attaches its report and
marks the Page ready for review, and the reader opens the report beside the Page. Icons beside
the last two lines show what they cover, and a line's short caption appears only while its
chapter plays. The sentence beside the headline is the README's tagline; change both together.
Sections then cover Aerial view, with every chat at work and its whole tree of subagents across the
three peers, closing on [what the name means](product-specs/brand-language.md#the-name), every
provider's models and plans in one menu, work landing in Pages on a Board until it waits for the
reader to accept it, one plain request that has an agent file a whole backlog, and reaching all of
it from a phone, followed by a feature grid and a final download call.

The hero reaches something worth watching within about a second. Its opening burst sweeps each
message through the composer in a fraction of a second, and the Inbox plans each one while the
rest are still arriving, so every route shows while its card is still in view.

The nav, the footer and Aerial view's closing line set the name with `Wordmark.astro`, which lays
the word out in layers so its x can draw as two delegation lines crossing in Claude Code's and
Codex's colors while keeping the font's own shape: in the nav while the link is pointed at, and
elsewhere once it is all in view, where it stays. Its clip geometry is measured from Geist
SemiBold, so remeasure it in the `wordmark` utility if the site's font changes.

Product demos are scripted re-enactments built from replicas of the interface, not recordings:

- Demos show each flow as it is best designed, not only as today's interface draws it. Where a
  surface or flow would read better another way, the demo leads with that design and becomes
  its design reference for the app; keep what is already right in the app (its shell, labels,
  icons and colors) faithful so the replica still reads as Nodex.
- Every capability a demo shows must ship with the release the site is published with. Plan
  the release and the site together when a demo leads the app.
- Split tab groups follow the app: each group's tabs sit in the titlebar above its own pane,
  and a chat's Page opens in the side group. A Page's Files hang beneath the Files property as an
  outline across the Properties' width, with a guide for each open level and the chat that
  attached them named beside the count, as the app draws them. An HTML File opened there becomes
  a preview tab right after its Page, with the path back to the Page above it, and renders as the
  page it is; an image opened with a double click keeps a tab of its own.
- Work Pages read as the app's Board does: the workflow's Triage, Todo, In Progress, In Review
  and Done, empty columns folded to a strip, and each card and Page Status naming whose move it
  is, such as `Codex is working` or `Ready for your review` beside Accept.
- The cleared Inbox copies the app's own summary of how it plans: the model it is Suggested by,
  each Model guide family the reader's Agents offer and then each other Agent by name, beside
  what is left of its plan's weekly budget, and the reader's Routing preferences, in the app's
  labels and with the guide's one-line notes from `src/shared/inbox-model-guide.ts`; change the
  replica when the app changes them.
- Pointing at a chat's model button shows the model that leads it.
- An Inbox suggestion reads as the app's: a new chat's prompt, then each sentence the suggestion
  adds on its own beside a checked box, such as handing part of the work to another model. A
  suggestion never plans subtasks; the receiving Agent decides how to delegate, and the chat
  receives the prompt with each checked addition as its own paragraph. A message that is the
  person's own clear request keeps their words with a short routing note and no additions, so a
  card that shows additions starts from a thought rather than a request. The decision's model half
  names the model only when it differs from the Inbox's own.
- Subagents follow the app's Agent identity and its delegation map (`src/replica/Subagents.tsx`
  keeps the app's geometry): a subagent's card names its Agent beside the harness mark, its
  avatar and name, then its model and effort; each line takes the color of the harness the work
  went to, runs dashes while it works and turns solid as the result comes home. The map sits beside
  its lead when there is room and beneath it, on a rail, when there is not, and Aerial view stacks
  one band per chat. The Subagents tab header marks the child's Agent beside its model and effort,
  and its task reads "Sent by" with the sending chat's mark and title, so a Claude lead with a
  Gemini subagent reads at a glance.
- Nodex Mobile's replica draws the app at its real point sizes in its own colors and scales as one
  device, with a fingertip for a pointer. Its demo stands the phone in front of the computer running
  the same chats, joined through the routes Settings → Remote lists, because what sets it apart is
  that the phone reaches your own computer: a tap travels the line and then changes the computer's
  sidebar. Both routes stay in every frame, the local network and Tailscale, so any still says so.
  A screen too narrow for both shows the phone alone under a strip naming the routes.
- Replicas don't use motion's `layout` animations. Its projection ignores a scaled parent, and a
  Stage or device always scales, so a row lands in the wrong place.
- Every demo shares the fictional Lumen workspace in `src/demos/lumen.ts`; never show real
  user data, account names, or paths. Keep the English and Chinese workspace text together there,
  and match the desktop catalog for replica UI labels in `src/replica/copy.ts`.
- Replicas read the app's own artwork where it has some: subagent avatars are loaded from
  `src/renderer/assets/subagent-avatars/` at build time (and a change there redeploys the site),
  so redrawn icons appear without copying files.
- A demo's script is a list of named cues on one clock (`src/demos/timeline.ts`). It plays while
  on screen, shows its final frame under reduced motion, and plays once from the start under
  `?capture` for the recorder.
- A visitor gives a demo a few seconds, so every demo keeps moving: its first beat lands within
  0.8 s, no beat waits more than 2 s for the next, and its final frame holds at most 2.5 s before
  it plays again. Typing is a quick sweep; text a reader needs stays on screen after it is sent.
  A hold that needs longer is too much to read, so cut the text or split it into beats.
  `PACING` in `src/demos/timeline.ts` sets these limits, and a test checks every demo's script.

The README embeds media recorded from the same demos under `.github/assets/readme/`. Record
again with `vp run capture:landing` after changing a demo the README shows.

### Social cards

A link to the site previews as a social card. A page names its card through `BaseLayout`'s
`socialCard`, and `SOCIAL_CARDS` owns each card's published file and alt text, so the tags and the
recorder read one list. Home, Download and Changelog each have a card; Privacy and Terms use Home's. Every card signs
the name with what it means, `Every agent, a node.` The Download card lists every
build the page offers: the desktop app for macOS and Windows, and Nodex Mobile for iPhone and
Android.

The home card shows what sets Nodex apart: every agent at work together, in Aerial view. Two chats
fill its window, each with its tree of subagents, so all four peers appear doing something: a
Claude Code lead with Codex, Antigravity and OpenCode subagents, and an Antigravity lead whose Codex
subagent passes work to DeepSeek. Never trade that for size; a single chat reads as an ordinary
one. The window is enlarged a little and holds still, as a card does. The agents' marks stand alone
beneath its headline: they are known well enough to need no names, and the card's alt text says
them.

People see a card in a feed at about 500px wide, not at its 1200×630 design size:

- Keep every word worth reading at about 14px or larger at the design size, and on one line where
  it can be.
- Keep everything inside the central 1200×600, since a feed can crop a card to 2:1. A feed can also
  lay its own label over the lower left, so only the site's address sits there; the page's promise
  stays at the card's center.
- Show nothing a release would make stale, such as a version number. Cards are recorded when they
  change, not with each release. Anything a card shows follows the demos' rule and must have shipped.

After changing a card or the replica it shows, record it again with `vp run capture:landing --og`,
compare the result at 500px wide, and commit the images. Platforms cache previews, so a replaced
image can take days to reach a link that was already shared.

Release CTA contract:

- default CTA target: `https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg`
- Nodex requires Apple silicon and macOS 15 or later; the CTA does not select an architecture.

Keep landing work inside `packages/landing` rather than pulling renderer code into the package.
