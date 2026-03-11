import { describe, expect, test } from "bun:test";
import { getDefaultToggleListSettings } from "./settings";
import {
  getDefaultToggleListInlineViewProps,
  mergeToggleListInlineViewProps,
  parseToggleListInlineViewSettings,
} from "./inline-view-props";

function encodeRules(rules: unknown): string {
  return Buffer.from(JSON.stringify(rules), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("toggle-list inline view props", () => {
  test("parses settings from canonical rulesV2 props", () => {
    const defaults = getDefaultToggleListSettings();
    const settings = parseToggleListInlineViewSettings({
      rulesV2B64: encodeRules({
        ...defaults.rulesV2,
        mode: "advanced",
        includeHostCard: true,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["backlog", "backlog"] },
                { field: "priority", op: "in", values: ["p0-critical", "p2-medium"] },
              ],
            },
          ],
        },
        sort: [
          { field: "priority", direction: "desc" },
          { field: "created", direction: "asc" },
        ],
      }),
      propertyOrderCsv: "status,priority,estimate",
      hiddenPropertiesCsv: "estimate",
      showEmptyEstimate: "true",
    });

    expect(settings.rulesV2.mode).toBe("advanced");
    expect(settings.rulesV2.includeHostCard).toBeTrue();
    expect(settings.rulesV2.sort[0]?.field).toBe("priority");
    expect(settings.rulesV2.sort[0]?.direction).toBe("desc");
    expect(settings.rulesV2.sort[1]?.field).toBe("created");
    expect(settings.rulesV2.sort[1]?.direction).toBe("asc");
    expect(JSON.stringify(settings.propertyOrder)).toBe(JSON.stringify(["status", "priority", "estimate", "tags"]));
    expect(JSON.stringify(settings.hiddenProperties)).toBe(JSON.stringify(["estimate"]));
    expect(settings.showEmptyEstimate).toBeTrue();
  });

  test("falls back to defaults when rulesV2 props are invalid", () => {
    const settings = parseToggleListInlineViewSettings({
      rulesV2B64: "bad",
      propertyOrderCsv: "missing",
      hiddenPropertiesCsv: "none",
    });

    const defaults = getDefaultToggleListSettings();
    expect(JSON.stringify(settings.rulesV2)).toBe(JSON.stringify(defaults.rulesV2));
    expect(JSON.stringify(settings.propertyOrder)).toBe(JSON.stringify(defaults.propertyOrder));
    expect(JSON.stringify(settings.hiddenProperties)).toBe(JSON.stringify([]));
    expect(settings.showEmptyEstimate).toBeFalse();
  });

  test("merges settings into canonical serializable block props", () => {
    const defaults = getDefaultToggleListInlineViewProps("default");
    const settings = parseToggleListInlineViewSettings({
      ...defaults,
      rulesV2B64: encodeRules({
        ...getDefaultToggleListSettings().rulesV2,
        includeHostCard: true,
      }),
      showEmptyEstimate: "true",
    });
    const merged = mergeToggleListInlineViewProps(defaults, "alpha", settings);

    expect(merged.sourceProjectId).toBe("alpha");
    expect(typeof merged.rulesV2B64).toBe("string");
    expect(merged.rulesV2B64.length > 0).toBeTrue();
    expect(merged.propertyOrderCsv).toBe("priority,estimate,status,tags");
    expect(merged.hiddenPropertiesCsv).toBe("");
    expect(merged.showEmptyEstimate).toBe("true");
  });
});
