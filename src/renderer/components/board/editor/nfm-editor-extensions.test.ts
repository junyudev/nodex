import { describe, expect, test, vi } from "vite-plus/test";

import {
  attachNodexClipboardEnvelope,
  attachNodexClipboardFragment,
  attachNodexClipboardWriteClaim,
  attachNodexStructuralClipboardWriteClaim,
  encodeNodexStructuralClipboardDescriptor,
  inspectNodexClipboardHtml,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../../../../shared/clipboard-paste";
import { createNfmEditorExtensions, createNfmPasteHandler } from "./nfm-editor-extensions";
import { readMarkdown, writeMarkdown, type MarkdownBlock } from "../../../../shared/nodex-markdown";

describe("markdown editor extensions", () => {
  const writeClaim = "0199134e-cbb0-7000-8000-000000000006";
  test("keeps Code Block paste literal even when the clipboard carries a structural claim", () => {
    const onStructuralClaimPaste = vi.fn(() => true);
    const pasteHTML = vi.fn();
    const defaultPasteHandler = vi.fn(() => true);
    const codePosition = { parent: { type: { spec: { code: true } } } };
    const html = attachNodexStructuralClipboardWriteClaim("<p>Literal content</p>", writeClaim);
    const handler = createNfmPasteHandler({ onStructuralClaimPaste });
    expect(
      handler({
        event: {
          preventDefault: vi.fn(),
          clipboardData: {
            types: ["text/html", "text/plain"],
            getData: (type: string) => (type === "text/html" ? html : "Literal content"),
          },
        } as unknown as ClipboardEvent,
        editor: {
          prosemirrorView: { state: { selection: { $from: codePosition, $to: codePosition } } },
          pasteHTML,
          tryParseHTMLToBlocks: () => [],
        } as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(defaultPasteHandler).toHaveBeenCalledOnce();
    expect(onStructuralClaimPaste).not.toHaveBeenCalled();
    expect(pasteHTML).not.toHaveBeenCalled();
  });
  test("pastes an ordinary local-path copy immediately without starting structural rendezvous", () => {
    const internal = '<div data-pm-slice="0 0 -1 []"><p>Rich fragment</p></div>';
    const html = attachNodexClipboardWriteClaim(
      attachNodexClipboardFragment("<p>Portable presentation</p>", internal),
      writeClaim,
    );
    const pasteHTML = vi.fn();
    const onStructuralClaimPaste = vi.fn(() => true);
    const defaultPasteHandler = vi.fn();
    const handler = createNfmPasteHandler({ onStructuralClaimPaste });
    expect(
      handler({
        event: {
          clipboardData: {
            types: ["text/html", "text/plain"],
            getData: (type: string) => (type === "text/html" ? html : ""),
          },
        } as unknown as ClipboardEvent,
        editor: { pasteHTML } as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(pasteHTML).toHaveBeenCalledWith(internal, true);
    expect(onStructuralClaimPaste).not.toHaveBeenCalled();
    expect(defaultPasteHandler).not.toHaveBeenCalled();
  });
  test("claims a verified structural sidecar before generic paste parsing", () => {
    const defaultPasteHandler = vi.fn(() => true);
    const onStructuralPaste = vi.fn(() => true);
    const preventDefault = vi.fn();
    const envelope = {
      version: 1 as const,
      profileId: "profile:test",
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      bundleId: "bundle:test",
      capability: "a".repeat(64),
      manifestHash: "b".repeat(64),
      actionHint: "copy" as const,
    };
    const html = attachNodexClipboardEnvelope("<p>Portable fallback</p>", envelope);
    const handler = createNfmPasteHandler({ onStructuralPaste });

    const handled = handler({
      event: {
        preventDefault,
        clipboardData: {
          types: ["text/html", "text/plain"],
          getData: (type: string) => (type === "text/html" ? html : "Portable fallback"),
        },
      } as unknown as ClipboardEvent,
      editor: {} as never,
      defaultPasteHandler,
    });

    expect(handled).toBe(true);
    expect(onStructuralPaste).toHaveBeenCalledWith(envelope);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(defaultPasteHandler).not.toHaveBeenCalled();
  });

  test("queues a paste while its matching structural capture is still pending", () => {
    const onStructuralClaimPaste = vi.fn(() => true);
    const defaultPasteHandler = vi.fn(() => true);
    const preventDefault = vi.fn();
    const html = attachNodexStructuralClipboardWriteClaim("<p>Fallback</p>", writeClaim);
    const descriptor = {
      version: 1 as const,
      phase: "preparing" as const,
      writeClaim,
      actionHint: "cut" as const,
    };
    const handler = createNfmPasteHandler({ onStructuralClaimPaste });

    expect(
      handler({
        event: {
          preventDefault,
          clipboardData: {
            types: [NODEX_STRUCTURAL_CLIPBOARD_MIME, "text/html", "text/plain"],
            getData: (type: string) =>
              type === NODEX_STRUCTURAL_CLIPBOARD_MIME
                ? encodeNodexStructuralClipboardDescriptor(descriptor)
                : type === "text/html"
                  ? html
                  : "Fallback",
          },
        } as unknown as ClipboardEvent,
        editor: {
          tryParseHTMLToBlocks: () => [
            { id: "portable", type: "paragraph", props: {}, content: [], children: [] },
          ],
        } as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(onStructuralClaimPaste).toHaveBeenCalledWith({
      descriptor,
      portableBlocks: [{ id: "portable", type: "paragraph", props: {}, content: [], children: [] }],
    });
    expect(defaultPasteHandler).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  test("does not obtain structural authority from a later clipboard read", () => {
    const defaultPasteHandler = vi.fn(() => true);
    const onStructuralPaste = vi.fn(() => true);
    const preventDefault = vi.fn();
    const envelope = {
      version: 1 as const,
      profileId: "profile:test",
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      bundleId: "bundle:test",
      capability: "a".repeat(64),
      manifestHash: "b".repeat(64),
      actionHint: "copy" as const,
    };
    const eventHtml = inspectNodexClipboardHtml(
      attachNodexClipboardEnvelope("<p>Portable fallback</p>", envelope),
    ).fallbackHtml;
    const handler = createNfmPasteHandler({
      onStructuralPaste,
    });

    expect(
      handler({
        event: {
          preventDefault,
          clipboardData: {
            types: ["text/html", "text/plain"],
            getData: (type: string) => (type === "text/html" ? eventHtml : "Portable fallback"),
          },
        } as unknown as ClipboardEvent,
        editor: {} as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(onStructuralPaste).not.toHaveBeenCalled();
    expect(defaultPasteHandler).toHaveBeenCalledOnce();
  });

  test("removes owner semantics before untrusted HTML reaches BlockNote", () => {
    const defaultPasteHandler = vi.fn(() => true);
    const pasteHTML = vi.fn((html: string) => html);
    const handler = createNfmPasteHandler();

    expect(
      handler({
        event: {
          clipboardData: {
            types: ["text/html", "text/plain"],
            getData: (type: string) =>
              type === "text/html"
                ? '<div data-content-type="page">Untrusted Page</div>'
                : "Untrusted Page",
          },
        } as unknown as ClipboardEvent,
        editor: { pasteHTML } as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(pasteHTML).toHaveBeenCalledOnce();
    expect(pasteHTML.mock.calls[0]?.[0]).not.toContain('data-content-type="page"');
    expect(defaultPasteHandler).not.toHaveBeenCalled();
  });

  test.each([
    [
      "Markdown a source provides",
      { "text/markdown": "**Ship** it\n- [ ] tag", "text/plain": "Ship it tag" },
      "**Ship** it\n- [ ] tag",
    ],
    [
      "a table written as Markdown",
      { "text/plain": "| a | b |\n| - | - |\n| 1 | 2 |" },
      "| a | b |\n| - | - |\n| 1 | 2 |",
    ],
  ])(
    "pastes %s as the Blocks Nodex reads it as",
    (_source, data: Record<string, string>, markdown) => {
      const defaultPasteHandler = vi.fn(() => true);
      const blocksToFullHTML = vi.fn((_blocks: unknown[]) => "<blocks />");
      const pasteHTML = vi.fn();
      const handler = createNfmPasteHandler();

      expect(
        handler({
          event: {
            clipboardData: {
              types: Object.keys(data),
              getData: (type: string) => data[type] ?? "",
            },
          } as unknown as ClipboardEvent,
          editor: { blocksToFullHTML, pasteHTML } as never,
          defaultPasteHandler,
        }),
      ).toBe(true);
      expect(writeMarkdown(blocksToFullHTML.mock.calls[0]?.[0] as MarkdownBlock[])).toBe(
        writeMarkdown(readMarkdown(markdown)),
      );
      expect(pasteHTML).toHaveBeenCalledWith("<blocks />", true);
      expect(defaultPasteHandler).not.toHaveBeenCalled();
    },
  );

  test("leaves ordinary clipboard content on BlockNote's generic path", () => {
    const defaultPasteHandler = vi.fn(() => true);
    const handler = createNfmPasteHandler({ onStructuralPaste: () => true });

    expect(
      handler({
        event: {
          clipboardData: {
            types: ["text/plain"],
            getData: (type: string) => (type === "text/plain" ? "ordinary" : ""),
          },
        } as unknown as ClipboardEvent,
        editor: {} as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(defaultPasteHandler).toHaveBeenCalledOnce();
  });

  test("materializes ordinary clipboard blocks before replacing a typed-owner selection", () => {
    const defaultPasteHandler = vi.fn(() => true);
    const onStructuralBlockPaste = vi.fn(() => true);
    const preventDefault = vi.fn();
    const parsed = [{ id: "parsed", type: "paragraph", props: {}, content: [] }];
    const handler = createNfmPasteHandler({
      shouldHandleStructuralBlockPaste: () => true,
      onStructuralBlockPaste,
    });

    expect(
      handler({
        event: {
          preventDefault,
          clipboardData: {
            types: ["text/html", "text/plain"],
            getData: (type: string) =>
              type === "text/html" ? "<p>replacement</p>" : "replacement",
          },
        } as unknown as ClipboardEvent,
        editor: {
          tryParseHTMLToBlocks: () => parsed,
        } as never,
        defaultPasteHandler,
      }),
    ).toBe(true);
    expect(onStructuralBlockPaste).toHaveBeenCalledWith(parsed);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(defaultPasteHandler).not.toHaveBeenCalled();
  });
});
