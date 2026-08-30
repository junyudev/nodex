import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { useLayoutEffect, useState } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import type { Project } from "./types";
import { useProjects } from "./use-projects";

function makeProject(id: string, name = id): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [{ root: `/tmp/${id}`, order: 0 }],
    primaryWorkspaceRoot: `/tmp/${id}`,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-01-01T00:00:00.000Z"),
    updated: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function committed<Value>(value: Value) {
  return {
    ok: true as const,
    value,
    localCommit: {
      status: "committed" as const,
      commit: {
        store_epoch: "epoch:test",
        commit_seq: 2,
        manifest_hash: "f".repeat(64),
      },
      delivery: null,
    },
  };
}

function ProjectsHarness() {
  const first = useProjects();
  const second = useProjects();
  const [archiveResult, setArchiveResult] = useState("");

  return (
    <div>
      <span data-testid="project-count">
        {first.projects.length}:{second.projects.length}
      </span>
      <span data-testid="projects-ready">{String(first.ready)}</span>
      <span data-testid="projects-error">{first.error ?? ""}</span>
      <span data-testid="projects-has-more">{String(first.hasMoreProjects)}</span>
      <span data-testid="archive-result">{archiveResult}</span>
      <button
        type="button"
        onClick={() => {
          void first.reorderProjects({
            orderedProjectIds: first.projects.map((project) => project.id).reverse(),
          });
        }}
      >
        Reverse projects
      </button>
      <button type="button" onClick={() => void first.refresh()}>
        Retry projects
      </button>
      <button type="button" onClick={() => void first.loadMoreProjects()}>
        Show more projects
      </button>
      <button
        type="button"
        onClick={() => {
          const projectId = first.projects[0]?.id;
          if (!projectId) return;
          void first.archiveProject(projectId).then((result) => setArchiveResult(result.kind));
        }}
      >
        Remove first project
      </button>
    </div>
  );
}

function ProjectRenameHarness() {
  const projects = useProjects();
  const renderToken = projects.projectCatalogRenderToken;
  const markRendered = projects.markProjectCatalogRendered;
  useLayoutEffect(() => {
    if (renderToken === null) return;
    markRendered(renderToken);
  }, [markRendered, renderToken]);

  return (
    <div>
      <span data-testid="project-name">{projects.projects[0]?.name ?? ""}</span>
      <button
        type="button"
        onClick={() => void projects.updateProject("alpha", { name: "Renamed" })}
      >
        Rename project
      </button>
    </div>
  );
}

describe("useProjects", () => {
  let projects: Project[];
  let listCalls = 0;
  let paginateProjects = false;
  let projectionRevision = 1;
  let projectChangeListener: ((event: unknown) => void) | null = null;

  beforeEach(() => {
    projects = [makeProject("alpha"), makeProject("beta")];
    listCalls = 0;
    paginateProjects = false;
    projectionRevision = 1;
    projectChangeListener = null;

    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "projects:list") {
          listCalls += 1;
          const input = args[0] as { after?: string | null };
          if (paginateProjects) {
            const secondWindow = input.after === "projects:next";
            return {
              items: secondWindow ? projects.slice(2) : projects.slice(0, 2),
              nextCursor: secondWindow ? null : "projects:next",
              hasMore: !secondWindow,
              storeEpoch: "epoch:test",
              projectionRevision: 1,
            };
          }
          return {
            items: projects,
            nextCursor: null,
            hasMore: false,
            storeEpoch: "epoch:test",
            projectionRevision,
          };
        }

        if (channel === "projects:reorder") {
          const request = args[0] as {
            payload: { orderedProjectIds: string[] };
          };
          const input = request.payload;
          projects = input.orderedProjectIds
            .map((projectId) => projects.find((project) => project.id === projectId))
            .filter((project): project is Project => Boolean(project));
          return committed(projects);
        }

        if (channel === "projects:set-lifecycle") {
          const request = args[0] as {
            payload: { projectId: string };
          };
          const projectId = request.payload.projectId;
          const project = projects.find((candidate) => candidate.id === projectId);
          if (!project) return { ok: false, outcome: { kind: "not-found" } };
          projects = projects.filter((candidate) => candidate.id !== projectId);
          return committed({
            kind: "updated",
            changed: true,
            project: { ...project, lifecycle: "archived" },
          });
        }

        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: (channel: string, listener: (event: unknown) => void) => {
        if (channel === "projects-changed") {
          projectChangeListener = listener;
        }
        return () => {
          if (projectChangeListener === listener) projectChangeListener = null;
        };
      },
    });
  });

  test("dedupes list requests across consumers and refetches after project changes", async () => {
    const view = render(
      <TestQueryProvider>
        <ProjectsHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("project-count").textContent).toBe("2:2");
    });
    expect(listCalls).toBe(1);

    projects = [...projects, makeProject("gamma")];
    await act(async () => {
      projectChangeListener?.({});
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByTestId("project-count").textContent).toBe("3:3");
    });
    expect(listCalls).toBe(2);
  });

  test("keeps a rename visible across delayed acknowledgement and stale canonical reads", async () => {
    let resolveUpdate!: (value: unknown) => void;
    const update = new Promise<unknown>((resolve) => {
      resolveUpdate = resolve;
    });
    let submittedInput: Record<string, unknown> | null = null;
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "projects:list") {
          listCalls += 1;
          return {
            items: projects,
            nextCursor: null,
            hasMore: false,
            storeEpoch: "epoch:test",
            projectionRevision,
          };
        }
        if (channel === "projects:update") {
          submittedInput = args[0] as Record<string, unknown>;
          return await update;
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: (channel: string, listener: (event: unknown) => void) => {
        if (channel === "projects-changed") projectChangeListener = listener;
        return () => undefined;
      },
    });
    const view = render(
      <TestQueryProvider>
        <ProjectRenameHarness />
      </TestQueryProvider>,
    );
    await waitFor(() => expect(view.getByTestId("project-name").textContent).toBe("alpha"));

    fireEvent.click(view.getByRole("button", { name: "Rename project" }));
    expect(view.getByTestId("project-name").textContent).toBe("Renamed");
    await waitFor(() => expect(submittedInput).not.toBeNull());
    expect(submittedInput).toMatchObject({
      projectId: "alpha",
      updates: { name: "Renamed" },
    });

    await act(async () => {
      resolveUpdate({
        ok: true,
        value: { ...projects[0], name: "Renamed", bindingRevision: 2 },
        localCommit: {
          status: "committed",
          commit: {
            store_epoch: "epoch:test",
            commit_seq: 2,
            manifest_hash: "f".repeat(64),
          },
          delivery: null,
        },
      });
      await update;
    });
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(view.getByTestId("project-name").textContent).toBe("Renamed");

    projects = projects.map((project) =>
      project.id === "alpha" ? { ...project, name: "Renamed", bindingRevision: 2 } : project,
    );
    projectionRevision = 2;
    await act(async () => {
      projectChangeListener?.({});
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByTestId("project-name").textContent).toBe("Renamed"));
  });

  test("loads a continuation only after an explicit request", async () => {
    paginateProjects = true;
    projects = [makeProject("alpha"), makeProject("beta"), makeProject("gamma")];
    const view = render(
      <TestQueryProvider>
        <ProjectsHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("project-count").textContent).toBe("2:2");
    });
    expect(view.getByTestId("projects-has-more").textContent).toBe("true");
    expect(listCalls).toBe(1);

    fireEvent.click(view.getByRole("button", { name: "Show more projects" }));
    await waitFor(() => {
      expect(view.getByTestId("project-count").textContent).toBe("3:3");
    });
    expect(view.getByTestId("projects-has-more").textContent).toBe("false");
    expect(listCalls).toBe(2);
  });

  test("invalidates the bounded Project window after reorder", async () => {
    const view = render(
      <TestQueryProvider>
        <ProjectsHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("project-count").textContent).toBe("2:2");
    });
    expect(listCalls).toBe(1);

    fireEvent.click(view.getByRole("button", { name: "Reverse projects" }));
    await settleAsyncRender();

    expect(projects[0]?.id).toBe("beta");
    expect(listCalls).toBe(2);
  });

  test("archives through the typed lifecycle mutation and invalidates the active catalog", async () => {
    const view = render(
      <TestQueryProvider>
        <ProjectsHarness />
      </TestQueryProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId("project-count").textContent).toBe("2:2");
    });

    fireEvent.click(view.getByRole("button", { name: "Remove first project" }));

    await waitFor(() => {
      expect(view.getByTestId("archive-result").textContent).toBe("updated");
      expect(view.getByTestId("project-count").textContent).toBe("1:1");
    });
    expect(listCalls).toBe(2);
  });

  test("stays unready after an initial error and becomes ready after retry", async () => {
    let attempts = 0;
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel !== "projects:list") throw new Error(`Unexpected channel: ${channel}`);
        attempts += 1;
        if (attempts === 1) throw new Error("Project catalog unavailable");
        return {
          items: projects,
          nextCursor: null,
          hasMore: false,
          storeEpoch: "epoch:test",
          projectionRevision: attempts,
        };
      },
      on: () => () => undefined,
    });
    const view = render(
      <TestQueryProvider>
        <ProjectsHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("projects-ready").textContent).toBe("false");
      expect(view.getByTestId("projects-error").textContent).toBe("Project catalog unavailable");
    });

    fireEvent.click(view.getByRole("button", { name: "Retry projects" }));

    await waitFor(() => {
      expect(view.getByTestId("projects-ready").textContent).toBe("true");
      expect(view.getByTestId("project-count").textContent).toBe("2:2");
    });
    expect(attempts).toBe(2);
  });
});
