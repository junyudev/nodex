import { describe, expect, test } from "vite-plus/test";
import {
  applyCommandKeybindingUpdate,
  createCommandKeymapState,
  formatCommandShortcutLabel,
} from "../../../../shared/command-keybindings";
import type { RuntimePlatform } from "../../../../shared/runtime-platform";
import { resolveNfmChatSendShortcut } from "./nfm-chat-send-shortcuts";
import { resolveSendBlockSelection } from "./send-block-selection";

describe("nfm chat send shortcuts", () => {
  const chord = (overrides: Partial<Parameters<typeof resolveNfmChatSendShortcut>[0]>) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  });

  describe("Page editor chat shortcuts", () => {
    test.each<RuntimePlatform>(["macOS", "windows", "linux"])(
      "%s defaults match and display the platform modifiers",
      (platform) => {
        const state = createCommandKeymapState({}, platform);
        const modifier = platform === "macOS" ? { metaKey: true } : { ctrlKey: true };
        expect(resolveNfmChatSendShortcut(chord({ ...modifier, shiftKey: true }), state)).toBe(
          "send",
        );
        expect(resolveNfmChatSendShortcut(chord({ ...modifier, altKey: true }), state)).toBe(
          "add-to-composer",
        );
        expect(formatCommandShortcutLabel(state, "pageEditorSendToChat")).toBe(
          platform === "macOS" ? "⇧⌘⏎" : "Ctrl+Shift+Enter",
        );
        expect(formatCommandShortcutLabel(state, "pageEditorAddToComposer")).toBe(
          platform === "macOS" ? "⌥⌘⏎" : "Ctrl+Alt+Enter",
        );
      },
    );

    test("uses edited bindings and leaves explicitly unassigned commands alone", () => {
      const overrides = applyCommandKeybindingUpdate(
        {},
        "pageEditorSendToChat",
        {
          type: "set",
          keybinding: { key: "Ctrl+Alt+Y" },
        },
        "linux",
      );
      const state = createCommandKeymapState(
        { ...overrides, pageEditorAddToComposer: [] },
        "linux",
      );
      expect(
        resolveNfmChatSendShortcut(chord({ key: "y", ctrlKey: true, altKey: true }), state),
      ).toBe("send");
      expect(formatCommandShortcutLabel(state, "pageEditorSendToChat")).toBe("Ctrl+Alt+Y");
      expect(
        resolveNfmChatSendShortcut(chord({ ctrlKey: true, shiftKey: true }), state),
      ).toBeNull();
      expect(resolveNfmChatSendShortcut(chord({ ctrlKey: true, altKey: true }), state)).toBeNull();
      expect(formatCommandShortcutLabel(state, "pageEditorAddToComposer")).toBeUndefined();
    });

    test("leaves block activation, other keys, and IME composition alone", () => {
      const state = createCommandKeymapState({}, "macOS");
      for (const event of [
        chord({ metaKey: true }),
        chord({ ctrlKey: true, shiftKey: true }),
        chord({ metaKey: true, shiftKey: true, altKey: true }),
        chord({ key: "a", metaKey: true, shiftKey: true }),
        chord({ metaKey: true, shiftKey: true, isComposing: true }),
        chord({ metaKey: true, shiftKey: true, keyCode: 229 }),
      ])
        expect(resolveNfmChatSendShortcut(event, state)).toBeNull();
    });
  });
});

describe("send block selection", () => {
  interface TestBlock {
    id: string;
    type: string;
    children?: TestBlock[];
  }

  function createEditor(blocks: TestBlock[]) {
    const blockById = new Map<string, TestBlock>();
    const parentById = new Map<string, TestBlock>();

    const walk = (nodes: TestBlock[], parent?: TestBlock) => {
      for (const node of nodes) {
        blockById.set(node.id, node);
        if (parent) parentById.set(node.id, parent);
        walk(node.children ?? [], node);
      }
    };

    walk(blocks);

    const pmSelection: {
      nodes?: Array<{ attrs?: { id?: string } }>;
    } = {};

    return {
      document: blocks,
      prosemirrorView: {
        state: {
          selection: pmSelection,
        },
      },
      getSelection: () => undefined,
      getBlock: (id: string) => blockById.get(id),
      getParentBlock: (id: string) => parentById.get(id),
      removeBlocks: () => {},
      replaceBlocks: () => {},
      setSelectedIds(ids: string[]) {
        pmSelection.nodes = ids.map((id) => ({ attrs: { id } }));
      },
    };
  }

  function createContainer(): HTMLElement {
    return {
      querySelector: () => null,
    } as unknown as HTMLElement;
  }

  describe("resolveSendBlockSelection", () => {
    test("uses current block selection when available", () => {
      const editor = createEditor([
        { id: "a", type: "paragraph" },
        { id: "b", type: "paragraph" },
      ]);
      editor.setSelectedIds(["a", "b"]);

      const result = resolveSendBlockSelection(editor, createContainer(), "fallback");

      expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["a", "b"]));
      expect(JSON.stringify(result.blocks.map((block) => block.id))).toBe(
        JSON.stringify(["a", "b"]),
      );
    });

    test("falls back to drag-handle block when no selection exists", () => {
      const editor = createEditor([{ id: "fallback", type: "paragraph" }]);

      const result = resolveSendBlockSelection(editor, createContainer(), "fallback");

      expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["fallback"]));
    });

    test("keeps only top-level selection when parent and child are both selected", () => {
      const editor = createEditor([
        {
          id: "parent",
          type: "toggleListItem",
          children: [{ id: "child", type: "paragraph" }],
        },
      ]);
      editor.setSelectedIds(["parent", "child"]);

      const result = resolveSendBlockSelection(editor, createContainer(), "fallback");

      expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["parent"]));
    });

    test("uses the retained menu target even if the live editor selection later changes", () => {
      const editor = createEditor([
        { id: "retained-a", type: "paragraph" },
        { id: "retained-b", type: "paragraph" },
        { id: "later", type: "paragraph" },
      ]);
      editor.setSelectedIds(["later"]);

      const result = resolveSendBlockSelection(editor, createContainer(), "later", [
        "retained-a",
        "retained-b",
      ]);

      expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["retained-a", "retained-b"]));
    });

    test("returns empty when fallback block id does not exist", () => {
      const editor = createEditor([{ id: "one", type: "paragraph" }]);

      const result = resolveSendBlockSelection(editor, createContainer(), "missing");

      expect(result.blockIds.length).toBe(0);
      expect(result.blocks.length).toBe(0);
    });
  });
});
