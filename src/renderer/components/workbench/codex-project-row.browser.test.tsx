import type { CSSProperties } from "react";
import { act } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { Project } from "@/lib/types";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
import { createAgentRuntimeActivityStore } from "@/lib/agent-runtime-session-activity";
import { CodexProjectRow } from "./codex-sidebar";
import "../../globals.css";

const PROJECT: Project = {
  id: "project-alpha",
  libraryId: "library:test",
  databaseId: "database:test:primary",
  defaultDatabaseViewId: "view:test:primary",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Alpha",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [],
  primaryWorkspaceRoot: null,
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-08-01T00:00:00.000Z"),
  updated: new Date("2026-08-01T00:00:00.000Z"),
};

// The hover card shows live Runtime activity; this chrome test runs without the desktop bridge.
const QUIET_ACTIVITY = createAgentRuntimeActivityStore({
  read: async () => ({ sequence: 0, items: [], complete: true }),
  subscribe: () => () => {},
  readConnection: async () => ({ status: "idle" }),
  subscribeConnection: () => () => {},
});

describe("CodexProjectRow interaction chrome in Chromium", () => {
  test("keeps the marker at rest and layers row and disclosure hover states", async () => {
    const view = render(
      <TestQueryProvider>
        <NodexHoverCardProvider delay={0} timeoutMs={0}>
          <NodexTooltipProvider>
            <div
              className="w-72"
              style={
                {
                  "--color-token-list-hover-background": "rgba(13, 13, 13, 0.08)",
                } as CSSProperties
              }
            >
              <CodexProjectRow
                project={PROJECT}
                activityStore={QUIET_ACTIVITY}
                active
                expanded
                onActivate={() => undefined}
                onSelectProject={() => undefined}
                onUpdateProject={async () => null}
                onArchiveProject={async () => ({ kind: "not-found" })}
              />
            </div>
          </NodexTooltipProvider>
        </NodexHoverCardProvider>
      </TestQueryProvider>,
    );
    const row = view.container.querySelector<HTMLElement>("[data-app-action-sidebar-project-row]");
    const marker = view.container.querySelector<HTMLElement>(
      "[data-app-action-sidebar-project-marker]",
    );
    const disclosure = view.getByRole("button", { name: "Collapse project" });
    const projectNavigation = view.getByRole("button", { name: "Open Alpha" });
    if (!row || !marker) throw new Error("Expected Project row chrome");

    expect(getComputedStyle(marker).visibility).toBe("visible");
    expect(getComputedStyle(disclosure).opacity).toBe("0");

    await act(async () => {
      await userEvent.click(projectNavigation);
      await userEvent.unhover(row);
    });
    expect(document.activeElement).toBe(projectNavigation);
    expect(getComputedStyle(marker).visibility).toBe("visible");
    expect(getComputedStyle(disclosure).opacity).toBe("0");

    await act(async () => {
      await userEvent.hover(row);
    });
    expect(getComputedStyle(marker).visibility).toBe("hidden");
    expect(getComputedStyle(disclosure).opacity).toBe("1");
    expect(getComputedStyle(disclosure).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    await act(async () => {
      await userEvent.hover(disclosure);
    });
    expect(getComputedStyle(disclosure).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    await act(async () => {
      await userEvent.unhover(row);
      await userEvent.tab({ shift: true });
    });
    expect(document.activeElement).toBe(disclosure);
    expect(getComputedStyle(marker).visibility).toBe("hidden");
    expect(getComputedStyle(disclosure).opacity).toBe("1");
  });

  test("shares the trailing space between the Inbox count and pointer or keyboard actions", async () => {
    const onStartNewChat = vi.fn();
    const view = render(
      <TestQueryProvider>
        <NodexHoverCardProvider>
          <NodexTooltipProvider>
            <div className="w-72">
              <CodexProjectRow
                project={PROJECT}
                activityStore={QUIET_ACTIVITY}
                active={false}
                expanded
                inboxCount={12}
                hoverCardOpen={false}
                onActivate={() => undefined}
                onSelectProject={() => undefined}
                onStartNewChat={onStartNewChat}
                onUpdateProject={async () => null}
                onArchiveProject={async () => ({ kind: "not-found" })}
              />
            </div>
          </NodexTooltipProvider>
        </NodexHoverCardProvider>
      </TestQueryProvider>,
    );
    const row = view.container.querySelector<HTMLElement>("[data-app-action-sidebar-project-row]");
    if (!row) throw new Error("Expected Project row");
    const count = view.getByLabelText("12 in Alpha's Inbox");
    const projectNavigation = view.getByRole("button", { name: "Open Alpha" });
    const menu = view.getByRole("button", { name: "Project actions for Alpha" });
    const newChat = view.getByRole("button", { name: "Start new chat in Alpha" });
    const painted = (element: Element) =>
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    await act(async () => {
      await userEvent.unhover(row);
    });
    expect(painted(count)).toBe(true);
    expect(painted(menu)).toBe(false);
    expect(painted(newChat)).toBe(false);
    const text = document.createRange();
    text.selectNodeContents(count);
    const countRight = text.getBoundingClientRect().right;
    expect(row.getBoundingClientRect().right - countRight).toBeLessThanOrEqual(8);
    expect(countRight).toBeGreaterThan(newChat.getBoundingClientRect().left);
    expect(countRight).toBeLessThanOrEqual(newChat.getBoundingClientRect().right);

    await act(async () => {
      await userEvent.hover(row);
    });
    expect(painted(count)).toBe(false);
    expect(painted(menu)).toBe(true);
    expect(painted(newChat)).toBe(true);
    await act(async () => {
      await userEvent.click(menu);
      await userEvent.unhover(row);
    });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(painted(count)).toBe(false);
    await act(async () => {
      await userEvent.keyboard("{Escape}");
      projectNavigation.focus();
      await userEvent.tab();
    });
    expect(document.activeElement).toBe(menu);
    expect(painted(count)).toBe(false);
    expect(painted(menu)).toBe(true);
    await act(async () => {
      await userEvent.tab();
    });
    expect(document.activeElement).toBe(newChat);
    expect(painted(newChat)).toBe(true);
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    expect(onStartNewChat).toHaveBeenCalledOnce();
  });
});
