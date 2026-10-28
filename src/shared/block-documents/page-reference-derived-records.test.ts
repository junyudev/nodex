import { describe, expect, test } from "vite-plus/test";
import { deriveBlockDocumentRecords } from "./derived-records";
import { createPageDocumentGenesis } from "./block-document-codec";

describe("Block references and asset occurrences", () => {
  test("aggregates Page mentions separately from links and reference Blocks", () => {
    const page = createPageDocumentGenesis({
      documentId: "references",
      markdown:
        'See <nodex://pages/page-1> and <nodex://pages/page-1> or [the Page](nodex://pages/page-1)\n\n::page-ref{page="page-1"}',
    });
    try {
      expect(
        page.materialization.references.map(({ sourceBlockId: _, ...reference }) => reference),
      ).toEqual([
        { kind: "page", targetPageId: "page-1", presentation: "mention", occurrenceCount: 2 },
        { kind: "page", targetPageId: "page-1", presentation: "link", occurrenceCount: 1 },
        {
          kind: "page",
          targetPageId: "page-1",
          presentation: "reference_block",
          occurrenceCount: 1,
        },
      ]);
    } finally {
      page.document.destroy();
    }
  });
  test("uses Session identity and finds linked inline images in table cells", () => {
    const records = deriveBlockDocumentRecords([
      {
        id: "table",
        type: "table",
        props: {},
        children: [],
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                {
                  content: [
                    { type: "threadMention", props: { uuid: "session-1" } },
                    {
                      type: "link",
                      href: "https://example.com",
                      content: [
                        {
                          type: "inlineImage",
                          props: { url: "nodex://files/file-1", alt: "Diagram" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(records.references).toEqual([
      { kind: "session", sourceBlockId: "table", targetSessionId: "session-1" },
    ]);
    expect(records.assetRefs).toEqual([
      {
        sourceBlockId: "table",
        kind: "image",
        source: "nodex://files/file-1",
        managedFileName: null,
      },
    ]);
  });
});
