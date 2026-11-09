import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Project } from "../../lib/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render } from "../../test/dom";
import {
  ProjectCreateDialog,
  ProjectEditDialog,
  type ProjectDialogSubmitInput,
  type DatabasePageKeyAuthority,
} from "./project-edit-dialog";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  invoke: async () => [],
}));

const PROJECT: Project = {
  id: "beta",
  libraryId: "library:test",
  databaseId: "database:test:primary",
  defaultDatabaseViewId: "view:test:primary",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Beta",
  description: "",
  appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
  sources: [
    { kind: "directory" as const, path: "/repo/beta", order: 0 },
    { kind: "directory" as const, path: "/repo/beta-docs", order: 1 },
  ],
  primaryWorkspaceRoot: "/repo/beta",
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-03-15T00:00:00.000Z"),
  updated: new Date("2026-03-15T00:00:00.000Z"),
};

let queryClient: QueryClient;

const previewPrefix: DatabasePageKeyAuthority["previewPrefix"] = async (input) => {
  const prefix = input.requestedPrefix ?? (input.nameHint.trim().toUpperCase().slice(0, 3) || "NX");
  const nextNumber = input.projectId ? 8 : 1;
  return {
    prefix,
    availability: input.projectId && input.requestedPrefix === "BET" ? "current" : "available",
    alternativePrefix: null,
    nextNumber,
    exampleKeys: [`${prefix}-${nextNumber}`, `${prefix}-${nextNumber + 1}`],
  };
};

const readNamespace: DatabasePageKeyAuthority["readNamespace"] = async (
  _projectId,
  databaseId,
) => ({
  storeEpoch: "epoch:test",
  namespace: {
    databaseId: databaseId as never,
    currentPrefix: "BET",
    nextNumber: 8,
    assignedPageCount: 7,
    revision: 1,
    retiredPrefixes: [],
  },
});

const defaultPageKeyAuthority = (
  renamePrefix: DatabasePageKeyAuthority["renamePrefix"] = async () => undefined,
): DatabasePageKeyAuthority => ({ previewPrefix, readNamespace, renamePrefix });

function withQueryClient(element: ReactElement): ReactElement {
  return <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>;
}

function renderEditDialog(
  onSubmit: (input: ProjectDialogSubmitInput) => Promise<void>,
  pageKeyAuthority = defaultPageKeyAuthority(),
) {
  return render(
    withQueryClient(
      <NodexTooltipProvider>
        <ProjectEditDialog
          project={PROJECT}
          onClose={() => undefined}
          onSubmit={onSubmit}
          pageKeyAuthority={pageKeyAuthority}
        />
      </NodexTooltipProvider>,
    ),
  );
}

describe("ProjectEditDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  test("make primary moves the folder to the front of the saved sources", async () => {
    const submitted: ProjectDialogSubmitInput[] = [];
    const { getByLabelText, getByText } = renderEditDialog(async (input) => {
      submitted.push(input);
    });

    await act(async () => {
      fireEvent.click(getByLabelText("Make beta-docs primary"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(getByText("Save"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submitted[0]?.sources).toEqual(["/repo/beta-docs", "/repo/beta"]);
      expect(submitted[0]?.name).toBe("Beta");
      expect(submitted[0]?.appearance).toEqual(PROJECT.appearance);
    });
  });

  test("stages marker changes and submits appearance atomically with the form", async () => {
    const submitted: ProjectDialogSubmitInput[] = [];
    const view = renderEditDialog(async (input) => {
      submitted.push(input);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Change marker for Beta" }));
      await Promise.resolve();
    });
    const editorDialog = view
      .getByRole("heading", {
        name: "Edit project",
      })
      .closest('[role="dialog"]');
    const pickerDialog = view.getByRole("dialog", {
      name: "Project marker for Beta",
    });
    expect(editorDialog?.contains(pickerDialog)).toBe(false);
    expect(document.body.contains(pickerDialog)).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Use Red" }));
      await Promise.resolve();
    });

    expect(submitted).toHaveLength(0);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submitted).toEqual([
        {
          appearance: {
            color: "red",
            marker: { kind: "icon", icon: "terminal" },
          },
          name: "Beta",
          sources: ["/repo/beta", "/repo/beta-docs"],
        },
      ]);
    });
  });

  test("Cancel discards a staged marker without submitting", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    const view = render(
      withQueryClient(
        <NodexTooltipProvider>
          <ProjectEditDialog
            project={PROJECT}
            onClose={onClose}
            onSubmit={onSubmit}
            pageKeyAuthority={defaultPageKeyAuthority()}
          />
        </NodexTooltipProvider>,
      ),
    );

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: "Change marker for Beta",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Use Red" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("keeps the dialog and staged marker intact after a rejected Save", async () => {
    const view = renderEditDialog(async () => {
      throw new Error("revision changed");
    });

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: "Change marker for Beta",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Use Red" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Done" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByRole("heading", { name: "Edit project" })).toBeTruthy();
      expect(
        view.getByRole("button", {
          name: "Change marker for Beta",
        }),
      ).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: "Change marker for Beta",
        }),
      );
      await Promise.resolve();
    });
    expect(
      view
        .getByRole("button", {
          name: "Use Red",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("removing a folder drops it from the saved sources", async () => {
    const submitted: ProjectDialogSubmitInput[] = [];
    const { getByLabelText, getByText, queryByText } = renderEditDialog(async (input) => {
      submitted.push(input);
    });

    await act(async () => {
      fireEvent.click(getByLabelText("Remove beta-docs"));
      await Promise.resolve();
    });

    expect(queryByText("beta-docs")).toBe(null);
    expect(queryByText("Primary")).toBe(null);

    await act(async () => {
      fireEvent.click(getByText("Save"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submitted[0]?.sources).toEqual(["/repo/beta"]);
    });
  });

  test("submits an explicit Project key and explains prefix renames", async () => {
    const submitted: ProjectDialogSubmitInput[] = [];
    const renamed: Parameters<DatabasePageKeyAuthority["renamePrefix"]>[0][] = [];
    const view = renderEditDialog(
      async (input) => {
        submitted.push(input);
      },
      defaultPageKeyAuthority(async (input) => {
        renamed.push(input);
      }),
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Change" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Page key prefix" }), {
        target: { value: "rnd" },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByText(/7 Pages will use prefix RND/i)).toBeTruthy();
      expect(view.getByText(/keep working and remain reserved/i)).toBeTruthy();
      expect(view.getByText("RND-8 is available")).toBeTruthy();
      expect(view.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submitted[0]).not.toHaveProperty("pageKeyPrefix");
      expect(renamed[0]).toMatchObject({
        projectId: PROJECT.id,
        databaseId: PROJECT.databaseId,
        expectedRevision: 1,
        prefix: "RND",
      });
    });
  });

  test("keeps a prefix rename retry separate after Project details were saved", async () => {
    const submitted: ProjectDialogSubmitInput[] = [];
    let renameAttempts = 0;
    const view = renderEditDialog(
      async (input) => {
        submitted.push(input);
      },
      defaultPageKeyAuthority(async () => {
        renameAttempts += 1;
        if (renameAttempts === 1) throw new Error("Database write unavailable");
      }),
    );

    fireEvent.click(view.getByRole("button", { name: "Change" }));
    fireEvent.change(view.getByRole("textbox", { name: "Page key prefix" }), {
      target: { value: "RND" },
    });
    await waitFor(() => {
      expect(view.getByText("RND-8 is available")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "Project details were saved, but the prefix was not changed",
      );
      expect(submitted).toHaveLength(1);
      expect(renameAttempts).toBe(1);
    });

    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Project name" }), {
        target: { value: "Beta after conflict" },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("alert")).toBe(null));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submitted).toHaveLength(2);
      expect(submitted[1]?.name).toBe("Beta after conflict");
      expect(renameAttempts).toBe(2);
    });
  });

  test("creates a Project without exposing or submitting Page-key settings", async () => {
    const submitted: ProjectDialogSubmitInput[] = [];
    const view = render(
      withQueryClient(
        <NodexTooltipProvider>
          <ProjectCreateDialog
            onClose={() => undefined}
            onCreate={async (input) => {
              submitted.push(input);
            }}
          />
        </NodexTooltipProvider>,
      ),
    );

    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Project name" }), {
        target: { value: "Lab" },
      });
      await Promise.resolve();
    });

    expect(view.queryByRole("textbox", { name: "Page key prefix" })).toBe(null);
    expect(view.queryByText("Page key settings")).toBe(null);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create project" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(submitted).toEqual([
        {
          appearance: DEFAULT_PROJECT_APPEARANCE,
          name: "Lab",
          sources: [],
        },
      ]);
    });
  });

  test("resets project-scoped confirmation state when retargeted", async () => {
    const renderDialog = (project: Project) => (
      <NodexTooltipProvider>
        <ProjectEditDialog
          project={project}
          onClose={() => undefined}
          onSubmit={async () => undefined}
          pageKeyAuthority={defaultPageKeyAuthority()}
          onArchiveProject={async () => ({ kind: "not-found" })}
        />
      </NodexTooltipProvider>
    );
    const view = render(withQueryClient(renderDialog(PROJECT)));

    fireEvent.click(view.getByRole("button", { name: "Remove project" }));
    expect(await view.findByRole("heading", { name: "Remove Beta?" })).toBeTruthy();

    const nextProject: Project = {
      ...PROJECT,
      id: "gamma",
      name: "Gamma",
    };
    view.rerender(withQueryClient(renderDialog(nextProject)));

    await waitFor(() => {
      expect(view.queryByRole("heading", { name: "Remove Beta?" })).toBe(null);
      expect((view.getByRole("textbox", { name: "Project name" }) as HTMLInputElement).value).toBe(
        "Gamma",
      );
    });
  });
});
