import type { CodexConversationItem } from "@/lib/types";
import type { VisibleConversationTurnEntry } from "./selectors";

export interface ConversationMarkdownInput {
  cwd?: string | null;
  title?: string | null;
  turns: readonly VisibleConversationTurnEntry[];
}

type UnknownRecord = Record<string, unknown>;

const GIT_ACTION_DIRECTIVE_PATTERN = /::git-[a-z-]+\{[^}\n]*\}/g;
const MARKDOWN_LINK_TARGET_PATTERN =
  /\]\((<[^>\n]+>|[^)\s\n]+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/g;
const PATH_LINE_SUFFIX_PATTERN = /^(.*?)(:\d+(?:-\d+)?)$/;
const UNIX_HOME_PATTERN = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;
const WINDOWS_HOME_PATTERN = /^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeNewlines(value: string): string {
  return value.replaceAll(/\r\n?/g, "\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeDetailsTags(value: string): string {
  return value.replaceAll(/<\/?details(?=[\s>])[^>]*>/gi, (tag) => escapeHtml(tag));
}

function maxBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function inlineCode(value: string): string {
  const fence = "`".repeat(maxBacktickRun(value) + 1);
  return `${fence}${value}${fence}`;
}

function fencedCode(language: string, value: string): string {
  const body = normalizeNewlines(value).trimEnd();
  const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

function normalizeAbsolutePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function resolveHomeDirectory(cwd: string | null): string | null {
  if (!cwd) return null;
  return UNIX_HOME_PATTERN.exec(cwd)?.[0] ?? WINDOWS_HOME_PATTERN.exec(cwd)?.[0] ?? null;
}

function rewritePath(value: string, cwd: string | null): string {
  const suffixMatch = PATH_LINE_SUFFIX_PATTERN.exec(value);
  const path =
    suffixMatch && isAbsolutePath(suffixMatch[1] ?? "") ? (suffixMatch[1] ?? value) : value;
  const suffix = path === value ? "" : (suffixMatch?.[2] ?? "");
  const normalized = normalizeAbsolutePath(path);
  const normalizedCwd = cwd ? normalizeAbsolutePath(cwd) : null;
  if (normalizedCwd && normalizedCwd !== "/") {
    if (normalized === normalizedCwd) return `.${suffix}`;
    if (normalized.startsWith(`${normalizedCwd}/`)) {
      return `./${normalized.slice(normalizedCwd.length + 1)}${suffix}`;
    }
  }

  const home = resolveHomeDirectory(normalizedCwd);
  if (home) {
    if (normalized === home) return `~${suffix}`;
    if (normalized.startsWith(`${home}/`)) {
      return `~/${normalized.slice(home.length + 1)}${suffix}`;
    }
  }
  return `${normalized}${suffix}`;
}

function rewriteMarkdownLinkPaths(value: string, cwd: string | null): string {
  return value.replaceAll(
    MARKDOWN_LINK_TARGET_PATTERN,
    (whole, rawTarget: string, title: string | undefined) => {
      const angled = rawTarget.startsWith("<") && rawTarget.endsWith(">");
      const target = angled ? rawTarget.slice(1, -1) : rawTarget;
      if (!isAbsolutePath(normalizeAbsolutePath(target))) return whole;
      const rewritten = rewritePath(target, cwd);
      const safeTarget = angled || /[\s()]/.test(rewritten) ? `<${rewritten}>` : rewritten;
      return `](${safeTarget}${title ?? ""})`;
    },
  );
}

function normalizeMessage(value: string, cwd: string | null): string {
  const normalized = normalizeNewlines(value)
    .split("\n")
    .map((line) => {
      const withoutDirectives = line.replaceAll(GIT_ACTION_DIRECTIVE_PATTERN, "");
      return withoutDirectives.trim().length === 0 ? "" : withoutDirectives.trimEnd();
    })
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n");
  return rewriteMarkdownLinkPaths(escapeDetailsTags(normalized), cwd);
}

function quoteBlock(value: string): string {
  return normalizeNewlines(value)
    .trim()
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

function details(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${normalizeNewlines(body).trim()}\n\n</details>`;
}

function groupedActivityDetails(items: readonly string[]): string {
  const count = items.length;
  const label = `${count} previous ${count === 1 ? "message" : "messages"}`;
  return `<details><summary>${label}</summary>\n\n${quoteBlock(items.join("\n\n"))}\n</details>`;
}

function titledLines(title: string, lines: readonly (string | null | undefined)[]): string {
  const content = lines
    .flatMap((line) => (line == null ? [] : [escapeDetailsTags(normalizeNewlines(line))]))
    .filter((line) => line.trim().length > 0);
  return content.length === 0 ? title : `${title}\n\n${content.join("\n")}`;
}

function rawItem(item: CodexConversationItem): UnknownRecord {
  return asRecord(item.rawItem) ?? {};
}

function renderUserContext(item: CodexConversationItem, cwd: string | null): string | null {
  const lines: string[] = [];
  const attachments = item.userAttachments ?? [];
  const files = attachments.filter((attachment) => attachment.type === "file");
  const images = attachments.filter((attachment) => attachment.type === "image");
  if (files.length > 0) {
    lines.push("Attachments:");
    for (const attachment of files) {
      lines.push(`- ${attachment.label}: ${inlineCode(rewritePath(attachment.path, cwd))}`);
    }
  }
  if (images.length > 0) {
    lines.push("Images:");
    for (const attachment of images) {
      lines.push(`- ${inlineCode(rewritePath(attachment.source, cwd))}`);
    }
  }
  if ((item.commentAttachments?.length ?? 0) > 0) {
    lines.push("Comments:");
    for (const comment of item.commentAttachments ?? []) {
      const start = comment.position.start_line;
      const end = comment.position.line;
      const lineRange = start && start !== end ? `:${start}-${end}` : `:${end}`;
      const text = comment.content
        .map((entry) => entry.text)
        .join(" ")
        .replaceAll("\n", " ");
      lines.push(
        `- ${rewritePath(`${comment.position.path}${lineRange}`, cwd)}: ${escapeDetailsTags(text)}`,
      );
    }
  }
  return lines.length === 0 ? null : titledLines("User context", lines);
}

function renderUserMessage(item: CodexConversationItem, cwd: string | null): string | null {
  const sections: string[] = [];
  const message = normalizeMessage(item.markdownText ?? "", cwd).trim();
  if (message) sections.push(message);
  const context = renderUserContext(item, cwd);
  if (context) sections.push(context);
  return sections.length === 0 ? null : quoteBlock(sections.join("\n\n"));
}

function renderAssistantMessage(item: CodexConversationItem, cwd: string | null): string | null {
  const message = normalizeMessage(item.markdownText ?? "", cwd).trim();
  return message.length === 0 ? null : message;
}

function renderCommand(item: CodexConversationItem): string {
  const command =
    item.command?.trim() || item.cmd?.join(" ").trim() || item.parsedCmd?.cmd.trim() || "";
  const blocks = [fencedCode("bash", `$ ${command}`)];
  if (item.aggregatedOutput != null && item.aggregatedOutput.trim().length > 0) {
    blocks.push(fencedCode("text", item.aggregatedOutput));
  }
  const status =
    item.executionStatus === "interrupted"
      ? "Stopped"
      : item.exitCode == null
        ? item.executionStatus === "completed"
          ? "Success"
          : "Running"
        : item.exitCode === 0
          ? "Success"
          : `Failed with exit code ${item.exitCode}`;
  blocks.push(status);
  return details(`Ran <code>${escapeHtml(command)}</code>`, blocks.join("\n\n"));
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of normalizeNewlines(diff).split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function renderPatch(item: CodexConversationItem, cwd: string | null): string | null {
  const changes = item.fileChange?.changes ?? {};
  const sections = Object.entries(changes).flatMap(([path, change]) => {
    if (change.type === "nonRenderable") return [];
    const diff =
      change.type === "update"
        ? change.unifiedDiff
        : change.type === "add"
          ? change.content
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")
          : change.content
              .split("\n")
              .map((line) => `-${line}`)
              .join("\n");
    if (!diff.trim()) return [];
    const stats = diffStats(diff);
    const verb = change.type === "add" ? "Added" : change.type === "delete" ? "Deleted" : "Updated";
    return [
      details(
        `${verb} <code>${escapeHtml(rewritePath(path, cwd))}</code> +${stats.additions} -${stats.deletions}`,
        fencedCode("diff", diff),
      ),
    ];
  });
  return sections.length === 0 ? null : sections.join("\n");
}

function renderMcpContent(item: CodexConversationItem): string {
  const call = item.mcpToolCall;
  if (!call) return "MCP tool call";
  const sections = [
    `MCP tool call\n\n${escapeDetailsTags(`${call.invocation.server}.${call.invocation.tool}`)}`,
    fencedCode("json", JSON.stringify(call.invocation.arguments, null, 2) ?? "null"),
  ];
  if (call.result == null) {
    sections.push(call.completed ? "Result: none" : "Status: running");
    return sections.join("\n\n");
  }
  if (call.result.type === "error") {
    sections.push(`Error: ${escapeDetailsTags(call.result.error)}`);
    return sections.join("\n\n");
  }
  for (const content of call.result.content) {
    if (content.type === "text") sections.push(fencedCode("text", content.text));
    if (content.type === "image") sections.push(`Image output: ${content.mimeType}`);
    if (content.type === "audio") sections.push(`Audio output: ${content.mimeType}`);
    if (content.type === "resource_link") {
      sections.push(`Resource: ${content.title ?? content.name ?? content.uri} (${content.uri})`);
    }
    if (content.type === "embedded_resource") {
      const title = content.resource.title ?? content.resource.name ?? content.resource.uri;
      sections.push(
        content.resource.text?.trim()
          ? `Resource: ${title}\n\n${fencedCode("text", content.resource.text)}`
          : `Resource: ${title}`,
      );
    }
    if (content.type === "unknown") {
      sections.push(fencedCode("json", JSON.stringify(content.raw, null, 2) ?? "null"));
    }
  }
  if (call.result.structuredContent != null) {
    sections.push(
      fencedCode("json", JSON.stringify(call.result.structuredContent, null, 2) ?? "null"),
    );
  }
  return sections.join("\n\n");
}

function renderSystemEvent(item: CodexConversationItem, cwd: string | null): string | null {
  const raw = rawItem(item);
  switch (item.semanticKind) {
    case "proposedPlan":
      return item.markdownText?.trim() ? `Plan\n\n${escapeDetailsTags(item.markdownText)}` : null;
    case "todoList":
      return item.markdownText?.trim() ? details("Plan", item.markdownText) : null;
    case "exec":
      return renderCommand(item);
    case "patch":
      return renderPatch(item, item.grantRoot ?? item.cwd ?? cwd);
    case "diff":
      return item.markdownText?.trim()
        ? details("Diff", fencedCode("diff", item.markdownText))
        : null;
    case "webSearch":
      return `Searched the web for ${inlineCode(item.webSearch?.query ?? item.markdownText ?? "")}`;
    case "generatedImage":
      return item.generatedImage?.src
        ? `Generated image\n\n![Generated image](${item.generatedImage.src})`
        : titledLines("Generated image", [
            `Status: ${item.generatedImage?.status ?? item.status ?? "pending"}`,
          ]);
    case "imageView":
      return (item.imageViewPaths?.length ?? 0) === 1
        ? "Viewed an image"
        : `Viewed ${item.imageViewPaths?.length ?? 0} images`;
    case "mcpToolCall":
      return renderMcpContent(item);
    case "dynamicToolCall":
      return titledLines("Tool call", [
        `Tool: ${item.dynamicToolCall?.tool ?? item.type}`,
        item.dynamicToolCall?.completed ? "Status: completed" : "Status: running",
      ]);
    case "automationUpdate":
      return titledLines("Scheduled task update", [
        `Mode: ${item.automationUpdate?.result?.mode ?? "pending"}`,
        `Automation ID: ${item.automationUpdate?.result?.automationId ?? "pending"}`,
      ]);
    case "userInputResponse": {
      const questions = item.userInputQuestions ?? [];
      return titledLines(
        "User input response",
        questions.flatMap((question) => [
          `- ${question.question}`,
          ...(item.userInputAnswers?.[question.id] ?? []).map((answer) => `  - ${answer}`),
        ]),
      );
    }
    case "mcpServerElicitation":
      return titledLines("MCP server elicitation", [
        item.status === "completed" ? "Status: completed" : "Status: pending",
        `Action: ${asString(raw.action) ?? "none"}`,
      ]);
    case "permissionRequest":
      return titledLines("Permission request", [
        item.status === "completed" ? "Status: completed" : "Status: pending",
        `Reason: ${item.markdownText ?? "Not provided"}`,
        `Response: ${raw.response == null ? "none" : "granted"}`,
      ]);
    case "automaticApprovalReview":
      return titledLines("Auto-review", [
        `Status: ${item.status ?? "completed"}`,
        item.markdownText ?? null,
      ]);
    case "multiAgentAction": {
      const receivers = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.length : 0;
      return titledLines("Subagent action", [
        `Action: ${asString(raw.tool) ?? asString(raw.action) ?? item.type}`,
        `Status: ${item.status ?? "completed"}`,
        `Receiver threads: ${receivers}`,
        asString(raw.prompt) ? `Prompt: ${asString(raw.prompt)}` : null,
      ]);
    }
    case "planImplementation":
      return titledLines("Plan implementation", [
        item.status === "completed" ? "Status: completed" : "Status: running",
        item.markdownText ?? null,
      ]);
    case "remoteTaskCreated":
      return titledLines("Remote task created", [
        `Task ID: ${asString(raw.taskId) ?? item.itemId}`,
      ]);
    case "contextCompaction":
      return titledLines("Context compaction", [
        `Source: ${item.contextCompaction?.source ?? "automatic"}`,
        item.contextCompaction?.completed ? "Status: completed" : "Status: running",
      ]);
    case "personalityChanged":
      return titledLines("Personality changed", [
        `Personality: ${asString(raw.personality) ?? "unknown"}`,
      ]);
    case "forkedFromConversation":
      return titledLines("Copied conversation", [
        `Source conversation: ${asString(raw.sourceConversationId) ?? "unknown"}`,
      ]);
    case "modelChanged":
      return titledLines("Model changed", [
        `${asString(raw.fromModel) ?? "unknown"} -> ${asString(raw.toModel) ?? "unknown"}`,
      ]);
    case "modelRerouted":
      return titledLines("Model rerouted", [
        `${asString(raw.fromModel) ?? "unknown"} -> ${asString(raw.toModel) ?? "unknown"}`,
        `Reason: ${asString(raw.reason) ?? "unknown"}`,
      ]);
    case "systemError":
      return item.markdownText?.trim()
        ? `System error\n\n${escapeDetailsTags(item.markdownText)}`
        : null;
    case "streamError":
      return titledLines("Stream error", [item.markdownText, item.additionalDetails]);
    case "worktreeInit":
      return titledLines("Worktree initialization", ["Worktree: created"]);
    case "reasoning":
    case "subAgentActivity":
    case "autoReviewInterruptionWarning":
    case "steered":
    case "workedFor":
    case "userMessage":
    case "assistantMessage":
    case "hook":
    case "toolCall":
    case "systemEvent":
    case undefined:
      return null;
  }
}

function renderRequest(request: VisibleConversationTurnEntry["requests"][number]): string {
  const record = request as unknown as UnknownRecord;
  const type = asString(record.type) ?? "request";
  if (type === "userInput") {
    const questions = Array.isArray(record.questions)
      ? record.questions.flatMap((question) => {
          const value = asRecord(question);
          return value && typeof value.question === "string" ? [`- ${value.question}`] : [];
        })
      : [];
    return titledLines("User input requested", questions);
  }
  if (type === "approval") return titledLines("Approval requested", [asString(record.reason)]);
  if (type === "permissionRequest")
    return titledLines("Permission request", [asString(record.reason)]);
  if (type === "implementPlan") return "Plan implementation requested";
  return titledLines("Request pending", [`Type: ${type}`]);
}

function renderTurn(entry: VisibleConversationTurnEntry, cwd: string | null): string | null {
  const sections: string[] = [];
  const items = entry.turn.items;
  const modelChanges = items.filter((item) => item.semanticKind === "modelChanged");
  const users = items.filter((item) => item.semanticKind === "userMessage" || item.role === "user");
  const reroutes = items.filter((item) => item.semanticKind === "modelRerouted");
  const assistants = items.filter(
    (item) => item.semanticKind === "assistantMessage" || item.role === "assistant",
  );
  const postAssistant = items.filter(
    (item) =>
      item.semanticKind === "remoteTaskCreated" ||
      item.semanticKind === "personalityChanged" ||
      item.semanticKind === "forkedFromConversation",
  );
  const excluded = new Set([
    ...modelChanges,
    ...users,
    ...reroutes,
    ...assistants,
    ...postAssistant,
  ]);
  const activity = items
    .filter((item) => !excluded.has(item))
    .flatMap((item) => {
      const rendered = renderSystemEvent(item, cwd);
      return rendered ? [rendered] : [];
    });
  if (entry.turn.diff?.trim() && !items.some((item) => item.semanticKind === "diff")) {
    activity.push(details("Diff", fencedCode("diff", entry.turn.diff)));
  }
  activity.push(...entry.requests.map(renderRequest));

  for (const item of modelChanges) {
    const rendered = renderSystemEvent(item, cwd);
    if (rendered) sections.push(rendered);
  }
  for (const item of users) {
    const rendered = renderUserMessage(item, item.cwd ?? cwd);
    if (rendered) sections.push(rendered);
  }
  for (const item of reroutes) {
    const rendered = renderSystemEvent(item, cwd);
    if (rendered) sections.push(rendered);
  }
  if (activity.length > 0) sections.push(groupedActivityDetails(activity));
  for (const item of assistants) {
    const rendered = renderAssistantMessage(item, item.cwd ?? cwd);
    if (rendered) sections.push(rendered);
  }
  for (const item of postAssistant) {
    const rendered = renderSystemEvent(item, cwd);
    if (rendered) sections.push(rendered);
  }
  return sections.length === 0 ? null : sections.join("\n\n");
}

function normalizeTitle(value: string | null | undefined): string {
  const normalized = (value ?? "Nodex conversation").replaceAll(/\s+/g, " ").trim();
  return (normalized || "Nodex conversation").replaceAll("#", "\\#");
}

export function renderConversationMarkdownHeader(title?: string | null): string {
  return `# ${normalizeTitle(title)}`;
}

/** Renders one complete Turn so explicit history export can keep a one-Turn working set. */
export function renderConversationTurnMarkdown(
  entry: VisibleConversationTurnEntry,
  cwd: string | null = null,
): string | null {
  return renderTurn(entry, entry.turn.items.find((item) => item.cwd)?.cwd ?? cwd);
}

export function renderConversationMarkdown({
  cwd = null,
  title,
  turns,
}: ConversationMarkdownInput): string {
  const sections = [renderConversationMarkdownHeader(title)];
  for (const entry of turns) {
    const rendered = renderConversationTurnMarkdown(entry, cwd);
    if (rendered) sections.push(rendered);
  }
  return `${sections.join("\n\n").trimEnd()}\n`;
}
