import { describe, expect, test } from "vite-plus/test";

import type { FilePreviewAuthority, FileReadAuthority } from "@/lib/library-file-resources";
import { describeAttachment, resolveAttachmentDestination } from "./attachment-reference";

const FILE_ID = "0199134e-cbb0-7000-8000-000000000006";
const routingContext = { kind: "project", projectId: "project-1" } as const;
const pageAuthority: FileReadAuthority = {
  contentRoutingContext: routingContext,
  storeEpoch: "store-1",
  libraryId: "library-1",
  readSource: { kind: "page", page_id: "page-1" },
};
const saved = {
  kind: "file",
  mode: "materialized",
  source: `nodex://files/${FILE_ID}`,
} as const;

describe("attachment destination", () => {
  test("opens a Library File beside its Page when the surface can open Page File tabs", () => {
    expect(
      resolveAttachmentDestination({
        attachment: saved,
        authority: pageAuthority,
        canOpenPageFile: true,
      }),
    ).toEqual({ kind: "page-file", routingContext, pageId: "page-1", fileId: FILE_ID });
  });

  test("keeps a captured or tab-less read in a viewer bound to the surface's authority", () => {
    const revision: FileReadAuthority = {
      ...pageAuthority,
      readSource: { kind: "document_revision", document_id: "document-1", revision_id: "r-1" },
    };
    const exactVersion: FileReadAuthority = { ...pageAuthority, version: 3 };
    const recovery: FilePreviewAuthority = {
      contentRoutingContext: routingContext,
      storeEpoch: "store-1",
      libraryId: "library-1",
      bindings: {},
    };
    for (const authority of [revision, exactVersion, recovery]) {
      expect(
        resolveAttachmentDestination({ attachment: saved, authority, canOpenPageFile: true }),
      ).toEqual({ kind: "file-viewer", authority, fileId: FILE_ID });
    }
    expect(
      resolveAttachmentDestination({
        attachment: saved,
        authority: pageAuthority,
        canOpenPageFile: false,
      }),
    ).toEqual({ kind: "file-viewer", authority: pageAuthority, fileId: FILE_ID });
  });

  test("cannot open a Library File without a read authority", () => {
    expect(
      resolveAttachmentDestination({ attachment: saved, authority: null, canOpenPageFile: true }),
    ).toEqual({ kind: "none" });
  });

  test("opens linked paths and older saved copies as local files", () => {
    expect(
      resolveAttachmentDestination({
        attachment: { kind: "folder", mode: "link", source: "/Users/me/Reports" },
        authority: pageAuthority,
        canOpenPageFile: true,
      }),
    ).toEqual({ kind: "local-path", path: "/Users/me/Reports", directory: true });
    expect(
      resolveAttachmentDestination({
        attachment: { kind: "text", mode: "materialized", source: "nodex://assets/notes.txt" },
        authority: null,
        canOpenPageFile: false,
      }),
    ).toEqual({ kind: "managed-asset", source: "nodex://assets/notes.txt", directory: false });
  });
});

describe("attachment summary", () => {
  test("names the File, then its format and size", () => {
    expect(
      describeAttachment({ ...saved, name: "guide.md", mimeType: "text/markdown", bytes: 31_744 }),
    ).toEqual({ title: "guide.md", detail: "Markdown · 31 KB" });
    expect(
      describeAttachment({
        kind: "text",
        mode: "materialized",
        source: `nodex://files/${FILE_ID}`,
        name: "Incident timeline",
        bytes: 12,
      }),
    ).toEqual({ title: "Incident timeline", detail: "Text · 12 B" });
  });

  test("shows where a linked attachment points", () => {
    expect(
      describeAttachment({
        kind: "file",
        mode: "link",
        source: "/tmp/report.txt",
        name: "report.txt",
        bytes: 2048,
      }),
    ).toEqual({ title: "report.txt", detail: "/tmp/report.txt" });
  });
});
