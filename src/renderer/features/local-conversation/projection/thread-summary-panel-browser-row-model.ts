import { getIntl } from "@/lib/i18n";
import type { PanelId } from "../../../lib/types";
import type { ThreadSummaryPanelBrowserRow } from "../thread-stage-types";
import {
  makeBrowserSidebarTabKey,
  type BrowserSidebarTabSnapshot,
  type BrowserUseTabState,
} from "../../../../shared/browser-sidebar";

const BROWSER_ATTACH_TOKEN_URL_PREFIX = "about:blank#codex-browser-sidebar-attach-token=";

export interface ThreadSummaryPanelBrowserRowInput {
  id: string;
  browserTabId: string;
  workbenchTabId?: string | null;
  tabTitle: string;
  configTitle?: string | null;
  url?: string | null;
  faviconUrl?: string | null;
  isAgentWorking?: boolean;
  panelId?: PanelId;
  leafId?: string | null;
}

export interface ThreadSummaryPanelWorkbenchBrowserSource {
  browserTabId: string;
  workbenchTabId: string;
  tabTitle: string;
  configTitle?: string | null;
  url?: string | null;
  faviconUrl?: string | null;
  panelId: PanelId;
  leafId?: string | null;
}

export interface ThreadSummaryPanelBrowserRowsInput {
  rightTabs: readonly ThreadSummaryPanelWorkbenchBrowserSource[];
  bottomTabs: readonly ThreadSummaryPanelWorkbenchBrowserSource[];
  pendingTabs: readonly ThreadSummaryPanelWorkbenchBrowserSource[];
  runtimeTabs: readonly BrowserUseTabState[];
  snapshots: readonly BrowserSidebarTabSnapshot[];
  activeBrowserUseTabId: string | null;
}

export function buildThreadSummaryPanelBrowserRow(
  input: ThreadSummaryPanelBrowserRowInput,
): ThreadSummaryPanelBrowserRow {
  const rawUrl = input.url?.trim() ?? "";
  const displayUrl = isHiddenBrowserSummaryUrl(rawUrl)
    ? null
    : resolveBrowserSummaryDisplayUrl(rawUrl);
  const titleSource = input.configTitle?.trim() || input.tabTitle;
  const title = displayUrl
    ? resolveBrowserSummaryTitle(titleSource, displayUrl)
    : resolveBlankBrowserSummaryTitle(titleSource);
  const faviconUrl = input.faviconUrl?.trim() ?? "";

  return {
    id: input.id,
    browserTabId: input.browserTabId,
    workbenchTabId: input.workbenchTabId ?? null,
    title,
    displayUrl,
    url: isBrowserAttachTokenUrl(rawUrl) ? "" : rawUrl,
    faviconUrl: faviconUrl.length > 0 ? faviconUrl : null,
    isAgentWorking: input.isAgentWorking === true,
    isMaterialized: input.workbenchTabId !== null && input.workbenchTabId !== undefined,
    panelId: input.panelId,
    leafId: input.leafId ?? null,
  };
}

export function buildThreadSummaryPanelBrowserRows({
  rightTabs,
  bottomTabs,
  pendingTabs,
  runtimeTabs,
  snapshots,
  activeBrowserUseTabId,
}: ThreadSummaryPanelBrowserRowsInput): ThreadSummaryPanelBrowserRow[] {
  const snapshotsByKey = new Map(
    snapshots.map((snapshot) => [makeBrowserSidebarTabKey(snapshot), snapshot]),
  );
  const runtimeById = new Map(runtimeTabs.map((tab) => [tab.browserTabId, tab]));
  const rows: ThreadSummaryPanelBrowserRow[] = [];
  const seenBrowserTabIds = new Set<string>();

  const appendWorkbenchSource = (source: ThreadSummaryPanelWorkbenchBrowserSource) => {
    if (seenBrowserTabIds.has(source.browserTabId)) return;
    seenBrowserTabIds.add(source.browserTabId);
    const runtime = runtimeById.get(source.browserTabId) ?? null;
    const snapshot = runtime
      ? (snapshotsByKey.get(makeBrowserSidebarTabKey(runtime)) ?? null)
      : (snapshots.find((candidate) => candidate.browserTabId === source.browserTabId) ?? null);
    rows.push(
      buildThreadSummaryPanelBrowserRow({
        id: source.workbenchTabId,
        browserTabId: source.browserTabId,
        workbenchTabId: source.workbenchTabId,
        tabTitle: snapshot?.title ?? source.tabTitle,
        configTitle: snapshot?.title ?? runtime?.title ?? source.configTitle,
        url: snapshot?.url ?? runtime?.url ?? source.url,
        faviconUrl: snapshot?.faviconUrl ?? source.faviconUrl,
        isAgentWorking: isThreadSummaryBrowserRowAgentWorking(
          activeBrowserUseTabId,
          source.browserTabId,
        ),
        panelId: source.panelId,
        leafId: source.leafId,
      }),
    );
  };

  for (const source of [...rightTabs, ...bottomTabs, ...pendingTabs]) {
    appendWorkbenchSource(source);
  }
  for (const runtime of runtimeTabs) {
    if (seenBrowserTabIds.has(runtime.browserTabId)) continue;
    seenBrowserTabIds.add(runtime.browserTabId);
    const snapshot = snapshotsByKey.get(makeBrowserSidebarTabKey(runtime)) ?? null;
    rows.push(
      buildThreadSummaryPanelBrowserRow({
        id: `browser-use:${runtime.browserTabId}`,
        browserTabId: runtime.browserTabId,
        workbenchTabId: null,
        tabTitle: snapshot?.title ?? runtime.title,
        configTitle: snapshot?.title ?? runtime.title,
        url: snapshot?.url ?? runtime.url,
        faviconUrl: snapshot?.faviconUrl,
        isAgentWorking: isThreadSummaryBrowserRowAgentWorking(
          activeBrowserUseTabId,
          runtime.browserTabId,
        ),
      }),
    );
  }
  return rows;
}

export function isThreadSummaryBrowserRowAgentWorking(
  activeBrowserUseTabId: string | null | undefined,
  browserTabId: string,
): boolean {
  return activeBrowserUseTabId === browserTabId;
}

function isHiddenBrowserSummaryUrl(url: string): boolean {
  return url.length === 0 || url === "about:blank" || isBrowserAttachTokenUrl(url);
}

function isBrowserAttachTokenUrl(url: string): boolean {
  return url.startsWith(BROWSER_ATTACH_TOKEN_URL_PREFIX);
}

function resolveBlankBrowserSummaryTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0)
    return getIntl().formatMessage({
      id: "conversation.threadSummaryPanelBrowserRowModel.browser",
      defaultMessage: "Browser",
    });
  if (trimmed === "about:blank")
    return getIntl().formatMessage({
      id: "conversation.threadSummaryPanelBrowserRowModel.browser",
      defaultMessage: "Browser",
    });
  if (trimmed.startsWith(BROWSER_ATTACH_TOKEN_URL_PREFIX))
    return getIntl().formatMessage({
      id: "conversation.threadSummaryPanelBrowserRowModel.browser",
      defaultMessage: "Browser",
    });
  return trimmed;
}

function resolveBrowserSummaryTitle(title: string, displayUrl: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return displayUrl;
  if (trimmed === "New tab") return displayUrl;
  if (trimmed === "about:blank") return displayUrl;
  if (trimmed.startsWith(BROWSER_ATTACH_TOKEN_URL_PREFIX)) return displayUrl;
  return trimmed;
}

function resolveBrowserSummaryDisplayUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./u, "");
  } catch {
    return url.replace(/^https?:\/\//u, "");
  }
}
