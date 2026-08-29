import { afterEach, describe, expect, test } from "vite-plus/test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NfmEditorContextMenuPreview, runNfmEditorContextCommand } from "./nfm-editor-context-menu";

afterEach(() => {
  cleanup();
});

describe("nfm editor context menu", () => {
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

  test("emits the selected editing command", () => {
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

    fireEvent.click(view.getByText("Copy"));

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
    target.addEventListener("paste", (event) => {
      pastedHtml = (event as ClipboardEvent).clipboardData?.getData("text/html") ?? "";
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
        return () => calls.push("release");
      },
    );

    expect(handled).toBe(false);
    expect(calls.join(",")).toBe("focus,prepare,release");
  });
});
