import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useSortable } from "@dnd-kit/sortable";
import { useState, useLayoutEffect, useMemo, type CSSProperties } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { Project, CodexSidebarThreadItem } from "@/lib/types";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
import { CodexProjectRow, CodexSidebarSection, CodexSidebarThreadRow } from "./codex-sidebar";
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
  SidebarThreadDropContainer,
  SidebarThreadReorderRows,
  SidebarThreadSortableRows,
  resolveSidebarThreadKeysWithPendingDrops,
  usePendingSidebarThreadDrops,
  useReportSidebarThreadCanonicalLanes,
  useSidebarThreadReorderController,
  type SidebarThreadDropRequest,
} from "./sidebar-thread-reorder";
import { useDndContext } from "@dnd-kit/core";
import { emptySessionLinkedPageStore } from "../../test/session-linked-page";
import "../../globals.css";

describe("sidebar project group dnd", () => {
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
    const { setNodeRef, setActivatorNodeRef, ...sortable } = useSortable({
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
        ref={setNodeRef}
        {...sortable.attributes}
        data-project-id={projectId}
        data-testid={`project-${projectId}`}
        style={{ alignItems: "center", display: "flex", height: 40, width: 240 }}
      >
        <div
          ref={setActivatorNodeRef}
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
    const { setNodeRef, ...target } = useSidebarPinnedDropContainer();

    return (
      <div
        ref={setNodeRef}
        data-testid="pinned-project-drop-target"
        style={{ height: 40, width: 240 }}
      >
        {target.projectDragActive && target.isOver ? <SidebarDropIndicator /> : null}
      </div>
    );
  }

  function CustomSectionProjectDropTarget() {
    const { setNodeRef, ...target } = useSidebarThreadDropContainer({
      acceptProjectDrop: true,
      containerId: "section:section-alpha",
      targetProjectKind: "local",
    });
    const active = target.isOver && (target.projectDragActive || target.threadDragActive);

    return (
      <div ref={setNodeRef}>
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
          expect(drops).toEqual([
            { projectId: "alpha", targetContainerId: "section:section-alpha" },
          ]);
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
});

describe("sidebar thread reorder", () => {
  const PROJECT: Project = {
    id: "project-beta",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Project beta",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-07-15T00:00:00.000Z"),
    updated: new Date("2026-07-15T00:00:00.000Z"),
  };

  const THREAD: CodexSidebarThreadItem = {
    key: "local:thread-alpha",
    kind: "local",
    backendBinding: { driver: "codex", instanceId: "codex" },
    runLocation: { kind: "local-checkout" },
    hostId: "local",
    threadId: "thread-alpha",
    parentThreadId: null,
    sessionId: "session-alpha",
    projectId: "project-alpha",
    title: "Drag an open rich tooltip",
    preview: "",
    cwd: null,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    pinned: false,
    pinnedOrder: null,
    unread: false,
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: null,
    archived: false,
    statusType: "notLoaded",
    statusActiveFlags: [],
    projectless: false,
    disabled: false,
  };

  function ThreadReorderHarness({ onCommit }: { onCommit: (nextThreadKeys: string[]) => void }) {
    const [threadKeys, setThreadKeys] = useState(["alpha", "beta"]);
    return (
      <SidebarReorderDndProvider>
        <div
          aria-label="Project chats"
          role="list"
          style={{ display: "flex", flexDirection: "column", width: 240 }}
        >
          <SidebarThreadReorderRows
            containerId="project-pinned:alpha"
            visibleThreadKeys={threadKeys}
            sortableThreadKeys={threadKeys}
            onVisibleThreadOrderChange={async ({ nextVisibleThreadKeys }) => {
              onCommit(nextVisibleThreadKeys);
              setThreadKeys(nextVisibleThreadKeys);
            }}
            renderThread={(threadKey) => (
              <div
                data-thread-key={threadKey}
                data-testid={`thread-${threadKey}`}
                style={{ alignItems: "center", display: "flex", height: 40 }}
              >
                {threadKey}
              </div>
            )}
          />
        </div>
      </SidebarReorderDndProvider>
    );
  }

  function SessionReorderHarness({
    onCommit,
  }: {
    onCommit: (orderedSessionIds: string[]) => void;
  }) {
    const [threadKeys, setThreadKeys] = useState(["chat", "draft"]);
    const sessionIdByThreadKey = new Map([
      ["chat", "session-chat"],
      ["draft", "session-draft"],
    ]);
    const reorder = useSidebarThreadReorderController({
      visibleThreadKeys: threadKeys,
      onVisibleThreadOrderChange: async ({ nextVisibleThreadKeys }) => {
        onCommit(
          nextVisibleThreadKeys.flatMap((threadKey) => {
            const sessionId = sessionIdByThreadKey.get(threadKey);
            return sessionId ? [sessionId] : [];
          }),
        );
        setThreadKeys(nextVisibleThreadKeys);
      },
    });
    return (
      <SidebarReorderDndProvider getThreadIdByThreadKey={() => null}>
        <div
          aria-label="Session-first Project chats"
          role="list"
          style={{ display: "flex", flexDirection: "column", width: 240 }}
        >
          <SidebarThreadSortableRows
            containerId="project:alpha"
            getItemId={(threadKey) => sessionIdByThreadKey.get(threadKey)}
            getThreadId={() => null}
            itemIds={threadKeys.flatMap((threadKey) => {
              const sessionId = sessionIdByThreadKey.get(threadKey);
              return sessionId ? [sessionId] : [];
            })}
            visibleThreadKeys={threadKeys}
            sortableThreadKeysInDisplayOrder={reorder.displayedVisibleThreadKeys}
            controller={reorder.controller}
            dropIndicatorTarget={reorder.dropIndicatorTarget}
            renderThread={(threadKey) => (
              <div
                data-thread-key={threadKey}
                data-testid={`session-${threadKey}`}
                style={{ alignItems: "center", display: "flex", height: 40 }}
              >
                {threadKey}
              </div>
            )}
          />
        </div>
      </SidebarReorderDndProvider>
    );
  }

  function SectionDropRows({ containerId, keys }: { containerId: string; keys: string[] }) {
    const reorder = useSidebarThreadReorderController({ visibleThreadKeys: keys });
    return (
      <div role="list" aria-label={`${containerId} chats`}>
        <SidebarThreadSortableRows
          containerId={containerId}
          getItemId={(key) => key}
          getSessionId={(key) => `session-${key}`}
          getThreadId={(key) => (key === "draft" ? null : `thread-${key}`)}
          itemIds={keys}
          visibleThreadKeys={keys}
          sortableThreadKeysInDisplayOrder={reorder.displayedVisibleThreadKeys}
          controller={reorder.controller}
          dropIndicatorTarget={reorder.dropIndicatorTarget}
          sourceProjectKind="local"
          targetProjectKind="local"
          renderThread={(key) => (
            <div data-testid={`section-chat-${key}`} style={{ height: 40 }}>
              {key}
            </div>
          )}
        />
      </div>
    );
  }

  function RemeasuredSectionTarget({ offset }: { offset: number }) {
    const { droppableRects, measureDroppableContainers } = useDndContext();
    useLayoutEffect(() => {
      if (offset === 0) return;
      measureDroppableContainers([]);
    }, [measureDroppableContainers, offset]);
    return (
      <div style={{ paddingTop: offset }}>
        <SectionDropRows containerId="section:target" keys={["alpha", "beta"]} />
        <output hidden data-testid="measured-alpha-top">
          {droppableRects.get("alpha")?.top}
        </output>
      </div>
    );
  }

  function RemeasuredSectionDropHarness({
    offset,
    onDrop,
  }: {
    offset: number;
    onDrop: (drop: SidebarThreadDropRequest) => void;
  }) {
    return (
      <SidebarReorderDndProvider
        onThreadDrop={(drop) => {
          onDrop(drop);
          return null;
        }}
      >
        <div style={{ width: 240 }}>
          <SectionDropRows containerId="chats" keys={["draft"]} />
          <RemeasuredSectionTarget offset={offset} />
        </div>
      </SidebarReorderDndProvider>
    );
  }

  function ExpandingSectionDropHarness({
    expanded,
    onDrop,
  }: {
    expanded: boolean;
    onDrop: (drop: SidebarThreadDropRequest) => void;
  }) {
    return (
      <SidebarReorderDndProvider
        onThreadDrop={(drop) => {
          onDrop(drop);
          return null;
        }}
      >
        <div style={{ width: 240 }}>
          <SectionDropRows containerId="chats" keys={["draft"]} />
          <SidebarThreadDropContainer containerId="section:expanding" targetProjectKind="local">
            <CodexSidebarSection
              heading="Expanding section"
              collapsed={!expanded}
              onToggle={() => {}}
            >
              <div style={{ height: 20 }} />
            </CodexSidebarSection>
          </SidebarThreadDropContainer>
          <SectionDropRows containerId="section:target" keys={["alpha", "beta"]} />
        </div>
      </SidebarReorderDndProvider>
    );
  }

  function ThreadlessSectionDropHarness({
    collapsed = false,
    empty = false,
    onDrop,
  }: {
    collapsed?: boolean;
    empty?: boolean;
    onDrop: (drop: SidebarThreadDropRequest) => void;
  }) {
    return (
      <SidebarReorderDndProvider
        getThreadIdByThreadKey={(key) => (key === "draft" ? null : `thread-${key}`)}
        onThreadDrop={(drop) => {
          onDrop(drop);
          return null;
        }}
      >
        <div
          style={
            {
              width: 240,
              "--color-token-list-hover-background": "rgba(13, 13, 13, 0.08)",
              "--color-token-text-link-foreground": "rgb(58, 131, 247)",
            } as CSSProperties
          }
        >
          <SectionDropRows containerId="chats" keys={["draft"]} />
          <div data-testid="section-drop-surface" style={{ marginTop: 24 }}>
            <SidebarThreadDropContainer containerId="section:target" targetProjectKind="local">
              <CodexSidebarSection
                heading="Target section"
                collapsed={collapsed}
                onToggle={() => {}}
              >
                <SectionDropRows
                  containerId="section:target"
                  keys={empty ? [] : ["alpha", "beta"]}
                />
              </CodexSidebarSection>
            </SidebarThreadDropContainer>
          </div>
        </div>
      </SidebarReorderDndProvider>
    );
  }

  async function moveSectionPointer(pointerId: number, x: number, y: number) {
    await act(async () => {
      fireEvent.pointerMove(document, {
        buttons: 1,
        clientX: x,
        clientY: y,
        isPrimary: true,
        pointerId,
        pointerType: "mouse",
      });
      await Promise.resolve();
    });
  }

  async function startSectionPointerDrag(source: HTMLElement, pointerId: number) {
    const rect = source.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    await act(async () => {
      fireEvent.pointerDown(source, {
        button: 0,
        clientX: x,
        clientY: y,
        isPrimary: true,
        pointerId,
        pointerType: "mouse",
      });
      await Promise.resolve();
    });
    await moveSectionPointer(pointerId, x, y + 8);
  }

  async function finishSectionPointerDrag(pointerId: number, cancel = false) {
    await act(async () => {
      if (cancel) fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
      fireEvent.pointerUp(document, {
        button: 0,
        isPrimary: true,
        pointerId,
        pointerType: "mouse",
      });
      await Promise.resolve();
    });
  }

  function SemanticThreadRows({ threadKeys }: { threadKeys: string[] }) {
    const pendingDrops = usePendingSidebarThreadDrops();
    const canonicalLanes = useMemo(
      () =>
        new Map([
          [
            "project:alpha",
            {
              projectionRevision: 2,
              threadIds: threadKeys.map((threadKey) => `thread-${threadKey}`),
            },
          ],
        ]),
      [threadKeys],
    );
    useReportSidebarThreadCanonicalLanes(canonicalLanes);
    const optimisticThreadKeys = resolveSidebarThreadKeysWithPendingDrops({
      containerId: "project:alpha",
      pendingThreadDrops: pendingDrops,
      threadKeys,
      getThreadId: (threadKey) => `thread-${threadKey}`,
    });
    const reorder = useSidebarThreadReorderController({
      visibleThreadKeys: threadKeys,
    });
    return (
      <SidebarThreadSortableRows
        containerId="project:alpha"
        getThreadId={(threadKey) => `thread-${threadKey}`}
        visibleThreadKeys={optimisticThreadKeys}
        sortableThreadKeysInDisplayOrder={threadKeys}
        controller={reorder.controller}
        dropIndicatorTarget={reorder.dropIndicatorTarget}
        renderThread={(threadKey) => (
          <div
            data-thread-key={threadKey}
            data-testid={`canonical-thread-${threadKey}`}
            style={{ alignItems: "center", display: "flex", height: 40 }}
          >
            {threadKey}
          </div>
        )}
      />
    );
  }

  function SemanticThreadReorderHarness({
    beforeCanonicalCommit,
    onDrop,
  }: {
    beforeCanonicalCommit?: Promise<void>;
    onDrop: (drop: SidebarThreadDropRequest) => Promise<void>;
  }) {
    const [threadKeys, setThreadKeys] = useState(["alpha", "beta"]);
    return (
      <SidebarReorderDndProvider
        getThreadIdByThreadKey={(threadKey) => `thread-${threadKey}`}
        onThreadDrop={async (drop) => {
          await onDrop(drop);
          if (beforeCanonicalCommit) {
            void beforeCanonicalCommit.then(() => setThreadKeys(["beta", "alpha"]));
            return { operationId: "move:alpha", projectionRevision: 2 };
          }
          setThreadKeys(["beta", "alpha"]);
          return { operationId: "move:alpha", projectionRevision: 2 };
        }}
      >
        <div
          aria-label="Canonical Project chats"
          role="list"
          style={{ display: "flex", flexDirection: "column", width: 240 }}
        >
          <SemanticThreadRows threadKeys={threadKeys} />
        </div>
      </SidebarReorderDndProvider>
    );
  }

  function readRenderedThreadKeys(list: HTMLElement): string[] {
    return Array.from(list.querySelectorAll<HTMLElement>("[data-thread-key]"))
      .filter((row) => row.closest("[role='list']") === list)
      .map((row) => row.dataset.threadKey ?? "");
  }

  describe("sidebar thread reorder in Chromium", () => {
    test("keeps the row insertion boundary current while an earlier section expands", async () => {
      const drops: SidebarThreadDropRequest[] = [];
      const onDrop = (drop: SidebarThreadDropRequest) => drops.push(drop);
      const view = render(<ExpandingSectionDropHarness expanded={false} onDrop={onDrop} />);
      const pointerId = 23;
      const alpha = view.getByTestId("section-chat-alpha");
      const beta = view.getByTestId("section-chat-beta");
      const list = view.getByRole("list", { name: "section:target chats" });
      const initialRect = alpha.getBoundingClientRect();
      const x = initialRect.left + initialRect.width / 2;
      const y = initialRect.top + 30;

      try {
        await startSectionPointerDrag(view.getByTestId("section-chat-draft"), pointerId);
        await moveSectionPointer(pointerId, x, y);
        await waitFor(() => {
          expect(
            list.querySelector("[role='presentation']")?.nextElementSibling?.contains(beta),
          ).toBe(true);
        });

        // An earlier disclosure moves the row without resizing it or moving the pointer.
        // Use the product animation; the fixture never requests a dnd-kit remeasurement.
        await act(async () => {
          view.rerender(<ExpandingSectionDropHarness expanded onDrop={onDrop} />);
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(alpha.getBoundingClientRect().top).toBe(initialRect.top + 24);
          expect(alpha.getBoundingClientRect().height).toBe(initialRect.height);
          const indicator = list.querySelector<HTMLElement>("[role='presentation']");
          expect(indicator?.nextElementSibling?.contains(alpha)).toBe(true);
          expect(indicator?.getBoundingClientRect().top).toBe(alpha.getBoundingClientRect().top);
        });
        await finishSectionPointerDrag(pointerId);
        await waitFor(() => {
          expect(drops).toHaveLength(1);
          expect(drops[0]).toMatchObject({
            sessionId: "session-draft",
            targetContainerId: "section:target",
            beforeItemId: "alpha",
          });
        });
      } finally {
        await finishSectionPointerDrag(pointerId, true);
        view.unmount();
      }
    });

    test("uses a remeasured target midpoint for preview and drop without changing the hovered row", async () => {
      const drops: SidebarThreadDropRequest[] = [];
      const onDrop = (drop: SidebarThreadDropRequest) => drops.push(drop);
      const view = render(<RemeasuredSectionDropHarness offset={0} onDrop={onDrop} />);
      const pointerId = 22;
      const alpha = view.getByTestId("section-chat-alpha");
      const beta = view.getByTestId("section-chat-beta");
      const list = view.getByRole("list", { name: "section:target chats" });
      const initialRect = alpha.getBoundingClientRect();
      const x = initialRect.left + initialRect.width / 2;
      const y = initialRect.top + 30;

      try {
        await startSectionPointerDrag(view.getByTestId("section-chat-draft"), pointerId);
        await moveSectionPointer(pointerId, x, y);
        await waitFor(() => {
          expect(
            list.querySelector("[role='presentation']")?.nextElementSibling?.contains(beta),
          ).toBe(true);
        });

        // The same row still contains the pointer, but layout moves its midpoint past it.
        // dnd-kit's remeasurement replaces its Rect without changing the over ID.
        await act(async () => {
          view.rerender(<RemeasuredSectionDropHarness offset={20} onDrop={onDrop} />);
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(alpha.getBoundingClientRect().top).toBe(initialRect.top + 20);
          expect(Number(view.getByTestId("measured-alpha-top").textContent)).toBe(
            alpha.getBoundingClientRect().top,
          );
        });
        await waitFor(() => {
          const indicator = list.querySelector<HTMLElement>("[role='presentation']");
          expect(indicator?.nextElementSibling?.contains(alpha)).toBe(true);
          expect(indicator?.getBoundingClientRect().top).toBe(alpha.getBoundingClientRect().top);
        });
        await finishSectionPointerDrag(pointerId);
        await waitFor(() => {
          expect(drops).toHaveLength(1);
          expect(drops[0]).toMatchObject({
            sessionId: "session-draft",
            targetContainerId: "section:target",
            beforeItemId: "alpha",
          });
        });
      } finally {
        await finishSectionPointerDrag(pointerId, true);
        view.unmount();
      }
    });

    test("moves a threadless Session through section hover and exact row insertion feedback", async () => {
      const drops: SidebarThreadDropRequest[] = [];
      const view = render(<ThreadlessSectionDropHarness onDrop={(drop) => drops.push(drop)} />);
      const pointerId = 20;
      const source = view.getByTestId("section-chat-draft");
      const surface = view.getByTestId("section-drop-surface");
      const container = surface.firstElementChild as HTMLElement;
      const list = view.getByRole("list", { name: "section:target chats" });
      const header = view.getByRole("button", { name: "Target section" });
      const alpha = view.getByTestId("section-chat-alpha");
      const beta = view.getByTestId("section-chat-beta");
      const x = header.getBoundingClientRect().left + header.getBoundingClientRect().width / 2;

      try {
        await startSectionPointerDrag(source, pointerId);
        await moveSectionPointer(pointerId, x, header.getBoundingClientRect().top + 8);
        await waitFor(() => {
          expect(container.dataset.sidebarDropTarget).toBe("true");
          expect(getComputedStyle(container).backgroundColor).toBe("rgba(13, 13, 13, 0.08)");
          expect(list.querySelector("[role='presentation']")).toBeNull();
        });

        await moveSectionPointer(pointerId, x, alpha.getBoundingClientRect().top + 4);
        await waitFor(() => {
          const indicator = list.querySelector<HTMLElement>("[role='presentation']");
          expect(indicator).not.toBeNull();
          expect(indicator?.nextElementSibling?.contains(alpha)).toBe(true);
          expect(indicator!.getBoundingClientRect().top).toBe(alpha.getBoundingClientRect().top);
          expect(getComputedStyle(indicator!, "::before").backgroundColor).toBe(
            "rgb(58, 131, 247)",
          );
          expect(container.dataset.sidebarDropTarget).toBeUndefined();
        });

        await moveSectionPointer(pointerId, x, alpha.getBoundingClientRect().bottom - 4);
        await waitFor(() => {
          const indicator = list.querySelector<HTMLElement>("[role='presentation']");
          expect(indicator?.nextElementSibling?.contains(beta)).toBe(true);
          expect(indicator!.getBoundingClientRect().top).toBe(beta.getBoundingClientRect().top);
        });
        await finishSectionPointerDrag(pointerId, true);
        await waitFor(() => {
          expect(list.querySelector("[role='presentation']")).toBeNull();
          expect(container.dataset.sidebarDropTarget).toBeUndefined();
          expect(drops).toEqual([]);
        });

        await startSectionPointerDrag(view.getByTestId("section-chat-draft"), pointerId);
        await moveSectionPointer(pointerId, x, alpha.getBoundingClientRect().bottom - 4);
        await waitFor(() => {
          expect(
            list.querySelector("[role='presentation']")?.nextElementSibling?.contains(beta),
          ).toBe(true);
        });
        await finishSectionPointerDrag(pointerId);
        await waitFor(() => {
          expect(drops).toHaveLength(1);
          expect(drops[0]).toMatchObject({
            sessionId: "session-draft",
            threadId: null,
            sourceContainerId: "chats",
            targetContainerId: "section:target",
            beforeItemId: "beta",
          });
          expect(list.querySelector("[role='presentation']")).toBeNull();
          expect(container.dataset.sidebarDropTarget).toBeUndefined();
        });
      } finally {
        await finishSectionPointerDrag(pointerId, true);
        view.unmount();
      }
    });

    test.each([
      { collapsed: false, empty: true },
      { collapsed: true, empty: false },
    ])(
      "accepts threadless Session drops on a section with $collapsed collapsed and $empty empty",
      async ({ collapsed, empty }) => {
        const drops: SidebarThreadDropRequest[] = [];
        const view = render(
          <ThreadlessSectionDropHarness
            collapsed={collapsed}
            empty={empty}
            onDrop={(drop) => drops.push(drop)}
          />,
        );
        const pointerId = 21;
        const surface = view.getByTestId("section-drop-surface");
        const container = surface.firstElementChild as HTMLElement;
        const header = view.getByRole("button", { name: "Target section" });
        const rect = header.getBoundingClientRect();

        try {
          await startSectionPointerDrag(view.getByTestId("section-chat-draft"), pointerId);
          await moveSectionPointer(pointerId, rect.left + rect.width / 2, rect.top + 8);
          await waitFor(() => expect(container.dataset.sidebarDropTarget).toBe("true"));
          await finishSectionPointerDrag(pointerId, true);
          await waitFor(() => {
            expect(container.dataset.sidebarDropTarget).toBeUndefined();
            expect(surface.querySelector("[role='presentation']")).toBeNull();
            expect(drops).toEqual([]);
          });

          await startSectionPointerDrag(view.getByTestId("section-chat-draft"), pointerId);
          await moveSectionPointer(pointerId, rect.left + rect.width / 2, rect.top + 8);
          await waitFor(() => expect(container.dataset.sidebarDropTarget).toBe("true"));
          await finishSectionPointerDrag(pointerId);
          await waitFor(() => {
            expect(drops).toHaveLength(1);
            expect(drops[0]).toMatchObject({
              sessionId: "session-draft",
              threadId: null,
              targetContainerId: "section:target",
            });
            expect(container.dataset.sidebarDropTarget).toBeUndefined();
            expect(header.getAttribute("aria-expanded")).toBe(String(!collapsed));
          });
        } finally {
          await finishSectionPointerDrag(pointerId, true);
          view.unmount();
        }
      },
    );

    test("reorders a persisted pre-thread New Chat by Session identity", async () => {
      const committedSessionOrders: string[][] = [];
      const view = render(
        <SessionReorderHarness
          onCommit={(orderedSessionIds) => committedSessionOrders.push(orderedSessionIds)}
        />,
      );
      const list = view.getByRole("list", { name: "Session-first Project chats" });
      const draft = view.getByTestId("session-draft");
      const chat = view.getByTestId("session-chat");
      const draftRect = draft.getBoundingClientRect();
      const chatRect = chat.getBoundingClientRect();
      const pointerId = 6;
      const pointerX = chatRect.left + chatRect.width / 2;

      try {
        await act(async () => {
          fireEvent.pointerDown(draft, {
            button: 0,
            clientX: draftRect.left + draftRect.width / 2,
            clientY: draftRect.top + draftRect.height / 2,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          fireEvent.pointerMove(document, {
            buttons: 1,
            clientX: pointerX,
            clientY: draftRect.top - 8,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          fireEvent.pointerMove(document, {
            buttons: 1,
            clientX: pointerX,
            clientY: chatRect.top + 4,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });
        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: chatRect.top + 4,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(committedSessionOrders).toEqual([["session-draft", "session-chat"]]);
          expect(readRenderedThreadKeys(list)).toEqual(["draft", "chat"]);
        });
      } finally {
        view.unmount();
      }
    });

    test("keeps the visible insertion intent current while moving across one row midpoint", async () => {
      const committedOrders: string[][] = [];
      const view = render(
        <ThreadReorderHarness
          onCommit={(nextThreadKeys) => committedOrders.push(nextThreadKeys)}
        />,
      );
      const list = view.getByRole("list", { name: "Project chats" });
      const beta = view.getByTestId("thread-beta");
      const alpha = view.getByTestId("thread-alpha");
      const betaRect = beta.getBoundingClientRect();
      const alphaRect = alpha.getBoundingClientRect();
      const pointerId = 7;
      const pointerX = alphaRect.left + alphaRect.width / 2;

      try {
        await act(async () => {
          fireEvent.pointerDown(beta, {
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
          expect(list.children).toHaveLength(3);
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
          expect(list.children).toHaveLength(2);
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

    test("commits the changed order without replaying a source-to-target transition", async () => {
      const committedOrders: string[][] = [];
      const errors: ErrorEvent[] = [];
      const consoleErrors: unknown[][] = [];
      const handleError = (event: ErrorEvent) => errors.push(event);
      const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });
      window.addEventListener("error", handleError);

      const view = render(
        <ThreadReorderHarness
          onCommit={(nextThreadKeys) => committedOrders.push(nextThreadKeys)}
        />,
      );
      const list = view.getByRole("list", { name: "Project chats" });
      const beta = view.getByTestId("thread-beta");
      const alpha = view.getByTestId("thread-alpha");
      const betaRect = beta.getBoundingClientRect();
      const alphaRect = alpha.getBoundingClientRect();
      const pointerId = 8;
      const pointerX = alphaRect.left + alphaRect.width / 2;
      const dropY = alphaRect.top + 4;
      const sourceSortableRow = beta.closest<HTMLElement>("[role='listitem']");
      const postDropStyleMutations: string[] = [];
      const styleObserver = new MutationObserver((records) => {
        for (const record of records) {
          postDropStyleMutations.push(record.oldValue ?? "");
          postDropStyleMutations.push((record.target as HTMLElement).getAttribute("style") ?? "");
        }
      });

      try {
        await act(async () => {
          fireEvent.pointerDown(beta, {
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
          expect(list.children).toHaveLength(3);
        });
        expect(sourceSortableRow).not.toBeNull();
        styleObserver.observe(sourceSortableRow!, {
          attributeFilter: ["style"],
          attributeOldValue: true,
          attributes: true,
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
          expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);
        });
        const movedRow = view.getByTestId("thread-beta").closest<HTMLElement>("[role='listitem']");
        expect(movedRow).not.toBeNull();
        expect(movedRow).toBe(sourceSortableRow);
        expect(postDropStyleMutations).toEqual([]);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(movedRow?.getAnimations()).toHaveLength(0);
        expect(getComputedStyle(movedRow!).transform).toBe("none");
        expect(errors).toHaveLength(0);
        expect(consoleErrors).toHaveLength(0);
      } finally {
        styleObserver.disconnect();
        window.removeEventListener("error", handleError);
        consoleError.mockRestore();
        view.unmount();
      }
    });

    test("keeps a regular same-lane drop optimistic until canonical settlement without shifting geometry", async () => {
      let resolveCommit!: () => void;
      const commit = new Promise<void>((resolve) => {
        resolveCommit = resolve;
      });
      let resolveCanonicalCommit!: () => void;
      const canonicalCommit = new Promise<void>((resolve) => {
        resolveCanonicalCommit = resolve;
      });
      const drops: SidebarThreadDropRequest[] = [];
      const view = render(
        <SemanticThreadReorderHarness
          beforeCanonicalCommit={canonicalCommit}
          onDrop={async (drop) => {
            drops.push(drop);
            await commit;
          }}
        />,
      );
      const list = view.getByRole("list", { name: "Canonical Project chats" });
      const beta = view.getByTestId("canonical-thread-beta");
      const alpha = view.getByTestId("canonical-thread-alpha");
      const betaRect = beta.getBoundingClientRect();
      const alphaRect = alpha.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const pointerId = 9;
      const pointerX = alphaRect.left + alphaRect.width / 2;
      const dropY = alphaRect.top + 4;
      let pointerReleased = false;

      try {
        await act(async () => {
          fireEvent.pointerDown(beta, {
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
          expect(list.querySelector("[role='presentation']")).not.toBeNull();
        });
        expect(list.getBoundingClientRect().height).toBe(listRect.height);
        expect(alpha.getBoundingClientRect().top).toBe(alphaRect.top);

        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: dropY,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          pointerReleased = true;
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(drops).toEqual([
            {
              beforeThreadId: "thread-alpha",
              sourceContainerId: "project:alpha",
              targetContainerId: "project:alpha",
              threadId: "thread-beta",
            },
          ]);
          expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);

        await act(async () => {
          resolveCommit();
          await commit;
          await Promise.resolve();
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);

        await act(async () => {
          resolveCanonicalCommit();
          await canonicalCommit;
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);
        });
      } finally {
        if (!pointerReleased) {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: dropY,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
        }
        resolveCommit();
        resolveCanonicalCommit();
        view.unmount();
      }
    });

    test("returns a regular chat to its original slot without submitting a move", async () => {
      const drops: SidebarThreadDropRequest[] = [];
      const consoleErrors: unknown[][] = [];
      const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });
      const view = render(
        <SemanticThreadReorderHarness
          onDrop={async (drop) => {
            drops.push(drop);
          }}
        />,
      );
      const list = view.getByRole("list", { name: "Canonical Project chats" });
      const beta = view.getByTestId("canonical-thread-beta");
      const alpha = view.getByTestId("canonical-thread-alpha");
      const betaRect = beta.getBoundingClientRect();
      const alphaRect = alpha.getBoundingClientRect();
      const pointerId = 10;
      const pointerX = alphaRect.left + alphaRect.width / 2;
      let pointerReleased = false;

      try {
        await act(async () => {
          fireEvent.pointerDown(beta, {
            button: 0,
            clientX: pointerX,
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
          expect(list.querySelector("[role='presentation']")).not.toBeNull();
        });

        await act(async () => {
          fireEvent.pointerMove(document, {
            buttons: 1,
            clientX: pointerX,
            clientY: betaRect.top + 4,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(list.querySelector("[role='presentation']")).toBeNull();
        });

        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: betaRect.top + 4,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
          pointerReleased = true;
          await Promise.resolve();
        });

        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(drops).toEqual([]);
        expect(readRenderedThreadKeys(list)).toEqual(["alpha", "beta"]);
        expect(consoleErrors).toEqual([]);
      } finally {
        if (!pointerReleased) {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: pointerX,
            clientY: betaRect.top + 4,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          });
        }
        consoleError.mockRestore();
        view.unmount();
      }
    });

    test("starts a drag from an open rich tooltip without replacing the sortable host", async () => {
      const errors: ErrorEvent[] = [];
      const controller: SidebarThreadReorderController = {
        handleDragEnd() {},
      };
      const handleError = (event: ErrorEvent) => {
        errors.push(event);
      };
      window.addEventListener("error", handleError);

      const view = render(
        <TestQueryProvider>
          <NodexHoverCardProvider>
            <NodexTooltipProvider>
              <SidebarReorderDndProvider>
                <SidebarThreadSortableContext threadKeys={[THREAD.key]}>
                  <div role="list" aria-label="Source project chats">
                    <SidebarThreadSortableItem
                      containerId="project:project-alpha"
                      controller={controller}
                      threadId={THREAD.threadId}
                      threadKey={THREAD.key}
                    >
                      <CodexSidebarThreadRow
                        item={THREAD}
                        linkedPageStore={emptySessionLinkedPageStore}
                        active={false}
                        hoverCardBranchName="codex/stable-ref"
                        hoverCardProjectLabel="Project alpha"
                        onSelect={() => {}}
                      />
                    </SidebarThreadSortableItem>
                  </div>
                </SidebarThreadSortableContext>
                <div role="list" aria-label="Destination projects">
                  <CodexProjectRow
                    project={PROJECT}
                    active={false}
                    expanded={false}
                    onActivate={() => {}}
                    onUpdateProject={async () => PROJECT}
                    onArchiveProject={async () => ({ kind: "not-found" })}
                  />
                </div>
              </SidebarReorderDndProvider>
            </NodexTooltipProvider>
          </NodexHoverCardProvider>
        </TestQueryProvider>,
      );

      try {
        const row = view.container.querySelector<HTMLElement>(
          "[data-app-action-sidebar-thread-row]",
        );
        const sortableHost = row?.closest<HTMLElement>(
          "[aria-roledescription='sortable']",
        )?.parentElement;
        if (!row || !sortableHost) {
          throw new TypeError("Expected a mounted sortable thread row");
        }

        await act(async () => {
          fireEvent.mouseEnter(row, {
            clientX: 20,
            clientY: 20,
          });
        });
        await waitFor(() => {
          expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        });

        await act(async () => {
          fireEvent.pointerDown(row, {
            button: 0,
            clientX: 20,
            clientY: 20,
            isPrimary: true,
            pointerId: 1,
            pointerType: "mouse",
          });
          fireEvent.pointerMove(document, {
            buttons: 1,
            clientX: 20,
            clientY: 40,
            isPrimary: true,
            pointerId: 1,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(sortableHost.hasAttribute("inert")).toBe(true);
        });
        expect(sortableHost.isConnected).toBe(true);
        expect(errors).toHaveLength(0);
      } finally {
        await act(async () => {
          fireEvent.pointerUp(document, {
            button: 0,
            clientX: 20,
            clientY: 40,
            isPrimary: true,
            pointerId: 1,
            pointerType: "mouse",
          });
          await Promise.resolve();
        });
        window.removeEventListener("error", handleError);
        view.unmount();
      }
    });
  });
});
