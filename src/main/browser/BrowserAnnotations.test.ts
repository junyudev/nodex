import { describe, expect, test } from "vite-plus/test";
import { BrowserAnnotations } from "./BrowserAnnotations";
import type {
  BrowserAnnotationSave,
  BrowserSavedAnnotation,
} from "../../shared/browser-annotation";

const url = "https://example.com/";
const draft: BrowserAnnotationSave = {
  editorId: "editor-1",
  sessionId: "session-1",
  destination: "session:chat-1",
  pageUrl: url,
  note: "Make this easier to read",
  intent: "comment",
  designChanges: [],
  anchors: [
    {
      id: "anchor-1",
      kind: "element",
      pageUrl: url,
      selector: "#heading",
      rect: { x: 10, y: 20, width: 30, height: 40 },
    },
  ],
};
function fixture() {
  let records: BrowserSavedAnnotation[] = [];
  const owner = new BrowserAnnotations((value) => {
    records = value;
  }, "tab-1");
  owner.destination = draft.destination;
  owner.sessionId = draft.sessionId;
  const save = (input = draft) => {
    const result = owner.save(input, url, "Example");
    if (!result.ok) throw new Error(result.message);
    return result.annotation;
  };
  return { owner, save, records: () => records };
}
describe("Browser annotations", () => {
  test("acknowledges a saved note once and numbers new notes monotonically", () => {
    const { owner, save, records } = fixture();
    const first = save();
    expect(first).toMatchObject({ number: 1, note: draft.note, evidenceState: "pending" });
    expect(save()).toBe(first);
    expect(records()).toHaveLength(1);
    owner.remove([first.id]);
    expect(save({ ...draft, editorId: "editor-2" }).number).toBe(2);
    expect(owner.save(draft, url, "Example")).toMatchObject({ ok: false });
  });
  test("keeps the note when evidence fails and attaches evidence when ready", () => {
    const { owner, save, records } = fixture();
    const first = save();
    owner.evidence(first.id, first, "Screenshot unavailable");
    expect(records()[0]).toMatchObject({
      note: draft.note,
      evidenceState: "failed",
      evidenceError: "Screenshot unavailable",
    });
    const second = save({ ...draft, editorId: "editor-2" });
    const evidence = {
      attachmentId: "shot",
      source: "nodex://assets/shot.png",
      mimeType: "image/png" as const,
      width: 40,
      height: 40,
    };
    owner.evidence(second.id, second, evidence);
    expect(records()[1]).toMatchObject({ note: draft.note, evidenceState: "ready", evidence });
  });
  test("editing keeps the number and retires a late capture; removing retires it too", () => {
    const { owner, save, records } = fixture();
    const first = save();
    const edited = save({
      ...draft,
      annotationId: first.id,
      editorId: "edit",
      note: "Updated note",
    });
    owner.evidence(first.id, first, "Late failure");
    expect(records()).toEqual([edited]);
    expect(edited).toMatchObject({ id: first.id, number: 1, note: "Updated note" });
    owner.remove([edited.id]);
    owner.evidence(edited.id, edited, "Late failure");
    expect(records()).toEqual([]);
  });
  test("clears only the admitted set, leaving a concurrently saved note", () => {
    const { owner, save, records } = fixture();
    const first = save();
    const admitted = [first.id];
    const second = save({ ...draft, editorId: "editor-2" });
    owner.remove(admitted);
    expect(records()).toEqual([second]);
    owner.remove(records().map((record) => record.id));
    expect(records()).toEqual([]);
  });
  test.each([
    { sessionId: "stale" },
    { destination: "session:another-chat" },
    { pageUrl: "https://other.example/" },
    { anchors: [{ ...draft.anchors[0]!, pageUrl: "https://other.example/" }] },
    { note: "  " },
    { annotationId: "missing" },
    { intent: "designChange" as const },
  ])("refuses invalid or stale editor input %j without saving", (patch) => {
    const { owner, records } = fixture();
    expect(owner.save({ ...draft, ...patch }, url, "Example")).toMatchObject({
      ok: false,
      message: expect.any(String),
    });
    expect(records()).toEqual([]);
  });
  test("a page change keeps saved notes scoped to their original URL", () => {
    const { owner, save, records } = fixture();
    save();
    expect(
      owner.save({ ...draft, editorId: "new" }, "https://other.example/", "Other"),
    ).toMatchObject({ ok: false });
    expect(records()[0]?.pageUrl).toBe(url);
    owner.destination = null;
    expect(owner.save({ ...draft, editorId: "new" }, url, "Example")).toMatchObject({ ok: false });
  });
});
