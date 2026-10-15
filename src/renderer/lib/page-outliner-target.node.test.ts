import { describe, expect, test } from "vite-plus/test";
import {
  PAGE_DOCUMENT_SCHEMA_VERSION,
  plainTextToPortableRichText,
} from "../../shared/block-documents";
import type { PageTargetReadModel } from "../../shared/page-targets";
import type { Page } from "../../shared/page";
import { projectContentRoute } from "../../shared/content-routing-context";
import {
  pageOutlinerInlineStateLabel,
  pageOutlinerPlainTitle,
  resolvePageOutlinerTarget,
  type PageOutlinerTargetInput,
} from "./page-outliner-target";

const page: Page & { readonly lifecycle: "active" } = {
  pageId: "page-target",
  libraryId: "library:target",
  lifecycle: "active",
  parent: { kind: "page", pageId: "host-page" },
  parentRevision: 1,
  metadataRevision: 2,
  documentId: "document:page-target",
  documentGeneration: 1,
  documentHeadSeq: 2,
  title: "Canonical title",
  richTitle: plainTextToPortableRichText("Canonical title"),
  preview: "",
  plainText: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const available: Extract<PageTargetReadModel, { readonly status: "available" }> = {
  libraryId: "library:target",
  storeEpoch: "epoch:test",
  commitSeq: 1,
  status: "available",
  targetPageId: page.pageId,
  page,
  document: {
    readiness: "ready",
    schemaKey: "nodex.page",
    schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  },
};

const input = (overrides: Partial<PageOutlinerTargetInput> = {}): PageOutlinerTargetInput => ({
  relationship: "reference",
  targetBlockId: page.pageId,
  model: available,
  loading: false,
  error: null,
  contentRoutingContext: projectContentRoute("host-project"),
  hostPageId: "host-page",
  ancestorPageIds: ["host-page"],
  ...overrides,
});

describe("resolvePageOutlinerTarget", () => {
  test("uses canonical target identity and summary", () => {
    expect(resolvePageOutlinerTarget(input())).toMatchObject({
      status: "available",
      relationship: "reference",
      targetBlockId: "page-target",
      contentRoutingContext: projectContentRoute("host-project"),
      page: { title: "Canonical title" },
      inlineMode: "editable",
    });
  });

  test("renders an intentionally empty authoritative title as Untitled", () => {
    const target = resolvePageOutlinerTarget(
      input({
        model: {
          ...available,
          page: {
            ...page,
            title: "",
            richTitle: [],
          },
        },
      }),
    );
    expect(pageOutlinerPlainTitle(target)).toBe("Untitled");
  });

  test("distinguishes self and ancestor cycles while preserving one target", () => {
    expect(resolvePageOutlinerTarget(input({ hostPageId: page.pageId }))).toMatchObject({
      status: "available",
      inlineMode: "self",
    });
    expect(
      resolvePageOutlinerTarget(input({ ancestorPageIds: ["host-page", page.pageId] })),
    ).toMatchObject({ status: "available", inlineMode: "cycle" });
  });

  test("makes archived targets non-editable independently of summary flags", () => {
    expect(
      resolvePageOutlinerTarget(
        input({
          model: {
            ...available,
            page: { ...page, lifecycle: "archived" },
          },
        }),
      ),
    ).toMatchObject({ status: "available", inlineMode: "archived" });
  });

  test("uses stable state copy when a target is unavailable", () => {
    const target = resolvePageOutlinerTarget(
      input({ model: null, targetBlockId: " missing-target " }),
    );
    expect(target).toEqual({
      status: "missing",
      relationship: "reference",
      targetBlockId: "missing-target",
      fallbackTitle: "Page unavailable",
    });
    expect(pageOutlinerInlineStateLabel(target)).toBe("Missing");
  });

  test("does not present a stale hint as a valid empty reference", () => {
    expect(resolvePageOutlinerTarget(input({ targetBlockId: " ", model: null }))).toEqual({
      status: "invalid_reference",
      relationship: "reference",
      targetBlockId: "",
      fallbackTitle: "Invalid Page mention",
    });
  });

  test("keeps a useful fallback and message when target loading fails", () => {
    expect(
      resolvePageOutlinerTarget(
        input({
          model: null,
          error: new Error("Transport closed"),
        }),
      ),
    ).toEqual({
      status: "error",
      relationship: "reference",
      targetBlockId: "page-target",
      fallbackTitle: "Page unavailable",
      message: "Transport closed",
    });
  });
});
