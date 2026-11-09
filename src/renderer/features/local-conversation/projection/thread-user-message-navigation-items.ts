import type { CodexConversationItem } from "../../../lib/types";
import { getCodexFileChangePaths } from "../../../../shared/codex-file-change";
import { selectTurnRenderModel } from "./build-turn-render-model";
import type { ProjectlessOutputScope } from "./projectless-output-scope";
import type { VisibleConversationTurnEntry } from "../selectors";
import type {
  ThreadBlockModel,
  ThreadTranscriptBlockModel,
  ThreadUserMessageNavigationItem,
  ThreadUserMessageNavigationOutput,
  ThreadUserMessageNavigationOutputType,
} from "../thread-stage-types";

export const MIN_THREAD_USER_MESSAGE_NAVIGATION_ITEMS = 4;
export const IMPLEMENT_PLAN_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:";
export const IMPLEMENT_PLAN_NAVIGATION_LABEL = "Yes, implement this plan";
export const EMPTY_USER_MESSAGE_NAVIGATION_LABEL = "(No content)";
export const MAX_THREAD_USER_MESSAGE_NAVIGATION_OUTPUT_PILLS = 2;

const OUTPUT_TYPE_PRIORITY: Record<ThreadUserMessageNavigationOutputType, number> = {
  app: 0,
  website: 1,
  "google-drive": 2,
  file: 3,
  image: 4,
  commit: 5,
  "pull-request": 6,
  review: 7,
};
const GOOGLE_DRIVE_DOMAINS = ["drive.google.com", "googleusercontent.com"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .map((entry) => stringifyValue(entry))
      .filter(Boolean)
      .join(" ");
  const record = asRecord(value);
  if (!record) return "";
  return Object.values(record)
    .map((entry) => stringifyValue(entry))
    .filter(Boolean)
    .join(" ");
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname
      .toLowerCase()
      .replace(/\.$/u, "")
      .replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isGoogleDriveResourceUrl(value: string): boolean {
  const hostname = hostnameFromUrl(value);
  if (!hostname) return false;
  return GOOGLE_DRIVE_DOMAINS.some((domain) => isDomainOrSubdomain(hostname, domain));
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function normalizePreviewText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isThreadTranscriptBlock(block: ThreadBlockModel): block is ThreadTranscriptBlockModel {
  return "entry" in block;
}

function flattenThreadBlocks(blocks: readonly ThreadBlockModel[]): ThreadBlockModel[] {
  const flattened: ThreadBlockModel[] = [];

  for (const block of blocks) {
    flattened.push(block);

    if (block.type === "assistantMessage" && block.assistantAfterBlocks) {
      flattened.push(...flattenThreadBlocks(block.assistantAfterBlocks));
      continue;
    }

    if (block.type === "agentActivityGroup") {
      for (const entry of block.entries) {
        flattened.push(entry);
      }
    }
  }

  return flattened;
}

function resolveUserLabel(block: ThreadTranscriptBlockModel): string {
  const text = normalizePreviewText(block.entry.markdownText ?? block.searchableText);
  if (text.startsWith(IMPLEMENT_PLAN_PROMPT_PREFIX)) return IMPLEMENT_PLAN_NAVIGATION_LABEL;
  if (text.length === 0) return EMPTY_USER_MESSAGE_NAVIGATION_LABEL;
  return text;
}

function resolveAssistantResponsePreview(
  blocks: readonly ThreadBlockModel[],
  userBlockIndex: number,
): string {
  const nextAssistant = blocks
    .slice(userBlockIndex + 1)
    .find(
      (block): block is ThreadTranscriptBlockModel =>
        isThreadTranscriptBlock(block) &&
        block.type === "assistantMessage" &&
        normalizePreviewText(block.entry.markdownText ?? block.searchableText).length > 0,
    );

  return nextAssistant
    ? normalizePreviewText(nextAssistant.entry.markdownText ?? nextAssistant.searchableText)
    : "";
}

function addOutput(
  outputs: Map<string, ThreadUserMessageNavigationOutput>,
  input: Omit<ThreadUserMessageNavigationOutput, "id">,
) {
  const label = input.label.trim();
  if (label.length === 0) return;
  const key = `${input.type}:${label.toLowerCase()}`;
  if (outputs.has(key)) return;
  outputs.set(key, {
    id: key,
    type: input.type,
    label,
  });
}

function addFileOutputs(
  outputs: Map<string, ThreadUserMessageNavigationOutput>,
  entry: CodexConversationItem,
) {
  if (!entry.fileChange) return;
  const paths = getCodexFileChangePaths(entry.fileChange.changes);
  const label = firstNonEmpty(entry.fileChange.label, paths[0]);
  if (!label) return;
  addOutput(outputs, { type: "file", label: basename(label) });
}

function addWebOutputs(
  outputs: Map<string, ThreadUserMessageNavigationOutput>,
  entry: CodexConversationItem,
) {
  if (entry.semanticKind === "webSearch" || entry.type === "web_search") {
    addOutput(outputs, { type: "website", label: "Web" });
  }

  const text = [
    entry.mcpToolCall?.mcpAppResourceUri ?? "",
    stringifyValue(entry.toolCall?.result),
    stringifyValue(entry.dynamicToolCall?.contentItems),
    stringifyValue(entry.rawItem),
  ].join(" ");
  const urls = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  for (const url of urls) {
    const host = hostnameFromUrl(url);
    if (!host) continue;
    const isGoogleDrive = GOOGLE_DRIVE_DOMAINS.some((domain) => isDomainOrSubdomain(host, domain));
    addOutput(outputs, {
      type: isGoogleDrive ? "google-drive" : "website",
      label: isGoogleDrive ? "Google Drive" : host,
    });
  }
}

function addMcpOutputs(
  outputs: Map<string, ThreadUserMessageNavigationOutput>,
  entry: CodexConversationItem,
) {
  const mcp = entry.mcpToolCall;
  if (mcp?.mcpAppResourceUri) {
    const isGoogleDrive = isGoogleDriveResourceUrl(mcp.mcpAppResourceUri);
    addOutput(outputs, {
      type: isGoogleDrive ? "google-drive" : "app",
      label: isGoogleDrive
        ? "Google Drive"
        : (firstNonEmpty(mcp.invocation.server, mcp.invocation.tool, mcp.pluginId) ?? "App"),
    });
  }

  const dynamicContent = entry.dynamicToolCall?.contentItems ?? [];
  if (
    dynamicContent.some((contentItem) => {
      const type = asRecord(contentItem)?.type;
      return type === "image" || type === "inputImage";
    })
  ) {
    addOutput(outputs, { type: "image", label: "Image" });
  }

  const mcpResult = mcp?.result;
  if (asRecord(mcpResult)?.type === "success") {
    const content = asRecord(mcpResult)?.content;
    if (
      Array.isArray(content) &&
      content.some((contentItem) => {
        const type = asRecord(contentItem)?.type;
        return type === "image" || type === "inputImage";
      })
    ) {
      addOutput(outputs, { type: "image", label: "Image" });
    }
  }
}

function addGitOutputs(
  outputs: Map<string, ThreadUserMessageNavigationOutput>,
  entry: CodexConversationItem,
) {
  const text = [
    entry.markdownText ?? "",
    entry.additionalDetails ?? "",
    entry.aggregatedOutput ?? "",
    stringifyValue(entry.rawItem),
    stringifyValue(entry.toolCall?.result),
  ].join("\n");

  if (text.includes("::git-commit") || /\bcreated commit\b/i.test(text)) {
    addOutput(outputs, { type: "commit", label: "Commit" });
  }
  if (
    text.includes("::git-create-pr") ||
    /\bpull request\b/i.test(text) ||
    /\bPR #?\d+\b/.test(text)
  ) {
    addOutput(outputs, { type: "pull-request", label: "Pull request" });
  }
}

function collectOutputsFromBlocks(
  blocks: readonly ThreadBlockModel[],
): ThreadUserMessageNavigationOutput[] {
  const outputs = new Map<string, ThreadUserMessageNavigationOutput>();

  for (const block of blocks) {
    if (block.type === "turnDiff") {
      addOutput(outputs, { type: "review", label: "Review" });
    }
    if (!isThreadTranscriptBlock(block)) continue;

    addFileOutputs(outputs, block.entry);
    addWebOutputs(outputs, block.entry);
    addMcpOutputs(outputs, block.entry);
    addGitOutputs(outputs, block.entry);
  }

  return [...outputs.values()].sort(
    (left, right) =>
      OUTPUT_TYPE_PRIORITY[left.type] - OUTPUT_TYPE_PRIORITY[right.type] ||
      left.label.localeCompare(right.label),
  );
}

export function getThreadUserMessageNavigationVisibleOutputs(
  outputs: readonly ThreadUserMessageNavigationOutput[],
): ThreadUserMessageNavigationOutput[] {
  if (outputs.length <= MAX_THREAD_USER_MESSAGE_NAVIGATION_OUTPUT_PILLS) {
    return [...outputs];
  }

  const visible = outputs.slice(0, MAX_THREAD_USER_MESSAGE_NAVIGATION_OUTPUT_PILLS);
  return [
    ...visible,
    {
      id: "additional-output-count",
      type: visible[visible.length - 1]?.type ?? "file",
      label: `+${outputs.length - visible.length}`,
    },
  ];
}

function isHeartbeatUserMessage(block: ThreadTranscriptBlockModel): boolean {
  const rawItem = asRecord(block.entry.rawItem);
  const rawType = typeof rawItem?.type === "string" ? rawItem.type : "";
  const source = typeof block.entry.source === "string" ? block.entry.source : "";
  return (
    rawType.toLowerCase().includes("heartbeat") ||
    source.toLowerCase().includes("heartbeat") ||
    (block.entry.markdownText ?? "").includes("Sent by rule")
  );
}

export function buildThreadUserMessageNavigationItems(
  entries: readonly VisibleConversationTurnEntry[],
  scope: ProjectlessOutputScope = {},
): ThreadUserMessageNavigationItem[] {
  const items: ThreadUserMessageNavigationItem[] = [];

  for (const entry of entries) {
    const turnModel = selectTurnRenderModel({
      entry,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: scope.cwd,
      projectlessOutputDirectory: scope.projectlessOutputDirectory,
    });
    const blocks = flattenThreadBlocks(turnModel.blocks);
    const userBlocks = blocks
      .map((block, blockIndex) => ({ block, blockIndex }))
      .filter(
        (candidate): candidate is { block: ThreadTranscriptBlockModel; blockIndex: number } =>
          isThreadTranscriptBlock(candidate.block) &&
          candidate.block.type === "userMessage" &&
          typeof candidate.block.searchUnitKey === "string",
      );

    for (const [userIndex, candidate] of userBlocks.entries()) {
      const remainingBlocks = blocks.slice(candidate.blockIndex + 1);
      const messageId = asRecord(candidate.block.entry.rawItem)?.clientId;
      items.push({
        ...(typeof messageId === "string" ? { messageId } : {}),
        id: candidate.block.searchUnitKey ?? `${entry.turnId}:user:${userIndex}`,
        turnId: entry.turnId,
        turnKey: entry.turnKey,
        ordinal: items.length + 1,
        label: resolveUserLabel(candidate.block),
        responsePreview: resolveAssistantResponsePreview(blocks, candidate.blockIndex),
        outputs: collectOutputsFromBlocks(remainingBlocks),
        isHeartbeat: isHeartbeatUserMessage(candidate.block),
      });
    }
  }

  return items;
}
