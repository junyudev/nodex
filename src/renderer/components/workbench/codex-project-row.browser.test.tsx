import type { CSSProperties } from "react";
import { act } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { Project } from "@/lib/types";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
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
});
