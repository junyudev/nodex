# Nodex

![Nodex preview](packages/landing/public/og.png)

**Local-first orchestration for coding agents.** Nodex gives your agent work a real workspace: tasks, threads, terminals, files, diffs, and history stay together instead of scattering across chat tabs and terminal windows.

[Download for macOS](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg) · [Intel Mac download](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-x64.dmg) · [Product page](https://nodex.jyu.app) · [Changelog](https://nodex.jyu.app/changelog/)

## Why Nodex

Coding agents are powerful, but the surrounding workflow can get messy fast. One task turns into a chat, a terminal, a diff, a browser tab, a note, and a half-remembered branch name.

Nodex is built for that moment. It turns agent work into a visible operating surface where every project has its own board, every session has context, and every change can be reviewed where the conversation happened.

## What You Can Do

- **Coordinate work on a live board.** Track ideas, bugs, experiments, and implementation tasks across project-specific views.
- **Keep the agent close to the task.** Start Codex sessions from cards or project chats, then keep the thread attached to the work it belongs to.
- **Review changes in context.** Open diffs next to the conversation that produced them, with files and terminals available in the same workspace.
- **Work safely in local projects or new worktrees.** Keep exploratory agent runs isolated without losing the thread, task, or review trail.
- **Capture richer task context.** Write card notes with blocks, attachments, images, toggles, and runnable thread sections.
- **Resume without losing context.** Reopen windows, sessions, panels, and project state so long-running work stays organized.

## Who It Is For

Nodex is for builders who use coding agents as part of real development work:

- solo developers running several agent tasks at once
- founders turning product ideas into working software
- engineers who want a local, inspectable command center for agent-assisted changes
- anyone who wants agent output tied back to tasks, branches, files, and review

## The Shape of the App

Think of Nodex as a local desktop workbench:

- a project board for deciding what should happen next
- a session space for talking to agents
- a card editor for durable product and implementation notes
- side panels for files, browser previews, terminals, and reviews
- local history and backups so the workspace remains yours

It is intentionally local-first. The core task state lives on your machine, and the app is designed around project folders you already own.

## Try Nodex

Nodex is in beta for macOS 15 and later, with builds for Apple silicon and Intel Macs.

Start with the [public product page](https://nodex.jyu.app), or download the latest build directly:

- [Apple silicon Mac](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg)
- [Intel Mac](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-x64.dmg)

## Use Nodex from Codex or Claude Code

Nodex ships a native CLI and one official `nodex` Agent Skill for working with
Pages, rich Nested Markdown, saved database Views, and Board placement through
the same local Core authority as the desktop app.

After moving `Nodex.app` into `/Applications`, install the CLI from
**Nodex → Install Command Line Tool…**, then choose **Set Up Agent Skills…**.
The equivalent terminal command is:

```bash
nodex setup
```

Native setup is deliberately global-only and link-based:

- Codex: `~/.agents/skills/nodex`
- Claude Code: `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/nodex`

It never writes project files, creates `.agents/.nodex`, copies the Skill, or
overwrites an existing file, directory, or foreign link. `nodex skills status`
distinguishes a current managed link, a compatible external install, a missing
target, and a conflict; rerunning setup safely completes an interrupted install.

For a third-party global or project-local copy, use the public official mirror:

```bash
npx skills@latest add NodexApp/skills
```

For a reproducible release, use the mirror's annotated version tag:
`npx skills@latest add https://github.com/NodexApp/skills/tree/vX.Y.Z`.

That copy remains externally owned—Nodex reports compatible content but never
adopts, updates, or removes it. The Skill requires a compatible local `nodex`
CLI and a shell-capable local Agent. It does not make local Nodex data available
to Claude.ai, remote Cowork/cloud sessions, or any machine where Nodex is not
running. `nodex capabilities --json` reports the installed Agent interface and
bundle revision; a newer Skill/CLI mismatch must be resolved by updating Nodex,
not by bypassing its typed commands or reading SQLite directly.

## Project Notes

Contributor setup, build, release, and deployment details are kept outside this pitch page:

- [Developer guide](docs/development.md)
- [macOS release notes](docs/release-macos.md)
- [Landing site operations](docs/landing-site.md)
