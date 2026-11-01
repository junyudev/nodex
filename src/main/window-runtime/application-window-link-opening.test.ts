import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import { installApplicationWindowLinkRouting } from "./application-window-link-opening";
import { resolveLinkOpenRequest } from "../../shared/link-opening";
import { DEFAULT_LINK_OPENING_SETTINGS } from "../../shared/link-opening-settings";

describe("trusted application window link fallback", () => {
  function fixture() {
    const contents = new EventEmitter();
    let popup: Parameters<WebContents["setWindowOpenHandler"]>[0] | undefined;
    const open = vi.fn();
    const webContents = Object.assign(contents, {
      setWindowOpenHandler: (handler: typeof popup) => {
        popup = handler;
      },
    }) as unknown as WebContents;
    installApplicationWindowLinkRouting({
      webContents,
      isAppUrl: (url) => url.startsWith("nodex://app/"),
      openLink: open,
    });
    const windowOpen = (url: string, disposition = "default") =>
      popup!({ url, disposition } as Parameters<NonNullable<typeof popup>>[0]);
    return { contents, open, windowOpen };
  }
  it("denies native popups and sends HTTP destinations through the same preference decision", () => {
    const f = fixture();
    expect(f.windowOpen("https://example.com")).toEqual({ action: "deny" });
    const request = f.open.mock.calls[0]![0];
    expect(request).toEqual({
      url: "https://example.com",
      initiator: "window_open",
      disposition: "default",
    });
    expect(resolveLinkOpenRequest({ request, browserAvailable: true })?.target).toBe(
      "external-browser",
    );
    expect(
      resolveLinkOpenRequest({
        request,
        browserAvailable: true,
        preferences: { ...DEFAULT_LINK_OPENING_SETTINGS, openLinkInTarget: "in-app-browser" },
      })?.target,
    ).toBe("in-app-browser");
    f.windowOpen("https://example.com", "background-tab");
    expect(f.open).toHaveBeenLastCalledWith({ ...request, disposition: "new-background-tab" });
    for (const disposition of ["foreground-tab", "new-window", "other"]) {
      f.windowOpen("https://example.com", disposition);
      expect(f.open).toHaveBeenLastCalledWith(request);
    }
  });
  it("opens permitted non-HTTP schemes explicitly externally and rejects unsupported schemes", () => {
    const f = fixture();
    f.windowOpen("mailto:a@example.com");
    expect(f.open).toHaveBeenCalledWith({
      url: "mailto:a@example.com",
      initiator: "window_open",
      openTarget: "external-browser",
    });
    f.open.mockClear();
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "unknown://path"])
      expect(f.windowOpen(url)).toEqual({ action: "deny" });
    expect(f.open).not.toHaveBeenCalled();
  });
  it("keeps app navigation internal and prevents external main-frame navigation before routing it", () => {
    const f = fixture();
    const preventDefault = vi.fn();
    f.contents.emit("will-navigate", { preventDefault }, "nodex://app/index.html");
    expect(preventDefault).not.toHaveBeenCalled();
    f.contents.emit("will-navigate", { preventDefault }, "http://localhost:3000");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(
      resolveLinkOpenRequest({ request: f.open.mock.calls[0]![0], browserAvailable: true })?.target,
    ).toBe("in-app-browser");
  });
});
