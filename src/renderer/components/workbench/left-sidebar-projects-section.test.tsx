import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "../../lib/types";
import { SidebarProjectsSection } from "./left-sidebar-projects-section";

const PROJECTS: Project[] = [
  {
    id: "alpha",
    name: "Alpha",
    description: "",
    icon: "A",
    workspacePath: "",
    created: new Date("2026-03-15T00:00:00.000Z"),
  },
  {
    id: "beta",
    name: "Beta",
    description: "",
    icon: "B",
    workspacePath: "/repo/beta",
    created: new Date("2026-03-15T00:00:00.000Z"),
  },
];

describe("SidebarProjectsSection", () => {
  test("renders projects in space order and keeps workspace controls visible", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarProjectsSection, {
        projects: PROJECTS,
        spaces: [
          { projectId: "beta", colorToken: "var(--accent-blue)", initial: "B" },
          { projectId: "alpha", colorToken: "var(--accent-green)", initial: "A" },
        ],
        activeProjectId: "beta",
        expanded: true,
        onToggleExpanded: () => undefined,
        onSelectSpace: () => undefined,
        onCreateProject: async () => null,
        onDeleteProject: async () => false,
        onRenameProject: async () => null,
      }),
    );

    expect(markup.includes("Projects")).toBeTrue();
    expect(markup.includes("Manage projects")).toBeTrue();
    expect(markup.includes("/repo/beta")).toBeTrue();
    expect(markup.includes("/alpha")).toBeTrue();
    expect(markup.indexOf("Beta") < markup.indexOf("Alpha")).toBeTrue();
  });

  test("keeps only the active project row visible when collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarProjectsSection, {
        projects: PROJECTS,
        spaces: [
          { projectId: "beta", colorToken: "var(--accent-blue)", initial: "B" },
          { projectId: "alpha", colorToken: "var(--accent-green)", initial: "A" },
        ],
        activeProjectId: "beta",
        expanded: false,
        onToggleExpanded: () => undefined,
        onSelectSpace: () => undefined,
        onCreateProject: async () => null,
        onDeleteProject: async () => false,
        onRenameProject: async () => null,
      }),
    );

    expect(markup.includes("Beta")).toBeTrue();
    expect(markup.includes("Alpha")).toBeFalse();
  });
});
