# Nodex Insights

Turn your local AI coding agent usage into two shareable cards, Skyline and Receipt. Copy an image, save a PNG, or open an X post and paste in your card. The cards are the ones [Nodex](https://nodex.jyu.app), the cross-agent workspace and notebook, draws in its Insights.

Requires Node.js 20 or later.

```sh
npx nodex-insights
npx nodex-insights --year 2025 --no-cost
npx nodex-insights --since 2026-09-01 --until 2026-11-30 --name "Alex"
```

By default, the cards cover January 1 through today in your system time zone. Choose an earlier calendar year with `--year`, or use a custom range with `--since` and `--until`. Both endpoints are inclusive.

| Flag                   | What it does                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `--year <YYYY>`        | Use a calendar year. Previous years end on December 31.                                     |
| `--since <YYYY-MM-DD>` | Start a custom range on this date. The end defaults to today.                               |
| `--until <YYYY-MM-DD>` | End a custom range on this date. On its own, it starts the range on January 1 of that year. |
| `--no-cost`            | Omit estimated cost.                                                                        |
| `--name <text>`        | Put a name of up to 32 characters on the cards.                                             |
| `--no-open`            | Print the local preview URL so you can open it yourself.                                    |
| `--help`               | Show usage.                                                                                 |
| `--version`            | Show the installed version.                                                                 |

The report uses the [sources supported by ccusage](https://github.com/ccusage/ccusage#supported-sources), including Claude Code, Codex, OpenCode, Amp, pi-agent, GitHub Copilot CLI, and Gemini CLI. Cost is estimated at API list price. Your actual bill may differ.

## Privacy

npm may download the package the first time you run it. Once launched, the CLI runs its pinned ccusage with `--offline` and telemetry disabled. The CLI makes no outbound network requests, and the browser preview serves a single local document with embedded assets. Nothing is uploaded unless you choose to post it.

## 中文

运行 `npx nodex-insights`，即可把本机 AI 编程智能体的用量生成天际线和账单卡片。你可以复制图片、保存 PNG，或在 X 中发帖。预览页可以切换到中文。费用按 API 标价估算，可用 `--no-cost` 隐藏。使用记录在本机离线读取，只有发布时才会上传卡片。
