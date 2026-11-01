import { describe, expect, test, vi } from "vite-plus/test";
import {
  buildBrowserContextMenuTemplate,
  type BrowserContextMenuParams,
} from "./browser-context-menu";

function makeParams(patch: Partial<BrowserContextMenuParams> = {}): BrowserContextMenuParams {
  return {
    x: 12,
    y: 24,
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    formControlType: "none",
    editFlags: {
      canCopy: false,
      canCut: false,
      canPaste: false,
    },
    ...patch,
  };
}

function makeActions() {
  return {
    annotate: vi.fn(),
    attachImage: vi.fn(),
    back: vi.fn(),
    copyLink: vi.fn(),
    forward: vi.fn(),
    inspect: vi.fn(),
    openExternal: vi.fn(),
    openLink: vi.fn(),
    openWindow: vi.fn(),
    reload: vi.fn(),
  };
}

describe("buildBrowserContextMenuTemplate", () => {
  test("matches the Browser annotation and plain-page navigation order", () => {
    const actions = makeActions();
    const template = buildBrowserContextMenuTemplate({
      actions,
      canAnnotate: true,
      canGoBack: false,
      canGoForward: true,
      canReload: true,
      params: makeParams(),
    });

    expect(template.map((item) => (item.type === "separator" ? "separator" : item.label))).toEqual([
      "Quick annotate",
      "Annotate",
      "separator",
      "Back",
      "Forward",
      "Reload",
      "separator",
      "Inspect",
    ]);
    expect(template[3]?.enabled).toBe(false);
    expect(template[4]?.enabled).toBe(true);

    template[0]?.click?.({} as never, undefined, {} as never);
    template[7]?.click?.({} as never, undefined, {} as never);
    expect(actions.annotate).toHaveBeenCalledWith("quick-annotate");
    expect(actions.inspect).toHaveBeenCalledWith({ x: 12, y: 24 });
  });

  test("offers bounded image, link, and editable actions only for their context", () => {
    const actions = makeActions();
    const imageTemplate = buildBrowserContextMenuTemplate({
      actions,
      canAnnotate: false,
      canGoBack: false,
      canGoForward: false,
      canReload: true,
      params: makeParams({
        srcURL: "https://example.test/image.png",
        mediaType: "image",
        hasImageContents: true,
      }),
    });
    expect(imageTemplate.map((item) => item.label)).toEqual([
      "Attach image to chat",
      undefined,
      "Inspect",
    ]);

    const editableTemplate = buildBrowserContextMenuTemplate({
      actions,
      canAnnotate: false,
      canGoBack: false,
      canGoForward: false,
      canReload: true,
      params: makeParams({
        linkURL: "https://example.test/next",
        isEditable: true,
        formControlType: "input-text",
        editFlags: {
          canCopy: true,
          canCut: true,
          canPaste: false,
        },
      }),
    });
    expect(
      editableTemplate.map((item) =>
        item.type === "separator" ? "separator" : (item.role ?? item.label),
      ),
    ).toEqual([
      "Open in new tab",
      "Open in new window",
      "Open in external browser",
      "separator",
      "Copy link address",
      "cut",
      "copy",
      "paste",
      "separator",
      "Inspect",
    ]);
    expect(editableTemplate[7]?.enabled).toBe(false);
  });

  test("offers HTTP links with credentials in all link destinations", () => {
    const template = buildBrowserContextMenuTemplate({
      actions: makeActions(),
      canAnnotate: false,
      canGoBack: false,
      canGoForward: false,
      canReload: true,
      params: makeParams({
        linkURL: "https://user:secret@example.test/private",
      }),
    });

    expect(template.map((item) => item.label).filter(Boolean)).toEqual([
      "Open in new tab",
      "Open in new window",
      "Open in external browser",
      "Copy link address",
      "Inspect",
    ]);
  });
});
