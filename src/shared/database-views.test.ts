import { describe, expect, test } from "vite-plus/test";
import { evaluateDatabaseViewRows, type DatabaseViewReadModel } from "./database-views";
import type { DatabasePageSummary } from "./types";
import { authorizedReadStampFixture } from "./testing/authorized-read-stamp-fixture";

const makePage = (id: string): DatabasePageSummary => ({
  id,
  pageKey: null,
  status: "build",
  archived: false,
  title: id,
  richTitle: [{ type: "text", text: id, styles: {} }],
  priority: undefined,
  tags: [],
  created: new Date("2026-01-01T00:00:00.000Z"),
  order: 0,
  descriptionPreview: "",
  descriptionLength: 0,
  hasDescription: false,
});

const makeReadModel = (includeHostPage: boolean): DatabaseViewReadModel => ({
  libraryId: "library:test",
  storeEpoch: "epoch:test",
  commitSeq: 1,
  authorization: authorizedReadStampFixture({
    deliveryAddress: {
      kind: "project",
      library_id: "library:test",
      project_id: "project:test",
    },
    subject: { kind: "view", view_id: "view:test" },
    storeEpoch: "epoch:test",
  }),
  dataSourceId: "data-source:test",
  view: {
    id: "view:test",
    databaseBlockId: "database:test",
    projectId: "project:test",
    name: "Test",
    layout: "list",
    config: { options: { includeHostPage } },
    isPrimary: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  rows: ["host", "sibling"].map((id) => ({
    page: makePage(id),
    groupKey: null,
    subgroupKey: null,
    rankKey: id,
  })),
});

describe("durable Database View contracts", () => {
  test("hides the host Page unless the canonical View opts in", () => {
    expect(evaluateDatabaseViewRows(makeReadModel(false), { hostBlockId: "host" })).toHaveLength(1);
    expect(evaluateDatabaseViewRows(makeReadModel(true), { hostBlockId: "host" })).toHaveLength(2);
  });
});
