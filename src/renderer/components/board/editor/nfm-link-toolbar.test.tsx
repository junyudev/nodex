import { describe, expect, vi, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender } from "../../../test/dom";

const deleteLink = vi.fn();
const editLink = () => {};
const retainedSelectionPresentations: string[] = [];
const formattingToolbarStore = {
  setState: () => {},
};
let createLinkButtonState:
  | {
      url?: string;
      text: string;
      range: {
        from: number;
        to: number;
      };
    }
  | undefined;

vi.mock("./nfm-link-toolbar-deps", () => ({
  useFileLinkOpener: () => ({
    opener: () => undefined,
  }),
  writeTextToClipboard: async () => true,
  openNfmResolvedLinkAction: async () => true,
  resolveNfmLinkAction: () => ({
    kind: "web-url",
    href: "https://community.openai.com/t/example",
    url: "https://community.openai.com/t/example",
  }),
  resolveNfmLinkTooltipLabel: () => null,
  useBlockNoteEditor: () => ({
    domElement: null,
    isEditable: true,
  }),
  useComponentsContext: () => null,
  useDictionary: () => ({
    formatting_toolbar: {
      link: {
        tooltip: "Add link",
        secondary_tooltip: "Ctrl+K",
      },
    },
    generic: {
      ctrl_shortcut: "Ctrl",
    },
    link_toolbar: {
      open: {
        tooltip: "Open in new tab",
      },
      edit: {
        tooltip: "Edit",
      },
      form: {
        url_placeholder: "Paste or type a link",
        title_placeholder: "Link title",
      },
      delete: {
        tooltip: "Remove link",
      },
    },
  }),
  useEditorState: () => createLinkButtonState,
  useExtension: () => ({
    deleteLink,
    editLink,
    store: formattingToolbarStore,
  }),
  NfmCompactLinkToolbar: ({
    editLabel,
    onClearLink,
    onEditLink,
  }: {
    editLabel: string;
    onClearLink: () => void;
    onEditLink: () => void;
  }) => (
    <div data-testid="nfm-compact-link-toolbar">
      <button type="button" onClick={onEditLink}>
        {editLabel}
      </button>
      <button type="button" onClick={onClearLink}>
        Clear
      </button>
    </div>
  ),
  NfmCreateLinkDialogSurface: () => <div data-testid="nfm-create-link-dialog" />,
  NfmLinkEditToolbarSurface: () => <div data-testid="nfm-link-edit-toolbar" />,
}));

vi.mock("./nfm-retained-selection-presentation", () => ({
  useNfmRetainedSelectionPresentation: (presentation: string) => {
    retainedSelectionPresentations.push(presentation);
  },
}));

describe("NfmLinkToolbar", () => {
  test("does not crash when the create-link button becomes unavailable for a node selection", async () => {
    createLinkButtonState = {
      url: "https://example.com",
      text: "Example",
      range: { from: 1, to: 8 },
    };

    const { NfmCreateLinkButton } = await import("./nfm-link-toolbar");

    const view = render(
      <NodexTooltipProvider>
        <NfmCreateLinkButton />
      </NodexTooltipProvider>,
    );

    expect(Boolean(view.getByRole("button", { name: "Add link" }))).toBe(true);

    createLinkButtonState = undefined;

    await act(async () => {
      view.rerender(
        <NodexTooltipProvider>
          <NfmCreateLinkButton />
        </NodexTooltipProvider>,
      );
      await settleAsyncRender();
    });

    expect(view.queryByRole("button", { name: "Add link" }) === null).toBe(true);
  });

  test("opens the create-link dialog from a custom render trigger", async () => {
    retainedSelectionPresentations.length = 0;
    createLinkButtonState = {
      text: "Example",
      range: { from: 1, to: 8 },
    };

    const { NfmCreateLinkButton } = await import("./nfm-link-toolbar");

    const view = render(
      <NodexTooltipProvider>
        <NfmCreateLinkButton
          renderTrigger={(props) => (
            <button
              type="button"
              aria-label={props.ariaLabel}
              onMouseDown={props.onMouseDown}
              onClick={props.onClick}
            >
              Custom link
            </button>
          )}
        />
      </NodexTooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Add link" }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByTestId("nfm-create-link-dialog"))).toBe(true);
    expect(retainedSelectionPresentations[retainedSelectionPresentations.length - 1]).toBe(
      "inline",
    );
  });

  test("keeps the edit toolbar open for the current link after clicking edit", async () => {
    createLinkButtonState = undefined;
    const { NfmLinkToolbar } = await import("./nfm-link-toolbar");

    const view = render(
      <NodexTooltipProvider>
        <NfmLinkToolbar
          url="https://community.openai.com/t/example"
          text="OpenAI forum note"
          range={{ from: 4, to: 9 }}
          setToolbarOpen={() => {}}
          setToolbarPositionFrozen={() => {}}
          projectWorkspacePath={null}
        />
      </NodexTooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit" }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByTestId("nfm-link-edit-toolbar"))).toBe(true);
    expect(view.queryByTestId("nfm-compact-link-toolbar") === null).toBe(true);
  });

  test("clears the current link from the compact toolbar", async () => {
    deleteLink.mockClear();
    const setToolbarOpen = vi.fn();
    const { NfmLinkToolbar } = await import("./nfm-link-toolbar");

    const view = render(
      <NodexTooltipProvider>
        <NfmLinkToolbar
          url="https://community.openai.com/t/example"
          text="OpenAI forum note"
          range={{ from: 4, to: 9 }}
          setToolbarOpen={setToolbarOpen}
          setToolbarPositionFrozen={() => {}}
          projectWorkspacePath={null}
        />
      </NodexTooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear" }));
      await settleAsyncRender();
    });

    expect(deleteLink).toHaveBeenCalledWith(4);
    expect(setToolbarOpen).toHaveBeenCalledWith(false);
  });

  test("keeps the edit toolbar mounted across parent rerenders when the wrapper component identity is stable", async () => {
    createLinkButtonState = undefined;
    const { NfmLinkToolbar } = await import("./nfm-link-toolbar");

    function ToolbarComponent(toolbarProps: {
      url: string;
      text: string;
      range: { from: number; to: number };
      setToolbarOpen: () => void;
      setToolbarPositionFrozen: () => void;
    }) {
      return <NfmLinkToolbar {...toolbarProps} projectWorkspacePath={null} />;
    }

    function Host() {
      const [tick, setTick] = useState(0);

      return (
        <NodexTooltipProvider>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            Rerender {tick}
          </button>
          <ToolbarComponent
            url="https://community.openai.com/t/example"
            text="OpenAI forum note"
            range={{ from: 4, to: 9 }}
            setToolbarOpen={() => {}}
            setToolbarPositionFrozen={() => {}}
          />
        </NodexTooltipProvider>
      );
    }

    const view = render(<Host />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit" }));
      await settleAsyncRender();
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Rerender/ }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByTestId("nfm-link-edit-toolbar"))).toBe(true);
    expect(view.queryByTestId("nfm-compact-link-toolbar") === null).toBe(true);
  });
});
