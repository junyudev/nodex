<p align="center">
  <a href="https://nodex.jyu.app">
    <picture>
      <source srcset=".github/assets/nodex-wordmark-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/nodex-wordmark-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/nodex-wordmark-light.svg" alt="Nodex logo">
    </picture>
  </a>
</p>

<h3 align="center">The cross-agent workspace and notebook.</h3>

<p align="center">
  <a href="https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg"><picture><source srcset=".github/assets/readme/install/macos-dark.svg" media="(prefers-color-scheme: dark)"><img alt="Download Nodex for macOS" src=".github/assets/readme/install/macos-light.svg" height="44"></picture></a>
  <a href="https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe"><picture><source srcset=".github/assets/readme/install/windows-dark.svg" media="(prefers-color-scheme: dark)"><img alt="Download Nodex for Windows" src=".github/assets/readme/install/windows-light.svg" height="44"></picture></a>
  <a href="https://testflight.apple.com/join/Yz8Kpcty"><picture><source srcset=".github/assets/readme/install/iphone-dark.svg" media="(prefers-color-scheme: dark)"><img alt="Download Nodex for iPhone" src=".github/assets/readme/install/iphone-light.svg" height="44"></picture></a>
  <a href="https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-android.apk"><picture><source srcset=".github/assets/readme/install/android-dark.svg" media="(prefers-color-scheme: dark)"><img alt="Download Nodex for Android" src=".github/assets/readme/install/android-light.svg" height="44"></picture></a>
</p>

<p align="center">
  <a href="https://nodex.jyu.app"><picture><source srcset="https://img.shields.io/badge/website-nodex.jyu.app-f5f5f4?style=flat&labelColor=262b33" media="(prefers-color-scheme: dark)"><img alt="Website" src="https://img.shields.io/badge/website-nodex.jyu.app-161618?style=flat&labelColor=ececea"></picture></a>
  <a href="https://github.com/junyudev/nodex/releases/latest"><picture><source srcset="https://img.shields.io/github/v/release/junyudev/nodex?style=flat&label=release&labelColor=262b33&color=f5f5f4" media="(prefers-color-scheme: dark)"><img alt="Latest release" src="https://img.shields.io/github/v/release/junyudev/nodex?style=flat&label=release&labelColor=ececea&color=161618"></picture></a>
  <a href="https://nodex.jyu.app/changelog/"><picture><source srcset="https://img.shields.io/badge/changelog-what%27s%20new-f5f5f4?style=flat&labelColor=262b33" media="(prefers-color-scheme: dark)"><img alt="Changelog" src="https://img.shields.io/badge/changelog-what%27s%20new-161618?style=flat&labelColor=ececea"></picture></a>
  <a href="LICENSE"><picture><source srcset="https://img.shields.io/badge/license-Apache%202.0-f5f5f4?style=flat&labelColor=262b33" media="(prefers-color-scheme: dark)"><img alt="Apache 2.0 License" src="https://img.shields.io/badge/license-Apache%202.0-161618?style=flat&labelColor=ececea"></picture></a>
  <a href="https://github.com/junyudev/nodex/stargazers"><picture><source srcset="https://img.shields.io/github/stars/junyudev/nodex?style=flat&label=stars&labelColor=262b33&color=f5f5f4&logo=github&logoColor=888888" media="(prefers-color-scheme: dark)"><img alt="GitHub stars" src="https://img.shields.io/github/stars/junyudev/nodex?style=flat&label=stars&labelColor=ececea&color=161618&logo=github&logoColor=888888"></picture></a>
</p>

<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">中文</a>
</p>

<picture>
  <source srcset=".github/assets/readme/hero-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/hero-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/hero-light.avif" alt="Six messages dropped into the Nodex Inbox each get a suggestion, across Codex, Antigravity, DeepSeek, a running chat and Notes, one moved to Claude Opus by hand; the Claude chat hands its routes, tests and docs to GPT, Gemini and a free model, the reader watches the Gemini subagent finish, then steps back to the chat's Subagents map; a Gemini chat writes its findings into its Page, attaches an HTML report and marks the Page ready for review" width="100%">
</picture>

Coding agents are good at the work. The part around it is still yours: turning ideas into prompts,
picking a model for each, tracking which chat owns what, and filing the results. **Nodex does that
part**, and everything stays on your computer.

### One inbox that plans the work

Drop in a burst of messages. Nodex suggests what to do with each: the Project, agent, model and
effort for a new chat, or the chat that's already on it. Nothing runs until you confirm, unless you
let Nodex start clear requests for you.

### Any agent can lead. Any agent can help.

<picture>
  <source srcset=".github/assets/readme/aerial-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/aerial-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/aerial-light.avif" alt="Aerial view of three chats at work: a Claude Code lead with Codex, Antigravity and OpenCode subagents, a Codex lead whose Claude reviewer reports back, and an Antigravity lead whose Codex subagent hands its screenshots to DeepSeek, each line in its harness's color" width="100%">
</picture>

Any chat can hand parts of its work to another provider: a Claude Code chat gives its tests to
Gemini in Antigravity and its routes to GPT in Codex, while a Codex chat asks Claude to review.
Aerial view shows every chat at work with its whole tree of subagents. Open a subagent beside its
chat to follow along, and reply or stop it where its Agent allows.

<details>
<summary>Make Claude lead and Codex build by default</summary>

Add this to `~/.claude/CLAUDE.md`. It only applies inside Nodex.

```markdown
## Delegating to Codex in Nodex

When you are Claude running in Nodex with the `delegate_task` tool, fan out early and liberally
to Codex subagents. I'm explicitly opting in: this overrides the default lean toward doing work
yourself and spawning sparingly. Outside Nodex, ignore this section.

- **How**: call `delegate_task` with `mode: "async"`, targeting Codex with the newest
  `gpt-*-sol` model in `list_agent_models` and `xhigh` reasoning effort. Launch independent
  tasks in parallel, then end your turn; Nodex wakes you when they settle.
- **Delegate**: work that needs no visual or product taste, such as backend, data and protocol
  changes, migrations, codebase exploration, root-cause investigation, writing and running tests,
  and mechanical refactors. Front-end plumbing that needs no visual judgment can go too.
- **Keep**: work that needs taste, such as UI layout, styling, interaction feel and copy, plus
  architecture decisions, integration and final review.
- **Brief**: each task sees only your prompt. State the goal, references, scope and expected
  outcome, and leave the implementation to it. Give parallel writers disjoint files or their own
  worktree.
- **Review**: read the diffs and evidence, not just the summary. You own the result.
```

</details>

### Bring the plans you pay for. Add the free ones.

<picture>
  <source srcset=".github/assets/readme/agents-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/agents-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/agents-light.avif" alt="The Nodex model menu filtered to free OpenCode models, beside Claude, Codex, Antigravity and DeepSeek usage meters" width="100%">
</picture>

Claude Code, Codex and Antigravity are built in, DeepSeek, Kimi, GLM and MiniMax connect with your
own API key, OpenCode and 40+ more agents install from the ACP Registry, and OpenCode's free models
sit in the same menu. Usage meters show what's left of each plan and each key's balance, and the
Inbox weighs it before it picks a model.

### The work lands in Pages you both edit

<picture>
  <source srcset=".github/assets/readme/pages-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/pages-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/pages-light.avif" alt="A Nodex Board beside an open Page: the agent writes its findings into the Page and attaches its files, the Page moves to In Review and waits for Accept, and the flame graph opens from the Page's Files in a tab" width="100%">
</picture>

Every Inbox message is a Page. Work you hand to a Project moves across its Board to Done, each card
naming whose move it is. Agents read and write Pages through the `nodex` CLI and attach reports, screenshots and
traces as files. When the work is ready, the Page waits In Review for you to accept it.

### Ask once. Watch the whole board sort itself out.

<picture>
  <source srcset=".github/assets/readme/tidy-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/tidy-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/tidy-light.avif" alt="One plain request in the agent dock files a fifteen-task backlog: the agent reads every Page, applies thirteen edits in one batch, and the List regroups by status" width="100%">
</picture>

Ask in plain words. The agent runs one read-only query over your backlog, then one atomic batch of
edits that never overwrites newer changes. The View you have open regroups as it lands.

### Leave your desk. Not your agents.

<picture>
  <source srcset=".github/assets/readme/mobile-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/mobile-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/mobile-light.avif" alt="A phone approves a chat's command and the same chat starts working on the computer behind it; the phone moves from home Wi-Fi to Tailscale, drops a message into the Inbox, and starts the chat it suggests, which appears on the computer" width="100%">
</picture>

Nodex Mobile shows every chat, the ones asking for you first. Answer approvals, queue a follow-up,
stop a run, or drop a thought into the Inbox, even offline. It connects straight to your computer
over your local network or Tailscale, encrypted end to end, with no Nodex server in between.
[Set it up](https://nodex.jyu.app/download/#mobile).

## Everything around the agent

- **Automations** start work on a schedule, a heartbeat or a GitHub event, or ask you first.
- **GitHub** issues and PRs follow their Page; reviews and CI results come back to its chat.
- **Worktrees and Environments** give each Page's work its own isolated checkout.
- **Review** shows unstaged, staged, branch and last-turn diffs beside the chat.
- **Browser, Terminal and Files** open next to the conversation that needs them.
- **Search, Canvas, split panes and multiple windows** keep a busy workspace navigable.
- **Team Spaces** share Pages, Boards and an Inbox on a host your team runs.
- **Page history and whole-workspace snapshots** let you restore anything.
- **Conversation import** brings your existing Codex, Claude Code and Antigravity chats along.

## Install

Nodex is in beta. Sign in with the Claude Code, Codex, Antigravity or OpenCode account you
already have, add a DeepSeek API key, or start with OpenCode's free models.

- **macOS 15+** on Apple silicon: `brew install --cask junyudev/tap/nodex`, or the
  [disk image](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg).
- **Windows 11** on x64: the [installer](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe).
  It isn't code-signed yet, so if SmartScreen appears, choose More info, then Run anyway.
- **iPhone and Android**: [TestFlight beta](https://testflight.apple.com/join/Yz8Kpcty) or [APK](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-android.apk). Nodex
  Mobile needs Nodex running on your computer.

## Community

Bring questions, bug reports and ideas to [Discord](https://discord.com/invite/9yRa5SUeDz) or the
QQ group **1126214921**. Inside Nodex, both are under **Feedback & community** in the menu at the
bottom-left corner.

## Documentation

[Product specification](docs/product-specs/nodex-product-spec.md) ·
[Command-line interface](docs/CLI.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Development guide](docs/development.md)

<sub>Open source under the [Apache License 2.0](LICENSE).</sub>
