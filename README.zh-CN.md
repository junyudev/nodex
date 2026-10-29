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
  <a href="https://nodex.jyu.app">官网</a> ·
  <a href="https://github.com/junyudev/nodex/releases/latest">下载</a> ·
  <a href="https://nodex.jyu.app/changelog/">更新日志</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/junyudev/nodex/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/junyudev/nodex?style=flat-square&label=release" /></a>
  <img alt="macOS 15+ on Apple silicon" src="https://img.shields.io/badge/macOS-15%2B%20·%20Apple%20silicon-black?style=flat-square&logo=apple" />
  <a href="LICENSE"><img alt="Apache 2.0 License" src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" /></a>
</p>

<picture>
  <source srcset=".github/assets/readme/hero-dark.webp" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/hero-light.webp" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/hero-light.webp" alt="往 Nodex 收件箱里连发六条消息，每条都被规划给合适的 Agent，其中一条被手动换成 Claude Opus，清空后的收件箱会说明它是怎么规划的；Claude 对话分派 GPT 子 Agent，点开其中一个能看到它在 Codex 里干活；性能分析对话把 HTML 报告附到 Page 上，在旁边的浏览器 tab 里打开" width="100%">
</picture>

## 安装

```bash
brew install --cask junyudev/tap/nodex
```

也可以下载 [Apple 芯片版 Nodex](https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg)，
拖进“应用程序”即可。Nodex 目前为 Beta，支持 macOS 15 及以上。直接登录你已有的 Codex、Claude Code
或 OpenCode 账号；什么都没有，也可以先用 OpenCode 的免费模型。

## 为什么是 Nodex

Coding Agent 已经很会干活了。麻烦的是活儿以外的部分：把一堆想法整理成 prompt、给每件事挑模型、
记住哪个对话在做哪件事、再把结果搬回笔记里。

Nodex 负责的就是这部分。把想法一股脑丢进收件箱，每一条都会变成一个 Page，并附上执行方案：
去哪个 Project、用哪个 Agent 和模型、哪些部分交给别人做。活儿在真正的对话里跑，旁边就是终端、
diff 和浏览器；结果落回你和 Agent 都能编辑的 Pages。所有数据都留在你的 Mac 上。

## 有什么不一样

### 一个会做规划的收件箱

一口气丢进好几条消息。Nodex 一次性为每一条给出建议：在合适的 Project 里，用合适的 Agent、
模型和推理强度开一个新对话；发给已经在做这件事的对话；归档到别的 Project；或者先留作笔记。
新对话的方案还会写明哪些部分由主 Agent 交给其他模型去做。你确认之前，什么都不会运行。

### 让 Claude 领队，让 GPT 开工

<picture>
  <source srcset=".github/assets/readme/fanout-dark.webp" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/fanout-light.webp" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/fanout-light.webp" alt="一个 Claude Code 对话把三部分工作交给 Codex 里的 GPT-6.1 Sol，另一部分交给 OpenCode 的免费模型" width="100%">
</picture>

任何对话都可以用 `delegate_task` 把一部分工作交给另一家的模型。比如让 Claude Code 里的 Opus 领队，
同时派出几个 Codex 里的 GPT-6.1 Sol 子 Agent 并行干活，盯着每个任务的进度，再把结果合并回来。
每个子 Agent 都有自己的对话，可以随时打开、追问或叫停。

### 已付费的订阅全用上，再加上免费模型

<picture>
  <source srcset=".github/assets/readme/agents-dark.webp" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/agents-light.webp" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/agents-light.webp" alt="Nodex 模型菜单筛选出 OpenCode 免费模型，旁边是 Claude 和 Codex 的用量表" width="100%">
</picture>

内置 Codex、Claude Code 和 OpenCode，另外还能从 ACP Registry 安装 40 多个 Agent，比如 Gemini CLI、
Qwen Code、GLM Agent。OpenCode 的免费模型就在同一个模型菜单里。用量表显示每个订阅还剩多少，
收件箱挑模型时也会把余量考虑进去：贵的模型花在刀刃上，其余交给免费模型。对话中途换模型也没关系，
下一条消息会把之前的对话完整交接给新的 Agent。

### 工作成果落在你们共同编辑的 Pages 里

<picture>
  <source srcset=".github/assets/readme/pages-dark.webp" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/pages-light.webp" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/pages-light.webp" alt="Nodex 看板上一个任务移到 Review，它的 Agent 把发现写进 Page、附上文件，火焰图从 Page 的文件树打开到旁边的新 tab" width="100%">
</picture>

Pages 支持属性、关联、子页面和历史版本，用 Board 和 List 视图来组织。每条收件箱消息本身就是一个
Page，沿着 Triage → Plan → Build → Review → Ship 推进。Agent 通过 `nodex` CLI 和 Agent Skill
读写 Pages，把报告、截图和 trace 作为 Page Files 附上去；点开文件会在 Page 旁边的新 tab 里打开，HTML
直接在浏览器 tab 里渲染。改动会实时出现在你打开的窗口里。

### 说一句话，整个看板自己理好

<picture>
  <source srcset=".github/assets/readme/tidy-dark.webp" media="(prefers-color-scheme: dark)">
  <source srcset=".github/assets/readme/tidy-light.webp" media="(prefers-color-scheme: light)">
  <img src=".github/assets/readme/tidy-light.webp" alt="在 agent 输入栏里说一句话，Agent 读完 15 个 Page，一次批量应用 13 处修改，List 按状态重新分组" width="100%">
</picture>

你的 Pages 和 Databases 都存在本地的一个 Profile 里，Agent 可以批量读取和修改。用大白话提要求就行，
Agent 在后台用 `nodex` CLI 完成：一条只读 SQL 查询读完整个 backlog，再用一次原子批量编辑写回
（数据被改过就拒绝，不会覆盖更新的内容）。你打开的视图会随之实时重新分组。

## Agent 周边的一切

- **Worktree 和 Environment**：每个对话都可以有自己隔离的 checkout。
- **Review**：在对话旁边查看未暂存、已暂存、分支和上一轮的 diff。
- **浏览器、终端和文件**：就开在需要它们的对话旁边。
- **Scheduled**：在你的 Mac 上运行定时任务和 heartbeat。
- **Canvas、命令面板、分屏和多窗口**：再忙的工作区也能理得清。
- **Page 历史版本和整个工作区的快照**：什么都能恢复。
- **导入对话**：把已有的 Codex 和 Claude Code 对话一起带过来。

## 文档

- [产品规格](docs/product-specs/nodex-product-spec.md)
- [命令行](docs/CLI.md)
- [架构](docs/ARCHITECTURE.md)
- [开发指南](docs/development.md)

## 许可证

Nodex 以 [Apache License 2.0](LICENSE) 开源。
