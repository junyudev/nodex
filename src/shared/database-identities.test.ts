import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { createUuidV7FromTimestamp, isUuidV7 } from "./uuid-v7";
import {
  BUILT_IN_DATA_SOURCE_PROPERTY_IDS,
  canonicalizeTagName,
  createCustomOptionId,
  createCustomPropertyId,
  createInitialDatabaseIdentities,
  isBuiltInDataSourceOptionId,
  isBuiltInDataSourcePropertyId,
  isReservedDataSourcePropertyId,
  parseDatabaseId,
  parseDataSourceOptionId,
  parseDataSourcePropertyId,
  type DataSourceOptionRef,
  type DataSourcePropertyRef,
} from "./database-identities";

const deterministicBytes = (length: number): Uint8Array => {
  expect(length).toBe(6);
  return Uint8Array.from([0, 1, 2, 253, 254, 255]);
};

describe("database identities", () => {
  test("allocates independent UUID-v7 identities for an initial Database", () => {
    const identities = createInitialDatabaseIdentities();

    expect(isUuidV7(identities.databaseId)).toBe(true);
    expect(isUuidV7(identities.dataSourceId)).toBe(true);
    expect(isUuidV7(identities.viewId)).toBe(true);
    expect(new Set(Object.values(identities))).toHaveLength(3);
  });

  test("validates injected UUID values and rejects coupled allocation", () => {
    const values = [
      createUuidV7FromTimestamp(1_762_400_000_000, 0),
      createUuidV7FromTimestamp(1_762_400_000_000, 1),
      createUuidV7FromTimestamp(1_762_400_000_000, 2),
    ];
    const identities = createInitialDatabaseIdentities(() => values.shift()!);

    expect(identities).toEqual({
      databaseId: createUuidV7FromTimestamp(1_762_400_000_000, 0),
      dataSourceId: createUuidV7FromTimestamp(1_762_400_000_000, 1),
      viewId: createUuidV7FromTimestamp(1_762_400_000_000, 2),
    });

    const duplicate = createUuidV7FromTimestamp(1_762_400_000_001, 0);
    expect(() => createInitialDatabaseIdentities(() => duplicate)).toThrow(
      "independently allocated",
    );
    expect(() => createInitialDatabaseIdentities(() => "not-a-uuid")).toThrow(
      "canonical lowercase UUID-v7",
    );
  });

  test("keeps existing global identities opaque while validating their transport form", () => {
    expect(parseDatabaseId("database:legacy:primary")).toBe("database:legacy:primary");
    expect(() => parseDatabaseId(" database:legacy:primary ")).toThrow(
      "canonical non-empty identity",
    );
    expect(() => parseDatabaseId("database:\nlegacy")).toThrow("canonical non-empty identity");
  });

  test("generates eight base64url characters from exactly six bytes", () => {
    expect(createCustomPropertyId(deterministicBytes)).toBe("p_AAEC_f7_");
    expect(createCustomOptionId(deterministicBytes)).toBe("o_AAEC_f7_");
    expect(createCustomPropertyId()).toMatch(/^p_[A-Za-z0-9_-]{8}$/u);
    expect(createCustomOptionId()).toMatch(/^o_[A-Za-z0-9_-]{8}$/u);

    expect(() => createCustomPropertyId(() => new Uint8Array(5))).toThrow("exactly 6 bytes");
    expect(() =>
      createCustomOptionId((() => [0, 1, 2, 3, 4, 5]) as unknown as (length: number) => Uint8Array),
    ).toThrow("must return Uint8Array");
  });

  test("accepts only reserved or compact Property identities", () => {
    expect(BUILT_IN_DATA_SOURCE_PROPERTY_IDS).toEqual([
      "status",
      "priority",
      "estimate",
      "tags",
      "due_date",
      "scheduled_start",
      "scheduled_end",
      "assignee",
      "task_parent",
      "blocked_by",
    ]);
    for (const propertyId of BUILT_IN_DATA_SOURCE_PROPERTY_IDS) {
      expect(parseDataSourcePropertyId(propertyId)).toBe(propertyId);
      expect(isBuiltInDataSourcePropertyId(propertyId)).toBe(true);
      expect(isReservedDataSourcePropertyId(propertyId)).toBe(true);
    }
    expect(parseDataSourcePropertyId("p_0123abcd")).toBe("p_0123abcd");
    for (const invalid of [
      "p_0123abc",
      "p_0123abcde",
      "o_0123abcd",
      "database:project:primary:property:status",
      "550e8400-e29b-41d4-a716-446655440000",
      " status",
    ]) {
      expect(() => parseDataSourcePropertyId(invalid)).toThrow();
    }
  });

  test("validates built-in option identities against their owning Property", () => {
    expect(isBuiltInDataSourceOptionId("status", "done")).toBe(true);
    expect(isBuiltInDataSourceOptionId("priority", "p0-critical")).toBe(true);
    expect(isBuiltInDataSourceOptionId("estimate", "xs")).toBe(true);
    expect(isBuiltInDataSourceOptionId("priority", "done")).toBe(false);
    for (const priority of ["p0-critical", "p1-high", "p2-medium", "p3-low"]) {
      expect(parseDataSourceOptionId({ propertyId: "priority", value: priority })).toBe(priority);
    }
    expect(() =>
      parseDataSourceOptionId({
        propertyId: "priority",
        value: "p4-later",
      }),
    ).toThrow("not valid");
    expect(isBuiltInDataSourceOptionId("tags", "done")).toBe(false);
    expect(isBuiltInDataSourceOptionId("toString", "call")).toBe(false);

    expect(parseDataSourceOptionId({ propertyId: "status", value: "done" })).toBe("done");
    expect(
      parseDataSourceOptionId({
        propertyId: "tags",
        value: "o_0123abcd",
      }),
    ).toBe("o_0123abcd");
    expect(
      parseDataSourceOptionId({
        propertyId: "p_abcdefgh",
        value: "o_0123abcd",
      }),
    ).toBe("o_0123abcd");

    expect(() => parseDataSourceOptionId({ propertyId: "priority", value: "done" })).toThrow(
      "not valid",
    );
    expect(() => parseDataSourceOptionId({ propertyId: "status", value: "ship" })).toThrow(
      "not valid",
    );
    expect(() => parseDataSourceOptionId({ propertyId: "tags", value: "bug" })).toThrow(
      "not valid",
    );
    expect(() =>
      parseDataSourceOptionId({
        propertyId: "priority",
        value: "o_0123abcd",
      }),
    ).toThrow("not valid");
    expect(() =>
      parseDataSourceOptionId({
        propertyId: "due_date",
        value: "o_0123abcd",
      }),
    ).toThrow("not valid");
  });

  test("canonicalizes tag names before applying caller-owned bounds", () => {
    expect(canonicalizeTagName("  Cafe\u0301  ")).toBe("Café");
    expect(canonicalizeTagName("\u0085ui\u0085")).toBe("ui");
    expect(canonicalizeTagName("\uFEFFui\uFEFF")).toBe("\uFEFFui\uFEFF");
    expect(canonicalizeTagName("  release candidate  ", { maxLength: 17 })).toBe(
      "release candidate",
    );
    expect(() => canonicalizeTagName("   ")).toThrow("must not be empty");
    expect(() => canonicalizeTagName("release", { maxLength: 6 })).toThrow("at most 6");
    expect(() => canonicalizeTagName("release", { maxLength: 0 })).toThrow("positive safe integer");
  });

  test("brands owner-qualified Property and option references", () => {
    const identities = createInitialDatabaseIdentities();
    const propertyRef: DataSourcePropertyRef = {
      dataSourceId: identities.dataSourceId,
      propertyId: parseDataSourcePropertyId("tags"),
    };
    const optionRef: DataSourceOptionRef = {
      ...propertyRef,
      optionId: parseDataSourceOptionId({
        propertyId: propertyRef.propertyId,
        value: "o_0123abcd",
      }),
    };

    expect(optionRef).toEqual({
      dataSourceId: identities.dataSourceId,
      propertyId: "tags",
      optionId: "o_0123abcd",
    });
    expectTypeOf(optionRef).toMatchTypeOf<DataSourceOptionRef>();
  });
});
