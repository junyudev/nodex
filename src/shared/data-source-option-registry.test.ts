import { describe, expect, test } from "vite-plus/test";
import {
  DataSourceOptionRegistryError,
  dataSourceOptionRegistryConfig,
  deleteDataSourceOption,
  parseDataSourceOptionRegistry,
  putDataSourceOption,
  resolveTagOptionByCanonicalName,
  validateDataSourceOptionSelection,
  type DataSourceOptionRegistry,
  type DataSourceOptionRegistryErrorCode,
} from "./data-source-option-registry";

const TAG_ONE = "o_AAAAAAAA";
const TAG_TWO = "o_BBBBBBBB";
const TAG_THREE = "o_CCCCCCCC";
const CUSTOM_PROPERTY = "p_AAAAAAAA";

const expectRegistryError = (
  action: () => unknown,
  code: DataSourceOptionRegistryErrorCode,
): DataSourceOptionRegistryError => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DataSourceOptionRegistryError);
    expect((error as DataSourceOptionRegistryError).code).toBe(code);
    return error as DataSourceOptionRegistryError;
  }
  throw new Error(`Expected DataSourceOptionRegistryError(${code})`);
};

const tagsRegistry = (): DataSourceOptionRegistry =>
  parseDataSourceOptionRegistry({
    dataSourceId: "source-a",
    propertyId: "tags",
    valueType: "multi_select",
    config: {
      options: [
        { id: TAG_ONE, name: "Café", color: "blue" },
        { id: TAG_TWO, name: "Ops" },
      ],
    },
  });

describe("Data Source option registry", () => {
  test("parses owner-qualified option identities and serializes the config", () => {
    const registry = parseDataSourceOptionRegistry({
      dataSourceId: "source-a",
      propertyId: "status",
      valueType: "select",
      config: {
        options: [
          { id: "triage", name: "Triage", color: "gray" },
          { id: "done", name: "Done" },
        ],
      },
    });

    expect(registry).toMatchObject({
      dataSourceId: "source-a",
      propertyId: "status",
      valueType: "select",
    });
    expect(dataSourceOptionRegistryConfig(registry)).toEqual({
      options: [
        { id: "triage", name: "Triage", color: "gray" },
        { id: "done", name: "Done" },
      ],
    });

    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: "status",
          valueType: "select",
          config: { options: [{ id: TAG_ONE, name: "Not semantic" }] },
        }),
      "invalid_registry",
    );
    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: "due_date",
          valueType: "select",
          config: { options: [] },
        }),
      "invalid_registry",
    );
  });

  test("requires stored tag names to be canonical and unique", () => {
    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: "tags",
          valueType: "multi_select",
          config: { options: [{ id: TAG_ONE, name: " Cafe\u0301 " }] },
        }),
      "invalid_registry",
    );
    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: "tags",
          valueType: "multi_select",
          config: {
            options: [
              { id: TAG_ONE, name: "Ops" },
              { id: TAG_TWO, name: "Ops" },
            ],
          },
        }),
      "option_name_conflict",
    );

    const registry = parseDataSourceOptionRegistry({
      dataSourceId: "source-a",
      propertyId: "tags",
      valueType: "multi_select",
      config: {
        options: [
          { id: TAG_ONE, name: "Ops" },
          { id: TAG_TWO, name: "ops" },
        ],
      },
    });
    expect(registry.options.map((option) => option.name)).toEqual(["Ops", "ops"]);
  });

  test("shares Core's 100-option and UTF-8 byte bounds", () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      id: `o_${index.toString(36).padStart(8, "0")}`,
      name: `Option ${index}`,
    }));
    const registry = parseDataSourceOptionRegistry({
      dataSourceId: "source-a",
      propertyId: CUSTOM_PROPERTY,
      valueType: "select",
      config: { options },
    });
    expect(registry.options).toHaveLength(100);
    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: CUSTOM_PROPERTY,
          valueType: "select",
          config: {
            options: [...options, { id: "o_overflow", name: "Overflow" }],
          },
        }),
      "invalid_registry",
    );
    expectRegistryError(
      () =>
        putDataSourceOption(registry, {
          optionId: "o_overflow",
          name: "Overflow",
        }),
      "invalid_registry",
    );
    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: "tags",
          valueType: "multi_select",
          config: {
            options: [{ id: TAG_ONE, name: "界".repeat(86) }],
          },
        }),
      "invalid_registry",
    );
    expectRegistryError(
      () =>
        parseDataSourceOptionRegistry({
          dataSourceId: "source-a",
          propertyId: CUSTOM_PROPERTY,
          valueType: "select",
          config: {
            options: [
              {
                id: TAG_ONE,
                name: "Name",
                color: "界".repeat(43),
              },
            ],
          },
        }),
      "invalid_registry",
    );
  });

  test("resolves tag names after canonicalization but remains case-sensitive", () => {
    const registry = tagsRegistry();

    expect(resolveTagOptionByCanonicalName(registry, "  Cafe\u0301  ")?.optionId).toBe(TAG_ONE);
    expect(resolveTagOptionByCanonicalName(registry, "café")).toBeNull();
    expect(resolveTagOptionByCanonicalName(registry, "Ops")?.optionId).toBe(TAG_TWO);
    expect(resolveTagOptionByCanonicalName(registry, "ops")).toBeNull();
  });

  test("puts options immutably and rejects a second tag identity for one name", () => {
    const original = tagsRegistry();
    const appended = putDataSourceOption(original, {
      optionId: TAG_THREE,
      name: "  Release train  ",
      color: "green",
    });
    const renamed = putDataSourceOption(appended, {
      optionId: TAG_THREE,
      name: "Release Train",
    });

    expect(original.options).toHaveLength(2);
    expect(appended.options[2]).toEqual({
      optionId: TAG_THREE,
      name: "Release train",
      color: "green",
    });
    expect(renamed.options[2]).toEqual({
      optionId: TAG_THREE,
      name: "Release Train",
    });
    expectRegistryError(
      () =>
        putDataSourceOption(original, {
          optionId: TAG_THREE,
          name: "Ops",
        }),
      "option_name_conflict",
    );
  });

  test("validates and canonicalizes selected values against the registry", () => {
    const multi = parseDataSourceOptionRegistry({
      dataSourceId: "source-a",
      propertyId: CUSTOM_PROPERTY,
      valueType: "multi_select",
      config: {
        options: [
          { id: TAG_ONE, name: "First" },
          { id: TAG_TWO, name: "Second" },
        ],
      },
    });
    expect(validateDataSourceOptionSelection(multi, [TAG_TWO, TAG_ONE, TAG_TWO])).toEqual([
      TAG_ONE,
      TAG_TWO,
    ]);
    expect(validateDataSourceOptionSelection(multi, null)).toBeNull();
    expectRegistryError(
      () => validateDataSourceOptionSelection(multi, [TAG_THREE]),
      "invalid_selection",
    );

    const select = parseDataSourceOptionRegistry({
      dataSourceId: "source-a",
      propertyId: CUSTOM_PROPERTY,
      valueType: "select",
      config: { options: [{ id: TAG_ONE, name: "First" }] },
    });
    expect(validateDataSourceOptionSelection(select, TAG_ONE)).toBe(TAG_ONE);
    expectRegistryError(
      () => validateDataSourceOptionSelection(select, [TAG_ONE]),
      "invalid_selection",
    );
  });

  test("deletes only options absent from every current selected value", () => {
    const registry = tagsRegistry();

    expectRegistryError(
      () =>
        deleteDataSourceOption(registry, {
          optionId: TAG_ONE,
          selectedValues: [[], [TAG_ONE, TAG_TWO]],
        }),
      "option_in_use",
    );
    expectRegistryError(
      () =>
        deleteDataSourceOption(registry, {
          optionId: TAG_ONE,
          selectedValues: [[TAG_THREE]],
        }),
      "invalid_selection",
    );

    const deleted = deleteDataSourceOption(registry, {
      optionId: TAG_ONE,
      selectedValues: [null, [], [TAG_TWO]],
    });
    expect(deleted.options.map((option) => option.optionId)).toEqual([TAG_TWO]);
    expect(registry.options.map((option) => option.optionId)).toEqual([TAG_ONE, TAG_TWO]);
    expectRegistryError(
      () =>
        deleteDataSourceOption(registry, {
          optionId: TAG_THREE,
          selectedValues: [],
        }),
      "option_not_found",
    );
  });
});
