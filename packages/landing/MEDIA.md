# Landing Product Media

The homepage keeps the Zen-style motion and media slots, but the current files
are temporary captures. Do not mark them ready for deployment until the final
set has been recorded and reviewed with the product owner.

## Required files

Each directory below lives under `public/media/` and contains `poster.webp`,
`video.webm`, and `video.mp4`:

- `hero-video` — the complete Page → agent → Review story
- `workspaces` — Shape: structure the task and select relevant context
- `compact-mode` — Run: send context and work with the coding agent
- `glance` — Review: inspect files and diffs beside the chat
- `split-views` — Shared Pages: an agent searches, reads, and updates a Page

Keep each poster at or below 300 KB and each video file at or below 4 MB. Videos
must be silent, loop cleanly, and show the same sanitized Project, task, theme,
and window geometry.

## Review checklist

Inspect every frame for usernames, account identity, absolute home paths,
tokens, notifications, private repository names, and synthetic product output.
Verify desktop and mobile crops, reduced-motion behavior, and both light and
dark themes before changing `landingMediaStatus` in
`src/constants/media.ts` from `pending` to `ready`.

Raw captures belong in `.generated/landing-captures/` and are not committed.
The deployment workflow requires the ready state, so temporary media can be
reviewed locally without replacing the public site.
