import { describe, expect, test } from "bun:test";
import {
  normalizeProjectIcon,
  normalizeProjectIconUpdate,
} from "./project-icon";

describe("project-icon", () => {
  test("normalizeProjectIcon returns empty icon for missing value", () => {
    expect(normalizeProjectIcon(undefined)).toBe("");
    expect(normalizeProjectIcon("")).toBe("");
  });

  test("normalizeProjectIcon picks the first emoji grapheme", () => {
    expect(normalizeProjectIcon("🚀 Launch")).toBe("🚀");
    expect(normalizeProjectIcon("Build 🧪 tests")).toBe("🧪");
  });

  test("normalizeProjectIcon falls back to empty when no emoji exists", () => {
    expect(normalizeProjectIcon("workspace")).toBe("");
  });

  test("normalizeProjectIconUpdate keeps undefined untouched", () => {
    expect(normalizeProjectIconUpdate(undefined)).toBe(undefined);
    expect(normalizeProjectIconUpdate("🛠️")).toBe("🛠️");
  });
});
