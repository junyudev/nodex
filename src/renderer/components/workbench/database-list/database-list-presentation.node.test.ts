import { describe, expect, test } from "vite-plus/test";
import type { DatabaseViewField } from "../../../../shared/database-kernel";
import {
  databaseListGridTemplate,
  databaseListIdentifierMinWidth,
  databaseListIdentifierSamples,
  partitionDatabaseListFields,
  projectDatabaseListPageIdentity,
  withForcedDatabaseListField,
} from "./database-list-grid";
import type { DatabaseListPageRow } from "./database-list-model";
import {
  databaseListDropIndicatorLeft,
  databaseListNestingContinuations,
  databaseListNestingGeometry,
  databaseListNestingLineInset,
  databaseListNestingLineLeft,
} from "./database-list-nesting-lines";
import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";
import {
  databaseListGroupLabel,
  databaseListPropertyHasValue,
} from "./database-list-property-presentation";

describe("database list grid", () => {
  const fields: readonly DatabaseViewField[] = [
    { kind: "property", propertyId: "assignee" },
    { kind: "property", propertyId: "labels" },
    { kind: "intrinsic", field: "updated_at" },
  ];

  describe("Database List field registry", () => {
    test("packs properties into the title cell and reserves grid tracks only for timestamps", () => {
      const partition = partitionDatabaseListFields([
        { kind: "intrinsic", field: "page_key" },
        ...fields,
      ]);
      expect(partition.identityFields).toEqual(["page_key"]);
      expect(partition.inlineFields).toEqual(fields.slice(0, 2));
      expect(partition.trailingFields).toEqual([fields[2]]);

      const template = databaseListGridTemplate(
        partition.trailingFields,
        {
          identifier: true,
          priority: true,
          status: true,
        },
        51,
      );
      expect(template).toContain("[title] minmax(0,1fr)");
      expect(template).toContain("[identifier] minmax(51px,auto)");
      expect(template).toContain("[updated_at] minmax(60px,auto)");
      expect(template).not.toContain("property:assignee");
      expect(template).not.toContain("dynamic-");
    });

    test("removes optional core tracks without changing the title/property cluster", () => {
      const coreColumns = { identifier: false, priority: false, status: true };
      const template = databaseListGridTemplate([], coreColumns);
      expect(template).not.toContain("[priority]");
      expect(template).toContain("[identifier status] 20px");
      expect(template).not.toContain("[identifier] minmax");
      expect(template).toContain("[title] minmax(0,1fr)");
    });

    test("removes the public ID from its visible grid track", () => {
      const partition = partitionDatabaseListFields(fields);
      expect(partition.identityFields).toEqual([]);

      const template = databaseListGridTemplate(partition.trailingFields, {
        identifier: partition.identityFields.length > 0,
        priority: true,
        status: true,
      });
      expect(template).toContain("[identifier status] 20px");
      expect(template).not.toContain("[identifier] minmax");
      expect(partition.trailingFields).toEqual([{ kind: "intrinsic", field: "updated_at" }]);
    });

    test("aliases the hidden identifier boundary onto a real track in every core layout", () => {
      expect(
        databaseListGridTemplate([], {
          identifier: false,
          priority: true,
          status: true,
        }),
      ).toContain("[identifier status] 20px");
      expect(
        databaseListGridTemplate([], {
          identifier: false,
          priority: true,
          status: false,
        }),
      ).toContain("[identifier title] minmax(0,1fr)");
    });

    test("measures each prefix and number depth instead of imposing a three-letter width", () => {
      const twoCharacterSamples = databaseListIdentifierSamples(
        ["NO-1", "NO-13"],
        (pageKey) => pageKey,
      );
      const threeCharacterSamples = databaseListIdentifierSamples(
        ["NOD-1", "NOD-13"],
        (pageKey) => pageKey,
      );
      expect(twoCharacterSamples).toHaveLength(10);
      expect(twoCharacterSamples).toContain("NO-88");
      expect(threeCharacterSamples).toContain("NOD-88");

      const measure = (value: string): number => value.length * 7;
      const twoCharacterWidth = databaseListIdentifierMinWidth(twoCharacterSamples, measure);
      const threeCharacterWidth = databaseListIdentifierMinWidth(threeCharacterSamples, measure);
      expect(twoCharacterWidth).toBe(35);
      expect(threeCharacterWidth).toBe(42);
      expect(databaseListGridTemplate([], undefined, twoCharacterWidth)).toContain(
        "[identifier] minmax(35px,auto)",
      );
    });

    test("uses the widest plausible numeral without measuring every row", () => {
      const samples = databaseListIdentifierSamples(
        ["NO-1", "NO-999", "LAB-20", null, "not-a-key"],
        (pageKey) => pageKey,
      );
      expect(samples).toHaveLength(20);
      expect(samples).toContain("NO-888");
      expect(samples).toContain("LAB-88");
      expect(
        databaseListIdentifierMinWidth(samples, (value) =>
          value.includes("8") ? value.length * 6 : value.length * 5,
        ),
      ).toBe(36);
    });

    test("adds an ordering field only to the current List session without duplicating it", () => {
      const created = { kind: "intrinsic", field: "created_at" } as const;
      expect(withForcedDatabaseListField(fields, created)).toEqual([...fields, created]);
      expect(withForcedDatabaseListField([...fields, created], created)).toEqual([
        ...fields,
        created,
      ]);
      expect(withForcedDatabaseListField(fields, null)).toBe(fields);
    });

    test("projects only the readable ID into the measured identity lane", () => {
      const identityFields = partitionDatabaseListFields([
        { kind: "intrinsic", field: "page_key" },
      ]).identityFields;
      expect(projectDatabaseListPageIdentity("LAB-13", identityFields)).toEqual({
        label: "LAB-13",
        title: "LAB-13",
      });
    });

    test("projects a high-cardinality row model in one linear pass", () => {
      const identities = Array.from({ length: 10_000 }, (_, index) =>
        projectDatabaseListPageIdentity(`LAB-${index + 1}`, ["page_key"]),
      );
      expect(identities).toHaveLength(10_000);
      expect(identities[0]?.label).toBe("LAB-1");
      expect(identities.at(-1)?.label).toBe("LAB-10000");
    });
  });
});

describe("database list nesting lines", () => {
  const page = (
    key: string,
    pageId: string,
    ancestorPageIds: readonly string[],
  ): DatabaseListPageRow => ({
    kind: "page",
    key,
    pageId,
    row: {
      pageId,
      pageKey: null,
      groupKey: "doing",
      subgroupKey: null,
      title: pageId,
      preview: "",
      plainText: "",
      tags: [],
      taskParentValueRevision: 1,
      documentGeneration: 1,
      documentHeadSeq: 1,
      metadataRevision: 1,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    },
    groupKey: "doing",
    subgroupKey: null,
    ancestorPageIds,
    depth: ancestorPageIds.length,
    hasChildren: false,
    transientKind: "none",
    subtreeOccurrenceCount: 1,
    concreteSubtreePageCount: 1,
    subtreeHeight: 0,
    firstChildOccurrenceKey: null,
    firstInGroup: false,
    lastInGroup: false,
    height: 44,
  });

  describe("Database List nesting guides", () => {
    test("anchors every tree level to the leading identity lane", () => {
      expect(databaseListNestingLineLeft(0)).toBe(35.5);
      expect(databaseListNestingLineLeft(1)).toBe(59.5);
      expect(databaseListNestingLineLeft(2)).toBe(83.5);
      expect(databaseListNestingLineInset(0)).toBe(29.5);
      expect(databaseListNestingLineInset(1)).toBe(53.5);
      expect(databaseListDropIndicatorLeft(0)).toBe(8);
      expect(databaseListDropIndicatorLeft(1)).toBe(52);
      expect(databaseListDropIndicatorLeft(2)).toBe(76);
    });

    test("aligns stems and elbows to the full Page row", () => {
      expect(databaseListNestingGeometry(44)).toEqual({
        fullVerticalLineHeight: 16,
        nestingLineTop: 15,
        parentLineTop: 39,
      });
    });

    test("continues only ancestor branches with a later direct sibling", () => {
      const rows = [
        page("root", "root", []),
        page("child-a", "child-a", ["root"]),
        page("grandchild", "grandchild", ["root", "child-a"]),
        page("child-b", "child-b", ["root"]),
      ];

      const continuations = databaseListNestingContinuations(rows);

      expect(continuations.get("child-a")).toEqual([true]);
      expect(continuations.get("grandchild")).toEqual([true, false]);
      expect(continuations.get("child-b")).toEqual([false]);
    });

    test("keeps identical Page ids in separate group occurrence trees", () => {
      const duplicate = page("other-group", "child-a", ["root"]);
      const rows = [
        page("first", "child-a", ["root"]),
        {
          ...duplicate,
          groupKey: "done",
          row: { ...duplicate.row, groupKey: "done" },
        },
      ];

      const continuations = databaseListNestingContinuations(rows);

      expect(continuations.get("first")).toEqual([false]);
      expect(continuations.get("other-group")).toEqual([false]);
    });
  });
});

describe("database list property presentation", () => {
  const property = (
    valueType: DataSourcePropertyRecordV2["valueType"],
  ): DataSourcePropertyRecordV2 => ({
    propertyId: "custom:test" as DataSourcePropertyRecordV2["propertyId"],
    dataSourceId: "data-source:test" as DataSourcePropertyRecordV2["dataSourceId"],
    name: "Test",
    ...testPropertySemantics(valueType),
    valueType,
    config: {},
    optionCount: 0,
    rankKey: "a",
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });

  describe("Database List property presence", () => {
    test("presents canonical workflow status labels without rewriting custom options", () => {
      expect(databaseListGroupLabel("status", "triage", "Incoming")).toBe("Incoming");
      expect(databaseListGroupLabel("status", "doing", "In progress")).toBe("In progress");
      expect(databaseListGroupLabel("custom:phase", "doing", "Engineering")).toBe("Engineering");
    });

    test("omits visual placeholders while preserving meaningful falsy values", () => {
      expect(databaseListPropertyHasValue(property("text"), "")).toBe(false);
      expect(databaseListPropertyHasValue(property("multi_select"), [])).toBe(false);
      expect(databaseListPropertyHasValue(property("checkbox"), false)).toBe(false);
      expect(databaseListPropertyHasValue(property("number"), 0)).toBe(true);
      expect(databaseListPropertyHasValue(property("checkbox"), true)).toBe(true);
    });

    test("uses relation totals instead of object truthiness", () => {
      const emptyRelation = {
        kind: "relation",
        value: {
          value_revision: 1,
          total_count: 0,
          targets: [],
          unavailable_count: 0,
          has_more: false,
        },
      } as const;
      expect(databaseListPropertyHasValue(property("relation"), emptyRelation)).toBe(false);
    });
  });
});
