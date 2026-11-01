import { describe, expect, test } from "vitest";
import {
  isBrowserHtmlFilePath,
  isBrowserUseNavigationUrl,
  isErrorPageExternalUrl,
  isExternallyOpenableUrl,
  isLocalHostname,
  isLocalUrl,
  readLocalHttpPort,
  resolveLinkOpenTarget,
  shouldOpenLinkInBrowser,
} from "./browser-url-policy";

describe("local classification", () => {
  test("loopback names include every .localhost subdomain but not all of 127/8", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "0.0.0.0",
      "[::1]",
      "::1",
      "a.localhost",
    ])
      expect(isLocalHostname(host), host).toBe(true);
    for (const host of ["127.0.0.2", "192.168.1.2", "localhost.example.com", "example.com"])
      expect(isLocalHostname(host), host).toBe(false);
  });

  test("local HTTP ports default by scheme", () => {
    expect(readLocalHttpPort("http://localhost:5173/app")).toBe(5173);
    expect(readLocalHttpPort("http://app.localhost/")).toBe(80);
    expect(readLocalHttpPort("https://127.0.0.1/")).toBe(443);
    expect(readLocalHttpPort("https://example.com/")).toBeNull();
    expect(readLocalHttpPort("file:///tmp/a.html")).toBeNull();
  });

  test("local file URLs exclude other hosts and network shares", () => {
    for (const url of [
      "file:///Users/ada/report/index.html",
      "file:///tmp/",
      "file:///tmp/report.pdf",
      "file://localhost/Users/ada/a.html",
      "file:///C:/work/a.html",
    ])
      expect(isLocalUrl(url), url).toBe(true);
    for (const url of [
      "file://server/share/a.html",
      "file:////server/share/a.html",
      "https://example.com",
    ])
      expect(isLocalUrl(url), url).toBe(false);
  });

  test("only .htm and .html paths render as Browser documents", () => {
    expect(isBrowserHtmlFilePath("/a/report/INDEX.HTML")).toBe(true);
    expect(isBrowserHtmlFilePath("/a/page.htm")).toBe(true);
    expect(isBrowserHtmlFilePath("/a/page.xhtml")).toBe(false);
    expect(isBrowserHtmlFilePath("/a/page.html.md")).toBe(false);
  });
});

describe("caller-specific URL policies", () => {
  test("the system opener accepts web, file, app and narrowly brokered password URLs", () => {
    for (const url of [
      "https://user:secret@example.com/path",
      "http://localhost:3000",
      "file:///tmp/a.pdf",
      "mailto:ada@example.com",
      "tel:+15551234",
      "sms:+15551234",
      "vscode://file/Users/ada/a.ts:3",
      "vscode-insiders://vscode-remote/ssh-remote+box/a.ts",
      "onepassword://grant-brokered-access?access_request_reference=abc_DEF-1",
    ])
      expect(isExternallyOpenableUrl(url), url).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "vscode://extension/foo",
      "vscode://user:x@file/a.ts",
      "onepassword://grant-brokered-access/?access_request_reference=abc",
      "onepassword://grant-brokered-access?access_request_reference=a&b=c",
      "slack://channel?id=1",
      "not a url",
    ])
      expect(isExternallyOpenableUrl(url), url).toBe(false);
  });

  test("error pages hand only HTTPS or local HTTP to the system browser", () => {
    expect(isErrorPageExternalUrl("https://example.com")).toBe(true);
    expect(isErrorPageExternalUrl("http://localhost:3000")).toBe(true);
    expect(isErrorPageExternalUrl("http://example.com")).toBe(false);
    expect(isErrorPageExternalUrl("file:///tmp/a.html")).toBe(false);
  });

  test("an Agent may navigate a controlled page only to the web or a blank page", () => {
    expect(isBrowserUseNavigationUrl("about:blank")).toBe(true);
    expect(isBrowserUseNavigationUrl("https://user:pw@example.com")).toBe(true);
    expect(isBrowserUseNavigationUrl("http://localhost:5173")).toBe(true);
    for (const url of [
      "file:///etc/hosts",
      "about:srcdoc",
      "data:text/html,x",
      "chrome://settings",
      "blob:https://a/b",
    ])
      expect(isBrowserUseNavigationUrl(url), url).toBe(false);
  });
});

describe("link destinations", () => {
  const prefs = {
    openLinkInTarget: "external-browser",
    openLocalUrlInTarget: "in-app-browser",
  } as const;

  test("local sites follow the local destination and other web links the web destination", () => {
    expect(
      resolveLinkOpenTarget({ browserAvailable: true, url: "https://example.com", ...prefs }),
    ).toBe("external-browser");
    expect(
      resolveLinkOpenTarget({ browserAvailable: true, url: "http://a.localhost:3000", ...prefs }),
    ).toBe("in-app-browser");
    expect(
      resolveLinkOpenTarget({ browserAvailable: true, url: "http://127.0.0.2:3000", ...prefs }),
    ).toBe("external-browser");
    expect(
      resolveLinkOpenTarget({ browserAvailable: true, url: "file:///tmp/a.pdf", ...prefs }),
    ).toBe("in-app-browser");
    expect(
      resolveLinkOpenTarget({
        browserAvailable: true,
        url: "file://server/share/a.html",
        ...prefs,
      }),
    ).toBe("external-browser");
  });

  test("explicit targets replace both preferences but cannot open what the Browser cannot show", () => {
    expect(
      resolveLinkOpenTarget({
        browserAvailable: true,
        url: "https://example.com",
        openTarget: "in-app-browser",
        ...prefs,
      }),
    ).toBe("in-app-browser");
    expect(
      resolveLinkOpenTarget({
        browserAvailable: true,
        url: "http://localhost:3000",
        openTarget: "external-browser",
        ...prefs,
      }),
    ).toBe("external-browser");
    expect(
      resolveLinkOpenTarget({
        browserAvailable: true,
        url: "mailto:a@b.c",
        openTarget: "in-app-browser",
        ...prefs,
      }),
    ).toBe("external-browser");
    expect(
      resolveLinkOpenTarget({
        browserAvailable: false,
        url: "http://localhost:3000",
        openTarget: "in-app-browser",
      }),
    ).toBe("external-browser");
    expect(
      resolveLinkOpenTarget({
        browserAvailable: true,
        url: "http://localhost:3000",
        useExternalBrowser: true,
      }),
    ).toBe("external-browser");
  });

  test("both destinations default to the in-app Browser", () => {
    expect(resolveLinkOpenTarget({ browserAvailable: true, url: "https://example.com" })).toBe(
      "in-app-browser",
    );
  });

  test("local HTML files open in the Browser unless an app or a line was chosen", () => {
    const html = { type: "file", path: "/Users/ada/report/index.html" } as const;
    expect(shouldOpenLinkInBrowser({ browserAvailable: true, link: html, ...prefs })).toBe(true);
    expect(
      shouldOpenLinkInBrowser({
        browserAvailable: true,
        link: html,
        openLinkInTarget: "external-browser",
        openLocalUrlInTarget: "external-browser",
      }),
    ).toBe(true);
    expect(
      shouldOpenLinkInBrowser({ browserAvailable: true, link: { ...html, target: "vscode" } }),
    ).toBe(false);
    expect(
      shouldOpenLinkInBrowser({ browserAvailable: true, link: { ...html, location: { line: 3 } } }),
    ).toBe(false);
    expect(shouldOpenLinkInBrowser({ browserAvailable: false, link: html })).toBe(false);
    expect(
      shouldOpenLinkInBrowser({
        browserAvailable: true,
        link: { type: "file", path: "/a/notes.md" },
      }),
    ).toBe(false);
  });
});
