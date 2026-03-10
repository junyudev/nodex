import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CARD_PROPERTY_POSITION,
  normalizeCardPropertyPosition,
} from "./card-property-position";

describe("card property position", () => {
  test("defaults to inline", () => {
    expect(DEFAULT_CARD_PROPERTY_POSITION).toBe("inline");
    expect(normalizeCardPropertyPosition(undefined)).toBe("inline");
    expect(normalizeCardPropertyPosition("side")).toBe("inline");
  });

  test("preserves the supported positions", () => {
    expect(normalizeCardPropertyPosition("top")).toBe("top");
    expect(normalizeCardPropertyPosition("inline")).toBe("inline");
    expect(normalizeCardPropertyPosition("bottom")).toBe("bottom");
  });
});
