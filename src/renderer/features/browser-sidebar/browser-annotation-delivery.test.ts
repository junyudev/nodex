import { expect, test } from "vite-plus/test";
import { deliverBrowserAnnotations } from "./browser-annotation-delivery";
import type { BrowserAnnotationAttachment } from "../../../shared/browser-annotation";
const note = (id: string): BrowserAnnotationAttachment => ({
  schemaVersion: 1,
  id,
  browserTabId: "tab",
  createdAt: 1,
  note: id,
  pageTitle: "Example",
  pageUrl: "https://example.com",
  anchors: [],
});
test.each(["refused", "error", "missing"])(
  "direct delivery %s leaves the saved note available",
  async (outcome) => {
    let saved = [note("one")];
    const result = await deliverBrowserAnnotations({
      destination: "chat",
      annotations: saved,
      admit:
        outcome === "missing"
          ? undefined
          : async () => {
              if (outcome === "error") throw new Error("Disconnected");
              return false;
            },
      consume: async (ids) => {
        saved = saved.filter((record) => !ids.includes(record.id));
      },
    });
    expect(result).toMatchObject({ admitted: false, reason: expect.stringContaining("saved") });
    expect(saved.map((record) => record.id)).toEqual(["one"]);
  },
);
test("send-all admits one message and consumes its exact set after admission", async () => {
  let saved = [note("one"), note("two")];
  const sent: BrowserAnnotationAttachment[][] = [];
  const result = await deliverBrowserAnnotations({
    destination: "chat",
    annotations: [...saved],
    admit: async (annotations) => {
      sent.push([...annotations]);
      saved.push(note("three"));
      return true;
    },
    consume: async (ids) => {
      saved = saved.filter((record) => !ids.includes(record.id));
    },
  });
  expect(result.admitted).toBe(true);
  expect(sent.map((message) => message.map((record) => record.id))).toEqual([["one", "two"]]);
  expect(saved.map((record) => record.id)).toEqual(["three"]);
});
