/**
 * The fictional workspace every demo shares: one product, three Projects, one burst of Inbox
 * messages. Agent and model names match what Nodex offers today; change them here when the
 * catalog moves on.
 */

import { byLocale, localizer } from "../lib/locale";
import type { BoardCard, Status } from "../replica/Board";
import type { PageFolder } from "../replica/Page";

/** Built-in Agents, and DeepSeek connected with the reader's own API key. */
export type ProviderKind = "codex" | "claude" | "antigravity" | "deepseek" | "opencode";

/** The Agents whose plans report a weekly budget; OpenCode reports none. */
export type MeteredProvider = Exclude<ProviderKind, "opencode">;

/**
 * What is left of each metered plan, as a share of its tightest window; for DeepSeek's prepaid
 * balance, the share of its last top-up.
 */
export type UsageLeft = Readonly<Record<MeteredProvider, number>>;

export interface AgentChoice {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly effort: "High" | "Extra High";
  /** The model is offered without a paid plan. */
  readonly free?: boolean;
}

export const AGENTS = {
  opus: { provider: "claude", model: "Claude Opus 5.5", effort: "High" },
  haiku: { provider: "claude", model: "Claude Haiku 5.5", effort: "High" },
  sol: { provider: "codex", model: "GPT-6.2 Sol", effort: "Extra High" },
  solHigh: { provider: "codex", model: "GPT-6.2 Sol", effort: "High" },
  neon: { provider: "antigravity", model: "Gemini 4 Neon", effort: "High" },
  dsPro: { provider: "deepseek", model: "DeepSeek V4 Pro", effort: "High" },
  dsFlash: { provider: "deepseek", model: "DeepSeek V4.1 Flash", effort: "High" },
  glm: { provider: "opencode", model: "GLM-5.3-Flash Free", effort: "High", free: true },
} as const satisfies Record<string, AgentChoice>;

/** One entry in the model menu, in the order the menu lists them. */
export interface CatalogModel {
  readonly name: string;
  readonly provider: ProviderKind;
  readonly free?: boolean;
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  { name: "GPT-6.2 Sol", provider: "codex" },
  { name: "GPT-6.2 Astra", provider: "codex" },
  { name: "GPT-6.1 Terra", provider: "codex" },
  { name: "GPT-6.1 Sol", provider: "codex" },
  { name: "GPT-6 Astra", provider: "codex" },
  { name: "GPT-6 Sol", provider: "codex" },
  { name: "GPT-6 Luna", provider: "codex" },
  { name: "Claude Opus 5.5", provider: "claude" },
  { name: "Claude Sonnet 5.5", provider: "claude" },
  { name: "Claude Fable 5.2", provider: "claude" },
  { name: "Claude Haiku 5.5", provider: "claude" },
  { name: "Beam Free", provider: "opencode", free: true },
  { name: "DeepSeek V4.1 Flash Free", provider: "opencode", free: true },
  { name: "Flint 40B Free", provider: "opencode", free: true },
  { name: "GLM-5.3-Flash Free", provider: "opencode", free: true },
  { name: "MiMo-V2.6-Flash Free", provider: "opencode", free: true },
  { name: "Nemotron 3 Ultra Free", provider: "opencode", free: true },
  { name: "Nemotron 3.5 Lightning Free", provider: "opencode", free: true },
  { name: "Nemotron 3.5 Super VL Free", provider: "opencode", free: true },
  { name: "Gemini 4 Neon", provider: "antigravity" },
  { name: "Gemini 4 Argon", provider: "antigravity" },
  { name: "Gemini 4 Hydrogen", provider: "antigravity" },
  { name: "Gemini 3.8 Flash", provider: "antigravity" },
  { name: "DeepSeek V4 Pro", provider: "deepseek" },
  { name: "DeepSeek V4.1 Flash", provider: "deepseek" },
];

/** What is left of each paid plan's weekly budget, as the rail's meters and the Inbox read it. */
export const WEEKLY_LEFT: UsageLeft = {
  claude: 0.62,
  codex: 0.71,
  antigravity: 0.84,
  deepseek: 0.58,
};

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  deepseek: "DeepSeek",
  opencode: "OpenCode",
};

export const PROJECTS = ["lumen-web", "lumen-api", "docs"] as const;
export type ProjectName = (typeof PROJECTS)[number];

export type Dispatch =
  | {
      readonly kind: "new_chat";
      readonly project: ProjectName;
      readonly prompt: string;
      readonly agent: AgentChoice;
      /**
       * Sentences the suggestion adds on its own, each with a checkbox; how to run the work, such
       * as handing part of it to another model, is the receiving Agent's to decide.
       */
      readonly additions?: readonly string[];
      /** The chat's title once it starts. */
      readonly chat: string;
    }
  | {
      readonly kind: "send_to_chat";
      readonly chat: string;
      readonly project: ProjectName;
      readonly prompt: string;
    }
  | { readonly kind: "save_to_notes"; readonly summary: string };

export type InboxMessageId =
  | "webhooks"
  | "coldstart"
  | "darkmode"
  | "digest"
  | "changelog"
  | "passkeys";

export interface InboxMessage {
  readonly id: InboxMessageId;
  readonly key: string;
  readonly text: string;
  readonly dispatch: Dispatch;
}

export interface Task {
  readonly key: string;
  readonly title: string;
  readonly priority: "high" | "medium" | "low";
  /** Where the agent files it; tasks without one stay in Triage for the reader. */
  readonly to?: Status;
  /** Auth work is raised to P1 on the way. */
  readonly raise?: boolean;
}

export const lumen = byLocale((locale) => {
  const t = localizer(locale);
  const titles = {
    passkeys: t("Passkey sign-in", "通行密钥登录"),
    coldstart: t("Dashboard cold start", "仪表盘冷启动"),
    darkmode: t("Settings redesign", "设置页改版"),
    webhooks: t("Idempotent Stripe webhooks", "Stripe webhook 幂等处理"),
    changelog: t("v2.4 changelog", "v2.4 更新日志"),
    ratelimit: t("Rate limiter", "限流"),
    digest: t("Weekly workspace digest", "工作区每周摘要"),
    onboarding: t("Onboarding checklist copy", "上手清单文案"),
    audit: t("Audit log export", "导出审计日志"),
  };
  /** In the order the hero sends them, newest last: the passkey fan-out lands right above the composer. */
  const inbox: readonly InboxMessage[] = [
    {
      id: "webhooks",
      key: "LUM-42",
      text: t(
        "Stripe webhooks double-charge when retries overlap",
        "Stripe webhook 的重试撞在一起时会重复扣款",
      ),
      dispatch: {
        kind: "new_chat",
        project: "lumen-api",
        chat: titles.webhooks,
        agent: AGENTS.sol,
        prompt: t(
          "Find why overlapping Stripe retries charge twice, make the handler idempotent, and add a regression test.",
          "查一下 Stripe 并发重试为什么会重复扣款，让处理逻辑支持幂等，再加个回归测试。",
        ),
      },
    },
    {
      id: "coldstart",
      key: "LUM-43",
      text: t("why is dashboard cold start 2.3s?", "仪表盘冷启动怎么要 2.3 秒？"),
      dispatch: {
        kind: "new_chat",
        project: "lumen-web",
        chat: titles.coldstart,
        agent: AGENTS.neon,
        prompt: t(
          "Profile the dashboard's cold start and report the three biggest costs. Don't change code.",
          "分析仪表盘的冷启动，找出最耗时的三项。先别改代码。",
        ),
      },
    },
    {
      id: "darkmode",
      key: "LUM-44",
      text: t("settings dark mode looks washed out", "设置页的深色模式看起来灰蒙蒙的"),
      dispatch: {
        kind: "send_to_chat",
        chat: titles.darkmode,
        project: "lumen-web",
        prompt: t(
          "Settings in dark mode looks washed out. Check contrast on surfaces and secondary text.",
          "设置页的深色模式看起来灰蒙蒙的。检查一下背景和次要文字的对比度。",
        ),
      },
    },
    {
      id: "digest",
      key: "LUM-45",
      text: t(
        "idea: weekly digest email for workspace owners",
        "点子：给工作区所有者发每周摘要邮件",
      ),
      dispatch: {
        kind: "save_to_notes",
        summary: t(
          "An idea for later, not work to start yet. Save it to Notes.",
          "这是之后的点子，暂时不用开始做。保存到笔记。",
        ),
      },
    },
    {
      id: "changelog",
      key: "DOC-12",
      text: t("draft the v2.4 changelog from merged PRs", "根据已合并的 PR 写一版 v2.4 更新日志"),
      dispatch: {
        kind: "new_chat",
        project: "docs",
        chat: titles.changelog,
        agent: AGENTS.dsFlash,
        prompt: t(
          "Draft the v2.4 changelog from PRs merged since v2.3, grouped by Added, Changed and Fixed.",
          "根据 v2.3 以来合并的 PR 草拟 v2.4 更新日志，按新增、变更和修复分组。",
        ),
      },
    },
    {
      id: "passkeys",
      key: "LUM-41",
      // A thought rather than a request, so the suggestion writes the prompt and offers its own
      // additions; a clear request would go through in the person's words.
      text: t(
        "passkeys for sign-in? keep passwords one more release",
        "登录改用通行密钥？密码再留一个版本",
      ),
      dispatch: {
        kind: "new_chat",
        project: "lumen-web",
        chat: titles.passkeys,
        agent: AGENTS.opus,
        prompt: t(
          "Replace password sign-in with passkeys across web and API, keeping passwords as a fallback for one release.",
          "将网页端和 API 的登录方式改为通行密钥，密码登录作为后备方案保留一个版本。",
        ),
        additions: [
          t(
            "Hand the WebAuthn routes to GPT-6.2 Sol in Codex.",
            "把 WebAuthn 路由交给 Codex 里的 GPT-6.2 Sol。",
          ),
          t(
            "Have Gemini 4 Neon in Antigravity write the end-to-end tests for both sign-in paths.",
            "让 Antigravity 里的 Gemini 4 Neon 为两种登录方式编写端到端测试。",
          ),
          t("Give the docs to a free model.", "文档交给免费模型。"),
        ],
      },
    },
  ];

  /** A message's Page key, which stays with the Page wherever its work goes. */
  const inboxKey = (id: InboxMessageId) => inbox.find((message) => message.id === id)!.key;

  /**
   * The passkey chat's subagents, one on each other harness, as its transcript names them. The
   * Claude lead keeps the sign-in UI and the session flow for itself.
   */
  const subagents = [
    {
      id: "webauthn",
      name: t("WebAuthn routes", "WebAuthn 路由"),
      avatar: "04-aperture",
      agent: AGENTS.sol,
      objective: t(
        "Add registration and assertion routes with a 5-minute challenge store.",
        "添加注册和验证路由，挑战值有效期为 5 分钟。",
      ),
      prompt: t(
        "Add WebAuthn registration and assertion routes under app/api/auth/webauthn, with a challenge store that expires after five minutes. Leave password sign-in untouched.",
        "在 app/api/auth/webauthn 下添加 WebAuthn 注册和验证路由，挑战值 5 分钟后过期。密码登录保持原样。",
      ),
      diff: { added: 412, removed: 38 },
    },
    {
      id: "tests",
      name: t("Sign-in tests", "登录测试"),
      avatar: "19-whirl",
      agent: AGENTS.neon,
      objective: t(
        "Cover passkey and password sign-in end to end.",
        "端到端覆盖通行密钥和密码两种登录方式。",
      ),
      prompt: t(
        "Write end-to-end tests for signing in with a passkey and with a password, including the fallback. Run them in Chromium and WebKit.",
        "为通行密钥和密码登录编写端到端测试，涵盖回退到密码登录的流程，并在 Chromium 和 WebKit 中运行。",
      ),
      diff: { added: 298 },
    },
    {
      id: "docs",
      name: t("Passkey docs", "通行密钥文档"),
      avatar: "00-marigold",
      agent: AGENTS.glm,
      objective: t(
        "Document passkey sign-in and the one-release password fallback.",
        "说明通行密钥登录，以及仅保留一个版本的密码后备方案。",
      ),
      prompt: t(
        "Document passkey sign-in for users and admins, and when the password fallback goes away.",
        "为用户和管理员说明如何用通行密钥登录，以及何时停用密码后备方案。",
      ),
      diff: { added: 64, removed: 12 },
    },
  ] as const;

  /**
   * The other chats working while the passkeys are under way, as Aerial view shows them: a Codex
   * chat that asks Claude to review its fix, and an Antigravity chat whose Codex subagent hands
   * its screenshots to DeepSeek in turn.
   */
  const aerial = {
    webhooks: {
      line: t("Making the webhook handler idempotent", "正在让 webhook 处理逻辑支持幂等"),
      review: {
        id: "review",
        name: t("Retry race review", "重试竞态审查"),
        avatar: "10-compass",
        agent: AGENTS.opus,
        diff: { added: 18, removed: 6 },
      },
    },
    settings: {
      line: t("Retuning dark surfaces and secondary text", "正在调整深色背景和次要文字"),
      question: t(
        "Keep the accent brighter in dark mode, or match light?",
        "深色模式的强调色要更亮一些，还是和浅色一致？",
      ),
      audit: {
        id: "audit",
        name: t("Contrast audit", "对比度检查"),
        avatar: "18-quadrant",
        agent: AGENTS.solHigh,
        diff: { added: 46, removed: 31 },
      },
      shots: {
        id: "shots",
        parent: "audit",
        name: t("Theme screenshots", "主题截图"),
        avatar: "22-origami",
        agent: AGENTS.dsFlash,
      },
    },
  } as const;

  /**
   * What the cold-start chat finds and attaches to its Page. Durations keep a non-breaking space
   * so a unit never wraps onto its own line.
   */
  const findings = [
    t(
      "Hydrating the whole workspace tree before first paint — 1.1 s",
      "首次绘制前对整个工作区树执行水合：1.1 秒",
    ),
    t("Charts bundle isn’t split (840 KB) — 0.6 s", "图表代码未拆包（840 KB）：0.6 秒"),
    t("Font request blocks render — 0.3 s", "字体请求阻塞渲染：0.3 秒"),
  ] as const;

  /** The lumen-web Board while the passkeys are under way: everything in Triage and Todo is placed. */
  const cards: readonly BoardCard[] = [
    {
      id: "passkeys",
      title: titles.passkeys,
      body: t(
        "Replace password sign-in with passkeys; keep passwords for one release.",
        "改用通行密钥登录，密码登录再保留一个版本。",
      ),
      status: "Doing",
      turn: { kind: "working", provider: "claude" },
      chat: { provider: "claude", working: true },
    },
    {
      id: "darkmode",
      title: titles.darkmode,
      body: t("Contrast on surfaces and secondary text.", "检查背景和次要文字的对比度。"),
      status: "Doing",
      turn: { kind: "working", provider: "antigravity" },
      chat: { provider: "antigravity", working: true },
    },
    {
      id: "coldstart",
      title: titles.coldstart,
      body: t(
        "Profile the cold start and report the three biggest costs.",
        "分析冷启动，找出最耗时的三项。",
      ),
      status: "Doing",
      turn: { kind: "working", provider: "antigravity" },
      chat: { provider: "antigravity", working: true },
    },
    {
      id: "onboarding",
      title: titles.onboarding,
      body: t("Shorter steps, one action each.", "缩短每个步骤，每步只做一件事。"),
      status: "Review",
      turn: { kind: "review" },
    },
    {
      id: "marketing",
      title: t("Dark mode for the marketing site", "官网深色模式"),
      body: t("Follow the system theme on every page.", "每个页面都跟随系统主题。"),
      status: "Done",
    },
  ];

  /** The lumen-web backlog that piled up in Triage, newest first; Inbox Pages keep their keys. */
  const tasks: readonly Task[] = [
    { key: inboxKey("coldstart"), title: titles.coldstart, priority: "medium", to: "Review" },
    {
      key: inboxKey("passkeys"),
      title: titles.passkeys,
      priority: "medium",
      to: "Doing",
      raise: true,
    },
    { key: "LUM-40", title: t("Upgrade React to 20", "将 React 升级到 20"), priority: "low" },
    {
      key: "LUM-36",
      title: t("Settings dark mode contrast", "设置页深色模式的对比度"),
      priority: "low",
      to: "Done",
    },
    {
      key: "LUM-35",
      title: t("Passkey prompt flicker", "通行密钥提示闪烁"),
      priority: "high",
      to: "Review",
    },
    { key: "LUM-33", title: titles.onboarding, priority: "low" },
    {
      key: "LUM-31",
      title: t("Fix the flaky upload test", "修复偶尔失败的上传测试"),
      priority: "medium",
      to: "Done",
    },
    { key: "LUM-30", title: titles.audit, priority: "medium", to: "Plan" },
    {
      key: "LUM-28",
      title: t("Remember auth on trusted devices", "在受信任的设备上保持登录"),
      priority: "low",
      to: "Doing",
      raise: true,
    },
    {
      key: "LUM-26",
      title: t("Session timeout banner", "会话超时提示条"),
      priority: "medium",
      to: "Done",
    },
    {
      key: "LUM-24",
      title: titles.digest,
      priority: "low",
      to: "Plan",
    },
    {
      key: "LUM-23",
      title: t("SSO auth loop in Safari", "Safari 中的 SSO 循环登录"),
      priority: "medium",
      to: "Doing",
      raise: true,
    },
    { key: "LUM-21", title: t("Billing page copy", "账单页面文案"), priority: "low", to: "Plan" },
    {
      key: "LUM-19",
      title: t("Auth tokens expire mid-session", "身份验证令牌在会话中途过期"),
      priority: "medium",
      to: "Doing",
      raise: true,
    },
    {
      key: "LUM-12",
      title: t("Dark mode for the marketing site", "官网深色模式"),
      priority: "low",
      to: "Done",
    },
  ];

  const usage = {
    claude: {
      title: "Claude",
      plan: "Max",
      windows: [
        { label: t("5-hour", "5 小时"), left: 0.38, reset: t("Resets 11:10 AM", "11:10 重置") },
        {
          label: t("Weekly", "每周"),
          left: 0.64,
          reset: t("Resets Thu 9:00 AM", "周四 09:00 重置"),
        },
      ],
    },
    codex: {
      title: "Codex",
      plan: "ChatGPT Pro",
      windows: [
        { label: t("5-hour", "5 小时"), left: 0.81, reset: t("Resets 12:40 PM", "12:40 重置") },
        {
          label: t("Weekly", "每周"),
          left: 0.71,
          reset: t("Resets Mon 8:00 AM", "周一 08:00 重置"),
        },
      ],
    },
    antigravity: {
      title: "Antigravity",
      plan: "",
      windows: [
        { label: t("5-hour", "5 小时"), left: 0.92, reset: t("Resets 1:20 PM", "13:20 重置") },
        {
          label: t("Weekly", "每周"),
          left: 0.84,
          reset: t("Resets Tue 7:00 AM", "周二 07:00 重置"),
        },
      ],
    },
  } as const;

  /** DeepSeek reports a prepaid balance rather than windows: what is left of the last top-up. */
  const deepseekBalance = {
    title: "DeepSeek",
    amount: t("$12.40", "¥86.20"),
  };

  return {
    deepseekBalance,
    inbox,
    subagents,
    aerial,
    findings,
    titles,
    cards,
    tasks,
    usage,
    inboxById: Object.fromEntries(inbox.map((message) => [message.id, message])) as Record<
      InboxMessageId,
      InboxMessage
    >,
    passkeyIntro: t(
      "I’ll build the sign-in UI and the session flow myself and hand the rest out in parallel: the routes to GPT-6.2 Sol, the tests to Gemini 4 Neon, the docs to a free model.",
      "我来做登录界面和会话流程，其余并行委派：路由交给 GPT-6.2 Sol，测试交给 Gemini 4 Neon，文档交给免费模型。",
    ),
    wiringPasskeys: t(
      "Wiring the passkey ceremony into the session",
      "正在将通行密钥验证接入会话流程",
    ),
    testingRoutes: t("Running the tests", "正在运行测试"),
    writingTests: t("Writing the tests", "正在编写测试"),
    testsDone: t(
      "Both sign-in paths are covered: 14 tests pass in Chromium and WebKit, with passkeys and with the password fallback.",
      "两种登录方式都已覆盖：14 项测试在 Chromium 和 WebKit 中全部通过，涵盖通行密钥和密码后备方案。",
    ),
    wroteFindings: t("Findings into Dashboard cold start", "“仪表盘冷启动”的分析结果"),
    attachedReport: t("3 files to Dashboard cold start", "3 个文件到“仪表盘冷启动”"),
    markedColdStart: t(
      `${inboxKey("coldstart")} ready for review`,
      `${inboxKey("coldstart")} 待审查`,
    ),
    coldStartAnswer: t(
      "Cold start is 2.3 s, and 1.1 s of it is hydrating the whole workspace tree before first paint. The findings are on the page, with the report, flame graph and raw trace attached.",
      "冷启动耗时 2.3 秒，其中 1.1 秒花在首次绘制前对整个工作区树执行水合。结果已写入页面，报告、火焰图和原始追踪数据都已附上。",
    ),
    profilingColdStart: t("Profiling the dashboard’s cold start", "正在分析仪表盘冷启动"),
    findingsHeading: t("Findings", "分析结果"),
    followUp: t(
      "Now write the fix plan, smallest change first.",
      "现在写个修复计划，从改动最小的开始。",
    ),
    profileSummary: t(
      "Cold start is 2.3 s. Most of it is hydrating the whole workspace tree before first paint, then an unsplit charts bundle and a blocking font request.",
      "冷启动耗时 2.3 秒。最耗时的是首次绘制前对整个工作区树执行水合，其次是未拆包的图表代码和阻塞渲染的字体请求。",
    ),
    profileRequest: t(
      "Profile the dashboard’s cold start and report the three biggest costs.",
      "分析仪表盘冷启动，找出最耗时的三项。",
    ),
    fixPlan: t(
      "Picking up from the profile above: hydrate the open Project first (−0.9 s), then split the charts bundle (−0.4 s), then preload the font (−0.2 s).",
      "按上面的分析，先只对当前项目执行水合（省 0.9 秒），再拆分图表代码（省 0.4 秒），最后预加载字体（省 0.2 秒）。",
    ),
    readingContext: t("Reading the conversation so far", "正在读取已有对话"),
    usageSource: t(
      "Account limits · read on this Mac just now",
      "账户限额 · 读取自这台 Mac，读取于刚刚",
    ),
    planningWork: t("Planning the work", "正在规划任务"),
    readingResult: (count: number) =>
      t(`Read ${count} Pages in lumen-web`, `已读取 lumen-web 中的 ${count} 个页面`),
    queryResult: (count: number) =>
      t(`Queried lumen-web · ${count} rows`, `已查询 lumen-web · ${count} 行`),
    appliedEdits: (count: number) =>
      t(`Applied ${count} edits in one batch`, `已批量应用 ${count} 项修改`),
    applyingEdits: (count: number) => t(`Applying ${count} edits`, `正在应用 ${count} 项修改`),
    rowCount: (count: number) => t(`${count} rows`, `${count} 行`),
    transactionResult: (count: number) =>
      t(`${count} edits · 1 transaction`, `${count} 项修改 · 1 次事务`),
    tidyResult: (total: number, destinations: readonly { status: string; count: number }[]) =>
      t(
        `Moved ${total} Pages: ${destinations.map(({ status, count }) => `${count} to ${status}`).join(", ")}. Auth work is now P1. Two still need you in Triage.`,
        `已移动 ${total} 个页面：${destinations.map(({ status, count }) => `${status} ${count} 个`).join("、")}。身份验证任务已提到 P1。待分流还有 2 个页面需要你处理。`,
      ),
    cliNoteBefore: t("The agent works through the ", "智能体通过 "),
    cliNoteAfter: t(" CLI. Two commands do the whole job.", " CLI 工作，两条命令就能完成。"),
    mobileCapture: t(
      "Passkey prompt flickers on iPad Safari",
      "iPad Safari 上的通行密钥提示会闪一下",
    ),
    mobileNewChat: t("Passkey prompt flicker", "通行密钥提示闪烁"),
    mobileTestsPreview: t("All 14 sign-in tests pass.", "14 项登录测试全部通过。"),
    reportPreview: t("Report attached to the Page.", "报告已附到页面。"),
    draftPreview: t("Draft ready for review.", "草稿可以审阅了。"),
    mobileDelegation: t(
      "Handed the routes, tests and docs to subagents. I’ll take the session flow.",
      "路由、测试和文档都交给子智能体了。我来处理会话流程。",
    ),
    mobileDelegationShort: t(
      "Handed the routes, tests and docs to subagents.",
      "路由、测试和文档已交给子智能体。",
    ),
    mobileMerged: t(
      "Routes and docs are merged. One check left: the sign-in suite.",
      "路由和文档已合并。还差最后一步：跑一遍登录测试。",
    ),
    mobileTestsDone: t(
      "All 14 sign-in tests pass, with passkeys and with the password fallback. Ready for review.",
      "14 项登录测试全部通过，涵盖通行密钥和密码后备方案。可以审查了。",
    ),
    mobileTestsDoneShort: t(
      "All 14 sign-in tests pass, with passkeys and the fallback.",
      "14 项登录测试全部通过，涵盖通行密钥和密码后备方案。",
    ),
    mobileDigestSummary: t(
      "An idea, not work to start yet. Save it to Notes.",
      "先记下来，这个点子暂时不用做。保存到笔记。",
    ),
    mobileSettingsSummary: t(
      "Check contrast on surfaces and secondary text.",
      "检查背景和次要文字的对比度。",
    ),
    mobileRepro: t(
      "Reproduce the flicker on iPad Safari, fix it and add a regression test.",
      "在 iPad Safari 上复现闪烁，修复后加个回归测试。",
    ),
    homeWifi: t("Home Wi-Fi", "家里的 Wi-Fi"),
    reachableAt: t("Reachable at", "连接地址"),
    encryptedDirect: t("Direct, encrypted end to end", "直连，端到端加密"),
    encrypted: t("Encrypted", "已加密"),
    tidyRequest: t(
      "Tidy up the backlog: finished work to Done, auth to In Progress at P1, the rest where it belongs.",
      "整理一下积压任务：做完的移到“已完成”，身份验证相关的移到“进行中”并提到 P1，其余归到合适的状态。",
    ),
    readingBacklog: t("Reading the backlog", "正在读取积压任务"),
    queryingBacklog: t("Querying lumen-web", "正在查询 lumen-web"),
    underTheHood: t("Under the hood", "幕后步骤"),
    queryBacklog: t("One SQL query reads the backlog", "一条 SQL 查询读取积压任务"),
    batchEdits: t("One transaction applies every edit", "在一次事务中应用所有修改"),
    hydrateWorkspace: t("Hydrate the whole workspace tree", "对整个工作区树执行水合"),
    unsplitCharts: t("Unsplit charts bundle (840 KB)", "未拆包的图表代码（840 KB）"),
    blockingFont: t("Blocking font request", "阻塞渲染的字体请求"),
    otherCosts: t("Everything else", "其他"),
    profileTitle: t("lumen-web · cold start profile", "lumen-web · 冷启动性能分析"),
    today: t("Today", "当前耗时"),
    afterFixes: t("With the three fixes", "完成三项修复后"),
    mainThread: t("Main thread, first 2.3 s", "主线程，前 2.3 秒"),
    suggestedFixes: t("Suggested fixes", "建议修复方案"),
    hydrateProject: t(
      "1. Hydrate the open Project first; load the rest after first paint.",
      "1. 先对当前项目执行水合，其余项目在首次绘制后加载。",
    ),
    splitCharts: t("2. Split the charts bundle by route.", "2. 按路由拆分图表代码。"),
    preloadFont: t(
      "3. Preload the font and swap it in on load.",
      "3. 预加载字体，加载完成后再替换。",
    ),
    flamegraphTitle: t("Dashboard cold start · 2.3 s", "仪表盘冷启动 · 2.3 秒"),
    routingPreferences: t(
      "Docs go to free models, changelogs to DeepSeek. Investigations stay read-only.",
      "文档交给免费模型，更新日志交给 DeepSeek。排查问题时只读。",
    ),
  };
});

export const COLD_START_FILES = [
  {
    name: "profile",
    files: [
      { name: "report.html", kind: "html", size: "14 KB" },
      { name: "flamegraph.png", kind: "image", size: "86 KB" },
      { name: "trace.json", kind: "json", size: "1.2 MB" },
    ],
  },
] as const satisfies readonly PageFolder[];
