import { BoardIcon, InboxIcon } from "@/components/shared/icons";
import { createIntl } from "react-intl";
import { describe, expect, test } from "vite-plus/test";

import { LIBRARY_INBOX, projectInbox } from "../../shared/inbox";
import { inboxSurface, type WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
import { resolveWorkbenchSceneTabPresentation } from "./workbench-scene-tab-presentation";

const databaseSurface: WorkbenchSurfaceDescriptor = {
  id: "surface:database",
  kind: "db_view",
  titleSnapshot: "Database",
  config: {
    routingContext: { kind: "project", projectId: "alpha" },
    target: { kind: "project-default" },
  },
  stateKey: 0,
  state: null,
};

const zh = createIntl({
  locale: "zh-CN",
  messages: {
    "lib.workbenchSceneTabPresentation.inbox": "收件箱",
    "lib.workbenchPanelActions.terminal.label": "终端",
    "lib.pageTitleProjection.untitled": "无标题",
    "shared.browserUrl.newTab": "新标签页",
    "workbench.workbenchPageFileSurface.page": "页面",
  },
});

describe("resolveWorkbenchSceneTabPresentation", () => {
  test("presents every Inbox Home as Inbox", () => {
    for (const scope of [projectInbox("alpha"), LIBRARY_INBOX]) {
      expect(resolveWorkbenchSceneTabPresentation(inboxSurface("home", scope))).toEqual({
        title: "Inbox",
        icon: InboxIcon,
      });
    }
  });

  test("presents the Project's Database like a standard DB View tab", () => {
    expect(resolveWorkbenchSceneTabPresentation(databaseSurface)).toEqual({
      title: "DB View",
      icon: BoardIcon,
    });
  });

  test("uses the kind to name a built-in surface without changing its stored snapshot", () => {
    const inbox = { ...inboxSurface("home", LIBRARY_INBOX), titleSnapshot: "Stored snapshot" };
    expect(resolveWorkbenchSceneTabPresentation(inbox, zh).title).toBe("收件箱");
    expect(inbox.titleSnapshot).toBe("Stored snapshot");
    const terminal = {
      id: "terminal",
      kind: "terminal",
      titleSnapshot: "Terminal",
      config: { terminalSessionId: "terminal-session" },
      stateKey: 0,
      state: null,
    } satisfies WorkbenchSurfaceDescriptor;
    expect(resolveWorkbenchSceneTabPresentation(terminal, zh).title).toBe("终端");
    expect(
      resolveWorkbenchSceneTabPresentation({ ...terminal, titleSnapshot: "Build" }, zh).title,
    ).toBe("Build");
  });

  test("localizes a blank Browser tab before the guest loads and preserves website titles", () => {
    const browser = {
      id: "browser",
      kind: "browser",
      titleSnapshot: "New tab",
      config: { browserTabId: "tab", url: "about:blank" },
      stateKey: 0,
      state: null,
    } satisfies WorkbenchSurfaceDescriptor;
    expect(resolveWorkbenchSceneTabPresentation(browser, zh).title).toBe("新标签页");
    const livePage = { url: "https://example.com", title: "New tab" };
    expect(resolveWorkbenchSceneTabPresentation(browser, zh, { browserPage: livePage }).title).toBe(
      "New tab",
    );
  });

  test("localizes a missing Page title and leaves a Page actually titled Page alone", () => {
    const page = {
      id: "page",
      kind: "page_stage",
      titleSnapshot: "Page",
      config: { pageId: "root", routingContext: { kind: "library" } },
      stateKey: 0,
      state: null,
    } satisfies WorkbenchSurfaceDescriptor;
    expect(resolveWorkbenchSceneTabPresentation(page, zh).title).toBe("页面");
    expect(resolveWorkbenchSceneTabPresentation({ ...page, titleSnapshot: "" }, zh).title).toBe(
      "无标题",
    );
    expect(
      resolveWorkbenchSceneTabPresentation(
        {
          ...page,
          config: { ...page.config, titleSnapshot: "Page" },
        },
        zh,
      ).title,
    ).toBe("Page");
  });
});
