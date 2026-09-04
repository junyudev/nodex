import type { ReactNode } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../../shared/database-identities";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { NodexModalHost } from "@/lib/modal-registry";
import { registerPageCreateTarget, type PageCreateTarget } from "@/lib/page-create-target-registry";
import { requestPageCreate } from "@/lib/page-create-workflow";
import { BOARD_PRIORITY_OPTIONS } from "@/lib/board-options";
import { estimateStyles } from "@/lib/types";
import { __resetNodexToastStoreForTests, NodexToastProvider } from "@/components/ui/toast";
import { renderWithMaitai } from "@/test/thread-maitai";

const commandState = vi.hoisted(() => ({
  create: vi.fn(),
}));
const editorState = vi.hoisted(() => ({
  latestFragment: null as null | {
    readonly length: number;
    delete: (index: number, length: number) => void;
  },
}));
const optionRuntime = vi.hoisted(() => ({ readWindow: vi.fn() }));

const property = (propertyId: "priority" | "estimate"): DataSourcePropertyRecordV2 => {
  const options =
    propertyId === "priority"
      ? BOARD_PRIORITY_OPTIONS.map(({ label, value }) => ({ id: value, name: label }))
      : (["xs", "s", "m", "l", "xl"] as const).map((id) => ({
          id,
          name: estimateStyles[id].label,
        }));
  return {
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId: parseDataSourceId("source-test"),
    name: propertyId,
    ...testPropertySemantics("select", options.length),
    valueType: "select",
    config: { options },
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
};

vi.mock("@/lib/board-page-create-command", () => ({
  createBoardPage: (...args: unknown[]) => commandState.create(...args),
}));

vi.mock("@/lib/database-property-options-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database-property-options-runtime")>()),
  readPropertyOptionWindow: optionRuntime.readWindow,
}));

vi.mock("./editor/nfm-editor", async () => {
  const React = await import("react");
  const { materializePageDocument, populateBlockDocumentBodyFromNfm } =
    await import("../../../shared/block-documents/block-document-codec");

  return {
    NfmEditor: ({
      source,
      embeddedBoundary,
    }: {
      source: {
        documentId: string;
        fragment: import("yjs").XmlFragment;
      };
      embeddedBoundary: {
        navigationRef: React.Ref<{
          focus: () => boolean;
          focusBoundary: () => boolean;
        }>;
      };
    }) => {
      editorState.latestFragment = source.fragment;
      const inputRef = React.useRef<HTMLTextAreaElement>(null);
      const readValue = () =>
        source.fragment.doc ? materializePageDocument(source.fragment.doc).nfm : "";
      const [value, setValue] = React.useState(readValue);
      React.useEffect(() => {
        setValue(source.fragment.doc ? materializePageDocument(source.fragment.doc).nfm : "");
      }, [source.documentId, source.fragment]);
      React.useImperativeHandle(embeddedBoundary.navigationRef, () => ({
        focus: () => {
          inputRef.current?.focus();
          return true;
        },
        focusBoundary: () => {
          inputRef.current?.focus();
          return true;
        },
      }));
      return (
        <textarea
          ref={inputRef}
          aria-label="Page description"
          data-document-id={source.documentId}
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);
            source.fragment.doc?.transact(() => {
              if (source.fragment.length > 0) {
                source.fragment.delete(0, source.fragment.length);
              }
              populateBlockDocumentBodyFromNfm(source.fragment, nextValue);
            });
          }}
        />
      );
    },
  };
});

const target: PageCreateTarget = {
  surfaceId: "surface-test",
  panelTabId: "tab-test",
  project: {
    id: "project-test",
    name: "Nodex",
    appearance: {
      color: "blue",
      marker: { kind: "icon", icon: "terminal" },
    },
  },
  databaseViewId: "view-test",
  clientSessionId: "session-test",
  accessContext: { kind: "project", projectId: "project-test" },
  properties: [property("priority"), property("estimate")],
  columns: [
    { id: "triage", name: "Triage" },
    { id: "plan", name: "Plan" },
    { id: "build", name: "Build" },
    { id: "ship", name: "Ship" },
  ],
  readOnlyReason: null,
};

const origin = {
  surfaceId: target.surfaceId,
  panelTabId: target.panelTabId,
  projectId: target.project.id,
  databaseViewId: target.databaseViewId,
  kind: "header" as const,
  columnId: "plan" as const,
};

const createPage = (id: string, title: string) => ({
  id,
  status: "plan" as const,
  archived: false,
  title,
  richTitle: plainTextToPortableRichText(title),
  description: "",
  tags: [],
  created: new Date("2026-08-08T00:00:00.000Z"),
  order: 0,
});

function ModalLauncher({
  children,
  onAncestorPointerDown,
  seedTitle,
  initialExpanded = false,
  visible = true,
}: {
  readonly children?: ReactNode;
  readonly onAncestorPointerDown?: () => void;
  readonly seedTitle?: string;
  readonly initialExpanded?: boolean;
  readonly visible?: boolean;
}) {
  const appHandle = useScopeHandle(appScope);
  if (!visible) return <>{children}</>;

  return (
    <div onPointerDown={onAncestorPointerDown}>
      <button
        type="button"
        onClick={() => {
          registerPageCreateTarget(appHandle, "registration-test", target);
          requestPageCreate(
            appHandle,
            seedTitle
              ? { target, origin, seed: { title: seedTitle }, initialExpanded }
              : { target, origin, initialExpanded },
          );
        }}
      >
        Open Page create
      </button>
      <button
        type="button"
        onClick={() => {
          requestPageCreate(appHandle, {
            target,
            origin,
            initialExpanded: true,
          });
        }}
      >
        Open Page create expanded
      </button>
      {children}
    </div>
  );
}

function TestShell({
  launcherVisible = true,
  onAncestorPointerDown,
  seedTitle,
  initialExpanded = false,
}: {
  readonly launcherVisible?: boolean;
  readonly onAncestorPointerDown?: () => void;
  readonly seedTitle?: string;
  readonly initialExpanded?: boolean;
}) {
  return (
    <NodexToastProvider>
      <ModalLauncher
        visible={launcherVisible}
        onAncestorPointerDown={onAncestorPointerDown}
        seedTitle={seedTitle}
        initialExpanded={initialExpanded}
      />
      <div data-board-root data-board-surface-id={target.surfaceId} tabIndex={-1}>
        <button type="button" data-page-create-trigger="header" data-page-create-column-id="plan">
          Source trigger
        </button>
        <div data-board-uuid-v7="created-page" tabIndex={-1} />
      </div>
      <NodexModalHost />
    </NodexToastProvider>
  );
}

describe("PageCreateDialog", () => {
  beforeEach(() => {
    commandState.create.mockReset();
    optionRuntime.readWindow.mockReset();
    optionRuntime.readWindow.mockResolvedValue({
      options: [],
      nextCursor: null,
      projectionRevision: 1,
    });
    editorState.latestFragment = null;
    __resetNodexToastStoreForTests();
  });

  test("is owned by the app modal host and survives its launcher unmounting", async () => {
    const onAncestorPointerDown = vi.fn();
    const view = renderWithMaitai(<TestShell onAncestorPointerDown={onAncestorPointerDown} />);

    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    expect(await view.findByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(view.getByLabelText("Page title"));
    expect(onAncestorPointerDown).not.toHaveBeenCalled();

    view.rerender(<TestShell launcherVisible={false} />);
    expect(view.getByRole("dialog")).toBeTruthy();
  });

  test("uses selected text only as the initial title of a new draft", async () => {
    const view = renderWithMaitai(<TestShell seedTitle="Fix release notes" />);

    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));

    expect(((await view.findByLabelText("Page title")) as HTMLInputElement).value).toBe(
      "Fix release notes",
    );
    expect((view.getByLabelText("Page description") as HTMLTextAreaElement).value).toBe("");
  });

  test("treats a repeated create request as focus, not a second draft", async () => {
    const view = renderWithMaitai(<TestShell />);
    const trigger = view.getByRole("button", { name: "Open Page create" });
    fireEvent.click(trigger);
    const title = await view.findByLabelText("Page title");
    title.blur();

    fireEvent.click(trigger);

    expect(view.getAllByRole("dialog")).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("preserves the draft after failure and focuses the exact created card after retry", async () => {
    let resolveRetry: (() => void) | null = null;
    commandState.create
      .mockResolvedValueOnce({ status: "error", error: "Core is temporarily unavailable" })
      .mockImplementationOnce(
        (input: { input: { title: string } }) =>
          new Promise((resolve) => {
            resolveRetry = () =>
              resolve({
                status: "created",
                page: createPage("created-page", input.input.title),
              });
          }),
      );
    const view = renderWithMaitai(<TestShell />);

    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    const title = await view.findByLabelText("Page title");
    const description = view.getByLabelText("Page description");
    fireEvent.change(title, { target: { value: "Create Page modal" } });
    fireEvent.change(description, { target: { value: "Failure-safe body" } });
    fireEvent.click(view.getByRole("button", { name: "Create page" }));

    expect((await view.findByRole("alert")).textContent).toContain(
      "Core is temporarily unavailable",
    );
    expect((title as HTMLInputElement).value).toBe("Create Page modal");
    expect((description as HTMLTextAreaElement).value).toBe("Failure-safe body");
    expect(commandState.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: target.project.id,
        databaseViewId: target.databaseViewId,
        status: "plan",
        input: expect.objectContaining({
          title: "Create Page modal",
          description: "Failure-safe body",
        }),
        placement: "top",
      }),
    );

    fireEvent.click(view.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Creating…" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Close Page creation" }).hasAttribute("disabled")).toBe(
      true,
    );
    await act(async () => {
      resolveRetry?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.container.querySelector("[data-board-uuid-v7='created-page']"),
      ),
    );
  });

  test("creates a Page with a canonical blank description", async () => {
    commandState.create.mockResolvedValue({
      status: "created",
      page: createPage("created-page", "Title only Page"),
    });
    const view = renderWithMaitai(<TestShell />);

    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    fireEvent.change(await view.findByLabelText("Page title"), {
      target: { value: "Title only Page" },
    });
    fireEvent.click(view.getByRole("button", { name: "Create page" }));

    await waitFor(() =>
      expect(commandState.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ description: "" }),
        }),
      ),
    );
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("moves from title to description without remounting it when expanded", async () => {
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    const title = await view.findByLabelText("Page title");
    const description = view.getByLabelText("Page description");
    const documentId = description.getAttribute("data-document-id");

    title.focus();
    fireEvent.keyDown(title, { key: "Enter", isComposing: true });
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(title, { key: "Enter" });
    expect(document.activeElement).toBe(description);

    fireEvent.change(description, { target: { value: "Keep editor state" } });
    const expandButton = view.getByRole("button", { name: "Expand Page composer" });
    const expandIcon = expandButton.querySelector("path")?.getAttribute("d");
    fireEvent.click(expandButton);
    const collapseButton = view.getByRole("button", { name: "Collapse Page composer" });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    expect(collapseButton.querySelector("path")?.getAttribute("d")).not.toBe(expandIcon);
    expect(view.getByLabelText("Page description").getAttribute("data-document-id")).toBe(
      documentId,
    );
    expect((view.getByLabelText("Page description") as HTMLTextAreaElement).value).toBe(
      "Keep editor state",
    );
  });

  test("opens directly in expanded mode when the request asks for it", async () => {
    const view = renderWithMaitai(<TestShell initialExpanded />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));

    expect(
      (await view.findByRole("button", { name: "Collapse Page composer" })).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  test("expands an existing draft without replacing its editor state", async () => {
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    const title = await view.findByLabelText("Page title");
    fireEvent.change(title, { target: { value: "Keep this draft" } });

    fireEvent.click(view.getByText("Open Page create expanded"));

    expect(await view.findByRole("button", { name: "Collapse Page composer" })).not.toBeNull();
    expect((view.getByLabelText("Page title") as HTMLInputElement).value).toBe("Keep this draft");

    fireEvent.click(view.getByRole("button", { name: "Collapse Page composer" }));
    fireEvent.click(view.getByText("Open Page create expanded"));

    expect(await view.findByRole("button", { name: "Collapse Page composer" })).not.toBeNull();
  });

  test("supports create-more keyboard submission and resets only the writing fields", async () => {
    commandState.create.mockResolvedValue({
      status: "created",
      page: createPage("created-page", "First Page"),
    });
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    const title = await view.findByLabelText("Page title");
    const description = view.getByLabelText("Page description");
    fireEvent.change(title, { target: { value: "First Page" } });
    fireEvent.change(description, { target: { value: "Body" } });

    await act(async () => {
      fireEvent.keyDown(description, {
        key: "Enter",
        metaKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(commandState.create).toHaveBeenCalledOnce());
    expect(view.getByRole("dialog")).toBeTruthy();
    expect((title as HTMLInputElement).value).toBe("");
    expect((view.getByLabelText("Page description") as HTMLTextAreaElement).value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  test("restores a dirty draft into a fresh collaborative document", async () => {
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    const title = await view.findByLabelText("Page title");
    const description = view.getByLabelText("Page description");
    const firstDocumentId = description.getAttribute("data-document-id");
    fireEvent.change(title, { target: { value: "Recover me" } });
    fireEvent.change(description, { target: { value: "Recovered body" } });
    fireEvent.click(view.getByRole("button", { name: "Close Page creation" }));

    const recoveryToast = await view.findByRole("alert");
    expect(recoveryToast.textContent).toContain("Page draft closed");
    fireEvent.click(view.getByRole("button", { name: "Restore" }));
    expect(await view.findByRole("dialog")).toBeTruthy();
    expect((view.getByLabelText("Page title") as HTMLInputElement).value).toBe("Recover me");
    expect((view.getByLabelText("Page description") as HTMLTextAreaElement).value).toBe(
      "Recovered body",
    );
    expect(view.getByLabelText("Page description").getAttribute("data-document-id")).not.toBe(
      firstDocumentId,
    );
  });

  test("always closes even when an unexpected draft snapshot cannot be encoded", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderWithMaitai(<TestShell />);

    try {
      fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
      fireEvent.change(await view.findByLabelText("Page title"), {
        target: { value: "Corrupted local draft" },
      });
      const fragment = editorState.latestFragment;
      if (!fragment) throw new Error("Expected the Page description fragment");
      fragment.delete(0, fragment.length);

      fireEvent.click(view.getByRole("button", { name: "Close Page creation" }));

      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
      expect(await view.findByText("Page draft couldn’t be preserved.")).toBeTruthy();
      expect(consoleError).toHaveBeenCalledWith("[page-create:draft-capture]", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  test("offers searchable Status choices and consumes Escape before the dialog", async () => {
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    await view.findByRole("dialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Page title" })),
    );
    const statusTrigger = view.getByRole("button", { name: "Status" });
    fireEvent.click(statusTrigger);
    const search = await view.findByRole("combobox", { name: "Search Status options" });
    expect(search.getAttribute("placeholder")).toBe("Change status…");
    expect(view.getByRole("option", { name: "Plan" }).getAttribute("aria-selected")).toBe("true");
    const dialogForm = view
      .getByRole("heading", { name: "New page" })
      .closest('[role="dialog"]')
      ?.querySelector("form");
    expect(dialogForm?.contains(search)).toBe(false);

    await act(async () => {
      fireEvent.change(search, { target: { value: "bui" } });
      await Promise.resolve();
    });
    expect((search as HTMLInputElement).value).toBe("bui");
    expect(view.getByRole("option", { name: "Build" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Triage" })).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(view.queryByRole("combobox", { name: "Search Status options" })).toBeNull(),
    );
    expect(view.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("keeps the dialog open when a body-portalled property menu is used", async () => {
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    await view.findByRole("dialog");

    fireEvent.click(view.getByRole("button", { name: "Status" }));
    const buildOption = await view.findByRole("option", { name: "Build" });
    await act(async () => {
      fireEvent.pointerDown(buildOption, {
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
      });
      fireEvent.pointerUp(buildOption, {
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
      });
      fireEvent.click(buildOption);
      await Promise.resolve();
    });

    expect(view.getByRole("dialog")).toBeTruthy();
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Status" }).textContent).toContain("Build"),
    );
  });

  test("uses searchable semantic pickers for Priority and Estimate", async () => {
    const view = renderWithMaitai(<TestShell />);
    fireEvent.click(view.getByRole("button", { name: "Open Page create" }));
    await view.findByRole("dialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Page title" })),
    );
    expect(view.getByRole("button", { name: "Priority" }).textContent).toContain("Priority");
    expect(view.getByRole("button", { name: "Estimate" }).textContent).toContain("Estimate");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Priority" }));
      await Promise.resolve();
    });
    const prioritySearch = await view.findByRole("combobox", {
      name: "Search Priority options",
    });
    expect(prioritySearch.getAttribute("placeholder")).toBe("Change priority…");
    expect(view.getByRole("option", { name: "P3 - Low" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "P4 - Later" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "P1 - High" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Priority" }).textContent).toContain("P1 - High");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Priority" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "No priority" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Priority" }).textContent).toContain("Priority");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Estimate" }));
      await Promise.resolve();
    });
    const estimateSearch = await view.findByRole("combobox", {
      name: "Search Estimate options",
    });
    expect(estimateSearch.getAttribute("placeholder")).toBe("Change estimate…");
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "M" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Estimate" }).textContent).toContain("M");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Estimate" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "No estimate" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Estimate" }).textContent).toContain("Estimate");
    expect(view.getByRole("dialog")).toBeTruthy();
  });
});
