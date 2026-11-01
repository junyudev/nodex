import { describe, expect, it } from "vite-plus/test";
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
    [{ platform: "linux", ctrlKey: true, shiftKey: true }, "primary-shift", "new-tab", true, false],
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
    expect(derive({ metaKey: true, altKey: true }, "primary", { markdownContext: true })).toEqual({
      disposition: "default",
      externalShortcutMatched: false,
      download: false,
      openTarget: "in-app-browser",
      presentationIntent: "full-width",
    });
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
