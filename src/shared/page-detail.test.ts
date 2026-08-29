import { describe, expect, test } from "vite-plus/test";

import { plainTextToPortableRichText } from "./block-documents";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "./database-identities";
import {
  PageDetailContractError,
  parseLibraryPageDetailResult,
  parsePageDetailResult,
  type PageDetailResult,
} from "./page-detail";
import { testPropertyManagement } from "./testing/database-property-record";
import { authorizedReadStampFixture } from "./testing/authorized-read-stamp-fixture";

const timestamp = "2026-07-16T00:00:00.000Z";
const databaseId = parseDatabaseId("019f714b-0000-7000-8000-000000000001");
const dataSourceId = parseDataSourceId("019f714b-0000-7000-8000-000000000002");
const viewId = parseDatabaseViewId("019f714b-0000-7000-8000-000000000003");
const statusPropertyId = parseDataSourcePropertyId("status");

const memberResult = (): PageDetailResult => ({
  ok: true,
  value: {
    projectId: "project-1",
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 2,
    authorization: authorizedReadStampFixture({
      deliveryAddress: {
        kind: "project",
        library_id: "library-1",
        project_id: "project-1",
      },
      subject: { kind: "page", page_id: "page-1" },
      commitSeq: 2,
    }),
    page: {
      pageId: "page-1",
      libraryId: "library-1",
      parent: { kind: "data_source", dataSourceId },
      lifecycle: "active",
      parentRevision: 1,
      metadataRevision: 1,
      documentId: "document-1",
      documentGeneration: 1,
      documentHeadSeq: 1,
      title: "Page",
      richTitle: plainTextToPortableRichText("Page"),
      preview: "",
      plainText: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    document: {
      readiness: "ready",
      schemaKey: "nodex.page",
      schemaVersion: 3,
    },
    intrinsicProperties: [],
    dataSourceContext: {
      kind: "member",
      pageKey: "PROJ-1",
      membership: {
        membershipId: "membership-1",
        dataSourceId,
        revision: 1,
        createdAt: timestamp,
      },
      database: {
        databaseId,
        libraryId: "library-1",
        name: "Database",
        lifecycle: "active",
        defaultViewId: viewId,
        accessRevision: 1,
        metadataRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      dataSource: {
        dataSourceId,
        libraryId: "library-1",
        homeDatabaseId: databaseId,
        name: "Pages",
        schemaKey: "nodex.data-source",
        schemaRevision: 1,
        lifecycle: "active",
        rankKey: "a0",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      properties: [
        {
          propertyId: statusPropertyId,
          dataSourceId,
          name: "Status",
          schema: { kind: "select" },
          capabilities: {
            filterOperators: ["select_is", "select_is_not", "is_empty", "is_not_empty"],
            sortable: true,
            groupable: true,
          },
          ...testPropertyManagement(),
          valueType: "select",
          config: {},
          optionCount: 1,
          rankKey: "a0",
          lifecycle: "active",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      pageLayout: {
        dataSourceId,
        revision: 1,
        entries: [{ propertyId: statusPropertyId, rankKey: "a0", visibility: "always_show" }],
      },
      values: {
        status: {
          propertyId: statusPropertyId,
          valueType: "select",
          value: "triage",
          revision: 1,
        },
      },
    },
  },
});

describe("Page Detail contract", () => {
  test("accepts nullable string and JSON intrinsic values", () => {
    const result = memberResult();
    if (!result.ok) throw new Error("Expected Page Detail fixture");
    const parsed = parsePageDetailResult({
      ...result,
      value: {
        ...result.value,
        intrinsicProperties: [
          { key: "description", valueType: "string", value: null, revision: 1 },
          { key: "metadata", valueType: "json", value: null, revision: 2 },
        ],
      },
    });

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        intrinsicProperties: [
          { key: "description", valueType: "string", value: null },
          { key: "metadata", valueType: "json", value: null },
        ],
      },
    });
  });

  test("accepts one coherent Page → Data Source → Database ownership chain", () => {
    const parsed = parsePageDetailResult(memberResult());
    expect(parsed.ok && parsed.value.page.parent).toEqual({
      kind: "data_source",
      dataSourceId,
    });
  });

  test("parses Library Page Detail without a Project coordinate", () => {
    const result = memberResult();
    if (!result.ok) return;
    const { projectId: _projectId, ...detail } = result.value;
    void _projectId;
    const parsed = parseLibraryPageDetailResult({
      ok: true,
      value: { ...detail, accessContext: { kind: "library" } },
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: { accessContext: { kind: "library" } },
    });
    if (parsed.ok) expect("projectId" in parsed.value).toBe(false);
  });

  test("rejects a membership that differs from the exclusive Page parent", () => {
    const result = structuredClone(memberResult());
    if (!result.ok || result.value.dataSourceContext.kind !== "member") return;
    const mutable = result.value.dataSourceContext.membership as {
      dataSourceId: string;
    };
    mutable.dataSourceId = "019f714b-0000-7000-8000-000000000004";

    expect(() => parsePageDetailResult(result)).toThrow(
      "Page parent and Data Source membership diverge",
    );
  });

  test("rejects a property value whose identity is not in the Source schema", () => {
    const result = structuredClone(memberResult()) as unknown as {
      ok: true;
      value: {
        dataSourceContext: {
          values: Record<string, unknown>;
        };
      };
    };
    result.value.dataSourceContext.values["unknown-property"] = {
      propertyId: "unknown-property",
      valueType: "text",
      value: "leak",
      revision: 1,
    };

    expect(() => parsePageDetailResult(result)).toThrow(PageDetailContractError);
  });
});
