<p align="center">
  <a href="https://nodex.jyu.app">
    <picture>
      <source srcset=".github/assets/nodex-wordmark-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/nodex-wordmark-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/nodex-wordmark-light.svg" alt="Nodex logo">
    </picture>
  </a>
</p>

<h3 align="center">跨智能体的工作空间和笔记本。</h3>

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
  <source srcset=".github/assets/readme/aerial-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/aerial-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/aerial-zh-light.avif" alt="鸟瞰视图里三个正在工作的对话：Claude Code 带着 Codex、Antigravity 和 OpenCode 子智能体，Codex 请 Claude 审查后收到结果，Antigravity 的 Codex 子智能体又把截图交给 DeepSeek，每条连线都是对应服务商的颜色" width="100%">
</picture>

### 谁都能带队，谁都能帮忙

1. **用最适合这件事的智能体开一个对话**：Claude Code、Codex、Antigravity、DeepSeek，或者另外 40 多个。
2. **它把一部分工作交给别的智能体。** Claude Code 对话把测试交给 Antigravity 里的 Gemini，把路由交给
   Codex 里的 GPT；Codex 对话也能请 Claude 审查。每份结果都会回到发起它的对话。
3. **从鸟瞰视图看所有对话。** 鸟瞰视图同时显示每个正在工作的对话和它的整棵子智能体树。在对话旁打开
   子智能体就能查看进展；智能体支持时，还能追问或叫停。

<details>
<summary>示例：决定谁带队、谁动手</summary>

这段让 Claude 带队、Codex 动手，Nodex 自己就是这样开发的。把它加进 `~/.claude/CLAUDE.md`，它只在
Nodex 里生效。想让别的智能体带队，就在它自己的指令文件里写一段类似的说明。

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

### 工作成果落在你们共同编辑的 Pages 里

<picture>
  <source srcset=".github/assets/readme/pages-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/pages-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/pages-zh-light.avif" alt="Nodex 看板旁打开着一个 Page：智能体把发现写进 Page、附上文件，Page 进入审查中等待接受，火焰图从 Page 的文件里打开到新 tab" width="100%">
</picture>

每条收件箱消息都是一个 Page。交给项目的工作会在它的看板上从待分流一路推进到已完成，每张卡片都写明下一步轮到谁。智能体通过
`nodex` CLI 读写 Pages，把报告、截图和 trace 作为文件附上去。工作完成后，Page 会停在审查中，等你接受。

### 已付费的订阅全用上，再加上免费模型

<picture>
  <source srcset=".github/assets/readme/agents-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/agents-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/agents-zh-light.avif" alt="Nodex 模型菜单筛选出 OpenCode 免费模型，旁边是 Claude、Codex、Antigravity 和 DeepSeek 的用量表" width="100%">
</picture>

用量表显示每个订阅和每个 API key 还剩多少，收件箱挑模型时会把余量考虑进去。DeepSeek、Kimi、GLM 和
MiniMax 用你自己的 API key 接入，OpenCode 和另外 40 多个智能体可以从 ACP Registry 安装，OpenCode
的免费模型就在同一个菜单里。

### 一个会做规划的收件箱

<picture>
  <source srcset=".github/assets/readme/hero-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/hero-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/hero-zh-light.avif" alt="往 Nodex 收件箱里连发六条消息，每条都得到建议，分别去往 Codex、Antigravity、DeepSeek、正在运行的对话和笔记，其中一条被手动换成 Claude Opus；Claude 对话把路由、测试和文档分别交给 GPT、Gemini 和免费模型，看着 Gemini 子智能体完成后，再回到对话的子智能体协作图；Gemini 对话把分析结果写进 Page、附上 HTML 报告，并标记为待审查" width="100%">
</picture>

一口气丢进好几条消息。Nodex 为每一条给出建议：新对话该去哪个 Project、用哪个智能体、模型和推理强度，
或者直接发给已经在做这件事的对话。你确认之前，什么都不会运行，除非你让 Nodex 替你开始明确的请求。

### 离开工位，不离开你的智能体

<picture>
  <source srcset=".github/assets/readme/mobile-zh-dark.avif" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/mobile-zh-light.avif" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/mobile-zh-light.avif" alt="在手机上批准对话里的一条命令，身后电脑上的同一个对话随即开始工作；手机从家里的 Wi-Fi 切到 Tailscale，往收件箱丢一条消息，再开启它建议的对话，新对话随即出现在电脑上" width="100%">
</picture>

Nodex Mobile 能看到所有对话，需要你处理的排在最前。可以批准操作、追加消息、停止运行，
或者随手把想法丢进收件箱，离线时也行。它通过局域网或 Tailscale 直连你的电脑，全程端到端加密，
中间没有 Nodex 服务器。[开始配置](https://nodex.jyu.app/download/#mobile)。

## 智能体周边的一切

- **用大白话提要求**：智能体先用一条只读查询读完整个 backlog，再用一次原子批量编辑写回，不会覆盖更新的内容。
- **洞察**：统计你的智能体做了什么，连装 Nodex 之前的 Claude Code 和 Codex 历史也算在内，还能生成一张可以分享的卡片。
- **自动化**：按计划、心跳或 GitHub 事件开始工作，也可以先问你。
- **GitHub**：Issue 和 PR 跟着对应的 Page，审查意见和 CI 结果会回到它的对话。
- **Worktree 和 Environment**：每个 Page 的工作都有自己隔离的 checkout。
- **Review**：在对话旁边查看未暂存、已暂存、分支和上一轮的 diff。
- **浏览器、终端和文件**：就开在需要它们的对话旁边。
- **搜索、Canvas、分屏和多窗口**：再忙的工作区也能理得清。
- **团队空间**：在团队自己的主机上共享 Pages、看板和收件箱。
- **Page 历史版本和整个工作区的快照**：什么都能恢复。
- **导入对话**：把已有的 Codex、Claude Code 和 Antigravity 对话一起带过来。

## 安装

Nodex 目前为 Beta。直接登录你已有的 Claude Code、Codex、Antigravity 或 OpenCode 账号，或者填上 DeepSeek 的 API key；什么都
没有，也可以先用 OpenCode 的免费模型。

- **macOS 15+**（Apple 芯片）：`brew install --cask junyudev/tap/nodex`，或下载
  [磁盘映像](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg)。
- **Windows 11**（x64）：[安装包](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe)。
  安装包尚未代码签名，如果出现 SmartScreen，点“更多信息”，再点“仍要运行”。
- **iPhone 和 Android**：[TestFlight 公测](https://testflight.apple.com/join/Yz8Kpcty) 或 [APK](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-android.apk)。
  Nodex Mobile 需要电脑上的 Nodex 保持运行。

## 常见问题

**和终端多路复用器有什么区别？** 多路复用器把所有智能体放在一个地方给你看。在 Nodex 里，它们还会互相
交接工作，收件箱知道每个订阅还剩多少，结果落在等你审查的 Pages 里。

**要钱吗？** Nodex 免费开源。智能体用的是你已有的订阅和 API key，也可以用 OpenCode 的免费模型。

**什么会离开我的电脑？** 你的代码只会发给你的智能体所用的模型服务商。Nodex 会分享匿名的使用和崩溃数据，
从不包含 prompt、代码或文件；可以在“设置 → 常规 → 隐私”里关掉，或者设置 `DO_NOT_TRACK`。

## 社区

有问题、遇到 bug 或有想法，欢迎来 [Discord](https://discord.com/invite/9yRa5SUeDz) 或 QQ 群
**1126214921**。在 Nodex 里，点左下角的菜单，打开“反馈与社区”即可找到它们。

## 文档

[产品规格](docs/product-specs/nodex-product-spec.md) · [命令行](docs/CLI.md) ·
[架构](docs/ARCHITECTURE.md) · [开发指南](docs/development.md)

<sub>以 [Apache License 2.0](LICENSE) 开源。</sub>
