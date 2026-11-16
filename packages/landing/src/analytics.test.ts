// @vitest-environment jsdom
import { expect, test, vi } from "vite-plus/test";

test("middle-click counts download links, but only primary activation counts the copy button", async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response());
  vi.stubGlobal("fetch", send);
  try {
    window.history.replaceState(null, "", "/download/?ref=NewsLetter");
    document.body.innerHTML = `
      <a data-download="macos"><span>Download</span></a>
      <button data-download="homebrew">Copy</button>
    `;
    await import("./analytics");
    send.mockClear();

    const linkLabel = document.querySelector("a span")!;
    const copy = document.querySelector("button")!;
    linkLabel.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    copy.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(send).not.toHaveBeenCalled();

    linkLabel.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    copy.click();

    const events = send.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).events);
    expect(events).toMatchObject([
      {
        eventName: "landing_download_clicked",
        metadata: { target: "macos", source: "newsletter" },
      },
      {
        eventName: "landing_download_clicked",
        metadata: { target: "homebrew", source: "newsletter" },
      },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
