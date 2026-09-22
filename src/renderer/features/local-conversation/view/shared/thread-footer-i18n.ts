/** Message actions follow the host language independently of transcript content. */
export function footerLocale(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language || "en";
}

type FooterLanguage = "en" | "zh-Hans" | "zh-Hant";

export function resolveFooterLanguage(locale: string): FooterLanguage {
  if (!/^zh(?:-|$)/iu.test(locale)) return "en";
  if (/(?:^|-)Hans(?:-|$)/iu.test(locale)) return "zh-Hans";
  if (/(?:^|-)Hant(?:-|$)/iu.test(locale)) return "zh-Hant";
  return /(?:^|-)(?:TW|HK|MO)(?:-|$)/iu.test(locale) ? "zh-Hant" : "zh-Hans";
}

const messages: Record<string, readonly [string, string]> = {
  Plan: ["计划", "計畫"],
  "Writing plan": ["正在编写计划", "正在撰寫計畫"],
  "Open plan in side panel": ["在侧栏中打开计划", "在側邊欄開啟計畫"],
  "Close plan side panel": ["关闭计划侧栏", "關閉計畫側邊欄"],
  "1 memory citation": ["1 条记忆引用", "1 則記憶引用"],
  "{count} memory citations": ["{count} 条记忆引用", "{count} 則記憶引用"],
  "Opening files on this host is unavailable": [
    "暂不支持打开此主机上的文件",
    "暫不支援開啟此主機上的檔案",
  ],
  "Auto-review stats": ["自动审查统计", "自動審查統計"],
  "Auto-review stats ({count} rejected)": [
    "自动审查统计（{count} 次拒绝）",
    "自動審查統計（{count} 次拒絕）",
  ],
  "Command history": ["命令历史", "命令歷史"],
  "Auto-review did not include a rationale": ["自动审查未提供理由", "自動審查未提供理由"],
  Copy: ["复制", "複製"],
  "Copy message": ["复制消息", "複製訊息"],
  "Copy response": ["复制回复", "複製回覆"],
  Copied: ["已复制", "已複製"],
  "Edit message": ["编辑消息", "編輯訊息"],
  Edit: ["编辑", "編輯"],
  "Rate response": ["评价回复", "評價回覆"],
  "Good response": ["回复不错", "回覆不錯"],
  "Bad response": ["回复不好", "回覆不好"],
  "Remove good response feedback": ["撤销好评", "撤銷好評"],
  "Remove bad response feedback": ["撤销差评", "撤銷差評"],
  "Branch in new chat": ["在新对话中创建分支", "在新對話中建立分支"],
  "Fork chat from here": ["从此处创建对话分支", "從此處建立對話分支"],
  "Hook blocked this message": ["Hook 拦截了这条消息", "Hook 攔截了這則訊息"],
  "Hook feedback": ["Hook 反馈", "Hook 回饋"],
  "Not sent": ["未发送", "未傳送"],
  "Sent as goal": ["已作为目标发送", "已作為目標傳送"],
  "Hooks summary": ["Hooks 摘要", "Hooks 摘要"],
  Ran: ["运行次数", "執行次數"],
  Session: ["会话", "工作階段"],
  Unknown: ["未知", "未知"],
  Error: ["错误", "錯誤"],
  Feedback: ["反馈", "回饋"],
  Stop: ["停止", "停止"],
  Message: ["消息", "訊息"],
  "{count} runs": ["{count} 次运行", "{count} 次執行"],
  Hooks: ["Hooks", "Hooks"],
  "Hook output": ["Hook 输出", "Hook 輸出"],
  Blocked: ["已拦截", "已攔截"],
  Errors: ["错误", "錯誤"],
  Runs: ["运行次数", "執行次數"],
  Event: ["事件", "事件"],
  Source: ["来源", "來源"],
  Output: ["输出", "輸出"],
  Admin: ["管理员", "管理員"],
  System: ["系统", "系統"],
  Custom: ["自定义", "自訂"],
  User: ["用户", "使用者"],
  Project: ["项目", "專案"],
  Plugin: ["插件", "外掛"],
  App: ["应用", "應用程式"],
  Skills: ["技能", "技能"],
  "Skills used": ["使用的技能", "使用的技能"],
  "Loading…": ["加载中…", "載入中…"],
  "Auto-review": ["自动审查", "自動審查"],
  Accepted: ["已批准", "已核准"],
  Rejected: ["已拒绝", "已拒絕"],
  Rationale: ["理由", "理由"],
  Command: ["命令", "命令"],
  "Memories cited": ["引用的记忆", "引用的記憶"],
  "Goal achieved in {totalTime}": ["目标已完成，用时 {totalTime}", "目標已完成，耗時 {totalTime}"],
  Download: ["下载", "下載"],
  "Download plan": ["下载计划", "下載計畫"],
  "Copy plan": ["复制计划", "複製計畫"],
  "Open in side panel": ["在侧栏中打开", "在側邊欄開啟"],
  "Open side panel": ["打开侧栏", "開啟側邊欄"],
  "Close side panel": ["关闭侧栏", "關閉側邊欄"],
};

export function formatFooterNumber(value: number, locale = footerLocale()): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function footerText(
  message: string,
  values: Readonly<Record<string, string | number>> = {},
  locale = footerLocale(),
): string {
  const language = resolveFooterLanguage(locale);
  const translations = messages[message];
  const text =
    language === "en" || !translations ? message : translations[language === "zh-Hans" ? 0 : 1];
  return text.replace(/\{(\w+)\}/gu, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) return placeholder;
    return typeof value === "number" ? formatFooterNumber(value, locale) : value;
  });
}
