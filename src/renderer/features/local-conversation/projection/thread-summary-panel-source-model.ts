import { getIntl } from "@/lib/i18n";
import type {
  CodexConversationItem,
  CodexConversationTurn,
  CodexMcpToolCallView,
  ProtocolAppInfo,
} from "../../../lib/types";
import { resolveCodexMcpVisualSource } from "../../../../shared/codex-mcp-tool-call";
import type { ThreadMcpAppSidePanelInput } from "../thread-stage-types";
import {
  buildMcpAppSidePanelInput,
  resolveMcpEmbeddedRenderableResource,
} from "./tool-metadata/mcp-tool-call-resource-utils";

export type ThreadSummaryPanelSourceKind = "tool" | "webPage" | "webSearch";

export type ThreadSummaryPanelSourceOpenAction =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "mcpApp";
      input: ThreadMcpAppSidePanelInput;
    };

export interface ThreadSummaryPanelSourceItem {
  id: string;
  kind: ThreadSummaryPanelSourceKind;
  label: string;
  logoUrl: string | null;
  logoUrlDark: string | null;
  mcpAppTarget: ThreadSummaryPanelMcpAppSourceTarget | null;
  openAction: ThreadSummaryPanelSourceOpenAction | null;
}

export interface ThreadSummaryPanelMcpAppSourceTarget {
  threadId: string;
  payload: CodexMcpToolCallView;
}

export interface ThreadSummaryPanelSourceModel {
  items: ThreadSummaryPanelSourceItem[];
  count: number;
}

interface McpSourceDraft {
  id: string;
  label: string;
  logoUrl: string | null;
  logoUrlDark: string | null;
  mcpAppTarget: ThreadSummaryPanelMcpAppSourceTarget | null;
  openAction: ThreadSummaryPanelSourceOpenAction | null;
}

interface WebPageSourceDraft {
  url: string;
  label: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isMcpToolCallItem(item: CodexConversationItem): boolean {
  return item.type === "mcpToolCall" || item.semanticKind === "mcpToolCall";
}

function isWebSearchItem(item: CodexConversationItem): boolean {
  return item.type === "webSearch" || item.semanticKind === "webSearch";
}

function resolveMcpAppSourceTarget(
  item: CodexConversationItem,
): ThreadSummaryPanelMcpAppSourceTarget | null {
  const payload = item.mcpToolCall;
  const threadId = trimNonEmptyString(item.threadId);
  if (!payload || !threadId) return null;

  return { threadId, payload };
}

function resolveMcpSourceOpenAction(
  target: ThreadSummaryPanelMcpAppSourceTarget | null,
): ThreadSummaryPanelSourceOpenAction | null {
  if (!target) return null;

  const resource = resolveMcpEmbeddedRenderableResource({ payload: target.payload });
  if (!resource) return null;

  return {
    type: "mcpApp",
    input: buildMcpAppSidePanelInput({
      threadId: target.threadId,
      payload: target.payload,
      resource,
    }),
  };
}

function resolveMcpSourceDraft(
  item: CodexConversationItem,
  resolvedApps: readonly ProtocolAppInfo[],
): McpSourceDraft | null {
  const payload = item.mcpToolCall;
  if (!payload) return null;

  const source = resolveCodexMcpVisualSource({
    functionName: payload.functionName,
    invocation: payload.invocation,
    resolvedApps,
    source: payload.source,
  });
  if (!source) return null;

  const mcpAppTarget = resolveMcpAppSourceTarget(item);
  return {
    id: source.key,
    label: source.name,
    logoUrl: source.logoUrl,
    logoUrlDark: source.logoUrlDark,
    mcpAppTarget,
    openAction: resolveMcpSourceOpenAction(mcpAppTarget),
  };
}

function collectToolSources(
  turns: readonly CodexConversationTurn[],
  resolvedApps: readonly ProtocolAppInfo[],
): ThreadSummaryPanelSourceItem[] {
  const sources = new Map<string, ThreadSummaryPanelSourceItem>();

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn) continue;

    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (!item || !isMcpToolCallItem(item)) continue;

      const source = resolveMcpSourceDraft(item, resolvedApps);
      if (!source) continue;

      const existingSource = sources.get(source.id);
      if (existingSource) {
        if (
          (!existingSource.openAction && source.openAction) ||
          (!existingSource.mcpAppTarget && source.mcpAppTarget)
        ) {
          sources.set(source.id, {
            ...existingSource,
            mcpAppTarget: existingSource.mcpAppTarget ?? source.mcpAppTarget,
            openAction: existingSource.openAction ?? source.openAction,
          });
        }
        continue;
      }

      sources.set(source.id, {
        id: source.id,
        kind: "tool",
        label: source.label,
        logoUrl: source.logoUrl,
        logoUrlDark: source.logoUrlDark,
        mcpAppTarget: source.mcpAppTarget,
        openAction: source.openAction,
      });
    }
  }

  return [...sources.values()];
}

function resolveWebSearchAction(item: CodexConversationItem): unknown {
  const rawItem = asRecord(item.rawItem);
  if (rawItem && Object.prototype.hasOwnProperty.call(rawItem, "action")) {
    return rawItem.action;
  }

  return item.toolCall?.result;
}

function parseReferenceWebUrl(value: unknown): URL | null {
  const rawUrl = trimNonEmptyString(value);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveWebPageSource(action: unknown): WebPageSourceDraft | null {
  const record = asRecord(action);
  const actionType = trimNonEmptyString(record?.type);
  if (actionType !== "openPage" && actionType !== "findInPage") return null;

  const url = parseReferenceWebUrl(record?.url);
  if (!url) return null;

  return {
    url: url.href,
    label: `${url.hostname.replace(/^www\./iu, "")}${url.pathname}`,
  };
}

function collectWebSources(
  turns: readonly CodexConversationTurn[],
): ThreadSummaryPanelSourceItem[] {
  const pageSources = new Map<string, ThreadSummaryPanelSourceItem>();
  let sawWebSearch = false;

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn) continue;

    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (!item || !isWebSearchItem(item)) continue;
      sawWebSearch = true;

      const page = resolveWebPageSource(resolveWebSearchAction(item));
      if (!page || pageSources.has(page.url)) continue;

      pageSources.set(page.url, {
        id: `web-page:${page.url}`,
        kind: "webPage",
        label: page.label,
        logoUrl: null,
        logoUrlDark: null,
        mcpAppTarget: null,
        openAction: {
          type: "url",
          url: page.url,
        },
      });
    }
  }

  const pages = [...pageSources.values()];
  if (pages.length > 0) return pages;
  if (!sawWebSearch) return [];

  return [
    {
      id: "web-search",
      kind: "webSearch",
      label: getIntl().formatMessage({
        id: "conversation.threadSummaryPanelSourceModel.webSearch",
        defaultMessage: "Web search",
      }),
      logoUrl: null,
      logoUrlDark: null,
      mcpAppTarget: null,
      openAction: null,
    },
  ];
}

export function buildThreadSummaryPanelSourceModel(
  turns: readonly CodexConversationTurn[],
  resolvedApps: readonly ProtocolAppInfo[] = [],
): ThreadSummaryPanelSourceModel {
  const items = [...collectToolSources(turns, resolvedApps), ...collectWebSources(turns)];

  return {
    items,
    count: items.length,
  };
}
