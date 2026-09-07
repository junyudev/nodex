import { describe, expect, test } from "vite-plus/test";
import type { Project } from "@/lib/types";
import {
  buildWorkbenchAutomationProjectOptions,
  formatWorkbenchAutomationProjectTriggerLabel,
  resolveWorkbenchAutomationProjectForRoot,
  toggleWorkbenchAutomationProjectRoot,
  selectWorkbenchAutomationProjectRoot,
} from "./workbench-automation-project-options";

function makeProject(input: {
  id: string;
  name?: string;
  roots?: string[];
  primaryWorkspaceRoot?: string | null;
}): Project {
  const roots = input.roots ?? [];
  return {
    id: input.id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: input.name ?? input.id,
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: roots.map((root, order) => ({ root, order })),
    primaryWorkspaceRoot: input.primaryWorkspaceRoot ?? roots[0] ?? null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-07-09T00:00:00.000Z"),
    updated: new Date("2026-07-09T00:00:00.000Z"),
  };
}

describe("workbench automation project options", () => {
  test("uses local project roots as selectable cwd values", () => {
    const options = buildWorkbenchAutomationProjectOptions({
      selectedProjectId: "nodex",
      projects: [
        makeProject({ id: "nodex", name: "Nodex", roots: ["/Users/asc/repo/nodex"] }),
        makeProject({ id: "scratch", name: "Scratch", roots: [] }),
      ],
      selectedRoots: [],
    });

    expect(options.length).toBe(1);
    expect(options[0]?.value).toBe("/Users/asc/repo/nodex");
    expect(options[0]?.label).toBe("Nodex");
    expect(options[0]?.description).toBe("/Users/asc/repo/nodex");
  });

  test("keeps unmatched selected roots visible for existing automations", () => {
    const options = buildWorkbenchAutomationProjectOptions({
      selectedProjectId: "nodex",
      projects: [makeProject({ id: "nodex", name: "Nodex", roots: ["/Users/asc/repo/nodex"] })],
      selectedRoots: ["/tmp/legacy"],
    });

    expect(options.length).toBe(2);
    expect(options[1]?.value).toBe("/tmp/legacy");
    expect(options[1]?.label).toBe("/tmp/legacy");
    expect(options[1]?.isFallback).toBe(true);
  });

  test("formats trigger labels for empty, single, and multi-root selections", () => {
    const options = buildWorkbenchAutomationProjectOptions({
      selectedProjectId: "nodex",
      projects: [makeProject({ id: "nodex", name: "Nodex", roots: ["/Users/asc/repo/nodex"] })],
      selectedRoots: [],
    });

    expect(
      formatWorkbenchAutomationProjectTriggerLabel({
        selectedProjectId: "nodex",
        selectedRoots: [],
        options,
      }),
    ).toBe("Select project");
    expect(
      formatWorkbenchAutomationProjectTriggerLabel({
        selectedProjectId: "nodex",
        selectedRoots: ["/Users/asc/repo/nodex"],
        options,
      }),
    ).toBe("Nodex");
    expect(
      formatWorkbenchAutomationProjectTriggerLabel({
        selectedProjectId: "nodex",
        selectedRoots: ["/Users/asc/repo/nodex", "/tmp/legacy"],
        options,
      }),
    ).toBe("Nodex · 2 folders");
  });

  test("toggles selected roots without duplicating cwd values", () => {
    const selected = toggleWorkbenchAutomationProjectRoot({
      selectedRoots: ["/Users/asc/repo/nodex"],
      root: "/Users/asc/repo/devtools-codex",
    });
    expect(JSON.stringify(selected)).toBe(
      JSON.stringify(["/Users/asc/repo/nodex", "/Users/asc/repo/devtools-codex"]),
    );

    const nextSelected = toggleWorkbenchAutomationProjectRoot({
      selectedRoots: selected,
      root: "/Users/asc/repo/nodex",
    });
    expect(JSON.stringify(nextSelected)).toBe(JSON.stringify(["/Users/asc/repo/devtools-codex"]));
  });

  test("resolves a selected cwd back to its owning project", () => {
    const projects = [
      makeProject({ id: "alpha", name: "Alpha", roots: ["/repo/alpha"] }),
      makeProject({
        id: "beta",
        name: "Beta",
        roots: ["/repo/beta", "/repo/beta-extra"],
        primaryWorkspaceRoot: "/repo/beta",
      }),
    ];

    expect(
      resolveWorkbenchAutomationProjectForRoot({
        projectId: "beta",
        projects,
        root: "/repo/beta-extra",
      })?.id,
    ).toBe("beta");
    expect(
      resolveWorkbenchAutomationProjectForRoot({
        projectId: "beta",
        projects,
        root: "/repo/missing",
      }),
    ).toBe(null);
  });
});

test("keeps Projects sharing a directory distinct and clears folders when switching Project", () => {
  const projects = [
    makeProject({ id: "a", roots: ["/shared"] }),
    makeProject({ id: "b", roots: ["/shared"] }),
  ];
  const options = buildWorkbenchAutomationProjectOptions({
    projects,
    selectedProjectId: "b",
    selectedRoots: ["/shared"],
  });
  expect(options.map((option) => option.projectId)).toEqual(["a", "b"]);
  expect(
    resolveWorkbenchAutomationProjectForRoot({ projects, projectId: "b", root: "/shared" })?.id,
  ).toBe("b");
  expect(
    selectWorkbenchAutomationProjectRoot({
      projectId: "b",
      selectedProjectId: "a",
      selectedRoots: ["/only-a", "/shared"],
      root: "/shared",
    }),
  ).toEqual({ projectId: "b", cwds: ["/shared"] });
  expect(
    formatWorkbenchAutomationProjectTriggerLabel({
      selectedProjectId: null,
      selectedRoots: [],
      options,
    }),
  ).toBe("No project");
});
