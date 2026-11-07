import { beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { render } from "../../../test/dom";
import { __resetNodexToastStoreForTests, NodexToastProvider } from "../../ui/toast";

let copyResult: { ok: true } | { ok: false; message: string } = { ok: true };
let focusCalls = 0;

vi.mock("./copy-image-button-deps", () => ({
  useBlockNoteEditor: () => ({
    focus: () => {
      focusCalls += 1;
    },
  }),
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({ label, onClick }: { label: string; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>
          {label}
        </button>
      ),
    },
  }),
  useDictionary: () => ({
    formatting_toolbar: {},
    generic: {},
    link_toolbar: {},
  }),
  useEditorState: () => ({
    type: "image",
    props: {
      url: "nodex://assets/diagram.png",
    },
  }),
  useExtension: () => ({}),
}));

describe("CopyImageButton", () => {
  beforeEach(() => {
    __resetNodexToastStoreForTests();
  });

  test("restores editor focus after a successful native image copy", async () => {
    copyResult = { ok: true };
    focusCalls = 0;

    const { CopyImageButton } = await import("./copy-image-button");
    const view = render(
      <NodexToastProvider>
        <CopyImageButton copyImageToClipboardImpl={async () => copyResult} />
      </NodexToastProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy image" }));
      await Promise.resolve();
    });

    expect(await view.findByText("Copied image to clipboard.")).toBeTruthy();
    expect(focusCalls).toBe(1);
  });

  test("shows a global danger toast when native image copy fails", async () => {
    copyResult = { ok: false, message: "Could not load the image file." };
    focusCalls = 0;

    const { CopyImageButton } = await import("./copy-image-button");
    const view = render(
      <NodexToastProvider>
        <CopyImageButton copyImageToClipboardImpl={async () => copyResult} />
      </NodexToastProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy image" }));
      await Promise.resolve();
    });

    expect(await view.findByText("Could not load the image file.")).toBeTruthy();
    expect(focusCalls).toBe(0);
  });
});
