import { beforeAll, beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { Project } from "../../lib/types";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithMaitai } from "../../test/thread-maitai";
import { openNodexMenu, textContent } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import type {
  NativeContextMenuItem,
  NativeContextMenuOptions,
} from "../../../shared/native-context-menu";

let SidebarProjectsSection: (typeof import("./left-sidebar-projects-section"))["SidebarProjectsSection"];
let CodexProjectRow: (typeof import("./codex-sidebar"))["CodexProjectRow"];
let CodexProjectSessionList: (typeof import("./codex-sidebar"))["CodexProjectSessionList"];
let invokeCalls: unknown[][] = [];
let mockInvokeImpl: ((channel: string, ...args: unknown[]) => Promise<unknown>) | null = null;

vi.mock("@/lib/api", () => ({
  readLibraryDatabaseModule: async (request: {
    read: { nameHint: string; requestedPrefix?: string };
  }) => {
    const prefix =
      request.read.requestedPrefix ??
      (request.read.nameHint.trim().toUpperCase().slice(0, 3) || "NX");
    return {
      ok: true,
      value: {
        storeEpoch: "epoch:test",
        value: {
          kind: "page_key_prefix_preview",
          value: {
            prefix,
            availability: "available",
            alternativePrefix: null,
            nextNumber: 1,
            exampleKeys: [`${prefix}-1`, `${prefix}-2`],
          },
        },
      },
    };
  },
  subscribeBoardChanges: () => () => undefined,
  subscribeProjectSessionChanges: () => () => undefined,
  subscribeProjectChanges: () => () => undefined,
  subscribeCodexHostMessages: () => () => undefined,
  subscribeDesktopNotificationActions: () => () => undefined,
  subscribeAppUpdateStatus: () => () => undefined,
  getWindowFocusState: async () => true,
  subscribeWindowFocusChanges: () => () => undefined,
}));

vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: async (channel: string, ...args: unknown[]) => {
    invokeCalls.push([channel, ...args]);
    return mockInvokeImpl?.(channel, ...args) ?? null;
  },
}));

vi.mock("@/lib/workbench-shell-operations", () => ({
  pickProjectSourceRoots: async () => {
    invokeCalls.push(["projects:pick-source-roots"]);
    return (await mockInvokeImpl?.("projects:pick-source-roots")) ?? [];
  },
}));

vi.mock("@/lib/file-system-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/file-system-operations")>()),
  openFileLink: async (target: unknown, opener: unknown) => {
    invokeCalls.push(["shell:open-file-link", target, opener]);
    return true;
  },
}));

const PROJECTS: Project[] = [
  {
    id: "alpha",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Alpha",
    description: "",
    appearance: { color: "green", marker: { kind: "icon", icon: "plant" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-03-15T00:00:00.000Z"),
    updated: new Date("2026-03-15T00:00:00.000Z"),
  },
  {
    id: "beta",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Beta",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "function" } },
    sources: [{ root: "/repo/beta", order: 0 }],
    primaryWorkspaceRoot: "/repo/beta",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-03-15T00:00:00.000Z"),
    updated: new Date("2026-03-15T00:00:00.000Z"),
  },
];

beforeAll(async () => {
  const [sectionModule, sidebarModule] = await Promise.all([
    import("./left-sidebar-projects-section"),
    import("./codex-sidebar"),
  ]);
  SidebarProjectsSection = sectionModule.SidebarProjectsSection;
  CodexProjectRow = sidebarModule.CodexProjectRow;
  CodexProjectSessionList = sidebarModule.CodexProjectSessionList;
});

beforeEach(() => {
  invokeCalls = [];
  mockInvokeImpl = null;
});

function renderProjectsSection(element: Parameters<typeof renderWithMaitai>[0]) {
  return renderWithMaitai(
    <TestQueryProvider>
      <NodexHoverCardProvider>
        <NodexTooltipProvider>
          {element}
          <NodexModalHost />
        </NodexTooltipProvider>
      </NodexHoverCardProvider>
    </TestQueryProvider>,
  );
}

function renderProjectRowWithSessions({
  expanded = true,
  animateChildren = true,
}: {
  expanded?: boolean;
  animateChildren?: boolean;
} = {}) {
  const project = PROJECTS[0] as Project;

  return renderProjectsSection(
    <CodexProjectRow
      project={project}
      active
      expanded={expanded}
      animateChildren={animateChildren}
      onActivate={() => undefined}
      onUpdateProject={async () => null}
      onArchiveProject={async () => ({ kind: "not-found" })}
    >
      <CodexProjectSessionList project={project}>
        <div role="listitem">Alpha session</div>
      </CodexProjectSessionList>
    </CodexProjectRow>,
  );
}

describe("SidebarProjectsSection", () => {
  test("renders project rows in project order with the Codex sidebar contract", () => {
    const { container, getByText, getByLabelText } = renderProjectsSection(
      <SidebarProjectsSection
        projects={PROJECTS}
        projectOrder={["beta", "alpha"]}
        activeProjectId="beta"
        expanded
        onToggleExpanded={() => undefined}
        onSelectProject={() => undefined}
        onCreateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onUpdateProject={async () => null}
        projectPickerOpenTick={0}
      />,
    );

    expect(getByText("Projects").textContent).toBe("Projects");
    expect(
      container.querySelector("[data-app-action-sidebar-projects-collapse-action]") === null,
    ).toBe(true);
    expect(getByLabelText("Project sidebar options").getAttribute("aria-disabled")).toBe(null);
    expect(getByLabelText("Add new project").getAttribute("aria-label")).toBe("Add new project");
    expect(textContent(container).indexOf("Beta") < textContent(container).indexOf("Alpha")).toBe(
      true,
    );
    expect(textContent(container).includes("/repo/beta")).toBe(false);
    expect(textContent(container).includes("/alpha")).toBe(false);

    const section = container.querySelector('[data-app-action-sidebar-section-heading="Projects"]');
    expect(section?.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("false");
    const sectionBody = section?.querySelector("[data-app-action-sidebar-section-body-motion]");
    expect(Boolean(sectionBody)).toBe(true);

    const rows = Array.from(container.querySelectorAll("[data-app-action-sidebar-project-row]"));
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute("data-app-action-sidebar-project-id")).toBe("beta");
    expect(rows[0]?.getAttribute("data-app-action-sidebar-project-label")).toBe("Beta");
    const betaProjectButton = rows[0]?.querySelector("[data-app-action-sidebar-select-project]");
    const betaDisclosureButton = rows[0]?.querySelector(
      "[data-app-action-sidebar-project-toggle-chevron]",
    );
    expect(betaProjectButton?.tagName).toBe("BUTTON");
    expect(betaProjectButton?.getAttribute("aria-label")).toBe("Open Beta");
    expect(betaProjectButton?.getAttribute("aria-current")).toBe("page");
    expect(betaDisclosureButton?.tagName).toBe("BUTTON");
    expect(betaDisclosureButton?.getAttribute("aria-label")).toBe("Collapse project");
  });

  test("opens project creation directly from the add-project button", async () => {
    const createCalls: unknown[] = [];
    mockInvokeImpl = async (channel) => {
      if (channel === "projects:pick-source-roots") return ["/repo/new-project"];
      return null;
    };
    const { findByText, getByLabelText, getByRole, getByText, queryByRole, queryByText } =
      renderProjectsSection(
        <SidebarProjectsSection
          projects={PROJECTS}
          projectOrder={["alpha", "beta"]}
          activeProjectId="alpha"
          expanded
          onToggleExpanded={() => undefined}
          onSelectProject={() => undefined}
          onCreateProject={async (input) => {
            createCalls.push(input);
            return PROJECTS[0] ?? null;
          }}
          onArchiveProject={async () => ({ kind: "not-found" })}
          onUpdateProject={async () => null}
          projectPickerOpenTick={0}
        />,
      );

    const addProjectButton = getByLabelText("Add new project");
    const addProjectIcon = addProjectButton.querySelector("svg");
    expect(addProjectIcon?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(addProjectIcon?.querySelectorAll("path")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(addProjectButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryByRole("menu")).toBe(null);
      expect(getByRole("heading", { name: "Create project" })).toBeTruthy();
    });
    expect(queryByText("Start from scratch")).toBe(null);
    expect(queryByText("Use an existing folder")).toBe(null);
    expect(getByText("Add folders Nodex can read and edit")).toBeTruthy();
    expect(getByRole("button", { name: "Create project" }).hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Create project" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(createCalls).toEqual([
        {
          appearance: {
            color: "black",
            marker: { kind: "icon", icon: "folder" },
          },
          name: "",
          sources: [],
        },
      ]);
      expect(queryByRole("heading", { name: "Create project" })).toBe(null);
    });

    await act(async () => {
      fireEvent.click(addProjectButton);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getByRole("heading", { name: "Create project" })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByLabelText("Choose source folders"));
      await Promise.resolve();
    });
    await findByText("new-project");

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Create project" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(createCalls).toEqual([
        {
          appearance: {
            color: "black",
            marker: { kind: "icon", icon: "folder" },
          },
          name: "",
          sources: [],
        },
        {
          appearance: {
            color: "black",
            marker: { kind: "icon", icon: "folder" },
          },
          name: "",
          sources: ["/repo/new-project"],
        },
      ]);
    });
  });

  test("opens the project sidebar options menu and sort flyout", async () => {
    const { getByLabelText, getByText } = renderProjectsSection(
      <SidebarProjectsSection
        projects={PROJECTS}
        projectOrder={["alpha", "beta"]}
        activeProjectId="alpha"
        expanded
        onToggleExpanded={() => undefined}
        onSelectProject={() => undefined}
        onCreateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onUpdateProject={async () => null}
        projectPickerOpenTick={0}
      />,
    );

    await openNodexMenu(getByLabelText("Project sidebar options"));

    await waitFor(() => {
      expect(textContent(document.body).includes("Archive all chats")).toBe(true);
      expect(textContent(document.body).includes("Removed projects…")).toBe(true);
      expect(textContent(document.body).includes("Organize pins")).toBe(false);
      expect(textContent(document.body).includes("Organize sidebar")).toBe(true);
      expect(textContent(document.body).includes("Sort by")).toBe(true);
    });

    const sortByItem = getByText("Sort by").closest('[role="menuitem"]');
    if (!(sortByItem instanceof HTMLElement)) {
      throw new Error("Expected Sort by menu item");
    }

    await act(async () => {
      fireEvent.pointerMove(sortByItem, { pointerType: "mouse" });
      fireEvent.keyDown(sortByItem, { key: "ArrowRight" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(textContent(document.body).includes("Manual order")).toBe(true);
      expect(textContent(document.body).includes("Created")).toBe(true);
      expect(textContent(document.body).includes("Updated")).toBe(true);
    });
  });

  test("hides project rows when the Projects section is initially collapsed", () => {
    const { container, queryByText } = renderProjectsSection(
      <SidebarProjectsSection
        projects={PROJECTS}
        projectOrder={["beta", "alpha"]}
        activeProjectId="beta"
        expanded={false}
        onToggleExpanded={() => undefined}
        onSelectProject={() => undefined}
        onCreateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onUpdateProject={async () => null}
        projectPickerOpenTick={0}
      />,
    );

    const section = container.querySelector('[data-app-action-sidebar-section-heading="Projects"]');
    expect(section?.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("true");
    expect(section?.querySelector("[data-app-action-sidebar-section-body-motion]")).toBe(null);
    expect(queryByText("Beta")).toBe(null);
    expect(queryByText("Alpha")).toBe(null);
  });

  test("edits name and source folders through the Edit project dialog", async () => {
    const updateCalls: unknown[][] = [];
    mockInvokeImpl = async (channel) => {
      if (channel === "projects:pick-source-roots") return ["/repo/selected"];
      return null;
    };

    const { getByLabelText, getByText, queryByRole, queryByText, findByText } =
      renderProjectsSection(
        <SidebarProjectsSection
          projects={PROJECTS}
          projectOrder={["beta", "alpha"]}
          activeProjectId="beta"
          expanded
          onToggleExpanded={() => undefined}
          onSelectProject={() => undefined}
          onCreateProject={async () => null}
          onArchiveProject={async () => ({ kind: "not-found" })}
          onUpdateProject={async (projectId, updates) => {
            updateCalls.push([projectId, updates]);
            return PROJECTS[1] ?? null;
          }}
          projectPickerOpenTick={0}
        />,
      );

    await openNodexMenu(getByLabelText("Project actions for Beta"));

    expect(getByText("Edit project").textContent).toBe("Edit project");
    expect(getByText("Archive chats").textContent).toBe("Archive chats");
    expect(getByText("Remove").textContent).toBe("Remove");
    expect(queryByText("Add source folder")).toBe(null);
    expect(queryByText("Edit sources")).toBe(null);
    expect(queryByText("Rename")).toBe(null);
    expect(queryByText("Choose icon")).toBe(null);

    await act(async () => {
      fireEvent.click(getByText("Edit project"));
      await Promise.resolve();
    });

    await findByText("Source folders");
    expect(queryByRole("menu")).toBe(null);
    expect(getByText("beta").textContent).toBe("beta");
    expect(queryByText("Primary")).toBe(null);

    await act(async () => {
      fireEvent.click(getByText("Add folder"));
      await Promise.resolve();
    });

    expect(invokeCalls.some((call) => call[0] === "projects:pick-source-roots")).toBe(true);
    await findByText("selected");
    expect(getByText("Primary").textContent).toBe("Primary");

    await act(async () => {
      fireEvent.click(getByText("Save"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(JSON.stringify(updateCalls[0])).toBe(
        JSON.stringify([
          "beta",
          {
            expectedBindingRevision: 1,
            appearance: PROJECTS[1]?.appearance,
            name: "Beta",
            sources: ["/repo/beta", "/repo/selected"],
          },
        ]),
      );
    });
  });

  test("keeps project disclosure stable when the portaled edit dialog is clicked", async () => {
    const onActivate = vi.fn();
    const { getByLabelText, getByRole, getByText, findByText } = renderProjectsSection(
      <CodexProjectRow
        project={PROJECTS[1] as Project}
        active
        expanded
        onActivate={onActivate}
        onUpdateProject={async () => PROJECTS[1] ?? null}
        onArchiveProject={async () => ({ kind: "not-found" })}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Open Beta" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    onActivate.mockClear();

    await openNodexMenu(getByLabelText("Project actions for Beta"));

    await act(async () => {
      fireEvent.click(getByText("Edit project"));
      await Promise.resolve();
    });

    await findByText("Source folders");
    const dialogContent = document.body.querySelector('[data-slot="codex-dialog-content"]');
    if (!(dialogContent instanceof HTMLElement)) {
      throw new Error("Expected Edit project dialog content");
    }

    await act(async () => {
      fireEvent.click(dialogContent);
      await Promise.resolve();
    });

    expect(onActivate).not.toHaveBeenCalled();
  });

  test("keeps disclosure stable across the interactive Project card and its Edit action", async () => {
    const onActivate = vi.fn();
    const onHoverCardOpenChange = vi.fn();
    mockInvokeImpl = async (channel) => {
      if (channel === "shell:path-context:get") {
        return { homeDirectory: "/Users/asc", separator: "/" };
      }
      if (channel === "git:repository:identity") {
        return {
          repositoryRoot: "/repo/beta",
          ownerRepo: { owner: "acme", repo: "beta" },
        };
      }
      if (channel === "shell:open-file-link") return true;
      return null;
    };

    renderProjectsSection(
      <CodexProjectRow
        project={PROJECTS[1] as Project}
        activity={{
          projectId: "beta",
          taskCount: 66,
          waitingCount: 1,
          unreadCount: 2,
          activeCount: 3,
        }}
        active
        expanded
        hoverCardOpen
        onHoverCardOpenChange={onHoverCardOpenChange}
        onActivate={onActivate}
        onUpdateProject={async () => PROJECTS[1] ?? null}
        onArchiveProject={async () => ({ kind: "not-found" })}
      />,
    );

    const card = await waitFor(() => {
      const candidate = document.body.querySelector<HTMLElement>(
        "[data-app-action-sidebar-project-hover-card]",
      );
      if (!candidate) throw new Error("Expected Project hover card");
      return candidate;
    });
    expect(within(card).getByText("66 tasks · 1 waiting · 2 unread · 3 active")).toBeTruthy();

    await act(async () => {
      fireEvent.click(card);
      await Promise.resolve();
    });
    expect(onActivate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(card).getByText("/repo/beta"));
      await Promise.resolve();
    });
    expect(
      invokeCalls.some(
        ([channel, target, opener]) =>
          channel === "shell:open-file-link" &&
          JSON.stringify(target) === JSON.stringify({ path: "/repo/beta" }) &&
          opener === "fileManager",
      ),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(within(card).getByText("Edit project"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onHoverCardOpenChange).toHaveBeenCalledWith(false);
      expect(document.body.textContent?.includes("Source folders")).toBe(true);
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  test("keeps project disclosure stable inside a row-owned confirmation dialog", async () => {
    const onActivate = vi.fn();
    const { container, getByLabelText, getByText, findByRole } = renderProjectsSection(
      <CodexProjectRow
        project={PROJECTS[1] as Project}
        active
        expanded
        onActivate={onActivate}
        onUpdateProject={async () => PROJECTS[1] ?? null}
        onArchiveProject={async () => ({ kind: "not-found" })}
      />,
    );

    await openNodexMenu(getByLabelText("Project actions for Beta"));
    await act(async () => {
      fireEvent.click(getByText("Remove"));
      await Promise.resolve();
    });

    const heading = await findByRole("heading", { name: "Remove Beta?" });
    fireEvent.click(heading);

    expect(
      container
        .querySelector("[data-app-action-sidebar-project-toggle-chevron]")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(onActivate).not.toHaveBeenCalled();
  });

  test("hides the reveal action for projects with multiple source folders", async () => {
    const multiRootBeta: Project = {
      ...PROJECTS[1]!,
      sources: [
        { root: "/repo/beta", order: 0 },
        { root: "/repo/beta-docs", order: 1 },
      ],
    };

    const { getByLabelText, getByText, queryByText } = renderProjectsSection(
      <SidebarProjectsSection
        projects={[multiRootBeta]}
        projectOrder={["beta"]}
        activeProjectId="beta"
        expanded
        onToggleExpanded={() => undefined}
        onSelectProject={() => undefined}
        onCreateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onUpdateProject={async () => null}
        projectPickerOpenTick={0}
      />,
    );

    await openNodexMenu(getByLabelText("Project actions for Beta"));

    expect(getByText("Edit project").textContent).toBe("Edit project");
    expect(queryByText(/Reveal in Finder|Open in Explorer|Open in File Manager/)).toBe(null);
  });

  test("opens the Project row context menu through the native bridge", async () => {
    const previousBridge = Object.getOwnPropertyDescriptor(window, "electronBridge");
    const showContextMenu = vi.fn(
      async (_items: NativeContextMenuItem[], _options?: NativeContextMenuOptions) => null,
    );
    Object.defineProperty(window, "electronBridge", {
      configurable: true,
      value: { showContextMenu },
    });

    try {
      const view = renderProjectsSection(
        <CodexProjectRow
          project={PROJECTS[1] as Project}
          active={false}
          expanded
          onActivate={() => undefined}
          onUpdateProject={async () => null}
          onArchiveProject={async () => ({ kind: "not-found" })}
          onSetProjectPinned={async () => null}
        />,
      );
      const row = view.container.querySelector<HTMLElement>(
        "[data-app-action-sidebar-project-row]",
      );
      if (!row) throw new Error("Expected Project row");

      await act(async () => {
        fireEvent.contextMenu(row, { clientX: 120, clientY: 80 });
        await Promise.resolve();
      });

      await waitFor(() => expect(showContextMenu).toHaveBeenCalledTimes(1));
      const [items, options] = showContextMenu.mock.calls[0] ?? [];
      expect(
        (items ?? []).map((item) => (item.type === "separator" ? "separator" : item.id)),
      ).toEqual([
        "project.togglePin",
        "project.edit",
        "separator",
        "project.reveal",
        "separator",
        "project.archiveChats",
        "separator",
        "project.remove",
      ]);
      expect(options).toBeUndefined();
    } finally {
      if (previousBridge) {
        Object.defineProperty(window, "electronBridge", previousBridge);
      } else {
        Reflect.deleteProperty(window, "electronBridge");
      }
    }
  });

  test("unmounts project session children when collapsed", () => {
    const { container, queryByText } = renderProjectRowWithSessions({ expanded: false });

    expect(container.querySelector("[data-app-action-sidebar-project-list-motion]")).toBe(null);
    expect(queryByText("Alpha session")).toBe(null);
  });

  test("keeps the Codex non-animated project children fallback available", () => {
    const { container, getByText } = renderProjectRowWithSessions({ animateChildren: false });

    const staticDisclosure = container.querySelector(
      "[data-app-action-sidebar-project-list-static]",
    );
    expect(Boolean(staticDisclosure)).toBe(true);
    expect(container.querySelector("[data-app-action-sidebar-project-list-motion]")).toBe(null);
    expect(getByText("Alpha session").textContent).toBe("Alpha session");
  });
});
