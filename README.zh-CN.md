<p align="center">
  <a href="https://nodex.jyu.app">
    <picture>
      <source srcset=".github/assets/nodex-wordmark-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/nodex-wordmark-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/nodex-wordmark-light.svg" alt="Nodex logo">
    </picture>
  </a>
</p>

<h3 align="center">一个收件箱。所有 Agent。全在本地。</h3>

<p align="center">
  开源工作台：让 Claude Code、Codex 和 OpenCode 在同一套本地 Pages 上协作。
</p>

<p align="center">
  <a href="https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg"><picture><source srcset=".github/assets/readme/install/macos-zh-dark.svg" media="(prefers-color-scheme: dark)"><img alt="下载 Nodex macOS" src=".github/assets/readme/install/macos-zh-light.svg" height="44"></picture></a>
  <a href="https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe"><picture><source srcset=".github/assets/readme/install/windows-zh-dark.svg" media="(prefers-color-scheme: dark)"><img alt="下载 Nodex Windows" src=".github/assets/readme/install/windows-zh-light.svg" height="44"></picture></a>
  <a href="https://testflight.apple.com/join/Yz8Kpcty"><picture><source srcset=".github/assets/readme/install/iphone-zh-dark.svg" media="(prefers-color-scheme: dark)"><img alt="下载 Nodex iPhone" src=".github/assets/readme/install/iphone-zh-light.svg" height="44"></picture></a>
  <a href="https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-android.apk"><picture><source srcset=".github/assets/readme/install/android-zh-dark.svg" media="(prefers-color-scheme: dark)"><img alt="下载 Nodex Android" src=".github/assets/readme/install/android-zh-light.svg" height="44"></picture></a>
</p>

<p align="center">
  <a href="https://nodex.jyu.app"><picture><source srcset="https://img.shields.io/badge/%E5%AE%98%E7%BD%91-nodex.jyu.app-f5f5f4?style=flat&labelColor=262b33" media="(prefers-color-scheme: dark)"><img alt="Website" src="https://img.shields.io/badge/%E5%AE%98%E7%BD%91-nodex.jyu.app-161618?style=flat&labelColor=ececea"></picture></a>
  <a href="https://github.com/junyudev/nodex/releases/latest"><picture><source srcset="https://img.shields.io/github/v/release/junyudev/nodex?style=flat&label=%E7%89%88%E6%9C%AC&labelColor=262b33&color=f5f5f4" media="(prefers-color-scheme: dark)"><img alt="Latest release" src="https://img.shields.io/github/v/release/junyudev/nodex?style=flat&label=%E7%89%88%E6%9C%AC&labelColor=ececea&color=161618"></picture></a>
  <a href="https://nodex.jyu.app/changelog/"><picture><source srcset="https://img.shields.io/badge/%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97-%E6%9C%80%E8%BF%91%E6%9B%B4%E6%96%B0-f5f5f4?style=flat&labelColor=262b33" media="(prefers-color-scheme: dark)"><img alt="Changelog" src="https://img.shields.io/badge/%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97-%E6%9C%80%E8%BF%91%E6%9B%B4%E6%96%B0-161618?style=flat&labelColor=ececea"></picture></a>
  <a href="LICENSE"><picture><source srcset="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache%202.0-f5f5f4?style=flat&labelColor=262b33" media="(prefers-color-scheme: dark)"><img alt="Apache 2.0 License" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache%202.0-161618?style=flat&labelColor=ececea"></picture></a>
  <a href="https://github.com/junyudev/nodex/stargazers"><picture><source srcset="https://img.shields.io/github/stars/junyudev/nodex?style=flat&label=stars&labelColor=262b33&color=f5f5f4&logo=github&logoColor=888888" media="(prefers-color-scheme: dark)"><img alt="GitHub stars" src="https://img.shields.io/github/stars/junyudev/nodex?style=flat&label=stars&labelColor=ececea&color=161618&logo=github&logoColor=888888"></picture></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <b>中文</b>
</p>

<picture>
  <source srcset=".github/assets/readme/hero-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/hero-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/hero-zh-light.avif" alt="往 Nodex 收件箱里连发六条消息，每条都被规划给合适的 Agent，其中一条被手动换成 Claude Opus，清空后的收件箱会说明它是怎么规划的；Claude 对话分派 GPT 子 Agent，点开其中一个能看到它在 Codex 里干活；性能分析对话把 HTML 报告附到 Page 上，在旁边的浏览器 tab 里打开" width="100%">
</picture>

Coding Agent 已经很会干活了。活儿以外的部分还得你自己来：把想法整理成 prompt、给每件事挑模型、
记住哪个对话在做哪件事、再把结果归档。**Nodex 负责的就是这部分**，而且所有数据都留在你的电脑上。

### 一个会做规划的收件箱

一口气丢进好几条消息。Nodex 为每一条给出建议：新对话该去哪个 Project、用哪个 Agent、模型和推理强度，
或者直接发给已经在做这件事的对话。你确认之前，什么都不会运行。

### 让 Claude 领队，让 GPT 开工

<picture>
  <source srcset=".github/assets/readme/fanout-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/fanout-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/fanout-zh-light.avif" alt="一个 Claude Code 对话把三部分工作交给 Codex 里的 GPT-6.2 Sol，另一部分交给 OpenCode 的免费模型" width="100%">
</picture>

任何对话都可以把一部分工作交给另一家的模型。Claude Code 对话派出几个 Codex 里的 GPT-6.2 Sol，
盯着每个任务，再把结果合并回来。每个子 Agent 都有自己的对话，可以随时打开、追问或叫停。

<details>
<summary>让 Claude 默认这样分工</summary>

把下面这段加进 `~/.claude/CLAUDE.md`，它只在 Nodex 里生效。

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

### 已付费的订阅全用上，再加上免费模型

<picture>
  <source srcset=".github/assets/readme/agents-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/agents-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/agents-zh-light.avif" alt="Nodex 模型菜单筛选出 OpenCode 免费模型，旁边是 Claude、Codex 和 Antigravity 的用量表" width="100%">
</picture>

内置 Codex、Claude Code、Antigravity 和 OpenCode，还能从 ACP Registry 安装 40 多个 Agent，OpenCode
的免费模型就在同一个菜单里。用量表显示每个订阅还剩多少，收件箱挑模型时会把余量考虑进去。

### 工作成果落在你们共同编辑的 Pages 里

<picture>
  <source srcset=".github/assets/readme/pages-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/pages-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/pages-zh-light.avif" alt="Nodex 看板上一个任务移到 Review，它的 Agent 把发现写进 Page、附上文件，火焰图从 Page 的文件树打开到旁边的新 tab" width="100%">
</picture>

每条收件箱消息都是一个 Page，在看板上从 Triage 一路推进到 Done。Agent 通过 `nodex` CLI 读写 Pages，
把报告、截图和 trace 作为文件附上去。它们的改动会实时出现在你打开的窗口里。

### 说一句话，整个看板自己理好

<picture>
  <source srcset=".github/assets/readme/tidy-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/tidy-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/tidy-zh-light.avif" alt="在 agent 输入栏里说一句话，Agent 读完 15 个 Page，一次批量应用 13 处修改，List 按状态重新分组" width="100%">
</picture>

用大白话提要求就行。Agent 先用一条只读查询读完整个 backlog，再用一次原子批量编辑写回，
不会覆盖更新的内容。你打开的视图会随之重新分组。

### 离开工位，不离开你的 Agent

<picture>
  <source srcset=".github/assets/readme/mobile-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/mobile-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/mobile-zh-light.avif" alt="在手机上批准对话里的一条命令，身后电脑上的同一个对话随即开始工作；手机从家里的 Wi-Fi 切到 Tailscale，往收件箱丢一条消息，再开启它建议的对话，新对话随即出现在电脑上" width="100%">
</picture>

Nodex Mobile 能看到所有对话，需要你处理的排在最前。可以批准操作、追加消息、停止运行，
或者随手把想法丢进收件箱，离线时也行。它通过局域网或 Tailscale 直连你的电脑，全程端到端加密，
中间没有 Nodex 服务器。[开始配置](https://nodex.jyu.app/download/#mobile)。

## Agent 周边的一切

- **Worktree 和 Environment**：每个对话都可以有自己隔离的 checkout。
- **Review**：在对话旁边查看未暂存、已暂存、分支和上一轮的 diff。
- **浏览器、终端和文件**：就开在需要它们的对话旁边。
- **Scheduled**：在你的电脑上运行定时任务和 heartbeat。
- **Canvas、命令面板、分屏和多窗口**：再忙的工作区也能理得清。
- **Page 历史版本和整个工作区的快照**：什么都能恢复。
- **导入对话**：把已有的 Codex、Claude Code 和 Antigravity 对话一起带过来。

## 安装

Nodex 目前为 Beta。直接登录你已有的 Codex、Claude Code、Antigravity 或 OpenCode 账号；什么都
没有，也可以先用 OpenCode 的免费模型。

- **macOS 15+**（Apple 芯片）：`brew install --cask junyudev/tap/nodex`，或下载
  [磁盘映像](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg)。
- **Windows 11**（x64）：[安装包](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe)。
  安装包尚未代码签名，如果出现 SmartScreen，点“更多信息”，再点“仍要运行”。
- **iPhone 和 Android**：[TestFlight 公测](https://testflight.apple.com/join/Yz8Kpcty) 或 [APK](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-android.apk)。
  Nodex Mobile 需要电脑上的 Nodex 保持运行。

## 社区

有问题、遇到 bug 或有想法，欢迎来 [Discord](https://discord.com/invite/9yRa5SUeDz) 或 QQ 群
**1126214921**。在 Nodex 里，点左下角的菜单，打开“反馈与社区”即可找到它们。

## 文档

[产品规格](docs/product-specs/nodex-product-spec.md) · [命令行](docs/CLI.md) ·
[架构](docs/ARCHITECTURE.md) · [开发指南](docs/development.md)

<sub>以 [Apache License 2.0](LICENSE) 开源。</sub>
