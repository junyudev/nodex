import { describe, expect, test } from "vite-plus/test";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import {
  buildDataSourceRelationCandidateRead,
  searchRelationTitles,
} from "./data-source-relation-runtime";

const property: DataSourcePropertyRecordV2 = {
  propertyId: parseDataSourcePropertyId("p_Relation"),
  dataSourceId: parseDataSourceId("source-current"),
  name: "Blocked by",
  ...testPropertySemantics("relation"),
  schema: {
    kind: "relation",
    targetDataSourceId: parseDataSourceId("source-target"),
    cardinality: "many",
  },
  valueType: "relation",
  config: {},
  optionCount: 0,
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

describe("Relation candidate runtime", () => {
  test.each(["", "   ", "\u3000"])(
    "encodes an empty editor query as an unfiltered first window: %j",
    (query) => {
      const read = buildDataSourceRelationCandidateRead({ property, query });
      expect(read).toMatchObject({
        target: { kind: "data_source", dataSourceId: "source-target" },
        mode: "relation_candidate_window",
        window: { after: null, first: 100 },
      });
      expect(read && "query" in read).toBe(false);
    },
  );

  test("trims a filtered continuation without changing its cursor", () => {
    expect(
      buildDataSourceRelationCandidateRead({
        property,
        query: "  Ｂlocked  ",
        after: "opaque-cursor",
      }),
    ).toMatchObject({
      query: "Ｂlocked",
      window: { after: "opaque-cursor", first: 100 },
    });
  });

  test("matches target titles with word boundaries, width folding, and typo fallback", () => {
    const candidates = [
      { title: "QueryMigartion" },
      { title: "QueryMigration" },
      { title: "数据库迁移方案" },
    ];
    expect(searchRelationTitles(candidates, "Ｍｉｇｒａｔｉｏｎ")).toEqual([candidates[1]]);
    expect(searchRelationTitles([candidates[1]], "migartion")).toEqual([candidates[1]]);
    expect(searchRelationTitles(candidates, "迁移")).toEqual([candidates[2]]);
  });
});
