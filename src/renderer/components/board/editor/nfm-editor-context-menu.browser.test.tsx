import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { captureNfmPasteTarget, createNfmPasteTargetPlugin } from "./nfm-paste-target";
import { readNativePastePayload } from "./nfm-paste-event";
import { NfmEditorContextMenuPreview, runNfmEditorContextCommand } from "./nfm-editor-context-menu";

afterEach(() => {
  cleanup();
});

describe("nfm editor context menu", () => {
  test("does not retry a failed native read against a newer browser clipboard", async () => {
    const originalApi = window.api;
    const originalClipboard = navigator.clipboard;
    const calls: string[] = [];
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        readPasteClipboard: async () => {
          throw new Error("inconsistent_read");
        },
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          calls.push("later read");
          return "new copy";
        },
      },
    });
    try {
      expect(
        await runNfmEditorContextCommand(
          {
            pasteText: () => {
              calls.push("paste");
              return true;
            },
          },
          "paste",
          undefined,
        ),
      ).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      Object.defineProperty(window, "api", { configurable: true, value: originalApi });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test("pastes delayed native text at the mapped original range, not the later caret", async () => {
    const originalApi = window.api;
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
        text: {},
      },
    });
    const doc = schema.node(
      "doc",
      null,
      schema.node("paragraph", null, schema.text("hello world")),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 2, 4),
        plugins: [createNfmPasteTargetPlugin()],
      }),
    });
    let resolveRead!: (value: { text: string }) => void;
    const read = new Promise<{ text: string }>((resolve) => {
      resolveRead = resolve;
    });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { readPasteClipboard: () => read },
    });
    try {
      const paste = runNfmEditorContextCommand({ prosemirrorView: view }, "paste", undefined, () =>
        captureNfmPasteTarget(view),
      );
      view.dispatch(view.state.tr.insertText("prefix", 1));
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      resolveRead({ text: "PASTE" });
      expect(await paste).toBe(true);
      expect(view.state.doc.textContent).toBe("prefixhPASTElo world");
    } finally {
      view.destroy();
      host.remove();
      Object.defineProperty(window, "api", { configurable: true, value: originalApi });
    }
  });
  test("renders cut, copy, and paste actions with shortcuts", () => {
    const view = render(
      <NfmEditorContextMenuPreview
        selectionEmpty={false}
        editable={true}
        onCommand={() => undefined}
      />,
    );

    expect(Boolean(view.baseElement.textContent?.includes("Cut"))).toBe(true);
    expect(Boolean(view.baseElement.textContent?.includes("⌘X"))).toBe(true);
    expect(Boolean(view.baseElement.textContent?.includes("Copy"))).toBe(true);
    expect(Boolean(view.baseElement.textContent?.includes("⌘C"))).toBe(true);
    expect(Boolean(view.baseElement.textContent?.includes("Paste"))).toBe(true);
    expect(Boolean(view.baseElement.textContent?.includes("⌘V"))).toBe(true);
  });

  test("emits the selected editing command", async () => {
    let command = "";
    const view = render(
      <NfmEditorContextMenuPreview
        selectionEmpty={false}
        editable={true}
        onCommand={(nextCommand) => {
          command = nextCommand;
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByText("Copy"));
    });

    expect(command).toBe("copy");
  });

  test("uses document editing commands after restoring editor focus", async () => {
    const calls: string[] = [];
    const editor = {
      prosemirrorView: {
        focus: () => calls.push("focus"),
      },
    };

    const handled = await runNfmEditorContextCommand(editor, "cut", (command) => {
      calls.push(command);
      return true;
    });

    expect(handled).toBe(true);
    expect(calls.join(",")).toBe("focus,cut");
  });

  test("pastes clipboard text through the editor when the menu paste action is selected", async () => {
    const originalApi = window.api;
    const originalClipboard = navigator.clipboard;
    const calls: string[] = [];
    const editor = {
      pasteText: (text: string) => {
        calls.push(`paste:${text}`);
        return true;
      },
      prosemirrorView: {
        focus: () => calls.push("focus"),
      },
    };

    Object.defineProperty(window, "api", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => "from clipboard",
      },
    });

    try {
      const handled = await runNfmEditorContextCommand(editor, "paste", (command) => {
        calls.push(command);
        return true;
      });

      expect(handled).toBe(true);
      expect(calls.join(",")).toBe("focus,paste:from clipboard");
    } finally {
      Object.defineProperty(window, "api", {
        configurable: true,
        value: originalApi,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test("prefers the native Electron clipboard bridge for menu paste", async () => {
    const originalApi = window.api;
    const originalClipboard = navigator.clipboard;
    const calls: string[] = [];
    const editor = {
      pasteText: (text: string) => {
        calls.push(`paste:${text}`);
        return true;
      },
      prosemirrorView: {
        focus: () => calls.push("focus"),
      },
    };

    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        readPasteClipboard: async () => ({ text: "native clipboard" }),
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          calls.push("browser-read");
          return "browser clipboard";
        },
      },
    });

    try {
      const handled = await runNfmEditorContextCommand(editor, "paste", () => true);

      expect(handled).toBe(true);
      expect(calls.join(",")).toBe("focus,paste:native clipboard");
    } finally {
      Object.defineProperty(window, "api", {
        configurable: true,
        value: originalApi,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test("preserves a structural envelope through context-menu synthetic paste", async () => {
    const originalApi = window.api;
    const target = document.createElement("div");
    document.body.append(target);
    let pastedHtml = "";
    let pastedItems: unknown;
    target.addEventListener("paste", (event) => {
      pastedHtml = (event as ClipboardEvent).clipboardData?.getData("text/html") ?? "";
      pastedItems = readNativePastePayload(event as ClipboardEvent)?.items;
      event.preventDefault();
    });
    const structuralEnvelope = {
      version: 1 as const,
      profileId: "profile",
      libraryId: "library",
      storeEpoch: "epoch",
      bundleId: "bundle",
      capability: "a".repeat(64),
      manifestHash: "b".repeat(64),
      actionHint: "copy" as const,
    };

    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        readPasteClipboard: async () => ({
          html: '<div data-content-type="page">Subpage</div>',
          text: "Subpage",
          structuralEnvelope,
          items: [{ path: "/synthetic/folder", kind: "folder", name: "folder" }],
        }),
      },
    });

    try {
      const handled = await runNfmEditorContextCommand(
        {
          prosemirrorView: {
            dom: target,
            focus: () => undefined,
          },
        },
        "paste",
        () => false,
      );

      expect(handled).toBe(true);
      expect(pastedHtml).toContain('name="nodex-clipboard-envelope-v1"');
      expect(pastedItems).toEqual([{ path: "/synthetic/folder", kind: "folder", name: "folder" }]);
      expect(pastedHtml).toContain('data-nodex-structural-fallback="1"');
      expect(pastedHtml).not.toContain('data-content-type="page"');
    } finally {
      target.remove();
      Object.defineProperty(window, "api", {
        configurable: true,
        value: originalApi,
      });
    }
  });

  test("freezes and releases the paste target around the asynchronous clipboard read", async () => {
    const calls: string[] = [];
    const editor = {
      pasteText: (text: string) => {
        calls.push(`paste:${text}`);
        return true;
      },
      prosemirrorView: {
        focus: () => calls.push("focus"),
      },
    };

    const handled = await runNfmEditorContextCommand(
      editor,
      "paste",
      () => {
        calls.push("exec");
        return true;
      },
      () => {
        calls.push("prepare");
        return {
          restore: () => true,
          release: () => {
            calls.push("release");
          },
        };
      },
    );

    expect(handled).toBe(false);
    expect(calls.join(",")).toBe("focus,prepare,release");
  });
});
