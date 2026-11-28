export type Locale = "en-US" | "zh-CN";

/**
 * The first language the environment names, in POSIX order. `C` and `POSIX` name no language,
 * so they defer to the next setting and finally to the system's own.
 */
export function detectLocale(
  env: NodeJS.ProcessEnv,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
): Locale {
  const named = [env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .map((entry) => entry?.trim() ?? "")
    .find((entry) => entry !== "" && !/^(?:c|posix)(?:[._@]|$)/i.test(entry));
  return (named ?? systemLocale).toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

const help = {
  "en-US": `Usage: npx nodex-insights [options]

Turn your local AI coding agent usage into Skyline and Receipt cards.

  --year <YYYY>        Calendar year (default: this year through today)
  --since <YYYY-MM-DD> First day of a custom range
  --until <YYYY-MM-DD> Last day of a custom range (default: today)
  --no-cost            Hide estimated cost
  --name <text>        Name on the cards (up to 32 characters)
  --no-open            Print the preview URL without opening it
  --help               Show this help
  --version            Show the version`,
  "zh-CN": `用法：npx nodex-insights [选项]

将本机 AI 编程智能体的用量生成天际线和账单卡片。

  --year <YYYY>        日历年（默认：今年年初至今天）
  --since <YYYY-MM-DD> 自定义日期范围的第一天
  --until <YYYY-MM-DD> 自定义日期范围的最后一天（默认：今天）
  --no-cost            隐藏预估费用
  --name <文本>        卡片上的名字（最多 32 个字符）
  --no-open            只显示预览网址
  --help               显示帮助
  --version            显示版本`,
};

export const terminal = {
  "en-US": {
    help: help["en-US"],
    reading: "Reading local agent history with ccusage (offline)…",
    invalidArguments: "Invalid arguments. Run npx nodex-insights --help for available options.",
    invalidDate: (flag: string) => `${flag} needs a valid date in YYYY-MM-DD format.`,
    invalidYear: "--year needs a valid year in YYYY format.",
    futureYear: "--year cannot be in the future.",
    conflictingDates: "Use --year or --since/--until, one at a time.",
    reversedDates: "--since must be on or before --until.",
    longName: "--name can be at most 32 characters.",
    empty: (span: string) =>
      `No agent history found for ${span}. ccusage looks for local history from Claude Code, Codex, OpenCode, and other supported agents.`,
    noPrice: "API list price unavailable",
    readFailed: "Could not read local agent history with ccusage.",
    previewFailed: "Could not start the local preview.",
    preview: (url: string) => `Your cards: ${url}  ·  Ctrl+C to stop`,
    openFailed: (url: string) => `Could not open your browser. Open this URL: ${url}`,
  },
  "zh-CN": {
    help: help["zh-CN"],
    reading: "正在使用 ccusage 离线读取本机的智能体记录…",
    invalidArguments: "参数无效。运行 npx nodex-insights --help 查看可用选项。",
    invalidDate: (flag: string) => `${flag} 需要 YYYY-MM-DD 格式的有效日期。`,
    invalidYear: "--year 需要 YYYY 格式的有效年份。",
    futureYear: "--year 不能是未来的年份。",
    conflictingDates: "--year 与 --since/--until 不能同时使用。",
    reversedDates: "--since 必须早于或等于 --until。",
    longName: "--name 最多可输入 32 个字符。",
    empty: (span: string) =>
      `未找到 ${span} 的智能体记录。ccusage 会查找 Claude Code、Codex、OpenCode 等受支持的智能体在本机的记录。`,
    noPrice: "暂无 API 标价",
    readFailed: "无法使用 ccusage 读取本机的智能体记录。",
    previewFailed: "无法启动本地预览。",
    preview: (url: string) => `你的卡片：${url}  ·  按 Ctrl+C 停止`,
    openFailed: (url: string) => `无法打开浏览器。请打开此网址：${url}`,
  },
} satisfies Record<Locale, object>;
