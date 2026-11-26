import type { Dispatch } from "../demos/lumen";
import { useDemoLocale } from "../demos/demo-locale";
import { byLocale, localizer } from "../lib/locale";
import type { Status } from "./Board";

// Chinese replica labels follow the app's zh-CN catalog wherever the app has an equivalent.
const replicaCopy = byLocale((locale) => {
  const t = localizer(locale);
  return {
    inbox: t("Inbox", "收件箱"),
    history: t("History", "历史记录"),
    projects: t("Projects", "项目"),
    chats: t("Chats", "聊天"),
    newChat: t("New chat", "新聊天"),
    noProjectlessChats: t("No projectless chats", "没有无项目聊天"),
    unread: t("Unread", "未读"),
    toggleBottomPanel: t("Toggle bottom panel", "显示/隐藏底部面板"),
    newTab: t("New tab", "新建标签页"),
    appNavigation: t("App navigation", "应用导航"),
    home: t("Home", "首页"),
    space: t("Space", "空间"),
    scheduled: t("Automations", "自动化"),
    plugins: t("Plugins", "插件"),
    account: t("Nodex account", "Nodex 账户"),
    newPage: t("New page", "新建页面"),
    statusLabel: t("Status", "状态"),
    priority: t("Priority", "优先级"),
    linkedChats: t("Linked chats", "关联聊天"),
    highPriority: t("P1 - High", "P1 - 高"),
    files: t("Files", "文件"),
    empty: t("Empty", "空"),
    from: t("From", "来自"),
    now: t("now", "刚刚"),
    followUpPlaceholder: t("Ask for follow-up changes", "提出后续修改"),
    addFiles: t("Add files and more", "添加文件等内容"),
    contextWindow: t("Context window", "上下文窗口"),
    stop: t("Stop", "停止"),
    send: t("Send", "发送"),
    backToSubagents: t("Back to subagents", "返回子智能体列表"),
    sentBy: t("Sent by", "发送者"),
    handoff: t("Context handoff", "上下文交接"),
    handoffExplanation: t(
      "Carried the conversation so far. Longer history stays readable to the Agent.",
      "已带入此前的对话。智能体仍可读取更早的历史记录。",
    ),
    doAnything: t("Do anything", "随心输入"),
    viewSource: t("View source", "查看源文件"),
    messageActions: t("Message actions", "消息操作"),
    suggestAgain: t("Suggest again", "重新建议"),
    snooze: t("Snooze", "延后"),
    addToTodo: t("Add to Todo", "添加到待办"),
    markDone: t("Mark done", "标记为完成"),
    handleManually: t("Handle manually", "手动处理"),
    findingDestination: t("Finding where this goes", "正在确定消息去向"),
    chooseModel: t("Choose the model for this chat", "为此聊天选择模型"),
    allClear: t("All clear", "已全部处理"),
    emptyInbox: t(
      "Everything you dropped here has somewhere to be.",
      "这里记录的消息都已安排妥当。",
    ),
    suggestedBy: t("Suggested by", "建议来自"),
    modelGuide: t("Model guide", "模型指南"),
    routingPreferences: t("Routing preferences", "分流偏好"),
    addImages: t("Add images", "添加照片"),
    sendToInbox: t("Send to Inbox", "发送到收件箱"),
    inboxPlaceholder: t("Drop a thought, task, or question…", "写下想法、任务或问题…"),
    searchModels: t("Search models…", "搜索模型…"),
    refreshModels: t("Refresh models", "刷新模型"),
    manageProviders: t("Manage providers", "管理提供商"),
    showAllModels: t("Show all models", "显示所有模型"),
    freeBadge: t("FREE", "免费"),
    settings: t("Settings", "设置"),
    showHandledMessages: t("Show handled messages", "显示已处理消息"),
    searchChats: t("Search chats", "搜索聊天"),
    back: t("Back", "返回"),
    needsYou: t("Needs you", "需要你处理"),
    working: t("Working", "正在处理"),
    recent: t("Recent", "最近"),
    waitingForYou: t("Waiting for you", "等待你回应"),
    done: t("Done", "已完成"),
    reply: t("Reply", "回复"),
    queue: t("Add to the queue", "加入队列"),
    startChat: t("Start chat", "开启聊天"),
    commandApproval: t("Command approval", "命令审批"),
    decline: t("Decline", "拒绝"),
    approve: t("Approve", "批准"),
    allowForChat: t("Allow for this chat", "在当前聊天中允许"),
    databaseSettings: t("Database settings", "数据库设置"),
    filterView: t("Filter View", "筛选视图"),
    sortView: t("Sort View", "为视图排序"),
    displayOptions: t("Display options", "显示选项"),
    search: t("Search", "搜索"),
    list: t("List", "列表"),
    board: t("Board", "看板"),
    setAsInboxDefault: t("Set as Inbox default", "设为收件箱默认"),
    subagents: t("Subagents", "子智能体"),
    running: t("Running", "正在运行"),
    fastOff: t("Fast · Off", "快速 · 关闭"),
    gptNote: t(
      "Backend, systems and data. Very economical, even at its highest effort.",
      "擅长后端、系统和数据。即使使用最高推理强度，成本也很低。",
    ),
    opusNote: t(
      "Frontend, UI and copy, with real taste. Spends the Claude budget faster.",
      "擅长前端、界面设计和文案，设计判断力出色。消耗 Claude 额度较快。",
    ),
    geminiNote: t(
      "Frontend and UI, with real taste. Spends a Gemini budget, not Claude's.",
      "擅长前端和界面设计，设计判断力出色。消耗 Gemini 额度，不占用 Claude 额度。",
    ),
    notReported: t("Not reported", "未报告"),
    suggestionCriteria: t(
      "Each suggestion follows your routing preferences first, then weighs what a model does well and how much of its weekly budget is left.",
      "每条建议会先遵循你的分流偏好，再考虑模型的优势和每周剩余用量。",
    ),
    commandLine: t("From Command line", "来自命令行"),
    playDemo: t("Play demo", "播放演示"),
    pauseDemo: t("Pause demo", "暂停演示"),
    startChatIn: (project: string) => t(`Start a chat in ${project}`, `在 ${project} 中开启新聊天`),
    sendToChat: t("Send to chat", "发送到聊天"),
    sending: t("Sending", "正在发送"),
    delivering: t("Delivering", "正在送达"),
    lookingAtThis: t("Looking at this", "正在确定消息去向"),
    libraryPlaceholder: t("Drop a thought in Library", "在资料库里记个想法"),
    library: t("Library", "资料库"),
    status: {
      // Stored ids keep the workflow's names; the app labels them Todo, In Progress and In Review.
      Triage: t("Triage", "待分流"),
      Plan: t("Todo", "待办"),
      Doing: t("In Progress", "进行中"),
      Review: t("In Review", "审查中"),
      Done: t("Done", "已完成"),
    } satisfies Record<Status, string>,
    effort: { High: t("High", "高"), "Extra High": t("Extra High", "很高") },
    toolVerb: {
      Edited: t("Edited", "已编辑"),
      Read: t("Read", "已读取"),
      Searched: t("Searched", "已搜索"),
      Ran: t("Ran", "已运行"),
      Wrote: t("Wrote", "已写入"),
      Attached: t("Attached", "已附加"),
      Moved: t("Moved", "已移动"),
      Marked: t("Marked", "已标记"),
    },
    decisionLabel: (dispatch: Dispatch) => {
      switch (dispatch.kind) {
        case "new_chat":
          return t(`New chat in ${dispatch.project}`, `在 ${dispatch.project} 中开启新聊天`);
        case "send_to_chat":
          return t(`Send to “${dispatch.chat}”`, `发送到“${dispatch.chat}”`);
        case "save_to_notes":
          return t("Save to Notes", "保存到笔记");
      }
    },
    outcomeLabel: (dispatch: Dispatch) => {
      switch (dispatch.kind) {
        case "new_chat":
          return t(`Starting a chat in ${dispatch.project}`, `正在 ${dispatch.project} 中开启聊天`);
        case "send_to_chat":
          return t(`Sending to “${dispatch.chat}”`, `正在发送到“${dispatch.chat}”`);
        case "save_to_notes":
          return t("Saved to Notes", "已保存到笔记");
      }
    },
    subagentGroup: (working: number, finished: number) => {
      if (working === 0) return t("finished", "已完成");
      if (finished === 0) return t(working === 1 ? "is working" : "are working", "正在处理");
      return t(
        `— ${working} working, ${finished} done`,
        `· ${working} 个处理中 · ${finished} 个已完成`,
      );
    },
    subagentLastSeparator: t(" and ", "和"),
    subagentSeparator: t(", ", "、"),
    subagentMore: (count: number) => t(` and ${count} more`, `及另外 ${count} 个`),
    leadsChat: (provider: string) =>
      t(`Leads this chat in ${provider}`, `负责此聊天的智能体是 ${provider}`),
    leadAgent: (agent: string) => t(`${agent} · lead`, `${agent} · 主智能体`),
    delegatingBack: (back: number, total: number) =>
      back >= total
        ? t(total === 1 ? "1 subagent back" : `All ${total} back`, `${total} 个已全部交回`)
        : t(`Delegating · ${back}/${total} back`, `委派中 · 已交回 ${back}/${total}`),
    backShort: (back: number, total: number) =>
      back >= total
        ? t(total === 1 ? "1 subagent back" : `All ${total} back`, `${total} 个已全部交回`)
        : t(`${back}/${total} back`, `已交回 ${back}/${total}`),
    elapsedSeconds: (count: number) => t(`${count}s`, `${count} 秒`),
    elapsedMinutes: (count: number) => t(`${count}m`, `${count} 分钟`),
    needsYourAnswer: t("Needs your answer", "需要你回答"),
    needsApproval: t("Needs approval", "需要批准"),
    aerialView: t("Aerial view", "鸟瞰"),
    active: t("Active", "活跃"),
    allProjects: t("All Projects", "所有项目"),
    managedByNodex: t("Managed by Nodex", "由 Nodex 管理"),
    subagentCount: (count: number) =>
      t(count === 1 ? "1 subagent" : `${count} subagents`, `${count} 个子智能体`),
    map: t("Map", "协作图"),
    isWorking: (agent: string) => t(`${agent} is working`, `${agent} 正在处理`),
    readyForYourReview: t("Ready for your review", "等待你审查"),
    accept: t("Accept", "接受"),
    openChat: t("Open chat", "打开聊天"),
    saveToNotes: t("Save to Notes", "保存到笔记"),
    letSubagentsDelegate: t("Let subagents delegate", "允许子智能体再委派"),
    fileCount: (count: number) => t(`${count} files`, `${count} 个文件`),
    fileFrom: t("from", "来自"),
    seconds: (value: string) => t(`${value} s`, `${value} 秒`),
    runningCommand: (command: string) => t(`Running ${command}`, `正在运行 ${command}`),
    suggestedByModel: (model: string) => t(`Suggested by ${model}`, `建议来自 ${model}`),
    ageMinutes: (minutes: number) => t(`${minutes}m`, `${minutes} 分钟前`),
    ageHours: (hours: number) => t(`${hours}h`, `${hours} 小时前`),
    budgetPrefix: t("", "剩余 "),
    budgetSuffix: t(" left", ""),
    budgetLeft: (percent: number) => t(`${percent}% left`, `剩余 ${percent}%`),
    amountLeft: (amount: string) => t(`${amount} left`, `剩余 ${amount}`),
    balance: t("Balance", "余额"),
    sinceLastTopUp: t("Since last top-up", "自上次充值"),
    workedFor: (duration: string) => t(`Worked for ${duration}`, `工作了 ${duration}`),
    duration: (minutes: number, seconds: number) =>
      t(`${minutes}m ${String(seconds).padStart(2, "0")}s`, `${minutes} 分 ${seconds} 秒`),
    steps: (count: number) => t(`${count} ${count === 1 ? "step" : "steps"}`, `${count} 个步骤`),
  };
});

export function useReplicaCopy() {
  return replicaCopy[useDemoLocale()];
}
