import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import {
  BROWSER_NEW_TAB_TITLE,
  BROWSER_TAB_FALLBACK_MESSAGES,
  browserTabFallbackMessage,
} from "../../shared/browser-url";
import type { WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
import type { WorkbenchSurfaceReference } from "../../shared/nodex-app-tools/workbench";
import { presentPageTitle } from "./page-title-projection-store";
import { presentSessionTitle } from "./session-title-presentation";
import type { WorkbenchTabProjection } from "./types";
import { PANEL_TOOL_TITLE_MESSAGES } from "./workbench-panel-actions";

const messages = defineMessages({
  inbox: { id: "lib.workbenchSceneTabPresentation.inbox", defaultMessage: "Inbox" },
  page: { id: "workbench.workbenchPageFileSurface.page", defaultMessage: "Page" },
  file: { id: "workbench.useWorkbenchPanelProjection.file", defaultMessage: "File" },
});

type TabShape<T> = T extends { readonly kind: infer K; readonly config: infer C }
  ? { readonly kind: K; readonly config: C }
  : never;

type TabTitleSource = TabShape<
  | WorkbenchSurfaceDescriptor
  | WorkbenchTabProjection
  | Exclude<WorkbenchSurfaceReference, { kind: "page_stage" }>
>;

export interface WorkbenchPanelTabTitleOptions {
  readonly browserPage?: { readonly url: string; readonly title: string };
  readonly standardDatabaseTitle?: boolean;
}

/** Presents a tab using its identity and live Browser state, leaving its snapshot intact. */
export function presentWorkbenchPanelTabTitle(
  tab: TabTitleSource,
  snapshot: string,
  intl: IntlShape = getIntl(),
  { browserPage, standardDatabaseTitle }: WorkbenchPanelTabTitleOptions = {},
): string {
  switch (tab.kind) {
    case "inbox":
      return intl.formatMessage(messages.inbox);
    case "conversation":
    case "side_chat":
      return presentSessionTitle(snapshot, intl);
    case "browser": {
      const savedUrl = "url" in tab.config ? tab.config.url : undefined;
      const savedTitle = "title" in tab.config ? tab.config.title : undefined;
      const url = browserPage?.url ?? savedUrl;
      // A restored tab without a saved URL may still have a previous page's title.
      if (url === undefined && snapshot.trim() && snapshot !== BROWSER_NEW_TAB_TITLE) {
        return snapshot === "Browser"
          ? intl.formatMessage(BROWSER_TAB_FALLBACK_MESSAGES.browser)
          : snapshot;
      }
      const title = browserPage?.title ?? savedTitle ?? (snapshot === "Browser" ? "" : snapshot);
      const fallback = browserTabFallbackMessage(url, title);
      return fallback ? intl.formatMessage(fallback) : title.trim();
    }
    case "terminal":
      return snapshot && snapshot !== "Terminal"
        ? snapshot
        : intl.formatMessage(PANEL_TOOL_TITLE_MESSAGES.terminal);
    case "files":
      return tab.config.path ? snapshot : intl.formatMessage(PANEL_TOOL_TITLE_MESSAGES.files);
    case "review":
      return intl.formatMessage(PANEL_TOOL_TITLE_MESSAGES.review);
    case "db_view":
      return standardDatabaseTitle || tab.config.target.kind === "project-default"
        ? intl.formatMessage(PANEL_TOOL_TITLE_MESSAGES.database)
        : presentPageTitle(snapshot, intl);
    case "page_stage":
      return tab.config.titleSnapshot === undefined && snapshot === "Page"
        ? intl.formatMessage(messages.page)
        : presentPageTitle(snapshot, intl);
    case "page_file":
      return (
        ("titleSnapshot" in tab.config && tab.config.titleSnapshot) ||
        tab.config.logicalPath?.split("/").at(-1) ||
        intl.formatMessage(messages.file)
      );
    default:
      return snapshot;
  }
}
