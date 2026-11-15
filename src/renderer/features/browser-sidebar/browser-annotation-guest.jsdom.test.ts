import { expect, test, vi } from "vite-plus/test";
import type {
  BrowserSavedAnnotation,
  BrowserAnnotationSelectionEvent,
} from "../../../shared/browser-annotation";
const guest = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      guest.listeners.set(channel, listener),
    send: guest.send,
  },
}));
vi.mock("../../../preload/browser-webmcp", () => ({ installBrowserWebMcp: () => undefined }));
test("same-mode synchronization preserves selected targets and saved pins survive exiting mode", async () => {
  await import("../../../preload/browser-guest");
  const target = document.createElement("button");
  target.id = "target";
  target.textContent = "Target";
  document.body.append(target);
  const mode = guest.listeners.get("browser-annotation-mode")!;
  mode({}, { enabled: true, sessionId: "editor", selectionMode: "inspect" });
  target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const selection = guest.send.mock.calls.find(
    ([channel]) => channel === "browser-annotation-selection",
  )?.[1] as BrowserAnnotationSelectionEvent;
  expect(selection.anchor.selector).toBe("#target");
  mode({}, { enabled: true, sessionId: "editor", selectionMode: "inspect" });
  guest.listeners.get("browser-annotation-design-preview")!(
    {},
    {
      sessionId: "editor",
      anchorId: selection.anchor.id,
      property: "fontSize",
      after: "24px",
      originalView: false,
    },
  );
  expect(target.style.fontSize).toBe("24px");
  const record: BrowserSavedAnnotation = {
    schemaVersion: 1,
    id: "note",
    number: 1,
    destination: "session:chat",
    browserTabId: "tab",
    pageUrl: location.href,
    pageTitle: "Example",
    createdAt: 1,
    note: "Readable",
    anchors: [selection.anchor],
    evidenceState: "pending",
  };
  const sync = guest.listeners.get("browser-annotation-saved")!;
  sync({}, [record]);
  sync({}, [record]);
  const presentation = guest.listeners.get("browser-annotation-presentation")!;
  presentation({}, { suspended: false, pinsVisible: false, agentControlled: false });
  expect(
    document.querySelector<HTMLButtonElement>("[data-nodex-browser-annotation-marker]")!.style
      .display,
  ).toBe("none");
  presentation({}, { suspended: false, pinsVisible: true, agentControlled: false });
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " ", code: "Space" }),
  );
  const suspendedClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(suspendedClick);
  expect(suspendedClick.defaultPrevented).toBe(false);
  target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " ", code: "Space" }));
  const resumedClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(resumedClick);
  expect(resumedClick.defaultPrevented).toBe(true);
  presentation({}, { suspended: false, pinsVisible: true, agentControlled: true });
  const controlledClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(controlledClick);
  expect(controlledClick.defaultPrevented).toBe(false);
  const controlledSpace = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: " ",
    code: "Space",
  });
  target.dispatchEvent(controlledSpace);
  expect(controlledSpace.defaultPrevented).toBe(false);
  expect(target.style.fontSize).toBe("");
  presentation({}, { suspended: false, pinsVisible: true, agentControlled: false });
  mode({}, { enabled: false });
  const markers = document.querySelectorAll<HTMLButtonElement>(
    "[data-nodex-browser-annotation-marker]",
  );
  expect(markers).toHaveLength(1);
  expect(markers[0]?.textContent).toBe("1");
  markers[0]!.click();
  expect(guest.send).toHaveBeenLastCalledWith("browser-annotation-open", {
    annotationId: "note",
    anchor: expect.objectContaining({ id: selection.anchor.id }),
  });
  sync({}, [{ ...record, pageUrl: "https://other.example" }]);
  expect(document.querySelectorAll("[data-nodex-browser-annotation-marker]")).toHaveLength(0);
  sync({}, []);
  target.remove();
});
