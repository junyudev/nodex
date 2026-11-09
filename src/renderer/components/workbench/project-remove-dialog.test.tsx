import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { Project, ProjectLifecycleMutationResult } from "@/lib/types";
import { render } from "@/test/dom";
import { ProjectRemoveDialog } from "./project-remove-dialog";

const PROJECT: Project = {
  id: "project-alpha",
  libraryId: "library-test",
  databaseId: "database-alpha",
  defaultDatabaseViewId: "view-alpha",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Alpha",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [{ kind: "directory" as const, path: "/repo/alpha", order: 0 }],
  primaryWorkspaceRoot: "/repo/alpha",
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-01-01T00:00:00.000Z"),
  updated: new Date("2026-01-01T00:00:00.000Z"),
};

describe("ProjectRemoveDialog", () => {
  test("explains recoverability and closes after a successful archive", async () => {
    const onOpenChange = vi.fn();
    const archive = vi.fn(async (): Promise<ProjectLifecycleMutationResult> => ({
      kind: "updated",
      changed: true,
      project: { ...PROJECT, lifecycle: "archived" },
    }));
    const view = render(
      <ProjectRemoveDialog
        open
        project={PROJECT}
        onOpenChange={onOpenChange}
        onArchiveProject={archive}
      />,
    );

    expect(view.getByRole("heading", { name: "Remove Alpha?" })).toBeTruthy();
    expect(
      view.getByText(/Files on your computer and existing chats won’t be deleted/),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Remove project" }));
    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith("project-alpha");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("keeps the dialog open and explains active runtime blockers", async () => {
    const onOpenChange = vi.fn();
    const view = render(
      <ProjectRemoveDialog
        open
        project={PROJECT}
        onOpenChange={onOpenChange}
        onArchiveProject={async () => ({
          kind: "blocked",
          project: PROJECT,
          blockers: [
            { kind: "active-turn", threadId: "thread-1", label: "Build release" },
            {
              kind: "terminal",
              terminalSessionId: "terminal-1",
              projectSessionId: "session-1",
            },
          ],
        })}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Remove project" }));

    expect((await view.findByRole("alert")).textContent).toContain(
      "Stop the active task and close its terminals before removing this project.",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("prevents dismissal and duplicate submission while pending", async () => {
    let resolveArchive: ((result: ProjectLifecycleMutationResult) => void) | null = null;
    const archive = vi.fn(
      () =>
        new Promise<ProjectLifecycleMutationResult>((resolve) => {
          resolveArchive = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    const view = render(
      <ProjectRemoveDialog
        open
        project={PROJECT}
        onOpenChange={onOpenChange}
        onArchiveProject={archive}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Remove project" }));
    await waitFor(() => {
      expect((view.getByRole("button", { name: "Removing…" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect((view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(view.getByRole("button", { name: "Removing…" }));
    expect(archive).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      resolveArchive?.({
        kind: "updated",
        changed: true,
        project: { ...PROJECT, lifecycle: "archived" },
      });
      await Promise.resolve();
    });
  });
});
