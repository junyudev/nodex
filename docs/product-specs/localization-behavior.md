# Localization Behavior

Nodex shows its interface in **English** or **Simplified Chinese**. This document
owns the display-language contract, how product copy is written so it can be
translated, and the Simplified Chinese terminology.

## Display language

- Settings → General → App → **Language** offers **Auto detect** followed by each
  shipped language, named in its own script (`English`, `简体中文`).
- Auto detect follows the operating system's preferred languages in order and
  uses the first one Nodex ships. Every Chinese variant uses Simplified Chinese.
  If the list is empty, Nodex uses the locale reported for the desktop app. If no
  supported language matches, Nodex uses English.
- The choice belongs to the Profile (top-level `locale` in `config.toml`). A
  missing or unsupported value means Auto detect. Changing it switches every open
  window and native menu without a restart. New dialogs and notifications use the
  current language.
- Main resolves the display language before creating any windows. Workbench and
  auxiliary windows read the active language before showing localized startup
  text or mounting React. They follow Main's updates while open.
- Only Nodex's own interface is translated. Page content, chat transcripts, Agent
  output, file names, model names and external product names (Codex, Claude Code,
  OpenCode, ChatGPT, GitHub, MCP, Git, Markdown) stay as written. Details that come
  from Agents, Core or the operating system (error causes, command output) are
  shown as received inside translated framing.
- Text Nodex sends to Agents (prompts, instructions, tool descriptions) and text
  it stores as content stays in English regardless of the display language.
- Untitled chats, built-in tab names, and Library root labels follow the display
  language. Names supplied by the user, a shell, or a website remain as written.

## Writing translatable copy

- Every user-visible string is a message: a stable dotted `id`, an English ICU
  `defaultMessage`, and a `description` when the English alone is ambiguous.
  Renderer code imports `FormattedMessage`, `useIntl`, `defineMessages` and
  `getIntl` from `@/lib/i18n`; Main formats native copy with `getMainIntl()` from
  `src/main/i18n/main-intl.ts`. Shared modules declare descriptors with
  `defineMessages` from `src/shared/i18n/messages.ts` and let the consumer format them.
- Ids follow `<area>.<surface>.<element>` in camelCase segments, for example
  `settings.general.restoreWindows.label`. One id always has one English text.
- Use ICU arguments instead of concatenation, `plural` for counts, `select` for
  variants, and rich-text tags (`<link>…</link>`) for inline markup, so each
  language can reorder the sentence.
- Format at render or call time, never at module load: a module constant holds
  descriptors, not strings. Dates, times, numbers, lists and relative times use the
  active `intl` formatters rather than hard-coded `en-US`.
- The language switches without a reload, and React Compiler memoizes a helper call
  on its visible inputs. In render paths, pass the component's `intl` from
  `useIntl()` into formatting helpers instead of letting them read `getIntl()`;
  event handlers, toasts and menus built when opened may use `getIntl()`.
- Keep stored values in English and localize them where they are shown: a new
  Session's stored `New chat` title, built-in tab titles and Library locations are
  presented through their display helpers. An ICU argument that renders Chinese text
  takes no surrounding spaces.
- `vp run i18n:check` fails when a message lacks a translation, a translation is
  unused, ICU arguments or tags differ between languages, or the catalog
  (`src/shared/i18n/catalogs/zh-CN.json`, sorted by id) is unsorted.
  `vp run i18n:check -- --write` sorts it and drops unused entries.

## Simplified Chinese style

- Address the person as **你**, never 您. Keep the tone plain and brief.
- Use full-width punctuation (，。：；？！（）“”). Keep `…` as a single ellipsis
  character. End a sentence with 。 only when the English ends with a period.
- Put one space between Chinese and Latin letters, digits or ICU arguments
  (`已选择 {count} 个文件`, `在 Finder 中显示`), but not before or after full-width punctuation.
- Buttons and menu items are short verb phrases (保存, 重命名, 在新窗口中打开).
  Errors start with 无法 (`Couldn't load X` → 无法加载 X). Confirmations ask
  `要…吗？`. Progress uses 正在…… (`Loading…` → 正在加载…).
- Keep key names as printed on keyboards (Enter, Esc, Shift, Cmd, Ctrl, Option).

### Terminology

| English                   | 简体中文               | English                 | 简体中文           |
| ------------------------- | ---------------------- | ----------------------- | ------------------ |
| Agent                     | 智能体                 | Subagent                | 子智能体           |
| Agent Instance            | 智能体实例             | Model                   | 模型               |
| Reasoning effort          | 推理强度               | Fast mode               | 快速模式           |
| Chat                      | 聊天                   | New chat                | 新聊天             |
| Session                   | 会话                   | Thread                  | 对话               |
| Conversation              | 对话                   | Turn                    | 轮次               |
| Run (noun)                | 运行                   | Prompt                  | 提示词             |
| Composer                  | 输入框                 | Follow-up               | 后续消息           |
| Queue / Steer             | 排队 / 引导            | Context                 | 上下文             |
| Handoff                   | 交接                   | Compact (context)       | 压缩               |
| Project                   | 项目                   | Environment             | 环境               |
| Worktree                  | 工作树                 | Branch                  | 分支               |
| Commit                    | 提交                   | Diff                    | 差异               |
| Staged / Unstaged         | 已暂存 / 未暂存        | Pull request            | Pull Request       |
| Review                    | 审查                   | Terminal                | 终端               |
| Browser                   | 浏览器                 | Command palette         | 命令面板           |
| Page                      | 页面                   | Block                   | 块                 |
| Document                  | 文档                   | Library                 | 资料库             |
| File                      | 文件                   | Folder                  | 文件夹             |
| Database                  | 数据库                 | Data Source             | 数据源             |
| View                      | 视图                   | Board                   | 看板               |
| Table                     | 表格                   | List                    | 列表               |
| Calendar                  | 日历                   | Canvas                  | 画布               |
| Card                      | 卡片                   | Property                | 属性               |
| Status                    | 状态                   | Priority                | 优先级             |
| Assignee                  | 负责人                 | Filter / Sort / Group   | 筛选 / 排序 / 分组 |
| Inbox                     | 收件箱                 | Automation              | 自动化             |
| Dry run / Ask first / Run | 试运行 / 先询问 / 运行 | Coordinator             | 协调者             |
| Space                     | 空间                   | Member                  | 成员               |
| Profile                   | 个人资料               | Device                  | 设备               |
| Remote access             | 远程访问               | Invite                  | 邀请               |
| Plugin                    | 插件                   | Skill                   | 技能               |
| MCP server                | MCP 服务器             | Hooks                   | 钩子               |
| Permission mode           | 权限模式               | Full access             | 完全访问权限       |
| Read only                 | 只读                   | Approve / Deny          | 批准 / 拒绝        |
| Dictation                 | 听写                   | Readback                | 朗读               |
| Usage                     | 用量                   | Insights                | 洞察               |
| Snapshot                  | 快照                   | Backup                  | 备份               |
| Revision                  | 版本                   | History                 | 历史记录           |
| Restore                   | 恢复                   | Archive / Unarchive     | 归档 / 取消归档    |
| Pin / Unpin               | 置顶 / 取消置顶        | Duplicate               | 创建副本           |
| Delete / Remove           | 删除 / 移除            | Untitled                | 无标题             |
| Attachment                | 附件                   | Mention                 | 提及               |
| Reminder                  | 提醒                   | Sidebar                 | 边栏               |
| Tab                       | 标签页                 | Panel                   | 面板               |
| Settings                  | 设置                   | General                 | 常规               |
| Appearance                | 外观                   | Keyboard shortcuts      | 键盘快捷键         |
| Notifications             | 通知                   | Account                 | 账户               |
| Sign in / Sign out        | 登录 / 退出登录        | Prepaid credit / Top up | 预付额度 / 充值    |
| Image                     | 图片                   | Fork / Side chat        | 分叉 / 侧边聊天    |
| Schedule (Automation)     | 计划                   | Transcribe / Transcript | 转写 / 转写文本    |
| Estimate                  | 预估                   | Annotate                | 批注               |
