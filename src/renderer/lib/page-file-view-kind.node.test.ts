import { describe, expect, it } from "vitest";
import { pageFileHasSourceView, resolvePageFileViewKind } from "./page-file-view-kind";

const kind = (name: string, mimeType = "application/octet-stream") =>
  resolvePageFileViewKind({ name, mimeType });

describe("resolvePageFileViewKind", () => {
  it("prefers the recorded MIME type and falls back to the name", () => {
    expect(kind("report", "text/html; charset=utf-8")).toBe("html");
    expect(kind("report.html")).toBe("html");
    expect(kind("flamegraph.png", "image/png")).toBe("image");
    expect(kind("photo.JPG")).toBe("image");
    expect(kind("trace.json", "application/json")).toBe("text");
    expect(kind("notes.md", "text/plain")).toBe("markdown");
    expect(kind("diagram.svg", "image/svg+xml")).toBe("svg");
    expect(kind("brief.pdf")).toBe("pdf");
    expect(kind("call.m4a", "audio/mp4")).toBe("audio");
    expect(kind("demo.webm")).toBe("video");
    expect(kind("events.ndjson")).toBe("text");
    expect(kind("data.geo+json", "application/geo+json")).toBe("text");
  });

  it("does not render formats Chromium cannot show", () => {
    expect(kind("scan.tiff", "image/tiff")).toBe("unsupported");
    expect(kind("archive.zip", "application/zip")).toBe("unsupported");
    expect(kind("binary")).toBe("unsupported");
  });

  it("offers a source view only for rendered text formats", () => {
    expect(pageFileHasSourceView("html")).toBe(true);
    expect(pageFileHasSourceView("markdown")).toBe(true);
    expect(pageFileHasSourceView("svg")).toBe(true);
    expect(pageFileHasSourceView("text")).toBe(false);
    expect(pageFileHasSourceView("image")).toBe(false);
  });
});
