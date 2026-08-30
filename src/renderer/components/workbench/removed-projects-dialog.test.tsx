import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import type { Project } from "@/lib/types";
import { installWindowApi } from "@/test/browser-globals";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import { RemovedProjectsDialog } from "./removed-projects-dialog";

function makeRemovedProject(): Project {
  return {
    id: "project-removed",
    libraryId: "library-test",
    databaseId: "database-removed",
    defaultDatabaseViewId: "view-removed",
    lifecycle: "archived",
    bindingRevision: 3,
    name: "Removed Alpha",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [{ root: "/repo/removed-alpha", order: 0 }],
    primaryWorkspaceRoot: "/repo/removed-alpha",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-01-01T00:00:00.000Z"),
    updated: new Date("2026-07-22T00:00:00.000Z"),
  };
}

describe("RemovedProjectsDialog", () => {
  let projects: Project[];
  let listCalls: unknown[][];

  beforeEach(() => {
    projects = [makeRemovedProject()];
    listCalls = [];
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "projects:list") {
          listCalls.push(args);
          return {
            items: projects,
            nextCursor: null,
            hasMore: false,
            storeEpoch: "epoch:test",
            projectionRevision: 1,
          };
        }
        if (channel === "projects:set-lifecycle") {
          const command = args[0] as {
            payload?: { projectId?: string };
          };
          const project = projects.find((candidate) => candidate.id === command.payload?.projectId);
          const value = project
            ? {
                kind: "updated" as const,
                changed: true,
                project: { ...project, lifecycle: "active" as const },
              }
            : { kind: "not-found" as const };
          if (!project) {
            return {
              ok: true,
              value,
              localCommit: {
                status: "no_op",
                observed: { store_epoch: "epoch:test", commit_head: 1 },
              },
            };
          }
          projects = [];
          return {
            ok: true,
            value,
            localCommit: {
              status: "no_op",
              observed: { store_epoch: "epoch:test", commit_head: 1 },
            },
          };
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => undefined,
    });
  });

  test("loads removed projects only when opened and restores one row in place", async () => {
    const closed = render(
      <TestQueryProvider>
        <RemovedProjectsDialog open={false} onOpenChange={() => undefined} />
      </TestQueryProvider>,
    );
    expect(listCalls).toEqual([]);
    closed.unmount();

    const view = render(
      <TestQueryProvider>
        <RemovedProjectsDialog open onOpenChange={() => undefined} />
      </TestQueryProvider>,
    );
    expect(await view.findByText("Removed Alpha")).toBeTruthy();
    expect(view.getByText("/repo/removed-alpha")).toBeTruthy();
    expect(listCalls).toEqual([
      [
        {
          includeArchived: true,
          after: null,
          first: 100,
        },
      ],
    ]);

    fireEvent.click(view.getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      expect(view.getByText("No removed projects")).toBeTruthy();
    });
  });
});
