import { describe, expect, test, vi, afterEach } from "vite-plus/test";
import type { BrowserSavedAnnotation } from "../../../shared/browser-annotation";
import {
  subscribeBrowserAnnotationAttachments,
  getBrowserAnnotationAttachmentsSnapshot,
  clearBrowserAnnotationAttachments,
  removeBrowserAnnotationAttachment,
} from "./browser-annotation-attachments";
const mocks = vi.hoisted(() => ({ query: vi.fn(), command: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
vi.mock("@/lib/renderer-command", () => ({ invokeRendererQuery: mocks.query }));
vi.mock("./browser-sidebar-commands", () => ({ invokeBrowserSidebarCommand: mocks.command }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("Main-owned Browser annotation projection", () => {
  test("projects broadcasts by destination and consumes exact IDs without local mutation", async () => {
    let publish: ((records: BrowserSavedAnnotation[]) => void) | undefined;
    let resolve!: (value: unknown) => void;
    mocks.query.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mocks.command.mockResolvedValue({ ok: true });
    vi.stubGlobal("api", {
      on: (_channel: string, listener: typeof publish) => {
        publish = listener;
        return () => undefined;
      },
    });
    const stop = subscribeBrowserAnnotationAttachments(vi.fn());
    const annotation: BrowserSavedAnnotation = {
      schemaVersion: 1,
      id: "note",
      number: 1,
      destination: "session:chat",
      browserTabId: "tab",
      pageUrl: "https://example.com",
      pageTitle: "Example",
      createdAt: 1,
      note: "Readable",
      anchors: [],
      evidenceState: "failed",
    };
    publish!([annotation]);
    resolve({ annotations: [] });
    await Promise.resolve();
    const projected = getBrowserAnnotationAttachmentsSnapshot("session:chat");
    expect(projected[0]).toMatchObject({ id: "note", evidenceState: "failed", note: "Readable" });
    expect(getBrowserAnnotationAttachmentsSnapshot("session:other")).toEqual([]);
    expect(getBrowserAnnotationAttachmentsSnapshot("session:chat")).toBe(projected);
    removeBrowserAnnotationAttachment("session:chat", "note");
    expect(mocks.command).toHaveBeenLastCalledWith({
      type: "consume-annotations",
      destination: "session:chat",
      ids: ["note"],
    });
    expect(getBrowserAnnotationAttachmentsSnapshot("session:chat")).toBe(projected);
    clearBrowserAnnotationAttachments("session:chat", ["note"]);
    publish!([]);
    expect(getBrowserAnnotationAttachmentsSnapshot("session:chat")).toEqual([]);
    stop();
  });
});
