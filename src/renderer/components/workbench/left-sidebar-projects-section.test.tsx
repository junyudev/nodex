import { describe, expect, test } from "bun:test";
import type { Project } from "../../lib/types";
import { SidebarProjectsSection } from "./left-sidebar-projects-section";
import { render, textContent } from "../../test/dom";

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
    const { container, getByRole, getByText, getByLabelText } = render(
      <SidebarProjectsSection
        projects={PROJECTS}
        spaces={[
          { projectId: "beta", colorToken: "var(--accent-blue)", initial: "B" },
          { projectId: "alpha", colorToken: "var(--accent-green)", initial: "A" },
        ]}
        activeProjectId="beta"
        expanded
        onToggleExpanded={() => undefined}
        onSelectSpace={() => undefined}
        onCreateProject={async () => null}
        onDeleteProject={async () => false}
        onRenameProject={async () => null}
      />,
    );

    expect(getByText("Projects").textContent).toBe("Projects");
    expect(getByLabelText("Manage projects").getAttribute("aria-label")).toBe("Manage projects");
    expect(textContent(container).includes("/repo/beta")).toBeTrue();
    expect(textContent(container).includes("/alpha")).toBeTrue();
    expect(textContent(container).indexOf("Beta") < textContent(container).indexOf("Alpha")).toBeTrue();

    const projectButton = getByRole("button", { name: /Beta\s*\/beta/ });
    const workspaceButton = getByLabelText("/repo/beta");
    expect(projectButton.contains(workspaceButton)).toBeFalse();
  });

  test("keeps only the active project row visible when collapsed", () => {
    const { getByText, queryByText } = render(
      <SidebarProjectsSection
        projects={PROJECTS}
        spaces={[
          { projectId: "beta", colorToken: "var(--accent-blue)", initial: "B" },
          { projectId: "alpha", colorToken: "var(--accent-green)", initial: "A" },
        ]}
        activeProjectId="beta"
        expanded={false}
        onToggleExpanded={() => undefined}
        onSelectSpace={() => undefined}
        onCreateProject={async () => null}
        onDeleteProject={async () => false}
        onRenameProject={async () => null}
      />,
    );

    expect(getByText("Beta").textContent).toBe("Beta");
    expect(queryByText("Alpha")).toBe(null);
  });
});
