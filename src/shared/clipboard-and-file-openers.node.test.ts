import { describe, expect, test, it } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  clipboardFileReferences,
  clipboardFileReferenceSources,
  replaceClipboardFileReferences,
} from "./clipboard-file-references";
import { writePortableMarkdown, type MarkdownInline } from "./nodex-markdown";
import {
  attachNodexClipboardEnvelope,
  attachNodexClipboardFragment,
  attachNodexClipboardWriteClaim,
  attachNodexStructuralClipboardWriteClaim,
  decodeNodexStructuralClipboardDescriptor,
  encodeNodexClipboardEnvelope,
  encodeNodexStructuralClipboardDescriptor,
  hasNodexStructuralClipboardFallback,
  hasUntrustedTypedOwnerHtml,
  inspectNodexClipboardHtml,
  NODEX_CLIPBOARD_FRAGMENT_MAX_ENCODED_LENGTH,
  readNodexClipboardFragment,
  readNodexClipboardWriteClaim,
  sanitizeUntrustedTypedOwnerHtml,
  type NodexClipboardEnvelopeV1,
} from "./clipboard-paste";
import {
  buildFileUrl,
  DEFAULT_FILE_LINK_OPENER_ID,
  formatFileLinkLocation,
  getFileManagerRevealLabel,
  getFileManagerName,
  normalizeFileLinkOpenerId,
  parseLocalFileLinkHref,
} from "./file-link-openers";
import {
  deriveLinkOpenIntent,
  resolveLinkOpenRequest,
  type LinkActivation,
  type LinkDisposition,
} from "./link-opening";
import {
  DEFAULT_LINK_OPENING_SETTINGS,
  type ExternalBrowserLinkShortcut,
} from "./link-opening-settings";
import type { LinkOpenTarget } from "./browser-url-policy";

describe("clipboard file references", () => {
  const source = "nodex://files/0199134e-cbb0-7000-8000-000000000006";

  function attachmentMarkdown(attachment: Readonly<Record<string, unknown>>): string {
    return writePortableMarkdown([
      {
        type: "paragraph",
        content: [{ type: "attachment", props: attachment } satisfies MarkdownInline],
        children: [],
      },
    ]).markdown;
  }

  function readLink(text: string) {
    const [token] = fromMarkdown(text).children;
    if (token?.type !== "paragraph") throw new Error("Expected one paragraph");
    const [link] = token.children;
    if (link?.type !== "link") throw new Error("Expected one link");
    return link;
  }

  describe("clipboard File references", () => {
    test("detects saved attachment occurrences without treating linked paths as exports", () => {
      const text = `[setup.html](${source}) [same](${source}) [local](/tmp/setup.html)`;
      expect(clipboardFileReferences(text)).toEqual([
        { source, fileId: source.slice("nodex://files/".length) },
      ]);
      expect(clipboardFileReferenceSources(text)).toEqual([source]);
      expect(clipboardFileReferences("[local](/tmp/setup.html)")).toEqual([]);
      expect(clipboardFileReferences(`${text} ![old](nodex://assets/image.png)`)).toBeNull();
    });

    test.each([
      "/Users/example/setup.html",
      "/Users/example/my  files/setup (v2).html",
      "/Users/example/setup(v2).html",
      "/Users/example/<setup>.html",
      "/Users/example/&amp;.html",
      String.raw`C:\my files\setup (v2).html`,
      String.raw`C:\files\setup.html`,
    ])("links %s the same way for direct and exported attachments", (path) => {
      const attachment = {
        type: "attachment",
        kind: "file",
        mode: "link",
        source: path,
        name: "setup [v2]*`&amp;.html",
      } as const;
      const portable = attachmentMarkdown({ ...attachment, mode: "materialized", source });
      const exported = replaceClipboardFileReferences(portable, new Map([[source, path]]));
      for (const written of [attachmentMarkdown(attachment), exported]) {
        const link = readLink(written);
        expect(link.url).toBe(path);
        expect(link.children.map((token) => token.type)).toEqual(["text"]);
        expect(link.children.map((token) => ("value" in token ? token.value : "")).join("")).toBe(
          attachment.name,
        );
      }
    });

    test("rewrites repeated images, attachments and literal references in one pass", () => {
      const asset = "nodex://assets/old.png";
      const text = `[file](${source})\n![image](${source})\n${source}\n![old](${asset})`;
      expect(
        replaceClipboardFileReferences(
          text,
          new Map([
            [source, "/my files/setup.html"],
            [asset, "/my files/old.png"],
          ]),
        ),
      ).toBe(
        "[file](</my files/setup.html>)\n![image](</my files/setup.html>)\n/my files/setup.html\n![old](</my files/old.png>)",
      );
    });
  });
});

describe("clipboard paste", () => {
  const envelope: NodexClipboardEnvelopeV1 = {
    version: 1,
    profileId: "profile-1",
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    bundleId: "bundle-1",
    capability: "a".repeat(64),
    manifestHash: "b".repeat(64),
    actionHint: "copy",
  };
  const writeClaim = "0199134e-cbb0-7000-8000-000000000004";

  describe("portable clipboard fragments", () => {
    test("round-trips Unicode rich content and slice boundaries through native HTML wrappers", () => {
      const fragment = '<div data-pm-slice="0 0 -1 []"><p>层级 🎨 &amp; text</p></div>';
      const html = attachNodexClipboardFragment("<p>层级 🎨 &amp; text</p>", fragment);
      expect(attachNodexClipboardFragment(html, fragment)).toBe(html);
      const inspected = inspectNodexClipboardHtml(
        attachNodexClipboardEnvelope(html, envelope, writeClaim),
      );
      expect(
        readNodexClipboardFragment(attachNodexClipboardEnvelope(html, envelope, writeClaim)),
      ).toBe(fragment);
      expect(inspected.envelope).toEqual(envelope);
      expect(inspected.fallbackHtml).toContain("<p>层级 🎨 &amp; text</p>");
      expect(readNodexClipboardFragment(inspected.fallbackHtml)).toBeNull();
    });

    test("cannot smuggle typed-owner authority through an encoded fragment", () => {
      const unsafe = '<div data-content-type="page">Subpage</div>';
      // Bypass our writer to exercise the external/untrusted reader boundary.
      const html = `<p data-nodex-clipboard-fragment-v1="${Buffer.from(unsafe).toString("base64url")}">Subpage</p>`;
      expect(readNodexClipboardFragment(html)).toBe(sanitizeUntrustedTypedOwnerHtml(unsafe));
      expect(inspectNodexClipboardHtml(html).envelope).toBeNull();
    });

    test.each(["%%%", "_w", "", "A".repeat(NODEX_CLIPBOARD_FRAGMENT_MAX_ENCODED_LENGTH + 1)])(
      "ignores malformed or oversized fragment %#",
      (encoded) => {
        const html = `<div data-nodex-clipboard-fragment-v1="${encoded}"><p>Fallback</p></div>`;
        expect(readNodexClipboardFragment(html)).toBeNull();
        expect(inspectNodexClipboardHtml(html).fallbackHtml).toBe("<div><p>Fallback</p></div>");
      },
    );
  });

  describe("Nodex structural clipboard sidecar", () => {
    test("round-trips strict preparing and ready private descriptors", () => {
      const preparing = {
        version: 1,
        phase: "preparing",
        writeClaim,
        actionHint: "cut",
      } as const;
      const ready = { ...preparing, phase: "ready", envelope } as const;

      expect(
        decodeNodexStructuralClipboardDescriptor(
          encodeNodexStructuralClipboardDescriptor(preparing),
        ),
      ).toEqual(preparing);
      expect(
        decodeNodexStructuralClipboardDescriptor(encodeNodexStructuralClipboardDescriptor(ready)),
      ).toEqual(ready);
    });

    test("rejects malformed, oversized, and authority-shaped private descriptors", () => {
      expect(decodeNodexStructuralClipboardDescriptor("not json")).toBeNull();
      expect(
        decodeNodexStructuralClipboardDescriptor(
          JSON.stringify({
            version: 1,
            phase: "preparing",
            writeClaim,
            actionHint: "cut",
            closure: { blocks: [] },
          }),
        ),
      ).toBeNull();
      expect(
        decodeNodexStructuralClipboardDescriptor(
          JSON.stringify({
            version: 1,
            phase: "ready",
            writeClaim,
            actionHint: "cut",
          }),
        ),
      ).toBeNull();
      expect(decodeNodexStructuralClipboardDescriptor("x".repeat(4 * 1024 + 1))).toBeNull();
    });

    test("round-trips one bounded envelope while retaining a safe fallback marker", () => {
      const html = attachNodexClipboardEnvelope("<p>Shareable fallback</p>", envelope);

      const inspected = inspectNodexClipboardHtml(html);

      expect(inspected.envelope).toEqual(envelope);
      expect(inspected.fallbackHtml).toContain("<p>Shareable fallback</p>");
      expect(inspected.fallbackHtml).not.toContain("nodex-clipboard-envelope-v1");
      expect(inspected.hasStructuralFallback).toBe(true);
      expect(hasNodexStructuralClipboardFallback(inspected.fallbackHtml)).toBe(true);
    });

    test("keeps the exact write claim beside the final envelope until cut preparation settles", () => {
      const html = attachNodexClipboardEnvelope("<p>Shareable fallback</p>", envelope, writeClaim);

      const inspected = inspectNodexClipboardHtml(html);

      expect(inspected.envelope).toEqual(envelope);
      expect(inspected.writeClaim).toBe(writeClaim);
      expect(readNodexClipboardWriteClaim(html)).toBe(writeClaim);
    });

    test("removes typed-owner semantics from portable HTML", () => {
      const unsafe = [
        '<div data-content-type="page">Page</div>',
        "<div data-content-type='database'>Database</div>",
        "<div data-content-type=canvas>Canvas</div>",
        '<div data-content-type="pageRef">Reference</div>',
      ].join("");

      const sanitized = sanitizeUntrustedTypedOwnerHtml(unsafe);
      const inspected = inspectNodexClipboardHtml(attachNodexClipboardEnvelope(unsafe, envelope));

      expect(hasUntrustedTypedOwnerHtml(sanitized)).toBe(false);
      expect(sanitized).toContain('data-content-type="pageRef"');
      expect(inspected.fallbackHtml).toContain('data-nodex-structural-fallback-type="page"');
      expect(inspected.fallbackHtml).not.toContain('data-content-type="page"');
    });

    test("round-trips a safe synchronous write claim without owner authority", () => {
      const html = attachNodexStructuralClipboardWriteClaim(
        '<div data-content-type="page">Subpage</div>',
        writeClaim,
      );
      const inspected = inspectNodexClipboardHtml(html);

      expect(inspected.writeClaim).toBe(writeClaim);
      expect(readNodexClipboardWriteClaim(html)).toBe(writeClaim);
      expect(inspected.envelope).toBeNull();
      expect(hasUntrustedTypedOwnerHtml(inspected.fallbackHtml)).toBe(false);

      const replacement = "0199134e-cbb0-7000-8000-000000000007";
      const replaced = attachNodexStructuralClipboardWriteClaim(html, replacement);
      expect(replaced.match(/data-nodex-clipboard-write-claim=/gu)).toHaveLength(1);
      expect(readNodexClipboardWriteClaim(replaced)).toBe(replacement);
    });

    test("claims ordinary presentation without marking it as structural fallback", () => {
      const html = attachNodexClipboardWriteClaim("<p>Portable</p>", writeClaim);
      const inspected = inspectNodexClipboardHtml(html);

      expect(inspected.writeClaim).toBe(writeClaim);
      expect(inspected.hasStructuralFallback).toBe(false);
      expect(inspected.fallbackHtml).toContain("<p>Portable</p>");
    });

    test("replaces an existing marker instead of emitting ambiguous capabilities", () => {
      const stale = encodeNodexClipboardEnvelope({ ...envelope, capability: "c".repeat(64) });
      const html = attachNodexClipboardEnvelope(`${stale}<p>Shareable fallback</p>`, envelope);

      expect(html.match(/nodex-clipboard-envelope-v1/gu)).toHaveLength(1);
      expect(inspectNodexClipboardHtml(html).envelope).toEqual(envelope);
    });

    test("strips malformed or non-canonical markers without promoting them", () => {
      const malformed =
        '<meta name="nodex-clipboard-envelope-v1" content="not+base64"><p>Fallback</p>';

      const inspected = inspectNodexClipboardHtml(malformed);

      expect(inspected.envelope).toBeNull();
      expect(inspected.fallbackHtml).toContain("<p>Fallback</p>");
      expect(inspected.fallbackHtml).not.toContain("nodex-clipboard-envelope-v1");
    });

    test("rejects payloads with unrecognized authority fields", () => {
      const encoded = btoa(JSON.stringify({ ...envelope, preserveIdentity: true }))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      const html = `<meta name="nodex-clipboard-envelope-v1" content="${encoded}">`;

      expect(inspectNodexClipboardHtml(html).envelope).toBeNull();
    });
  });
});

describe("file link openers", () => {
  const EXAMPLE_PARSER_PATH = "/workspace/nodex/src/renderer/lib/markdown/parser.ts";
  const EXAMPLE_MAIN_PATH = "/workspace/nodex/src/main/index.ts";

  describe("file link openers", () => {
    test.each([
      ["darwin", "Finder"],
      ["MacIntel", "Finder"],
      ["win32", "File Explorer"],
      ["Win32", "File Explorer"],
      ["linux", "File Manager"],
      ["", "File Manager"],
    ])("names the native file manager for %s", (platform, expected) => {
      expect(getFileManagerName(platform)).toBe(expected);
    });
    test.each([
      ["darwin", "Reveal in Finder"],
      ["MacIntel", "Reveal in Finder"],
      ["win32", "Open in Explorer"],
      ["Win32", "Open in Explorer"],
      ["linux", "Open in File Manager"],
    ])("names the native file-manager action for %s", (platform, expected) => {
      expect(getFileManagerRevealLabel(platform)).toBe(expected);
    });
    test("parses absolute file paths and line fragments", () => {
      expect(JSON.stringify(parseLocalFileLinkHref(`${EXAMPLE_PARSER_PATH}#L71`))).toBe(
        JSON.stringify({
          path: EXAMPLE_PARSER_PATH,
          line: 71,
        }),
      );
    });

    test("parses file URLs with line and column fragments", () => {
      expect(JSON.stringify(parseLocalFileLinkHref(`file://${EXAMPLE_MAIN_PATH}#L55C3`))).toBe(
        JSON.stringify({
          path: EXAMPLE_MAIN_PATH,
          line: 55,
          column: 3,
        }),
      );
    });

    test.each([
      ["file://server/share/doc.md", "//server/share/doc.md"],
      ["file://server/share/my%20doc.md", "//server/share/my doc.md"],
    ])("preserves the network host in %s", (href, path) => {
      expect(parseLocalFileLinkHref(`${href}#L55C3-L57C8`)).toEqual({
        path,
        line: 55,
        column: 3,
        endLine: 57,
        endColumn: 8,
      });
    });

    test.each([
      ["file:///workspace/my%20doc.md", "/workspace/my doc.md"],
      ["file://localhost/workspace/my%20doc.md", "/workspace/my doc.md"],
      ["file://LOCALHOST/workspace/my%20doc.md", "/workspace/my doc.md"],
      ["file:///C:/workspace/my%20doc.md", "C:/workspace/my doc.md"],
      ["file://localhost/C:/workspace/my%20doc.md", "C:/workspace/my doc.md"],
    ])("keeps %s local", (href, path) => {
      expect(parseLocalFileLinkHref(href)).toEqual({ path });
    });

    test("rejects a network file URL with invalid path encoding", () => {
      expect(parseLocalFileLinkHref("file://server/share/%ZZ.md")).toBeNull();
    });

    test("parses ranged line and column fragments", () => {
      expect(parseLocalFileLinkHref(`${EXAMPLE_PARSER_PATH}#L71C3-L76C8`)).toEqual({
        path: EXAMPLE_PARSER_PATH,
        line: 71,
        column: 3,
        endLine: 76,
        endColumn: 8,
      });
    });

    test("ignores non-file links", () => {
      expect(parseLocalFileLinkHref("https://example.com")).toBe(null);
      expect(parseLocalFileLinkHref("parser.ts")).toBe(null);
    });

    test("normalizes stored opener IDs", () => {
      expect(normalizeFileLinkOpenerId("CURSOR")).toBe("cursor");
      expect(normalizeFileLinkOpenerId("finder")).toBe("fileManager");
      expect(normalizeFileLinkOpenerId("android-studio")).toBe("androidStudio");
      expect(normalizeFileLinkOpenerId("unexpected")).toBe(DEFAULT_FILE_LINK_OPENER_ID);
    });

    test("formats file targets for editor commands and fallback URLs", () => {
      const target = {
        path: EXAMPLE_PARSER_PATH,
        line: 71,
        column: 4,
      };

      expect(formatFileLinkLocation(target)).toBe(`${EXAMPLE_PARSER_PATH}:71:4`);
      expect(buildFileUrl(target)).toBe(`file://${EXAMPLE_PARSER_PATH}#L71C4`);
    });
  });

  test.each(["C:\\workspace\\我的 #1%.ts", "\\\\server\\share\\我的 #1%.ts"])(
    "round-trips native Windows file URLs and line fragments: %s",
    (path) => {
      expect(parseLocalFileLinkHref(buildFileUrl({ path, line: 7, column: 3 }))).toEqual({
        path: path.replaceAll("\\", "/"),
        line: 7,
        column: 3,
      });
    },
  );

  test("preserves literal POSIX filename characters in a file URL", () => {
    const path = String.raw`/workspace/notes\#?.md`;
    expect(parseLocalFileLinkHref(buildFileUrl({ path, line: 7 }))).toEqual({ path, line: 7 });
  });
});

describe("link opening", () => {
  const web = "https://example.com";
  const derive = (
    activation: Partial<LinkActivation>,
    shortcut: ExternalBrowserLinkShortcut = "primary",
    extra: object = {},
  ) =>
    deriveLinkOpenIntent({
      url: web,
      activation: { platform: "darwin", ...activation },
      externalBrowserLinkShortcut: shortcut,
      ...extra,
    });

  describe("link activation intent", () => {
    it.each([
      [{}, "primary", "default", false, false],
      [{ metaKey: true }, "primary", "new-background-tab", true, false],
      [{ metaKey: true }, "unassigned", "new-background-tab", false, false],
      [{ metaKey: true, shiftKey: true }, "primary", "new-tab", false, false],
      [{ metaKey: true, shiftKey: true }, "primary-shift", "new-tab", true, false],
      [{ button: 1 }, "primary", "new-background-tab", false, false],
      [{ button: 1, shiftKey: true }, "primary-shift", "new-tab", false, false],
      [{ button: 1, metaKey: true }, "primary", "new-background-tab", false, false],
      [{ shiftKey: true }, "primary", "default", false, false],
      [{ altKey: true }, "primary", "default", false, true],
      [{ altKey: true }, "alt", "default", true, false],
      [{ ctrlKey: true }, "primary", "default", false, false],
      [{ ctrlKey: true, metaKey: true }, "primary", "new-background-tab", false, false],
      [{ platform: "win32", ctrlKey: true }, "primary", "new-background-tab", true, false],
      [
        { platform: "linux", ctrlKey: true, shiftKey: true },
        "primary-shift",
        "new-tab",
        true,
        false,
      ],
      [{ platform: "win32", metaKey: true }, "primary", "default", false, false],
      [{ button: 2, altKey: true }, "alt", "default", false, false],
    ] as const)(
      "classifies %j with %s",
      (activation, shortcut, disposition, externalShortcutMatched, download) => {
        expect(derive(activation, shortcut)).toMatchObject({
          disposition,
          externalShortcutMatched,
          download,
        });
      },
    );
    it("limits shortcuts to HTTP(S) and activations without explicit destinations", () => {
      for (const url of ["file:///tmp/report.html", "mailto:a@example.com", "javascript:alert(1)"])
        expect(derive({ metaKey: true }, "primary", { url }).externalShortcutMatched).toBe(false);
      for (const extra of [
        { openTarget: "in-app-browser" },
        { openTarget: "external-browser" },
        { useExternalBrowser: true },
      ])
        expect(derive({ metaKey: true }, "primary", extra).externalShortcutMatched).toBe(false);
    });
    it("requests markdown split only for eligible unmodified primary activations", () => {
      expect(derive({}, "primary", { markdownContext: true }).presentationIntent).toBe("split");
      for (const activation of [
        { shiftKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { button: 1 },
      ])
        expect(
          derive(activation, "primary", { markdownContext: true }).presentationIntent,
        ).toBeUndefined();
      expect(derive({}).presentationIntent).toBeUndefined();
    });
    it("uses primary+Alt markdown as explicit full view without shortcut or tab disposition", () => {
      expect(derive({ metaKey: true, altKey: true }, "primary", { markdownContext: true })).toEqual(
        {
          disposition: "default",
          externalShortcutMatched: false,
          download: false,
          openTarget: "in-app-browser",
          presentationIntent: "full-width",
        },
      );
      for (const activation of [
        { metaKey: true, altKey: true, ctrlKey: true },
        { metaKey: true, altKey: true, shiftKey: true },
        { metaKey: true, altKey: true, button: 1 },
      ])
        expect(
          derive(activation, "primary", { markdownContext: true }).presentationIntent,
        ).toBeUndefined();
    });
  });

  describe("link destination precedence", () => {
    const targets: LinkOpenTarget[] = ["in-app-browser", "external-browser"];
    const dispositions: LinkDisposition[] = ["default", "new-tab", "new-background-tab"];
    for (const webTarget of targets)
      for (const localTarget of targets)
        for (const openTarget of [undefined, ...targets])
          for (const useExternalBrowser of [undefined, true])
            for (const disposition of dispositions)
              for (const browserAvailable of [false, true])
                for (const shortcutMatched of [false, true]) {
                  it(`routes ${webTarget}/${localTarget}, override ${openTarget}/${useExternalBrowser}, ${disposition}, available=${browserAvailable}, shortcut=${shortcutMatched}`, () => {
                    for (const [url, preference] of [
                      [web, webTarget],
                      ["http://a.localhost:3000", localTarget],
                      ["file:///tmp/a.pdf", localTarget],
                    ] as const) {
                      const forced =
                        useExternalBrowser ||
                        openTarget === "external-browser" ||
                        (shortcutMatched && openTarget == null && !url.startsWith("file:"));
                      const internal =
                        browserAvailable &&
                        !forced &&
                        (openTarget === "in-app-browser" ||
                          disposition !== "default" ||
                          preference === "in-app-browser");
                      expect(
                        resolveLinkOpenRequest({
                          browserAvailable,
                          preferences: {
                            openLinkInTarget: webTarget,
                            openLocalUrlInTarget: localTarget,
                            externalBrowserLinkShortcut: "primary",
                          },
                          request: {
                            url,
                            initiator: "test",
                            openTarget,
                            useExternalBrowser,
                            disposition,
                            activation: shortcutMatched
                              ? { platform: "darwin", metaKey: true }
                              : undefined,
                          },
                        })?.target,
                      ).toBe(internal ? "in-app-browser" : "external-browser");
                    }
                  });
                }
    it("uses effective unconfigured defaults and makes the external shortcut outrank new tabs", () => {
      expect(
        resolveLinkOpenRequest({ browserAvailable: true, request: { url: web, initiator: "test" } })
          ?.target,
      ).toBe("external-browser");
      expect(
        resolveLinkOpenRequest({
          browserAvailable: true,
          request: { url: "http://localhost:3000", initiator: "test" },
        })?.target,
      ).toBe("in-app-browser");
      for (const openTarget of [undefined, ...targets]) {
        const result = resolveLinkOpenRequest({
          browserAvailable: true,
          preferences: DEFAULT_LINK_OPENING_SETTINGS,
          request: {
            url: web,
            initiator: "test",
            disposition: "new-tab",
            activation: { platform: "darwin", metaKey: true },
            openTarget,
          },
        });
        expect(result?.target).toBe(openTarget ?? "external-browser");
      }
    });
    it("denies unsupported URLs and preserves explicit external schemes", () => {
      for (const url of [
        "javascript:alert(1)",
        "data:text/html,hello",
        "nodex-unknown://path",
        "not a URL",
      ])
        expect(
          resolveLinkOpenRequest({
            browserAvailable: true,
            request: { url, initiator: "test", openTarget: "in-app-browser" },
          }),
        ).toBeNull();
      expect(
        resolveLinkOpenRequest({
          browserAvailable: true,
          request: { url: "mailto:a@example.com", initiator: "test", openTarget: "in-app-browser" },
        })?.target,
      ).toBe("external-browser");
    });
  });
});
