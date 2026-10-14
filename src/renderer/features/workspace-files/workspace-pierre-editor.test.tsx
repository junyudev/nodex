import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { forwardRef, useImperativeHandle } from "react";
import { settleAsyncRender } from "../../test/dom";
import { installAsyncRequestAnimationFrame } from "../../test/browser-globals";
import { WorkspacePierreEditor } from "./workspace-pierre-editor";

const { editor, codeViewHandle, typography, captureCodeViewOptions } = vi.hoisted(() => {
  const editor = {
    setSelections: vi.fn(),
  };
  return {
    editor,
    typography: { codeFontSize: 12 },
    captureCodeViewOptions: vi.fn(),
    codeViewHandle: {
      getEditor: vi.fn(() => editor),
      scrollTo: vi.fn(),
      setSelectedLines: vi.fn(),
    },
  };
});

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "dark" }),
}));

vi.mock("@/lib/use-code-font-size", () => ({
  useCodeFontSize: () => typography,
}));

vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: { children: React.ReactNode }) => children,
  CodeView: forwardRef(
    (
      {
        items,
        options,
        onItemEditChange,
      }: {
        items: Array<{ file: { contents: string; name: string }; edit: boolean }>;
        options: { itemMetrics: { lineHeight: number } };
        onItemEditChange: (item: unknown, file: { contents: string; name: string }) => void;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => codeViewHandle);
      captureCodeViewOptions(options);
      return (
        <button
          type="button"
          data-testid="editable-pierre-file"
          data-editable={items[0]?.edit}
          onClick={() =>
            onItemEditChange(items[0], {
              name: items[0]?.file.name ?? "file",
              contents: "edited",
            })
          }
        >
          {items[0]?.file.contents}
        </button>
      );
    },
  ),
}));

beforeEach(() => {
  installAsyncRequestAnimationFrame();
  editor.setSelections.mockClear();
  codeViewHandle.getEditor.mockClear();
  codeViewHandle.scrollTo.mockClear();
  codeViewHandle.setSelectedLines.mockClear();
  captureCodeViewOptions.mockClear();
  typography.codeFontSize = 12;
});

describe("WorkspacePierreEditor", () => {
  test("updates the virtual row and caret grid when the code preference changes", () => {
    const component = () => (
      <WorkspacePierreEditor
        value="original"
        filename="index.ts"
        language="typescript"
        sourceIdentity="/repo/index.ts"
        documentVersion={0}
        ariaLabel="Editor"
        onChange={() => undefined}
      />
    );
    const view = render(component());
    expect(captureCodeViewOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemMetrics: { lineHeight: 22, spacing: 0 } }),
    );
    typography.codeFontSize = 15;
    view.rerender(component());
    expect(captureCodeViewOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemMetrics: { lineHeight: 27, spacing: 0 } }),
    );
  });
  test("renders an editable Pierre item and delivers exact document changes", () => {
    const onChange = vi.fn();
    const view = render(
      <WorkspacePierreEditor
        value="original"
        filename="index.ts"
        language="typescript"
        sourceIdentity="/repo/index.ts"
        documentVersion={0}
        ariaLabel="Editor"
        onChange={onChange}
      />,
    );

    const editor = view.getByTestId("editable-pierre-file");
    expect(editor.getAttribute("data-editable")).toBe("true");
    editor.click();
    expect(onChange).toHaveBeenCalledWith("edited");
  });

  test("reveals and selects a line range in the editable surface", async () => {
    render(
      <WorkspacePierreEditor
        value={"first\nsecond\nthird\nfourth"}
        filename="index.ts"
        language="typescript"
        sourceIdentity="/repo/index.ts"
        documentVersion={0}
        ariaLabel="Editor"
        revealLocation={{ line: 2, column: 3, endLine: 4, endColumn: 8 }}
        onChange={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(editor.setSelections).toHaveBeenCalledWith([
      {
        start: { line: 1, character: 2 },
        end: { line: 3, character: 7 },
        direction: "forward",
      },
    ]);
    expect(codeViewHandle.setSelectedLines).toHaveBeenCalledWith(null);
    expect(codeViewHandle.scrollTo).toHaveBeenCalledWith({
      type: "range",
      id: "/repo/index.ts",
      range: { start: 2, end: 4 },
      align: "center",
      behavior: "instant",
    });
  });
});
