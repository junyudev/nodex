import { describe, expect, test } from "bun:test";
import { createCardToggleBlockSpec } from "./card-toggle-block";

function createBlock(meta: string) {
  return {
    id: "block-1",
    children: [],
    props: {
      backgroundColor: "default",
      textColor: "default",
      textAlignment: "left",
      cardId: "card-1",
      meta,
      snapshot: "",
      sourceProjectId: "",
      sourceStatus: "",
      sourceStatusName: "",
      projectionOwnerId: "",
      projectionKind: "",
      projectionSourceProjectId: "",
      projectionCardId: "",
    },
  };
}

function createEditor(block: ReturnType<typeof createBlock>) {
  return {
    dictionary: {
      toggle_blocks: {
        add_block_button: "Add block",
      },
    },
    isEditable: true,
    getBlock: () => block,
    onChange: () => () => {},
    updateBlock: () => block,
    setTextCursorPosition: () => {},
    focus: () => {},
    transact: <T>(callback: () => T) => callback(),
  };
}

describe("card toggle block", () => {
  test("renders properties inline with the editable title content", () => {
    const spec = createCardToggleBlockSpec();
    const block = createBlock("[P1] [In Progress]");
    const render = spec.implementation.render as (
      this: { blockContentDOMAttributes: Record<string, string> },
      block: unknown,
      editor: unknown,
    ) => {
      dom: HTMLElement;
      contentDOM?: HTMLElement;
    };
    const result = render.call({ blockContentDOMAttributes: {} }, block, createEditor(block));
    const wrapper = result.dom.querySelector(".bn-toggle-wrapper");

    expect(wrapper).not.toBeNull();
    if (wrapper === null) return;

    const row = wrapper.children.item(1);
    expect(row).not.toBeNull();
    if (row === null) return;

    expect(row.classList.contains("flex")).toBeFalse();

    const meta = row.firstElementChild;
    expect(meta?.tagName).toBe("SPAN");
    if (meta === null) return;

    expect(meta.classList.contains("inline-flex")).toBeTrue();
    expect(result.contentDOM?.tagName).toBe("SPAN");
    expect(row.lastElementChild === result.contentDOM).toBeTrue();
  });

  test("keeps exported meta text inline with the exported title container", () => {
    const spec = createCardToggleBlockSpec();
    const block = createBlock("[P1]");
    const toExternalHTML = spec.implementation.toExternalHTML as (
      this: { blockContentDOMAttributes: Record<string, string> },
      block: unknown,
      editor?: unknown,
      options?: unknown,
    ) => {
      dom: HTMLElement;
      contentDOM?: HTMLElement;
    };
    const result = toExternalHTML.call({ blockContentDOMAttributes: {} }, block);
    const paragraph = result.dom.querySelector("p");

    expect(paragraph?.tagName).toBe("P");
    if (paragraph === null) return;

    expect(result.contentDOM?.tagName).toBe("SPAN");
    expect(paragraph.lastElementChild === result.contentDOM).toBeTrue();
    expect(paragraph.firstElementChild?.tagName).toBe("SPAN");
  });
});
