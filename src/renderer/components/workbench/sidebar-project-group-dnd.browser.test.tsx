import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useSortable } from "@dnd-kit/sortable";
import { useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@/lib/types";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
import { CodexProjectRow } from "./codex-sidebar";
import {
  getSidebarGroupDndId,
  SidebarProjectSortableContext,
  useSidebarGroupReorderController,
  type SidebarGroupDndController,
  type SidebarGroupDndPayload,
} from "./sidebar-project-group-dnd";
import { SidebarDropIndicator } from "./sidebar-drop-indicator";
import {
  resolveSidebarProjectExternalDropTarget,
  SidebarReorderDndProvider,
} from "./sidebar-reorder-dnd";
import {
  SidebarThreadSortableContext,
  SidebarThreadSortableItem,
  useSidebarPinnedDropContainer,
  useSidebarThreadDropContainer,
  type SidebarThreadReorderController,
} from "./sidebar-thread-reorder";

const PROJECTS: Project[] = [
  {
    id: "alpha",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Project alpha",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-07-15T00:00:00.000Z"),
    updated: new Date("2026-07-15T00:00:00.000Z"),
  },
  {
    id: "beta",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Project beta",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-07-15T00:00:00.000Z"),
    updated: new Date("2026-07-15T00:00:00.000Z"),
  },
];

const THREAD_CONTROLLER: SidebarThreadReorderController = {
  handleDragEnd() {},
};

test("resolves a Project drop against the exact mixed Section row boundary", () => {
  const event = {
    active: {
      id: getSidebarGroupDndId("alpha"),
      rect: { current: { translated: { top: 60, bottom: 90 } } },
    },
    over: {
      id: "placement-chat",
      rect: { top: 0, bottom: 30 },
      data: {
        current: {
          kind: "sidebar-item",
          controller: THREAD_CONTROLLER,
          itemId: "placement-chat",
          itemIds: ["placement-project", "placement-chat"],
          nextItemId: null,
          thread: {
            containerId: "section:section-alpha",
            dragOverlay: "Chat",
            sourceProjectKind: "local",
            targetProjectKind: "local",
            threadId: "thread-alpha",
            threadKey: "local:thread-alpha",
          },
        },
      },
    },
  } as never;

  expect(resolveSidebarProjectExternalDropTarget(event, 4)).toEqual({
    beforeItemId: "placement-chat",
    targetContainerId: "section:section-alpha",
    targetItemIds: ["placement-project", "placement-chat"],
  });
  expect(resolveSidebarProjectExternalDropTarget(event, 26)).toEqual({
    beforeItemId: null,
    targetContainerId: "section:section-alpha",
    targetItemIds: ["placement-project", "placement-chat"],
  });
});

test("resolves a Project drop on the Section header as its first mixed boundary", () => {
  const event = {
    active: {
      id: getSidebarGroupDndId("alpha"),
      rect: { current: { translated: { top: 60, bottom: 90 } } },
    },
    over: {
      id: "sidebar-thread-container:section:section-alpha",
      rect: { top: 0, bottom: 120 },
      data: {
        current: {
          kind: "sidebar-thread-container",
          beforeItemId: "placement-project",
          containerId: "section:section-alpha",
          itemIds: ["placement-project", "placement-chat"],
          targetProjectKind: "local",
        },
      },
    },
  } as never;

  expect(resolveSidebarProjectExternalDropTarget(event, 12)).toEqual({
    beforeItemId: "placement-project",
    targetContainerId: "section:section-alpha",
    targetItemIds: ["placement-project", "placement-chat"],
  });
});

function SortableProject({
  controller,
  projectId,
}: {
  controller: SidebarGroupDndController;
  projectId: string;
}) {
  const sortable = useSortable({
    id: getSidebarGroupDndId(projectId),
    data: {
      kind: "sidebar-group",
      controller,
      dragOverlay: <div>{projectId}</div>,
      projectId,
    } satisfies SidebarGroupDndPayload,
  });
  return (
    <div
      ref={sortable.setNodeRef}
      {...sortable.attributes}
      data-project-id={projectId}
      data-testid={`project-${projectId}`}
      style={{ alignItems: "center", display: "flex", height: 40, width: 240 }}
    >
      <div
        ref={sortable.setActivatorNodeRef}
        {...sortable.listeners}
        data-testid={`project-${projectId}-activator`}
      >
        {projectId}
      </div>
    </div>
  );
}

function ProjectReorderHarness({
  beforeCanonicalCommit,
  onCommit,
}: {
  beforeCanonicalCommit?: Promise<void>;
  onCommit: (nextProjectIds: string[]) => void;
}) {
  const [projectIds, setProjectIds] = useState(["alpha", "beta"]);
  const reorder = useSidebarGroupReorderController({
    groupIds: projectIds,
    reorderGroups: async (nextProjectIds) => {
      onCommit(nextProjectIds);
      if (beforeCanonicalCommit) {
        void beforeCanonicalCommit.then(() => setProjectIds(nextProjectIds));
        return;
      }
      setProjectIds(nextProjectIds);
    },
  });
  return (
    <div aria-label="Projects" role="list">
      <SidebarProjectSortableContext groupIds={reorder.groupIds}>
        {reorder.groupIds.map((projectId, index) => (
          <div key={projectId}>
            {reorder.dropIndicatorIndex === index ? <SidebarDropIndicator /> : null}
            <SortableProject controller={reorder.controller} projectId={projectId} />
          </div>
        ))}
        {reorder.dropIndicatorIndex === reorder.groupIds.length ? <SidebarDropIndicator /> : null}
      </SidebarProjectSortableContext>
    </div>
  );
}

function MixedSidebarReorderHarness({
  onCommit,
}: {
  onCommit: (nextProjectIds: string[]) => void;
}) {
  const [projectIds, setProjectIds] = useState(PROJECTS.map((project) => project.id));
  const reorder = useSidebarGroupReorderController({
    groupIds: projectIds,
    reorderGroups: async (nextProjectIds) => {
      onCommit(nextProjectIds);
      setProjectIds(nextProjectIds);
    },
  });

  return (
    <TestQueryProvider>
      <NodexHoverCardProvider>
        <NodexTooltipProvider>
          <div aria-label="Mixed sidebar projects" role="list">
            <SidebarProjectSortableContext groupIds={reorder.groupIds}>
              {reorder.groupIds.map((projectId, index) => {
                const project = PROJECTS.find((candidate) => candidate.id === projectId);
                if (!project) return null;
                const threadKey = `local:thread-${projectId}`;

                return (
                  <div key={projectId}>
                    {reorder.dropIndicatorIndex === index ? <SidebarDropIndicator /> : null}
                    <CodexProjectRow
                      project={project}
                      active={false}
                      expanded
                      animateChildren={false}
                      dnd={{ controller: reorder.controller }}
                      onActivate={() => {}}
                      onUpdateProject={async () => project}
                      onArchiveProject={async () => ({ kind: "not-found" })}
                    >
                      <SidebarThreadSortableContext threadKeys={[threadKey]}>
                        <SidebarThreadSortableItem
                          containerId={`project:${projectId}`}
                          controller={THREAD_CONTROLLER}
                          threadKey={threadKey}
                        >
                          <div style={{ height: 30 }}>Task in {project.name}</div>
                        </SidebarThreadSortableItem>
                      </SidebarThreadSortableContext>
                    </CodexProjectRow>
                  </div>
                );
              })}
              {reorder.dropIndicatorIndex === reorder.groupIds.length ? (
                <SidebarDropIndicator />
              ) : null}
            </SidebarProjectSortableContext>
          </div>
        </NodexTooltipProvider>
      </NodexHoverCardProvider>
    </TestQueryProvider>
  );
}

function PinnedProjectDropTarget() {
  const target = useSidebarPinnedDropContainer();

  return (
    <div
      ref={target.setNodeRef}
      data-testid="pinned-project-drop-target"
      style={{ height: 40, width: 240 }}
    >
      {target.projectDragActive && target.isOver ? <SidebarDropIndicator /> : null}
    </div>
  );
}

function CustomSectionProjectDropTarget() {
  const target = useSidebarThreadDropContainer({
    acceptProjectDrop: true,
    containerId: "section:section-alpha",
    targetProjectKind: "local",
  });
  const active = target.isOver && (target.projectDragActive || target.threadDragActive);

  return (
    <div ref={target.setNodeRef}>
      {active ? <SidebarDropIndicator /> : null}
      <div data-testid="custom-section-project-drop-target" style={{ height: 40, width: 240 }} />
    </div>
  );
}

describe("sidebar project reorder in Chromium", () => {
  test("paints the drop indicator without changing list geometry", () => {
    const Rows = ({ indicator }: { indicator: boolean }) => (
      <div data-testid="geometry-list" style={{ display: "flex", flexDirection: "column" }}>
        <div data-testid="geometry-first" style={{ height: 32 }}>
          First
        </div>
        {indicator ? <SidebarDropIndicator /> : null}
        <div data-testid="geometry-second" style={{ height: 32 }}>
          Second
        </div>
      </div>
    );
    const view = render(<Rows indicator={false} />);
    const beforeList = view.getByTestId("geometry-list").getBoundingClientRect();
    const beforeSecond = view.getByTestId("geometry-second").getBoundingClientRect();

    view.rerender(<Rows indicator />);

    const afterList = view.getByTestId("geometry-list").getBoundingClientRect();
    const afterSecond = view.getByTestId("geometry-second").getBoundingClientRect();
    const indicator = view.container.querySelector<HTMLElement>("[role='presentation']");
    expect(indicator).not.toBeNull();
    expect(afterList.height).toBe(beforeList.height);
    expect(afterSecond.top).toBe(beforeSecond.top);
    expect(indicator?.getBoundingClientRect().height).toBe(0);
  });

  test("refreshes the insertion boundary while the pointer stays over one project", async () => {
    const committedOrders: string[][] = [];
    const view = render(
      <SidebarReorderDndProvider>
        <ProjectReorderHarness onCommit={(order) => committedOrders.push(order)} />
      </SidebarReorderDndProvider>,
    );
    const list = view.getByRole("list", { name: "Projects" });
    const alpha = view.getByTestId("project-alpha");
    const beta = view.getByTestId("project-beta");
    const betaActivator = view.getByTestId("project-beta-activator");
    const alphaRect = alpha.getBoundingClientRect();
    const betaRect = beta.getBoundingClientRect();
    const pointerId = 17;
    const pointerX = alphaRect.left + alphaRect.width / 2;

    try {
      await act(async () => {
        fireEvent.pointerDown(betaActivator, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: alphaRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.querySelectorAll("[role='presentation']")).toHaveLength(1);
      });

      await act(async () => {
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: alphaRect.bottom - 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.querySelectorAll("[role='presentation']")).toHaveLength(0);
      });
      expect(committedOrders).toHaveLength(0);
    } finally {
      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: alphaRect.bottom - 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      view.unmount();
    }
  });

  test("commits the indicated project insertion after pointer release", async () => {
    const committedOrders: string[][] = [];
    const view = render(
      <SidebarReorderDndProvider>
        <ProjectReorderHarness onCommit={(order) => committedOrders.push(order)} />
      </SidebarReorderDndProvider>,
    );
    const list = view.getByRole("list", { name: "Projects" });
    const alpha = view.getByTestId("project-alpha");
    const beta = view.getByTestId("project-beta");
    const betaActivator = view.getByTestId("project-beta-activator");
    const alphaRect = alpha.getBoundingClientRect();
    const betaRect = beta.getBoundingClientRect();
    const pointerId = 18;
    const pointerX = alphaRect.left + alphaRect.width / 2;
    const dropY = alphaRect.top + 4;

    try {
      await act(async () => {
        fireEvent.pointerDown(betaActivator, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.querySelectorAll("[role='presentation']")).toHaveLength(1);
      });

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(committedOrders).toEqual([["beta", "alpha"]]);
        expect(
          Array.from(list.querySelectorAll<HTMLElement>("[data-project-id]")).map(
            (row) => row.dataset.projectId,
          ),
        ).toEqual(["beta", "alpha"]);
      });
    } finally {
      view.unmount();
    }
  });

  test("keeps an acknowledged project order until canonical props render it", async () => {
    let resolveCanonicalCommit!: () => void;
    const canonicalCommit = new Promise<void>((resolve) => {
      resolveCanonicalCommit = resolve;
    });
    const view = render(
      <SidebarReorderDndProvider>
        <ProjectReorderHarness beforeCanonicalCommit={canonicalCommit} onCommit={() => {}} />
      </SidebarReorderDndProvider>,
    );
    const list = view.getByRole("list", { name: "Projects" });
    const alpha = view.getByTestId("project-alpha");
    const beta = view.getByTestId("project-beta");
    const betaActivator = view.getByTestId("project-beta-activator");
    const alphaRect = alpha.getBoundingClientRect();
    const betaRect = beta.getBoundingClientRect();
    const pointerId = 118;
    const pointerX = alphaRect.left + alphaRect.width / 2;
    const dropY = alphaRect.top + 4;

    try {
      await act(async () => {
        fireEvent.pointerDown(betaActivator, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(list.querySelectorAll("[role='presentation']")).toHaveLength(1);
      });
      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(
        Array.from(list.querySelectorAll<HTMLElement>("[data-project-id]")).map(
          (row) => row.dataset.projectId,
        ),
      ).toEqual(["beta", "alpha"]);

      await act(async () => {
        resolveCanonicalCommit();
        await canonicalCommit;
      });
      await waitFor(() => {
        expect(
          Array.from(list.querySelectorAll<HTMLElement>("[data-project-id]")).map(
            (row) => row.dataset.projectId,
          ),
        ).toEqual(["beta", "alpha"]);
      });
    } finally {
      resolveCanonicalCommit();
      view.unmount();
    }
  });

  test("shows the project ghost and commits through the shared project-task context", async () => {
    const committedOrders: string[][] = [];
    const runtimeErrors: ErrorEvent[] = [];
    const consoleErrors: unknown[][] = [];
    const handleError = (event: ErrorEvent) => runtimeErrors.push(event);
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args);
    });
    window.addEventListener("error", handleError);
    const view = render(
      <SidebarReorderDndProvider>
        <MixedSidebarReorderHarness onCommit={(order) => committedOrders.push(order)} />
      </SidebarReorderDndProvider>,
    );
    const list = view.getByRole("list", { name: "Mixed sidebar projects" });
    const alphaRow = view.getByRole("button", { name: "Project alpha" });
    const betaRow = view.getByRole("button", { name: "Project beta" });
    const betaRoot = view.getByRole("listitem", { name: "Project beta" });
    const betaActivator = view.getByText("Project beta", {
      selector: "[data-app-action-sidebar-project-label-text]",
    });
    const alphaRect = alphaRow.getBoundingClientRect();
    const betaRect = betaRow.getBoundingClientRect();
    const pointerId = 19;
    const pointerX = alphaRect.left + alphaRect.width / 2;
    const dropY = alphaRect.top + 4;
    let pointerReleased = false;

    try {
      await act(async () => {
        fireEvent.pointerDown(betaActivator, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(betaRoot.hasAttribute("inert")).toBe(true);
        expect(screen.getAllByText("Project beta").length).toBeGreaterThanOrEqual(2);
        expect(list.querySelectorAll("[role='presentation']")).toHaveLength(1);
      });

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      pointerReleased = true;

      await waitFor(() => {
        expect(committedOrders).toEqual([["beta", "alpha"]]);
        expect(
          Array.from(
            list.querySelectorAll<HTMLElement>("[data-app-action-sidebar-project-id]"),
          ).map((row) => row.dataset.appActionSidebarProjectId),
        ).toEqual(["beta", "alpha"]);
      });
      expect(runtimeErrors).toHaveLength(0);
      expect(consoleErrors).toHaveLength(0);
    } finally {
      if (!pointerReleased) {
        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: dropY,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });
      }
      window.removeEventListener("error", handleError);
      consoleError.mockRestore();
      view.unmount();
    }
  });

  test("routes a project drop through the pinned container's single shared registration", async () => {
    const drops: Array<{ projectId: string; targetContainerId: string }> = [];
    const controller: SidebarGroupDndController = {
      handleDragEnd() {},
    };
    const view = render(
      <SidebarReorderDndProvider onProjectDrop={(drop) => drops.push(drop)}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <SidebarProjectSortableContext groupIds={["alpha"]}>
            <SortableProject controller={controller} projectId="alpha" />
          </SidebarProjectSortableContext>
          <PinnedProjectDropTarget />
        </div>
      </SidebarReorderDndProvider>,
    );
    const source = view.getByTestId("project-alpha");
    const activator = view.getByTestId("project-alpha-activator");
    const target = view.getByTestId("pinned-project-drop-target");
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const pointerId = 20;
    const pointerX = targetRect.left + targetRect.width / 2;
    const dropY = targetRect.top + targetRect.height / 2;
    let pointerReleased = false;

    try {
      await act(async () => {
        fireEvent.pointerDown(activator, {
          button: 0,
          clientX: sourceRect.left + sourceRect.width / 2,
          clientY: sourceRect.top + sourceRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: sourceRect.bottom + 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(target.querySelector("[role='presentation']")).not.toBeNull();
      });

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      pointerReleased = true;

      await waitFor(() => {
        expect(drops).toEqual([{ projectId: "alpha", targetContainerId: "pinned" }]);
      });
    } finally {
      if (!pointerReleased) {
        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: dropY,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });
      }
      view.unmount();
    }
  });

  test("routes a Project drop into an empty custom Section", async () => {
    const drops: Array<{ projectId: string; targetContainerId: string }> = [];
    const controller: SidebarGroupDndController = { handleDragEnd() {} };
    const view = render(
      <SidebarReorderDndProvider onProjectDrop={(drop) => drops.push(drop)}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <SidebarProjectSortableContext groupIds={["alpha"]}>
            <SortableProject controller={controller} projectId="alpha" />
          </SidebarProjectSortableContext>
          <CustomSectionProjectDropTarget />
        </div>
      </SidebarReorderDndProvider>,
    );
    const source = view.getByTestId("project-alpha");
    const activator = view.getByTestId("project-alpha-activator");
    const target = view.getByTestId("custom-section-project-drop-target");
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const pointerId = 21;
    const pointerX = targetRect.left + targetRect.width / 2;
    const dropY = targetRect.top + targetRect.height / 2;
    let pointerReleased = false;

    try {
      await act(async () => {
        fireEvent.pointerDown(activator, {
          button: 0,
          clientX: sourceRect.left + sourceRect.width / 2,
          clientY: sourceRect.top + sourceRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: sourceRect.bottom + 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(target.parentElement?.querySelector("[role='presentation']")).not.toBeNull();
      });

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      pointerReleased = true;

      await waitFor(() => {
        expect(drops).toEqual([{ projectId: "alpha", targetContainerId: "section:section-alpha" }]);
      });
    } finally {
      if (!pointerReleased) {
        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: dropY,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });
      }
      view.unmount();
    }
  });
});
